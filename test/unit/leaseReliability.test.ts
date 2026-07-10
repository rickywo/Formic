import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { promisify } from 'node:util';
import {
  acquireLeases,
  getAllLeases,
  getExpiredLeases,
  getLeasesByTask,
  isFileLeased,
  persistLeases,
  releaseLeases,
  renewLeases,
} from '../../src/server/services/leaseManager.js';
import { setWorkspacePath } from '../../src/server/utils/paths.js';
import {
  checkoutWorkspaceFiles,
  getSafeWorkspaceRelativePath,
  hashWorkspaceFile,
} from '../../src/server/utils/safeGit.js';
import type { LeaseStoreSnapshot } from '../../src/types/index.js';

const execFileAsync = promisify(execFile);
const TEST_TASK_IDS = [
  'test-atomic-holder',
  'test-atomic-requester',
  'test-renew-active',
  'test-persist-old',
  'test-persist-final',
  'test-expiry-persist',
  'test-renewal-persist',
];

let workspacePath: string;

beforeEach(async () => {
  workspacePath = await mkdtemp(path.join(os.tmpdir(), 'formic-lease-test-'));
  await mkdir(path.join(workspacePath, '.formic'), { recursive: true });
  setWorkspacePath(workspacePath);
  for (const taskId of TEST_TASK_IDS) releaseLeases(taskId);
  await persistLeases();
});

afterEach(async () => {
  for (const taskId of TEST_TASK_IDS) releaseLeases(taskId);
  await persistLeases();
  await rm(workspacePath, { recursive: true, force: true });
});

describe('lease reliability regressions', () => {
  it('does not retain any exclusive lease when a shared-file conflict rejects the request', () => {
    const holder = acquireLeases({
      taskId: 'test-atomic-holder',
      exclusiveFiles: ['src/conflicted.ts'],
      sharedFiles: [],
    });
    assert.equal(holder.granted, true);

    const requester = acquireLeases({
      taskId: 'test-atomic-requester',
      exclusiveFiles: ['src/must-not-remain.ts'],
      sharedFiles: ['src/conflicted.ts'],
    });

    assert.equal(requester.granted, false);
    assert.deepEqual(requester.conflictingFiles, ['src/conflicted.ts']);
    assert.equal(isFileLeased('src/must-not-remain.ts'), false);
    assert.deepEqual(getLeasesByTask('test-atomic-requester'), []);
  });

  it('renews an expired lease for a task that the watchdog has confirmed is active', () => {
    const acquisition = acquireLeases({
      taskId: 'test-renew-active',
      exclusiveFiles: ['src/long-running.ts'],
      sharedFiles: [],
      leaseDurationMs: -1,
    });
    assert.equal(acquisition.granted, true);
    assert.equal(getExpiredLeases().some(lease => lease.taskId === 'test-renew-active'), true);

    assert.equal(renewLeases('test-renew-active', 60_000), true);
    const [renewed] = getLeasesByTask('test-renew-active');
    assert.ok(renewed);
    assert.ok(Date.parse(renewed.expiresAt) > Date.now());
    assert.equal(isFileLeased('src/long-running.ts'), true);
  });

  it('serializes atomic persistence so the final snapshot matches the final in-memory state', async () => {
    acquireLeases({
      taskId: 'test-persist-old',
      exclusiveFiles: ['src/old.ts'],
      sharedFiles: [],
    });
    releaseLeases('test-persist-old');
    acquireLeases({
      taskId: 'test-persist-final',
      exclusiveFiles: ['src/final.ts'],
      sharedFiles: [],
    });

    await persistLeases();

    const snapshotPath = path.join(workspacePath, '.formic', 'leases.json');
    const snapshot = JSON.parse(await readFile(snapshotPath, 'utf-8')) as LeaseStoreSnapshot;
    assert.deepEqual(snapshot.leases.map(entry => entry.lease.taskId), ['test-persist-final']);
    await assert.rejects(access(`${snapshotPath}.tmp`));
  });
});

describe('shell-safe Git operations', () => {
  beforeEach(async () => {
    await execFileAsync('git', ['init'], { cwd: workspacePath });
    await execFileAsync('git', ['config', 'user.email', 'tests@formic.local'], { cwd: workspacePath });
    await execFileAsync('git', ['config', 'user.name', 'Formic Tests'], { cwd: workspacePath });
    await writeFile(path.join(workspacePath, 'tracked.txt'), 'original\n', 'utf-8');
    await execFileAsync('git', ['add', 'tracked.txt'], { cwd: workspacePath });
  });

  it('hashes and checks out valid files using argument arrays', async () => {
    assert.match(await hashWorkspaceFile('tracked.txt', workspacePath), /^[a-f0-9]{40}$/);

    await writeFile(path.join(workspacePath, 'tracked.txt'), 'modified\n', 'utf-8');
    await checkoutWorkspaceFiles(['tracked.txt'], workspacePath);
    assert.equal(await readFile(path.join(workspacePath, 'tracked.txt'), 'utf-8'), 'original\n');
  });

  it('does not execute shell syntax embedded in a declared filename', async () => {
    const markerPath = path.join(workspacePath, 'PWNED');
    const maliciousPath = 'tracked.txt";touch PWNED;#';

    await assert.rejects(hashWorkspaceFile(maliciousPath, workspacePath));
    await assert.rejects(checkoutWorkspaceFiles([maliciousPath], workspacePath));
    await assert.rejects(access(markerPath));
  });

  it('rejects absolute and relative paths outside the workspace', () => {
    assert.equal(getSafeWorkspaceRelativePath('../outside.ts', workspacePath), null);
    assert.equal(getSafeWorkspaceRelativePath(path.join(os.tmpdir(), 'outside.ts'), workspacePath), null);
    assert.equal(getSafeWorkspaceRelativePath('src/inside.ts', workspacePath), path.join('src', 'inside.ts'));
  });
});

describe('lease persistence', () => {
  it('removes expired leases from leases.json after cleanExpiredLeases sweep', async () => {
    // Acquire a lease that is already expired (negative duration)
    const result = acquireLeases({
      taskId: 'test-expiry-persist',
      exclusiveFiles: ['src/expired.ts'],
      sharedFiles: [],
      leaseDurationMs: -1,
    });
    assert.equal(result.granted, true);
    assert.equal(getLeasesByTask('test-expiry-persist').length, 1);

    // Persist the initial state so the expired lease is on disk
    await persistLeases();

    // Trigger cleanup via getAllLeases (which calls cleanExpiredLeases internally)
    const allLeases = getAllLeases();
    const expiredStillPresent = allLeases.some(l => l.taskId === 'test-expiry-persist');
    assert.equal(expiredStillPresent, false, 'expired lease should be gone from memory');
    assert.equal(getLeasesByTask('test-expiry-persist').length, 0);

    // Serialize after the fire-and-forget persist to ensure the write completed
    await persistLeases();

    // Read leases.json and assert the expired lease is absent
    const snapshotPath = path.join(workspacePath, '.formic', 'leases.json');
    const snapshot = JSON.parse(await readFile(snapshotPath, 'utf-8')) as LeaseStoreSnapshot;
    const persisted = snapshot.leases.filter(e => e.lease.taskId === 'test-expiry-persist');
    assert.equal(persisted.length, 0, 'expired lease should not be in leases.json');
    assert.equal(snapshot.leases.length, 0, 'leases.json should be empty after cleanup');
  });

  it('persists renewed expiresAt to leases.json after renewLeases', async () => {
    // Acquire a normal lease
    const result = acquireLeases({
      taskId: 'test-renewal-persist',
      exclusiveFiles: ['src/renewed.ts'],
      sharedFiles: [],
      leaseDurationMs: 60_000,
    });
    assert.equal(result.granted, true);
    const [originalLease] = getLeasesByTask('test-renewal-persist');
    assert.ok(originalLease);
    // Capture the original expiresAt value before renewal mutates the object
    const originalExpiresAt = originalLease.expiresAt;

    // Renew with a specific duration so we can detect the change
    const renewalDurationMs = 120_000;
    const beforeRenewal = Date.now();
    const renewed = renewLeases('test-renewal-persist', renewalDurationMs);
    assert.equal(renewed, true);

    // Serialize after the fire-and-forget persist from renewLeases
    await persistLeases();

    // Read leases.json and assert the persisted expiresAt reflects the renewal
    const snapshotPath = path.join(workspacePath, '.formic', 'leases.json');
    const snapshot = JSON.parse(await readFile(snapshotPath, 'utf-8')) as LeaseStoreSnapshot;
    const persistedLease = snapshot.leases.find(e => e.lease.taskId === 'test-renewal-persist');
    assert.ok(persistedLease, 'renewed lease should be in leases.json');

    const persistedExpiry = Date.parse(persistedLease!.lease.expiresAt);
    // The persisted expiry should be approximately now + renewalDurationMs
    const expectedMin = beforeRenewal + renewalDurationMs - 5_000; // 5s tolerance
    assert.ok(
      persistedExpiry >= expectedMin,
      `persisted expiresAt (${persistedLease!.lease.expiresAt}) should reflect the renewed duration`
    );
    // Verify the persisted expiry differs from the original
    assert.notEqual(
      persistedLease!.lease.expiresAt,
      originalExpiresAt,
      'persisted expiresAt should differ from original pre-renewal value'
    );
  });
});
