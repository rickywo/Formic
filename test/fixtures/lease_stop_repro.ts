/**
 * Reproduction / regression fixture for lease preemption and deadlock resolution
 * stop-before-release sequencing (task t-5).
 *
 * preemptLease and detectDeadlock are not reachable via the REST API (they are
 * invoked from the workflow declare path and the watchdog respectively), so the
 * Python regression tests in test/test_concurrency_advanced.py spawn this script
 * with tsx against an isolated workspace and assert on its JSON output.
 *
 * Usage:
 *   WORKSPACE_PATH=/tmp/isolated npx tsx test/fixtures/lease_stop_repro.ts <scenario>
 *
 * Scenarios:
 *   preempt          — holder stoppable: preemption must stop the holder before release
 *   preempt-refuse   — holder cannot be stopped: preemption must be refused
 *   deadlock         — victim stoppable: resolution must stop the victim before release
 *   deadlock-refuse  — victim cannot be stopped: resolution must be skipped
 *
 * Prints a single JSON result object as the final stdout line.
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { setWorkspacePath, getWorkspacePath } from '../../src/server/utils/paths.js';
import {
  acquireLeases,
  preemptLease,
  detectDeadlock,
  getLeasesByTask,
  recordWait,
  releaseLeases,
  recordFileHashes,
  detectCollisions,
  clearWait,
} from '../../src/server/services/leaseManager.js';
import { createTask, getTask, loadBoard, saveBoard } from '../../src/server/services/store.js';
import type { Task } from '../../src/types/index.js';

interface StopCall {
  taskId: string;
  leasesHeldAtCall: number;
}

type StopperFn = (taskId: string) => Promise<boolean>;

/**
 * Register a stub task stopper that records each stop request together with the
 * number of leases the target still held at the moment of the call.
 *
 * Uses a dynamic import with feature detection: registerTaskStopper does not
 * exist in pre-fix code, so this fixture still runs (and its assertions fail,
 * proving the regression) against the unfixed tree.
 */
async function registerStubStopper(succeed: boolean, calls: StopCall[]): Promise<boolean> {
  const events = (await import('../../src/server/services/internalEvents.js')) as Record<string, unknown>;
  const register = events.registerTaskStopper;
  if (typeof register !== 'function') {
    return false;
  }
  (register as (fn: StopperFn) => void)(async (taskId: string) => {
    calls.push({ taskId, leasesHeldAtCall: getLeasesByTask(taskId).length });
    return succeed;
  });
  return true;
}

/**
 * Simulate a task that is past planning: give it a resume marker so the tests
 * can verify re-queueing preserves resumeFromStep.
 */
async function setResumeMarker(taskId: string): Promise<void> {
  const board = await loadBoard();
  const task = board.tasks.find((t: Task) => t.id === taskId);
  if (task) {
    task.resumeFromStep = 'declare';
    await saveBoard(board);
  }
}

/**
 * Set a fixture task's status to 'queued' so detectDeadlock's stale-record
 * filtering recognizes it as a live waiter. Tasks created via createTask()
 * start in 'todo' which the filter treats as stale; in the real system,
 * tasks waiting for leases are always in 'queued' status (yielded → re-queued).
 */
async function setTaskQueued(taskId: string): Promise<void> {
  const board = await loadBoard();
  const task = board.tasks.find((t: Task) => t.id === taskId);
  if (task) {
    task.status = 'queued';
    await saveBoard(board);
  }
}

async function runPreempt(stopSucceeds: boolean): Promise<Record<string, unknown>> {
  const stopCalls: StopCall[] = [];
  const stopperRegistered = await registerStubStopper(stopSucceeds, stopCalls);

  const holder = await createTask({ title: 'Repro preempt holder', context: 'lease stop repro', priority: 'low', type: 'standard' });
  const requester = await createTask({ title: 'Repro preempt requester', context: 'lease stop repro', priority: 'high', type: 'standard' });
  await setResumeMarker(holder.id);

  const file = `src/repro-preempt-${Date.now()}.ts`;
  const acquired = acquireLeases({ taskId: holder.id, exclusiveFiles: [file], sharedFiles: [] });

  const preemptResult = await preemptLease(requester.id, file);

  const holderAfter = await getTask(holder.id);
  const holderCalls = stopCalls.filter(c => c.taskId === holder.id);
  return {
    scenario: stopSucceeds ? 'preempt' : 'preempt-refuse',
    stopperRegistered,
    leaseGranted: acquired.granted,
    preemptResult,
    stopperCalledForHolder: holderCalls.length > 0,
    holderHeldLeaseWhenStopped: holderCalls.some(c => c.leasesHeldAtCall > 0),
    holderLeasesAfter: getLeasesByTask(holder.id).length,
    holderStatusAfter: holderAfter?.status ?? 'missing',
    resumeFromStepAfter: holderAfter?.resumeFromStep ?? null,
  };
}

async function runDeadlock(stopSucceeds: boolean): Promise<Record<string, unknown>> {
  const stopCalls: StopCall[] = [];
  const stopperRegistered = await registerStubStopper(stopSucceeds, stopCalls);

  const victim = await createTask({ title: 'Repro deadlock victim', context: 'lease stop repro', priority: 'low', type: 'standard' });
  const survivor = await createTask({ title: 'Repro deadlock survivor', context: 'lease stop repro', priority: 'high', type: 'standard' });
  await setResumeMarker(victim.id);
  // Set both tasks to 'queued' so detectDeadlock's stale-record filter
  // (which requires {queued, running, declaring}) does not exclude them.
  await setTaskQueued(victim.id);
  await setTaskQueued(survivor.id);

  const fileX = `src/repro-deadlock-x-${Date.now()}.ts`;
  const fileY = `src/repro-deadlock-y-${Date.now()}.ts`;
  acquireLeases({ taskId: victim.id, exclusiveFiles: [fileX], sharedFiles: [] });
  acquireLeases({ taskId: survivor.id, exclusiveFiles: [fileY], sharedFiles: [] });

  // Cross-waits: victim waits on fileY (held by survivor), survivor waits on fileX (held by victim)
  recordWait(victim.id, fileY);
  recordWait(survivor.id, fileX);

  const cycles = await detectDeadlock();

  const victimAfter = await getTask(victim.id);
  const victimCalls = stopCalls.filter(c => c.taskId === victim.id);
  return {
    scenario: stopSucceeds ? 'deadlock' : 'deadlock-refuse',
    stopperRegistered,
    cyclesDetected: cycles ? cycles.length : 0,
    stopperCalledForVictim: victimCalls.length > 0,
    victimHeldLeaseWhenStopped: victimCalls.some(c => c.leasesHeldAtCall > 0),
    victimLeasesAfter: getLeasesByTask(victim.id).length,
    survivorLeasesAfter: getLeasesByTask(survivor.id).length,
    victimStatusAfter: victimAfter?.status ?? 'missing',
    resumeFromStepAfter: victimAfter?.resumeFromStep ?? null,
  };
}

async function runPreemptEqualPriority(): Promise<Record<string, unknown>> {
  const stopCalls: StopCall[] = [];
  const stopperRegistered = await registerStubStopper(true, stopCalls);

  // Both tasks have equal priority (medium) → preemptLease should refuse
  const holder = await createTask({ title: 'Repro equal-pri holder', context: 'lease stop repro', priority: 'medium', type: 'standard' });
  const requester = await createTask({ title: 'Repro equal-pri requester', context: 'lease stop repro', priority: 'medium', type: 'standard' });

  const file = `src/repro-equalpri-${Date.now()}.ts`;
  const acquired = acquireLeases({ taskId: holder.id, exclusiveFiles: [file], sharedFiles: [] });

  const preemptResult = await preemptLease(requester.id, file);

  const holderCalls = stopCalls.filter(c => c.taskId === holder.id);
  return {
    scenario: 'preempt-equal-priority',
    stopperRegistered,
    leaseGranted: acquired.granted,
    preemptResult,
    stopperCalledForHolder: holderCalls.length > 0,
    holderLeasesAfter: getLeasesByTask(holder.id).length,
  };
}

async function runDeadlock3Task(): Promise<Record<string, unknown>> {
  const stopCalls: StopCall[] = [];
  const stopperRegistered = await registerStubStopper(true, stopCalls);

  // A→B→C→A cycle: 3 tasks in a circular wait
  const taskA = await createTask({ title: 'Deadlock3 A', context: 'lease stop repro', priority: 'low', type: 'standard' });
  const taskB = await createTask({ title: 'Deadlock3 B', context: 'lease stop repro', priority: 'medium', type: 'standard' });
  const taskC = await createTask({ title: 'Deadlock3 C', context: 'lease stop repro', priority: 'high', type: 'standard' });
  // Set all tasks to 'queued' so stale-record filter does not exclude them.
  await setTaskQueued(taskA.id);
  await setTaskQueued(taskB.id);
  await setTaskQueued(taskC.id);

  const fileX = `src/dl3-x-${Date.now()}.ts`;
  const fileY = `src/dl3-y-${Date.now()}.ts`;
  const fileZ = `src/dl3-z-${Date.now()}.ts`;

  // A holds X, B holds Y, C holds Z
  acquireLeases({ taskId: taskA.id, exclusiveFiles: [fileX], sharedFiles: [] });
  acquireLeases({ taskId: taskB.id, exclusiveFiles: [fileY], sharedFiles: [] });
  acquireLeases({ taskId: taskC.id, exclusiveFiles: [fileZ], sharedFiles: [] });

  // Circular waits: A waits on Y (held by B), B waits on Z (held by C), C waits on X (held by A)
  recordWait(taskA.id, fileY);
  recordWait(taskB.id, fileZ);
  recordWait(taskC.id, fileX);

  const cycles = await detectDeadlock();

  // The lowest-priority victim is task A (low)
  const aAfter = await getTask(taskA.id);
  const aCalls = stopCalls.filter(c => c.taskId === taskA.id);
  return {
    scenario: 'deadlock-3task',
    stopperRegistered,
    cyclesDetected: cycles ? cycles.length : 0,
    victimId: aCalls.length > 0 ? taskA.id : null,
    stopperCalled: aCalls.length > 0,
    victimStatusAfter: aAfter?.status ?? 'missing',
    victimLeasesAfter: getLeasesByTask(taskA.id).length,
  };
}

async function runDeadlockNoPhantom(): Promise<Record<string, unknown>> {
  // No wait-for entries → detectDeadlock should return null (no phantom resolution)
  // First verify the waitForMap is clear, then call detectDeadlock
  const cycles = await detectDeadlock();
  return {
    scenario: 'deadlock-no-phantom',
    cyclesDetected: cycles ? cycles.length : 0,
    phantomResolution: cycles !== null,
  };
}

async function runDeadlockShared(): Promise<Record<string, unknown>> {
  const stopCalls: StopCall[] = [];
  const stopperRegistered = await registerStubStopper(true, stopCalls);

  // Cycle involving shared-lease blocking:
  // A holds exclusive on F1. B holds SHARED on F2.
  // A wants exclusive on F2 → blocked by B's shared lease (shared→exclusive conflict).
  // B wants exclusive on F1 → blocked by A's exclusive lease.
  // Cycle: A → F2(B) → B → F1(A) → A.  Edge A→B only visible because
  // getBlockingHolders scans shared-lease compound keys, not just bare-path holders.
  const taskA = await createTask({ title: 'DeadlockShared A', context: 'lease stop repro', priority: 'low', type: 'standard' });
  const taskB = await createTask({ title: 'DeadlockShared B', context: 'lease stop repro', priority: 'high', type: 'standard' });
  // Set both tasks to 'queued' so stale-record filter does not exclude them.
  await setTaskQueued(taskA.id);
  await setTaskQueued(taskB.id);

  const fileF1 = `src/dlshared-f1-${Date.now()}.ts`;
  const fileF2 = `src/dlshared-f2-${Date.now()}.ts`;

  // A holds exclusive on F1; B holds SHARED on F2
  acquireLeases({ taskId: taskA.id, exclusiveFiles: [fileF1], sharedFiles: [] });
  acquireLeases({ taskId: taskB.id, exclusiveFiles: [], sharedFiles: [fileF2] });

  // Cross-waits: A wants exclusive on F2 (blocked by B's shared), B wants exclusive on F1 (blocked by A)
  recordWait(taskA.id, fileF2);
  recordWait(taskB.id, fileF1);

  const cycles = await detectDeadlock();

  // Lowest-priority victim is task A
  const aAfter = await getTask(taskA.id);
  const aCalls = stopCalls.filter(c => c.taskId === taskA.id);
  return {
    scenario: 'deadlock-shared',
    stopperRegistered,
    cyclesDetected: cycles ? cycles.length : 0,
    stopperCalled: aCalls.length > 0,
    victimStatusAfter: aAfter?.status ?? 'missing',
  };
}

async function runCollisionDetect(): Promise<Record<string, unknown>> {
  // Create two tasks sharing a file; one mutates it → collision detected
  const workspace = getWorkspacePath();
  const testFile = `src/collision-fixture-${Date.now()}.ts`;
  const fullPath = path.join(workspace, testFile);

  // Ensure directory and write original content
  const dir = path.dirname(fullPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const originalContent = `// collision fixture original ${Date.now()}\n`;
  writeFileSync(fullPath, originalContent, 'utf-8');

  try {
    const taskA = await createTask({ title: 'Collision A', context: 'collision fixture', priority: 'medium', type: 'standard' });
    const taskB = await createTask({ title: 'Collision B', context: 'collision fixture', priority: 'medium', type: 'standard' });

    // Both share the same file
    acquireLeases({ taskId: taskA.id, exclusiveFiles: [], sharedFiles: [testFile] });
    acquireLeases({ taskId: taskB.id, exclusiveFiles: [], sharedFiles: [testFile] });

    // Record hashes for both tasks
    await recordFileHashes(taskA.id, [testFile], workspace);
    await recordFileHashes(taskB.id, [testFile], workspace);

    // Task A mutates the file
    const mutatedContent = `// collision fixture mutated by A ${Date.now()}\n`;
    writeFileSync(fullPath, mutatedContent, 'utf-8');

    // Detect collisions for task B (should find that the file changed)
    const collisionsB = await detectCollisions(taskB.id, workspace);
    // Detect collisions for task A (A mutated it, so A's hash also doesn't match)
    const collisionsA = await detectCollisions(taskA.id, workspace);

    return {
      scenario: 'collision-detect',
      filePath: testFile,
      collisionsForB: collisionsB.length,
      collisionsForA: collisionsA.length,
      collisionDetected: collisionsB.length > 0,
      bCollisionFile: collisionsB.length > 0 ? collisionsB[0].filePath : null,
    };
  } finally {
    // Cleanup test file
    try { const fs = await import('node:fs'); fs.unlinkSync(fullPath); } catch {}
  }
}

async function runCollisionNoFalsePositive(): Promise<Record<string, unknown>> {
  // Two tasks share a file; neither modifies it → no collision
  const workspace = getWorkspacePath();
  const testFile = `src/collision-nofp-${Date.now()}.ts`;
  const fullPath = path.join(workspace, testFile);

  const dir = path.dirname(fullPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const content = `// no-false-positive fixture ${Date.now()}\n`;
  writeFileSync(fullPath, content, 'utf-8');

  try {
    const taskA = await createTask({ title: 'NoFP A', context: 'collision fixture', priority: 'medium', type: 'standard' });
    const taskB = await createTask({ title: 'NoFP B', context: 'collision fixture', priority: 'medium', type: 'standard' });

    acquireLeases({ taskId: taskA.id, exclusiveFiles: [], sharedFiles: [testFile] });
    acquireLeases({ taskId: taskB.id, exclusiveFiles: [], sharedFiles: [testFile] });

    await recordFileHashes(taskA.id, [testFile], workspace);
    await recordFileHashes(taskB.id, [testFile], workspace);

    // Neither modifies the file → no collision
    const collisionsB = await detectCollisions(taskB.id, workspace);
    const collisionsA = await detectCollisions(taskA.id, workspace);

    return {
      scenario: 'collision-no-false-positive',
      filePath: testFile,
      collisionsForB: collisionsB.length,
      collisionsForA: collisionsA.length,
      falsePositive: collisionsB.length > 0 || collisionsA.length > 0,
    };
  } finally {
    try { const fs = await import('node:fs'); fs.unlinkSync(fullPath); } catch {}
  }
}

async function main(): Promise<void> {
  if (!process.env.WORKSPACE_PATH || process.env.WORKSPACE_PATH === './workspace') {
    console.error('[Repro] Refusing to run: WORKSPACE_PATH must point to an isolated scratch directory');
    process.exit(2);
  }

  // Apply the workspace path so store.ts, leaseManager.ts etc. target the
  // isolated scratch directory rather than the server's live workspace.
  setWorkspacePath(process.env.WORKSPACE_PATH);

  const scenario = process.argv[2];
  let result: Record<string, unknown>;
  switch (scenario) {
    case 'preempt':
      result = await runPreempt(true);
      break;
    case 'preempt-refuse':
      result = await runPreempt(false);
      break;
    case 'preempt-equal-priority':
      result = await runPreemptEqualPriority();
      break;
    case 'deadlock':
      result = await runDeadlock(true);
      break;
    case 'deadlock-refuse':
      result = await runDeadlock(false);
      break;
    case 'deadlock-3task':
      result = await runDeadlock3Task();
      break;
    case 'deadlock-shared':
      result = await runDeadlockShared();
      break;
    case 'deadlock-no-phantom':
      result = await runDeadlockNoPhantom();
      break;
    case 'collision-detect':
      result = await runCollisionDetect();
      break;
    case 'collision-no-false-positive':
      result = await runCollisionNoFalsePositive();
      break;
    default:
      console.error(`[Repro] Unknown scenario: ${scenario ?? '(none)'}`);
      process.exit(2);
      return;
  }

  console.log(JSON.stringify(result));
  process.exit(0);
}

main().catch(err => {
  console.error('[Repro] Failed:', err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
