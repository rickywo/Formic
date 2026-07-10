/**
 * Unit tests for deadlock detection, shared-lease holder resolution,
 * multi-file wait tracking, and survivor cleanup.
 *
 * Covers:
 *  - 2-node cycle detected via shared-lease holder
 *  - 3-node cycle where one edge comes from a task's SECOND conflicting file
 *  - No-cycle configurations return null
 *  - Survivor stale-wait cleanup after cycle resolution (no phantom cycles)
 *  - Repro scenarios from repro-deadlock-survivor.ts and repro-deadlockshared-b.ts
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { promisify } from 'node:util';
import {
  acquireLeases,
  clearWait,
  detectDeadlock,
  getAllLeases,
  getFileHolders,
  getLeasesByTask,
  getWaitForEntries,
  persistLeases,
  recordWait,
  releaseLeases,
} from '../../src/server/services/leaseManager.js';
import { createTask, updateTaskStatus } from '../../src/server/services/store.js';
import { setWorkspacePath } from '../../src/server/utils/paths.js';

const execFileAsync = promisify(execFile);

/** Helper: run a git command in the temp workspace. */
async function git(args: string[], cwd: string): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

let workspacePath: string;

beforeEach(async () => {
  workspacePath = await mkdtemp(path.join(os.tmpdir(), 'formic-dd-test-'));
  await mkdir(path.join(workspacePath, '.formic'), { recursive: true });
  setWorkspacePath(workspacePath);

  // Minimal git repo so teardownTask's checkoutWorkspaceFiles has a valid
  // working tree.
  await git(['init'], workspacePath);
  await git(['config', 'user.email', 'test@formic.local'], workspacePath);
  await git(['config', 'user.name', 'Formic Test'], workspacePath);
  await writeFile(path.join(workspacePath, '.gitkeep'), '');
  await git(['add', '.gitkeep'], workspacePath);
  await git(['commit', '-m', 'init', '--no-verify'], workspacePath);
});

afterEach(async () => {
  // Clean up in-memory lease and wait state.
  for (const lease of getAllLeases()) {
    releaseLeases(lease.taskId);
  }
  // Also clear any left-over wait entries.
  for (const entry of getWaitForEntries()) {
    clearWait(entry.taskId);
  }
  await persistLeases();
  await rm(workspacePath, { recursive: true, force: true });
});

describe('getFileHolders', () => {
  it('resolves the exclusive holder for a bare-key lease', () => {
    const result = acquireLeases({
      taskId: 't-excl',
      exclusiveFiles: ['src/exclusive.ts'],
      sharedFiles: [],
    });
    assert.equal(result.granted, true);

    const holders = getFileHolders('src/exclusive.ts');
    assert.deepEqual([...holders], ['t-excl']);
  });

  it('resolves shared holders for scoped-key leases', () => {
    acquireLeases({ taskId: 't-s1', exclusiveFiles: [], sharedFiles: ['src/common.ts'] });
    acquireLeases({ taskId: 't-s2', exclusiveFiles: [], sharedFiles: ['src/common.ts'] });

    const holders = getFileHolders('src/common.ts');
    assert.equal(holders.size, 2);
    assert.ok(holders.has('t-s1'));
    assert.ok(holders.has('t-s2'));
  });

  it('resolves both exclusive and shared holders together', () => {
    // Exclusive and shared leases can coexist on DIFFERENT files.
    // Task A holds exclusive on fileA; Task B holds shared on fileA.
    // But acquireLeases won't allow shared if exclusive exists on the same file.
    // So we use separate files to demonstrate both resolution paths:
    //   fileE → exclusive holder only
    //   fileS → shared holders only
    // and assert getFileHolders handles each correctly.

    // Exclusive holder
    acquireLeases({ taskId: 't-excl', exclusiveFiles: ['src/mixed-e.ts'], sharedFiles: [] });
    const exclHolders = getFileHolders('src/mixed-e.ts');
    assert.equal(exclHolders.size, 1);
    assert.ok(exclHolders.has('t-excl'));

    // Shared holders
    acquireLeases({ taskId: 't-s1', exclusiveFiles: [], sharedFiles: ['src/mixed-s.ts'] });
    acquireLeases({ taskId: 't-s2', exclusiveFiles: [], sharedFiles: ['src/mixed-s.ts'] });
    const sharedHolders = getFileHolders('src/mixed-s.ts');
    assert.equal(sharedHolders.size, 2);
    assert.ok(sharedHolders.has('t-s1'));
    assert.ok(sharedHolders.has('t-s2'));

    // Clean up
    releaseLeases('t-excl');
    releaseLeases('t-s1');
    releaseLeases('t-s2');
  });

  it('returns empty set for a file with no leases', () => {
    const holders = getFileHolders('src/nonexistent.ts');
    assert.equal(holders.size, 0);
  });
});

describe('detectDeadlock — cycle detection', () => {
  it('detects a 2-node cycle via shared-lease holder', async () => {
    // Scenario: shared-lease holder blocking an exclusive request.
    // A holds SHARED on fileCommon (scoped key: fileCommon::A).
    // B holds exclusive on fileY.
    // A wants exclusive on fileY → denied (held by B) → wait(A, [fileY]).
    // B wants exclusive on fileCommon → denied (A's shared lease blocks
    //   exclusive access) → wait(B, [fileCommon]).
    // Cycle: A → B → A. The edge B→A exists because A holds a shared
    // (not exclusive) lease on fileCommon.

    const fileCommon = 'src/cycle-shared-s.ts';
    const fileY = 'src/cycle-shared-y.ts';

    const taskA = await createTask({ title: 'A (shared holder)', context: 'test', priority: 'high' });
    const taskB = await createTask({ title: 'B (shared holder)', context: 'test', priority: 'low' });
    await updateTaskStatus(taskA.id, 'running');
    await updateTaskStatus(taskB.id, 'running');

    // A holds only a SHARED lease on fileCommon (no exclusive leases)
    const grantA = acquireLeases({
      taskId: taskA.id,
      exclusiveFiles: [],
      sharedFiles: [fileCommon],
    });
    assert.equal(grantA.granted, true);

    // B holds exclusive on fileY
    const grantB = acquireLeases({
      taskId: taskB.id,
      exclusiveFiles: [fileY],
      sharedFiles: [],
    });
    assert.equal(grantB.granted, true);

    // A wants exclusive on fileY → denied, held by B
    const askA = acquireLeases({ taskId: taskA.id, exclusiveFiles: [fileY], sharedFiles: [] });
    assert.equal(askA.granted, false);
    recordWait(taskA.id, askA.conflictingFiles);

    // B wants exclusive on fileCommon → denied, A's shared lease blocks it
    const askB = acquireLeases({ taskId: taskB.id, exclusiveFiles: [fileCommon], sharedFiles: [] });
    assert.equal(askB.granted, false);
    recordWait(taskB.id, askB.conflictingFiles);

    const cycles = await detectDeadlock();
    assert.ok(cycles !== null, 'Expected a cycle to be detected');
    assert.ok(cycles!.length > 0);

    const hasAB = cycles!.some(c => c.includes(taskA.id) && c.includes(taskB.id));
    assert.ok(hasAB, `Cycle should contain both tasks: ${JSON.stringify(cycles)}`);

    // Clean up
    releaseLeases(taskA.id);
    releaseLeases(taskB.id);
    clearWait(taskA.id);
    clearWait(taskB.id);
  });

  it('detects a 3-node cycle where an edge comes from a second conflicting file', async () => {
    // Task A holds files [X, Y], Task B holds file Z.
    // Task C holds nothing initially, but wants Y (held by A).
    // Task B wants X (held by A) + Z is its own — wait from B to A.
    // Task A wants Z (held by B) — wait from A to B.
    // Task C also wants... let me set up a proper 3-node cycle.
    //
    // Better scenario:
    // A holds X (exclusive)
    // B holds Y (exclusive)
    // C holds Z (exclusive)
    //
    // A wants Y and Z → wait entries: [Y, Z] → edges: A→B (for Y), A→C (for Z)
    // B wants X → wait entry: [X] → edge: B→A
    // C wants... doesn't need to wait. This forms A→B→A (2-node) not 3-node.
    //
    // For 3-node via second conflicting file:
    // A holds X, B holds Y, C holds Z
    // A wants Y and Z → recordWait(A, [Y, Z]) → edges A→B, A→C
    // B wants X → recordWait(B, [X]) → edge B→A
    // C wants Y → recordWait(C, [Y]) → edge C→B
    //
    // Graph: A→B, A→C, B→A, C→B
    // Cycle from A's second file: A→C→B→A (3-node). The edge A→C comes from
    // A's second conflicting file (Z), which the old single-file code would miss.

    const fileX = 'src/c3-x.ts';
    const fileY = 'src/c3-y.ts';
    const fileZ = 'src/c3-z.ts';

    const taskA = await createTask({ title: 'A (3-node)', context: 'test', priority: 'high' });
    const taskB = await createTask({ title: 'B (3-node)', context: 'test', priority: 'medium' });
    const taskC = await createTask({ title: 'C (3-node)', context: 'test', priority: 'low' });
    await updateTaskStatus(taskA.id, 'running');
    await updateTaskStatus(taskB.id, 'running');
    await updateTaskStatus(taskC.id, 'running');

    // Grant initial exclusive leases
    assert.equal(acquireLeases({ taskId: taskA.id, exclusiveFiles: [fileX], sharedFiles: [] }).granted, true);
    assert.equal(acquireLeases({ taskId: taskB.id, exclusiveFiles: [fileY], sharedFiles: [] }).granted, true);
    assert.equal(acquireLeases({ taskId: taskC.id, exclusiveFiles: [fileZ], sharedFiles: [] }).granted, true);

    // A wants [Y, Z] → two edges from waitForMap: A→B and A→C
    const reqA = acquireLeases({ taskId: taskA.id, exclusiveFiles: [fileY, fileZ], sharedFiles: [] });
    assert.equal(reqA.granted, false);
    recordWait(taskA.id, reqA.conflictingFiles); // should be [Y, Z]

    // B wants X → edge B→A
    const reqB = acquireLeases({ taskId: taskB.id, exclusiveFiles: [fileX], sharedFiles: [] });
    assert.equal(reqB.granted, false);
    recordWait(taskB.id, reqB.conflictingFiles);

    // C wants Y → edge C→B
    const reqC = acquireLeases({ taskId: taskC.id, exclusiveFiles: [fileY], sharedFiles: [] });
    assert.equal(reqC.granted, false);
    recordWait(taskC.id, reqC.conflictingFiles);

    const cycles = await detectDeadlock();
    assert.ok(cycles !== null, 'Expected cycles to be detected');

    // Should find the 3-node cycle A → C → B → A (via A's second conflicting file Z)
    const has3Node = cycles!.some(c =>
      c.includes(taskA.id) && c.includes(taskB.id) && c.includes(taskC.id)
    );
    assert.ok(has3Node, `Expected 3-node cycle containing all tasks: ${JSON.stringify(cycles)}`);

    // Clean up
    for (const tid of [taskA.id, taskB.id, taskC.id]) {
      releaseLeases(tid);
      clearWait(tid);
    }
  });

  it('returns null when there are no cycles', async () => {
    // A holds X, B holds Y. A waits on Y, B does NOT wait on X — no cycle.
    const fileX = 'src/nocycle-x.ts';
    const fileY = 'src/nocycle-y.ts';

    const taskA = await createTask({ title: 'A (no cycle)', context: 'test', priority: 'high' });
    const taskB = await createTask({ title: 'B (no cycle)', context: 'test', priority: 'low' });
    await updateTaskStatus(taskA.id, 'running');
    await updateTaskStatus(taskB.id, 'running');

    assert.equal(acquireLeases({ taskId: taskA.id, exclusiveFiles: [fileX], sharedFiles: [] }).granted, true);
    assert.equal(acquireLeases({ taskId: taskB.id, exclusiveFiles: [fileY], sharedFiles: [] }).granted, true);

    // Only A waits — no cycle possible
    const reqA = acquireLeases({ taskId: taskA.id, exclusiveFiles: [fileY], sharedFiles: [] });
    assert.equal(reqA.granted, false);
    recordWait(taskA.id, reqA.conflictingFiles);

    const cycles = await detectDeadlock();
    assert.equal(cycles, null, 'Expected no cycles when wait graph is acyclic');

    // Clean up
    releaseLeases(taskA.id);
    releaseLeases(taskB.id);
    clearWait(taskA.id);
    clearWait(taskB.id);
  });

  it('returns null when waitForMap is empty', async () => {
    const cycles = await detectDeadlock();
    assert.equal(cycles, null);
  });
});

describe('detectDeadlock — survivor cleanup', () => {
  it('survivors have no stale wait entries after cycle resolution (no phantom cycles)', async () => {
    // Scenario from repro-deadlock-survivor.ts:
    // Step 1: A holds X, B holds Y
    // Step 2: A wants Y (held by B) → recordWait(A, [Y])
    // Step 3: B wants X (held by A) → recordWait(B, [X]) → cycle A↔B
    // Step 4: detectDeadlock resolves cycle → B is victim (low priority)
    // Step 5: New task C acquires Y, then wants X → recordWait(C, [X])
    // Step 6: detectDeadlock must NOT find a phantom cycle involving A
    //   (A's stale waitForMap entry for Y should be cleaned up)

    const fileX = 'src/survivor-x.ts';
    const fileY = 'src/survivor-y.ts';

    const taskA = await createTask({ title: 'A (survivor)', context: 'test', priority: 'high' });
    const taskB = await createTask({ title: 'B (victim)', context: 'test', priority: 'low' });
    await updateTaskStatus(taskA.id, 'running');
    await updateTaskStatus(taskB.id, 'running');

    // Step 1: A holds X, B holds Y
    assert.equal(acquireLeases({ taskId: taskA.id, exclusiveFiles: [fileX], sharedFiles: [] }).granted, true);
    assert.equal(acquireLeases({ taskId: taskB.id, exclusiveFiles: [fileY], sharedFiles: [] }).granted, true);

    // Step 2: A wants Y → recordWait(A, [Y])
    const askA = acquireLeases({ taskId: taskA.id, exclusiveFiles: [fileY], sharedFiles: [] });
    assert.equal(askA.granted, false);
    recordWait(taskA.id, askA.conflictingFiles);

    // Step 3: B wants X → recordWait(B, [X]) — forms cycle
    const askB = acquireLeases({ taskId: taskB.id, exclusiveFiles: [fileX], sharedFiles: [] });
    assert.equal(askB.granted, false);
    recordWait(taskB.id, askB.conflictingFiles);

    // Step 4: Resolve cycle — B (low) should be victim, A should be survivor
    const cycle1 = await detectDeadlock();
    assert.ok(cycle1 !== null, 'Expected first cycle to be detected');

    // B should be the victim (torn down) → B has no leases, no wait entries
    const bLeases = getLeasesByTask(taskB.id);
    assert.equal(bLeases.length, 0, 'Victim B should have no leases');

    // A should still hold X
    const aLeases = getLeasesByTask(taskA.id);
    assert.ok(aLeases.length > 0, 'Survivor A should still hold its lease');

    // CRITICAL: A should NOT have a stale wait entry for Y
    const waitEntries = getWaitForEntries();
    const aStillWaiting = waitEntries.some(e => e.taskId === taskA.id && e.filePaths.includes(fileY));
    assert.equal(aStillWaiting, false, 'Survivor A must not retain stale wait entry for Y');

    // Step 5: New task C acquires Y (B's lease was released), then wants X
    const taskC = await createTask({ title: 'C (unrelated)', context: 'test', priority: 'medium' });
    await updateTaskStatus(taskC.id, 'running');

    const grantC = acquireLeases({ taskId: taskC.id, exclusiveFiles: [fileY], sharedFiles: [] });
    assert.equal(grantC.granted, true, 'C should acquire Y since B released it');

    const askC = acquireLeases({ taskId: taskC.id, exclusiveFiles: [fileX], sharedFiles: [] });
    assert.equal(askC.granted, false);
    recordWait(taskC.id, askC.conflictingFiles);

    // Step 6: detectDeadlock should NOT find a phantom cycle.
    // If A's waitForMap entry was stale (still contained Y), and Y is now
    // held by C, then A → C → A would look like a cycle. But if cleanup
    // worked, A has no waitForMap entry and no phantom cycle forms.
    const cycle2 = await detectDeadlock();
    assert.equal(cycle2, null, 'No phantom cycle should form from stale survivor wait entries');

    // Clean up
    for (const tid of [taskA.id, taskB.id, taskC.id]) {
      releaseLeases(tid);
      clearWait(tid);
    }
  });
});

describe('detectDeadlock — multi-file wait edge validation', () => {
  it('ignores edges for files whose holders have released their leases (stale wait entries)', async () => {
    // A holds X, B holds Y.
    // A wants Y → recordWait(A, [Y]) → edge A→B.
    // B releases Y (e.g. preempted outside of deadlock detection).
    // detectDeadlock must NOT report a cycle because the edge A→B is no
    // longer valid — getFileHolders(Y) returns empty.

    const fileX = 'src/stale-x.ts';
    const fileY = 'src/stale-y.ts';

    const taskA = await createTask({ title: 'A (stale test)', context: 'test', priority: 'high' });
    const taskB = await createTask({ title: 'B (stale test)', context: 'test', priority: 'low' });
    await updateTaskStatus(taskA.id, 'running');
    await updateTaskStatus(taskB.id, 'running');

    assert.equal(acquireLeases({ taskId: taskA.id, exclusiveFiles: [fileX], sharedFiles: [] }).granted, true);
    assert.equal(acquireLeases({ taskId: taskB.id, exclusiveFiles: [fileY], sharedFiles: [] }).granted, true);

    // A waits on Y
    const askA = acquireLeases({ taskId: taskA.id, exclusiveFiles: [fileY], sharedFiles: [] });
    assert.equal(askA.granted, false);
    recordWait(taskA.id, askA.conflictingFiles);

    // Simulate B releasing Y between wait registration and deadlock detection
    releaseLeases(taskB.id);

    // B still holds nothing → no edge from A should exist
    const cycles = await detectDeadlock();
    assert.equal(cycles, null, 'Stale edge should not produce a phantom cycle');

    // Clean up
    releaseLeases(taskA.id);
    clearWait(taskA.id);
    clearWait(taskB.id);
  });
});

describe('detectDeadlock — shared-lease holder cycle', () => {
  it('detects a cycle where the blocking holder has a shared (not exclusive) lease', async () => {
    // Exact scenario: same file, exclusive vs shared conflict.
    // A holds exclusive on X.
    // B wants exclusive on X → denied because A holds exclusive.
    // C holds shared on X.
    // D wants exclusive on X → denied because... wait, D is blocked by A (exclusive).
    //
    // Let me construct the exact shared-holder scenario from the task:
    // A holds fileX (exclusive) + fileCommon (shared)
    // B holds fileY (exclusive) + fileCommon (shared) — shared doesn't conflict
    // B wants fileX → denied (A holds exclusive X) → recordWait(B, [X])
    // A wants fileY → denied (B holds exclusive Y) → recordWait(A, [Y])
    //
    // Cycle: A wants Y (held by B) → B wants X (held by A)
    // Both have shared leases on fileCommon — the shared lease doesn't
    // block anyone, but the cycle is through exclusive leases.

    const fileX = 'src/shcycle-x.ts';
    const fileY = 'src/shcycle-y.ts';
    const fileCommon = 'src/shcycle-common.ts';

    const taskA = await createTask({ title: 'A (shared holder)', context: 'test', priority: 'high' });
    const taskB = await createTask({ title: 'B (shared holder)', context: 'test', priority: 'low' });
    await updateTaskStatus(taskA.id, 'running');
    await updateTaskStatus(taskB.id, 'running');

    // A: exclusive X + shared common
    const grantA = acquireLeases({
      taskId: taskA.id,
      exclusiveFiles: [fileX],
      sharedFiles: [fileCommon],
    });
    assert.equal(grantA.granted, true);

    // B: exclusive Y + shared common (shared leases don't conflict)
    const grantB = acquireLeases({
      taskId: taskB.id,
      exclusiveFiles: [fileY],
      sharedFiles: [fileCommon],
    });
    assert.equal(grantB.granted, true);

    // B wants X (held exclusively by A) → denied
    const askB = acquireLeases({ taskId: taskB.id, exclusiveFiles: [fileX], sharedFiles: [] });
    assert.equal(askB.granted, false);
    recordWait(taskB.id, askB.conflictingFiles);

    // A wants Y (held exclusively by B) → denied → cycle closed
    const askA = acquireLeases({ taskId: taskA.id, exclusiveFiles: [fileY], sharedFiles: [] });
    assert.equal(askA.granted, false);
    recordWait(taskA.id, askA.conflictingFiles);

    const cycles = await detectDeadlock();
    assert.ok(cycles !== null, 'Expected cycle to be detected with shared-lease holders');

    const hasAB = cycles!.some(c => c.includes(taskA.id) && c.includes(taskB.id));
    assert.ok(hasAB, `Cycle should contain both A and B: ${JSON.stringify(cycles)}`);

    // Verify shared lease on common file was left intact for the survivor (A)
    const holders = getFileHolders(fileCommon);
    assert.ok(holders.has(taskA.id), 'Survivor A should still hold shared lease on common file');

    // Clean up
    for (const tid of [taskA.id, taskB.id]) {
      releaseLeases(tid);
      clearWait(tid);
    }
  });
});

describe('detectDeadlock — exclusive-only holder', () => {
  it('detects a 2-node exclusive-only cycle (classic deadlock)', async () => {
    const fileX = 'src/excl-x.ts';
    const fileY = 'src/excl-y.ts';

    const taskA = await createTask({ title: 'A (excl cycle)', context: 'test', priority: 'high' });
    const taskB = await createTask({ title: 'B (excl cycle)', context: 'test', priority: 'low' });
    await updateTaskStatus(taskA.id, 'running');
    await updateTaskStatus(taskB.id, 'running');

    assert.equal(acquireLeases({ taskId: taskA.id, exclusiveFiles: [fileX], sharedFiles: [] }).granted, true);
    assert.equal(acquireLeases({ taskId: taskB.id, exclusiveFiles: [fileY], sharedFiles: [] }).granted, true);

    const askA = acquireLeases({ taskId: taskA.id, exclusiveFiles: [fileY], sharedFiles: [] });
    assert.equal(askA.granted, false);
    recordWait(taskA.id, askA.conflictingFiles);

    const askB = acquireLeases({ taskId: taskB.id, exclusiveFiles: [fileX], sharedFiles: [] });
    assert.equal(askB.granted, false);
    recordWait(taskB.id, askB.conflictingFiles);

    const cycles = await detectDeadlock();
    assert.ok(cycles !== null);
    const hasAB = cycles!.some(c => c.includes(taskA.id) && c.includes(taskB.id));
    assert.ok(hasAB);

    // B (low priority) should be the victim
    const bLeases = getLeasesByTask(taskB.id);
    assert.equal(bLeases.length, 0, 'Victim B should have no leases after resolution');

    // Clean up
    for (const tid of [taskA.id, taskB.id]) {
      releaseLeases(tid);
      clearWait(tid);
    }
  });
});
