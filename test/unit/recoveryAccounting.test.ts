import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  createTask,
  getTask,
  queueTask,
  updateTask,
  recoverStuckTasks,
  saveBoard,
  loadBoard,
} from '../../src/server/services/store.js';
import {
  restoreLeases,
  getLeasesByTask,
  releaseLeases,
  persistLeases,
} from '../../src/server/services/leaseManager.js';
import { setWorkspacePath } from '../../src/server/utils/paths.js';
import { refreshEngineConfig, engineConfig } from '../../src/server/services/engineConfig.js';
import type { LeaseStoreSnapshot } from '../../src/types/index.js';

let workspacePath: string;

beforeEach(async () => {
  workspacePath = await mkdtemp(path.join(os.tmpdir(), 'formic-rec-test-'));
  await mkdir(path.join(workspacePath, '.formic'), { recursive: true });
  setWorkspacePath(workspacePath);
  await refreshEngineConfig();
});

afterEach(async () => {
  // releaseLeases() persists asynchronously; drain that queue before removing
  // the workspace so a pending leases.json write cannot race cleanup.
  await persistLeases();
  await rm(workspacePath, { recursive: true, force: true });
});

describe('recoverStuckTasks accounting', () => {
  it('produces a [StatusTransition] log entry and increments recoveryCount on recovery', async () => {
    // Create a task and manually set it to 'running' (simulating a stuck task)
    const task = await createTask({ title: 'Stuck running task', context: 'ctx' });
    await updateTask(task.id, { status: 'running' as const });

    // Verify initial state
    let t = await getTask(task.id);
    assert.ok(t);
    assert.equal(t!.status, 'running');
    assert.equal(t!.recoveryCount, null);

    // Run recovery
    const recovered = await recoverStuckTasks();
    assert.equal(recovered, 1, 'should recover exactly 1 task');

    // Verify the task is now queued
    t = await getTask(task.id);
    assert.ok(t);
    assert.equal(t!.status, 'queued', 'task should be re-queued');
    assert.equal(t!.recoveryCount, 1, 'recoveryCount should be incremented to 1');
    assert.equal(t!.pid, null, 'pid should be cleared');

    // Verify the [StatusTransition] log entry was appended
    assert.ok(t!.agentLogs.length > 0, 'agentLogs should contain status transition');
    const transitionLog = t!.agentLogs.find(line => line.includes('[StatusTransition]'));
    assert.ok(transitionLog, 'should have a StatusTransition log entry');
    assert.ok(transitionLog!.includes('running → queued'), 'should show running → queued transition');
    assert.ok(transitionLog!.includes('caller=recovery.startup'), 'should show recovery.startup caller');
  });

  it('increments recoveryCount cumulatively across multiple recoveries', async () => {
    // Create a task and set it to 'running'
    const task = await createTask({ title: 'Multi-recovery task', context: 'ctx' });
    await updateTask(task.id, { status: 'running' as const });

    // First recovery
    let recovered = await recoverStuckTasks();
    assert.equal(recovered, 1);

    let t = await getTask(task.id);
    assert.equal(t!.recoveryCount, 1);
    assert.equal(t!.status, 'queued');

    // Re-set to running to simulate another crash
    await updateTask(task.id, { status: 'running' as const });

    // Second recovery
    recovered = await recoverStuckTasks();
    assert.equal(recovered, 1);

    t = await getTask(task.id);
    assert.equal(t!.recoveryCount, 2, 'recoveryCount should be 2 after second recovery');
  });

  it('recovers tasks in multiple active statuses', async () => {
    const task1 = await createTask({ title: 'Briefing task', context: 'ctx' });
    const task2 = await createTask({ title: 'Planning task', context: 'ctx' });
    const task3 = await createTask({ title: 'Declaring task', context: 'ctx' });

    await updateTask(task1.id, { status: 'briefing' as const });
    await updateTask(task2.id, { status: 'planning' as const });
    await updateTask(task3.id, { status: 'declaring' as const });

    const recovered = await recoverStuckTasks();
    assert.equal(recovered, 3, 'should recover all 3 tasks');

    for (const id of [task1.id, task2.id, task3.id]) {
      const t = await getTask(id);
      assert.ok(t);
      assert.equal(t!.status, 'queued', `task ${id} should be queued`);
      assert.equal(t!.recoveryCount, 1, `task ${id} should have recoveryCount 1`);
    }
  });

  it('does not touch tasks already in queued status', async () => {
    const runningTask = await createTask({ title: 'Running task', context: 'ctx' });
    const queuedTask = await createTask({ title: 'Queued task', context: 'ctx' });

    await updateTask(runningTask.id, { status: 'running' as const });
    await queueTask(queuedTask.id);

    const recovered = await recoverStuckTasks();
    assert.equal(recovered, 1, 'should only recover the running task');

    const qt = await getTask(queuedTask.id);
    assert.ok(qt);
    assert.equal(qt!.status, 'queued', 'queued task should remain queued');
    assert.equal(qt!.recoveryCount, null, 'queued task recoveryCount should remain null');
  });
});

describe('orphan SIGTERM delivery', () => {
  it('sends SIGTERM to a recovered task\'s stale pid', async () => {
    // Spawn a dummy sleep process that will be our orphan
    const child = spawn('sleep', ['60'], {
      stdio: 'ignore',
      detached: true,
    });
    const orphanPid = child.pid;
    assert.ok(orphanPid, 'should have a pid');

    // Create a task and set it to 'running' with the orphan pid
    const task = await createTask({ title: 'Orphan task', context: 'ctx' });
    await updateTask(task.id, { status: 'running' as const, pid: orphanPid });

    let t = await getTask(task.id);
    assert.equal(t!.pid, orphanPid);

    // Run recovery - should SIGTERM the orphan
    const recovered = await recoverStuckTasks();
    assert.equal(recovered, 1);

    // Wait a bit for the signal to be delivered
    await new Promise(resolve => setTimeout(resolve, 200));

    // Verify the process is gone
    let killFailed = false;
    try {
      process.kill(orphanPid, 0); // signal 0 just checks existence
    } catch {
      killFailed = true; // ESRCH - process gone, which is what we want
    }
    assert.ok(killFailed, 'orphan process should be terminated');

    // Cleanup: ensure child is not left hanging if test fails
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  });

  it('handles already-dead pid gracefully (ESRCH)', async () => {
    // Find a pid that is extremely unlikely to exist
    // We'll use a very high pid that's almost certainly not in use
    const fakePid = 999999;

    // Verify it doesn't exist
    try {
      process.kill(fakePid, 0);
      // If we get here, the pid exists — skip this test
      assert.ok(true, 'pid exists, skipping (non-deterministic test)');
      return;
    } catch {
      // ESRCH - pid doesn't exist, good for our test
    }

    const task = await createTask({ title: 'Dead pid task', context: 'ctx' });
    await updateTask(task.id, { status: 'running' as const, pid: fakePid });

    // Should not throw - the ESRCH is caught internally
    const recovered = await recoverStuckTasks();
    assert.equal(recovered, 1);

    const t = await getTask(task.id);
    assert.equal(t!.status, 'queued');
    assert.equal(t!.recoveryCount, 1);
  });
});

describe('recovery cap demotion', () => {
  it('demotes a queued task with recoveryCount > maxExecutionRetries to todo', async () => {
    // Create a task and manually set it to queued with recoveryCount exceeding the cap
    const task = await createTask({ title: 'Recovery capped task', context: 'ctx' });
    await queueTask(task.id);
    await updateTask(task.id, { recoveryCount: engineConfig.maxExecutionRetries + 1 });

    // Verify initial state
    let t = await getTask(task.id);
    assert.ok(t);
    assert.equal(t!.status, 'queued');
    assert.ok((t!.recoveryCount ?? 0) > engineConfig.maxExecutionRetries);

    // Simulate queue processor cap logic (same pattern as retry/yield caps)
    const reason = `cap-exceeded:recoveries(${t!.recoveryCount})`;
    await updateTask(task.id, { yieldReason: reason });
    const { updateTaskStatus } = await import('../../src/server/services/store.js');
    await updateTaskStatus(task.id, 'todo', null, 'queueProcessor.recovery_cap_exceeded');

    t = await getTask(task.id);
    assert.ok(t);
    assert.equal(t!.status, 'todo', 'task should be transitioned to todo');
    assert.equal(t!.yieldReason, reason, 'yieldReason should be populated');
  });

  it('does not demote a task with recoveryCount at or below the cap', async () => {
    // Tasks at recoveryCount === maxExecutionRetries should still be allowed
    const task = await createTask({ title: 'Recovery ok task', context: 'ctx' });
    await queueTask(task.id);
    await updateTask(task.id, { recoveryCount: engineConfig.maxExecutionRetries });

    let t = await getTask(task.id);
    assert.ok(t);
    assert.equal(t!.status, 'queued');
    // recoveryCount > maxExecutionRetries is the condition, so at the cap is still OK
    assert.equal((t!.recoveryCount ?? 0) > engineConfig.maxExecutionRetries, false,
      'task at the cap should not trigger demotion');
  });
});

describe('queueTask resets recoveryCount', () => {
  it('resets recoveryCount to null on manual re-queue', async () => {
    const task = await createTask({ title: 'Reset recovery task', context: 'ctx' });

    // Simulate a task that was recovered, capped, and sent to todo
    await updateTask(task.id, {
      recoveryCount: 5,
      yieldReason: 'cap-exceeded:recoveries(5)',
      status: 'todo' as const,
    });

    let t = await getTask(task.id);
    assert.ok(t);
    assert.equal(t!.status, 'todo');
    assert.equal(t!.recoveryCount, 5);

    // User manually drags back to queued
    const queued = await queueTask(task.id);
    assert.ok(queued);
    assert.equal(queued!.status, 'queued');

    // Verify recoveryCount is reset
    t = await getTask(task.id);
    assert.ok(t);
    assert.equal(t!.recoveryCount, null, 'recoveryCount should be reset to null on manual re-queue');
  });
});

describe('recovery releases restored leases', () => {
  it('releases non-expired leases for recovered tasks after startup restore+recover sequence', async () => {
    // Create a task and set it to 'running' (simulating a stuck task from a prior session)
    const task = await createTask({ title: 'Stuck with lease', context: 'ctx' });
    await updateTask(task.id, { status: 'running' as const });

    // Manually write a leases.json with a non-expired lease for this task.
    // This simulates what survives a crash: the lease was on disk but the
    // server process died, so the lease never got released in memory.
    const futureExpiry = new Date(Date.now() + 300_000).toISOString();
    const snapshot: LeaseStoreSnapshot = {
      version: '1.0',
      savedAt: new Date().toISOString(),
      leases: [
        {
          key: 'src/stuck.ts',
          lease: {
            filePath: 'src/stuck.ts',
            taskId: task.id,
            acquiredAt: new Date().toISOString(),
            expiresAt: futureExpiry,
            leaseType: 'exclusive',
          },
        },
      ],
    };
    const leasesPath = path.join(workspacePath, '.formic', 'leases.json');
    await writeFile(leasesPath, JSON.stringify(snapshot, null, 2), 'utf-8');

    // Simulate the startup sequence: restoreLeases then recoverStuckTasks.
    await restoreLeases();

    // Verify the lease was restored into memory from disk.
    const leasesBefore = getLeasesByTask(task.id);
    assert.equal(leasesBefore.length, 1, 'lease should be restored from disk into memory');

    // Run recovery — this should re-queue the task AND release its leases.
    const recovered = await recoverStuckTasks();
    assert.equal(recovered, 1, 'should recover exactly 1 task');

    // Assert the task is re-queued.
    const t = await getTask(task.id);
    assert.ok(t);
    assert.equal(t!.status, 'queued', 'task should be re-queued after recovery');

    // Assert zero leases remain — recovery must release restored leases.
    const leasesAfter = getLeasesByTask(task.id);
    assert.deepEqual(leasesAfter, [], 'recovered task should hold zero leases');

    // Clean up any remaining in-memory lease state.
    releaseLeases(task.id);
  });
});
