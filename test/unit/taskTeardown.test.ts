import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { acquireLeases, getAllLeases, getLeasesByTask, getWaitForEntries, persistLeases, recordWait, releaseLeases } from '../../src/server/services/leaseManager.js';
import { createTask, loadBoard, updateTaskStatus } from '../../src/server/services/store.js';
import { setWorkspacePath } from '../../src/server/utils/paths.js';
import { teardownTask } from '../../src/server/services/taskTeardown.js';

let workspacePath: string;

/**
 * Helper: inspect the raw board.json to confirm a task's status without
 * loading the board (which triggers recovery side-effects).
 */
async function getBoardTaskStatus(taskId: string): Promise<string | null> {
  const board = await loadBoard();
  const task = board.tasks.find(t => t.id === taskId);
  return task ? task.status : null;
}

beforeEach(async () => {
  workspacePath = await mkdtemp(path.join(os.tmpdir(), 'formic-teardown-test-'));
  await mkdir(path.join(workspacePath, '.formic'), { recursive: true });
  setWorkspacePath(workspacePath);

  // Initialize a minimal git repo so checkoutWorkspaceFiles (which calls
  // `git checkout -- <files>`) has a valid git working tree.
  const { execFile } = await import('node:child_process');
  const git = (args: string[]) =>
    new Promise<void>((resolve, reject) => {
      execFile('git', args, { cwd: workspacePath }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  await git(['init']);
  // Set author identity for test commits.
  await git(['config', 'user.email', 'test@formic.local']);
  await git(['config', 'user.name', 'Formic Test']);
  // Create a dummy file so git has a HEAD (required for checkout to work).
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path.join(workspacePath, '.gitkeep'), '');
  await git(['add', '.gitkeep']);
  await git(['commit', '-m', 'init', '--no-verify']);
});

afterEach(async () => {
  // Clean up in-memory lease store to prevent cross-test leakage.
  for (const lease of getAllLeases()) {
    releaseLeases(lease.taskId);
  }
  await persistLeases();
  await rm(workspacePath, { recursive: true, force: true });
});

describe('teardownTask', () => {
  it('leaves the task with no leases, no wait entry, and status queued', async () => {
    const task = await createTask({ title: 'Teardown target', context: 'ctx' });
    await updateTaskStatus(task.id, 'running');

    // Set up leases and wait state.
    const result = acquireLeases({
      taskId: task.id,
      exclusiveFiles: ['src/a.ts', 'src/b.ts'],
      sharedFiles: ['docs/readme.md'],
    });
    assert.equal(result.granted, true);
    recordWait(task.id, ['src/blocked.ts']);
    assert.equal(getLeasesByTask(task.id).length, 3);

    // Tear down.
    await teardownTask(task.id, 'unit_test');

    // Assertions: no leases, no wait, status queued.
    assert.deepEqual(getLeasesByTask(task.id), []);
    assert.equal(getWaitForEntries().some(e => e.taskId === task.id), false);

    const finalStatus = await getBoardTaskStatus(task.id);
    assert.equal(finalStatus, 'queued');
  });

  it('handles stopWorkflow returning true (no active workflow) gracefully', async () => {
    const task = await createTask({ title: 'No workflow task', context: 'ctx' });
    await updateTaskStatus(task.id, 'running');

    acquireLeases({ taskId: task.id, exclusiveFiles: ['src/x.ts'], sharedFiles: [] });
    assert.equal(getLeasesByTask(task.id).length, 1);

    // When stopWorkflow finds no active workflow, it still returns true and
    // calls updateTaskStatus(taskId, 'todo', ...) internally. teardownTask
    // must then set the final status to 'queued'.
    await teardownTask(task.id, 'no_workflow');

    assert.deepEqual(getLeasesByTask(task.id), []);
    const finalStatus = await getBoardTaskStatus(task.id);
    assert.equal(finalStatus, 'queued');
  });

  it('reverts exclusive-leased files via checkoutWorkspaceFiles', async () => {
    const task = await createTask({ title: 'Revert files task', context: 'ctx' });
    await updateTaskStatus(task.id, 'running');

    // Create a real file in the workspace and commit it so git has a baseline.
    const { writeFile } = await import('node:fs/promises');
    const { execFile } = await import('node:child_process');
    const git = (args: string[]) =>
      new Promise<void>((resolve, reject) => {
        execFile('git', args, { cwd: workspacePath }, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    const testFilePath = path.join(workspacePath, 'src', 'revert-test.ts');
    await mkdir(path.dirname(testFilePath), { recursive: true });
    await writeFile(testFilePath, 'original content\n');
    await git(['add', 'src/revert-test.ts']);
    await git(['commit', '-m', 'add revert-test', '--no-verify']);

    // Modify the file (simulate work in progress that should be reverted).
    await writeFile(testFilePath, 'modified content — should be reverted\n');

    // Acquire lease on the file.
    acquireLeases({ taskId: task.id, exclusiveFiles: ['src/revert-test.ts'], sharedFiles: [] });
    assert.equal(getLeasesByTask(task.id).length, 1);

    // Tear down.
    await teardownTask(task.id, 'revert_test');

    // Verify the file was reverted to the committed version.
    const { readFile } = await import('node:fs/promises');
    const reverted = await readFile(testFilePath, 'utf-8');
    assert.equal(reverted, 'original content\n');

    // Sanity-check final state.
    assert.deepEqual(getLeasesByTask(task.id), []);
    const finalStatus = await getBoardTaskStatus(task.id);
    assert.equal(finalStatus, 'queued');
  });

  it('idempotent: calling teardownTask twice does not throw', async () => {
    const task = await createTask({ title: 'Double teardown', context: 'ctx' });
    await updateTaskStatus(task.id, 'running');

    acquireLeases({ taskId: task.id, exclusiveFiles: ['src/double.ts'], sharedFiles: [] });
    assert.equal(getLeasesByTask(task.id).length, 1);

    await teardownTask(task.id, 'first');
    // Second teardown should be a no-op without throwing.
    await assert.doesNotReject(async () => {
      await teardownTask(task.id, 'second');
    });

    assert.deepEqual(getLeasesByTask(task.id), []);
    const finalStatus = await getBoardTaskStatus(task.id);
    assert.equal(finalStatus, 'queued');
  });

  it('re-queues the task with teardown.<reason> caller tag', async () => {
    const task = await createTask({ title: 'Caller tag task', context: 'ctx' });
    await updateTaskStatus(task.id, 'running');

    acquireLeases({ taskId: task.id, exclusiveFiles: ['src/tag.ts'], sharedFiles: [] });

    await teardownTask(task.id, 'deadlock_resolution');

    // Verify the tag appears in the board data.
    const board = await loadBoard();
    const reloaded = board.tasks.find(t => t.id === task.id);
    assert.ok(reloaded);
    assert.equal(reloaded!.status, 'queued');
  });

  it('successfully tears down a task with only shared leases', async () => {
    const task = await createTask({ title: 'Shared-only task', context: 'ctx' });
    await updateTaskStatus(task.id, 'running');

    acquireLeases({ taskId: task.id, exclusiveFiles: [], sharedFiles: ['docs/shared.md'] });
    assert.equal(getLeasesByTask(task.id).length, 1);

    await teardownTask(task.id, 'shared_only');

    assert.deepEqual(getLeasesByTask(task.id), []);
    const finalStatus = await getBoardTaskStatus(task.id);
    assert.equal(finalStatus, 'queued');
  });
});
