import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { promisify } from 'node:util';
import {
  acquireLeases,
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
