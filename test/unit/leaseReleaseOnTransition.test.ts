import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { acquireLeases, getAllLeases, getLeasesByTask, getWaitForEntries, persistLeases, recordWait, releaseLeases } from '../../src/server/services/leaseManager.js';
import { setWorkspacePath } from '../../src/server/utils/paths.js';
import { createTask, updateTask, updateTaskStatus } from '../../src/server/services/store.js';
import type { LeaseStoreSnapshot } from '../../src/types/index.js';

let workspacePath: string;

beforeEach(async () => {
  workspacePath = await mkdtemp(path.join(os.tmpdir(), 'formic-lease-release-test-'));
  await mkdir(path.join(workspacePath, '.formic'), { recursive: true });
  setWorkspacePath(workspacePath);
});

afterEach(async () => {
  // The lease store is an in-memory module-level singleton shared across tests in this
  // process; clear out anything left behind (e.g. by the intentional active->active
  // non-release test) so it cannot leak into a later test's assertions.
  for (const lease of getAllLeases()) {
    releaseLeases(lease.taskId);
  }
  await persistLeases();
  await rm(workspacePath, { recursive: true, force: true });
});

describe('lease release on status transition', () => {
  it('releases leases and clears wait state when updateTask() moves a task out of an active status', async () => {
    const task = await createTask({ title: 'Running task', context: 'ctx' });
    await updateTaskStatus(task.id, 'running');

    const grant = acquireLeases({ taskId: task.id, exclusiveFiles: ['src/a.ts'], sharedFiles: [] });
    assert.equal(grant.granted, true);
    recordWait(task.id, ['src/waiting-on.ts']);
    assert.equal(getLeasesByTask(task.id).length, 1);

    const updated = await updateTask(task.id, { status: 'review' });
    assert.ok(updated);
    assert.equal(updated!.status, 'review');
    assert.deepEqual(getLeasesByTask(task.id), []);
    assert.equal(getWaitForEntries().some(entry => entry.taskId === task.id), false);

    await persistLeases();
    const snapshotPath = path.join(workspacePath, '.formic', 'leases.json');
    const snapshot = JSON.parse(await readFile(snapshotPath, 'utf-8')) as LeaseStoreSnapshot;
    assert.equal(snapshot.leases.some(entry => entry.lease.taskId === task.id), false);
  });

  it('releases leases and clears wait state when updateTaskStatus() moves a task out of an active status', async () => {
    const task = await createTask({ title: 'Running task 2', context: 'ctx' });
    await updateTaskStatus(task.id, 'running');

    acquireLeases({ taskId: task.id, exclusiveFiles: ['src/b.ts'], sharedFiles: [] });
    recordWait(task.id, ['src/waiting-on-2.ts']);

    const updated = await updateTaskStatus(task.id, 'queued');
    assert.ok(updated);
    assert.equal(updated!.status, 'queued');
    assert.deepEqual(getLeasesByTask(task.id), []);
    assert.equal(getWaitForEntries().some(entry => entry.taskId === task.id), false);
  });

  it('does NOT release leases on an active-to-active transition (declaring -> running)', async () => {
    const task = await createTask({ title: 'Declaring task', context: 'ctx' });
    await updateTaskStatus(task.id, 'declaring');

    acquireLeases({ taskId: task.id, exclusiveFiles: ['src/c.ts'], sharedFiles: [] });
    assert.equal(getLeasesByTask(task.id).length, 1);

    const updated = await updateTaskStatus(task.id, 'running');
    assert.ok(updated);
    assert.equal(updated!.status, 'running');
    assert.equal(getLeasesByTask(task.id).length, 1);
  });

  it('is safe to release the same task twice (store hook + workflow finally block)', async () => {
    const task = await createTask({ title: 'Double release task', context: 'ctx' });
    await updateTaskStatus(task.id, 'running');

    acquireLeases({ taskId: task.id, exclusiveFiles: ['src/d.ts'], sharedFiles: [] });

    // First release happens via the store hook.
    await updateTask(task.id, { status: 'review' });
    assert.deepEqual(getLeasesByTask(task.id), []);

    // Second release simulates a workflow.ts finally block firing after the store hook already ran.
    assert.doesNotThrow(() => releaseLeases(task.id));
    assert.deepEqual(getLeasesByTask(task.id), []);

    await persistLeases();
    const snapshotPath = path.join(workspacePath, '.formic', 'leases.json');
    const snapshot = JSON.parse(await readFile(snapshotPath, 'utf-8')) as LeaseStoreSnapshot;
    assert.ok(Array.isArray(snapshot.leases));
    assert.equal(snapshot.leases.some(entry => entry.lease.taskId === task.id), false);
  });
});
