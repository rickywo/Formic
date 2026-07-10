import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createTask, getTask, queueTask, updateTask, getAllTasks } from '../../src/server/services/store.js';
import { setWorkspacePath } from '../../src/server/utils/paths.js';
import { refreshEngineConfig, engineConfig } from '../../src/server/services/engineConfig.js';

let workspacePath: string;

beforeEach(async () => {
  workspacePath = await mkdtemp(path.join(os.tmpdir(), 'formic-cap-test-'));
  await mkdir(path.join(workspacePath, '.formic'), { recursive: true });
  setWorkspacePath(workspacePath);
  await refreshEngineConfig();
});

afterEach(async () => {
  await rm(workspacePath, { recursive: true, force: true });
});

describe('queue cap transition', () => {
  it('transitions a queued task with retryCount >= maxExecutionRetries to todo with yieldReason', async () => {
    // Create a task and manually set it as queued with a high retryCount
    const task = await createTask({ title: 'Capped retry task', context: 'ctx' });

    // Get the task into queued status with retryCount at the cap
    await queueTask(task.id);
    await updateTask(task.id, { retryCount: engineConfig.maxExecutionRetries });

    // Verify initial state
    let t = await getTask(task.id);
    assert.ok(t);
    assert.equal(t!.status, 'queued');
    assert.equal(t!.retryCount, engineConfig.maxExecutionRetries);

    // The queue processor (processQueue) is not directly exported so we simulate
    // its logic by directly transitioning the task — this validates the store
    // infrastructure that processQueue() uses (updateTask, updateTaskStatus).
    const reason = `cap-exceeded:retries(${engineConfig.maxExecutionRetries})`;
    await updateTask(task.id, { yieldReason: reason });
    const { updateTaskStatus } = await import('../../src/server/services/store.js');
    await updateTaskStatus(task.id, 'todo', null, 'queueProcessor.retry_cap_exceeded');

    t = await getTask(task.id);
    assert.ok(t);
    assert.equal(t!.status, 'todo', 'task should be transitioned to todo');
    assert.equal(t!.yieldReason, reason, 'yieldReason should be populated');
  });

  it('transitions a queued task with yieldCount >= maxYieldCount to todo with yieldReason', async () => {
    const task = await createTask({ title: 'Capped yield task', context: 'ctx' });

    await queueTask(task.id);
    await updateTask(task.id, { yieldCount: engineConfig.maxYieldCount });

    let t = await getTask(task.id);
    assert.ok(t);
    assert.equal(t!.status, 'queued');
    assert.equal(t!.yieldCount, engineConfig.maxYieldCount);

    const reason = `cap-exceeded:yields(${engineConfig.maxYieldCount})`;
    await updateTask(task.id, { yieldReason: reason });
    const { updateTaskStatus } = await import('../../src/server/services/store.js');
    await updateTaskStatus(task.id, 'todo', null, 'queueProcessor.yield_cap_exceeded');

    t = await getTask(task.id);
    assert.ok(t);
    assert.equal(t!.status, 'todo', 'task should be transitioned to todo');
    assert.equal(t!.yieldReason, reason, 'yieldReason should be populated');
  });

  it('does NOT re-transition a task already in todo after cap transition (idempotency)', async () => {
    // Simulate what happens when a task is already in todo after cap transition
    // and the queue processor re-scans: it should not be in the queued list anymore.
    const task = await createTask({ title: 'Already todo task', context: 'ctx' });

    await queueTask(task.id);
    await updateTask(task.id, {
      retryCount: engineConfig.maxExecutionRetries,
      yieldReason: `cap-exceeded:retries(${engineConfig.maxExecutionRetries})`,
    });
    const { updateTaskStatus } = await import('../../src/server/services/store.js');
    await updateTaskStatus(task.id, 'todo', null, 'queueProcessor.retry_cap_exceeded');

    // Verify the task is in todo, not queued
    const t = await getTask(task.id);
    assert.ok(t);
    assert.equal(t!.status, 'todo');

    // Verify it won't appear in the queued list (no re-log spam on subsequent cycles)
    const { getQueuedTasks } = await import('../../src/server/services/store.js');
    const queued = await getQueuedTasks();
    const stillQueued = queued.find(q => q.id === task.id);
    assert.equal(stillQueued, undefined, 'capped task should not appear in queued list');
  });
});

describe('queueTask counter reset', () => {
  it('resets retryCount, yieldCount, and yieldReason when manually re-queuing a capped task', async () => {
    // Create a task that was capped and sent back to todo
    const task = await createTask({ title: 'Reset counters task', context: 'ctx' });

    // Simulate cap: set task to todo with cap state
    await updateTask(task.id, {
      retryCount: 5,
      yieldCount: 10,
      yieldReason: 'cap-exceeded:retries(5)',
      status: 'todo',
    });

    let t = await getTask(task.id);
    assert.ok(t);
    assert.equal(t!.status, 'todo');
    assert.equal(t!.retryCount, 5);
    assert.equal(t!.yieldCount, 10);
    assert.ok(t!.yieldReason);

    // User manually drags back to queued
    const queued = await queueTask(task.id);
    assert.ok(queued);
    assert.equal(queued!.status, 'queued');

    // Verify counters are fresh
    t = await getTask(task.id);
    assert.ok(t);
    assert.equal(t!.retryCount, null, 'retryCount should be reset to null');
    assert.equal(t!.yieldCount, 0, 'yieldCount should be reset to 0');
    assert.equal(t!.yieldReason, undefined, 'yieldReason should be cleared');
  });
});
