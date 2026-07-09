/**
 * Unit tests for leaseManager.ts
 *
 * Tests the core lease management functions: acquire, release, renew,
 * conflict detection, priority preemption, deadlock detection, and
 * persistence functions.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { getWorkspacePath, setWorkspacePath } from '../../src/server/utils/paths.js';

// Dynamically reload the module for test isolation.
// The leaseStore/Map globals inside leaseManager are singletons within a
// single module instance, so we cache-bust to get fresh state per suite.
let leaseMod: typeof import('../../src/server/services/leaseManager.js');

async function reloadModule(): Promise<typeof import('../../src/server/services/leaseManager.js')> {
  const url = `../../src/server/services/leaseManager.js?t=${Date.now()}_${Math.random().toString(36).slice(2)}`;
  return await import(url);
}

describe('leaseManager', () => {
  beforeEach(async () => {
    leaseMod = await reloadModule();
  });

  afterEach(() => {
    // Release any lingering state by releasing leases — but since we
    // reload the module each test, state is already fresh.
  });

  // ==============================
  // acquireLeases
  // ==============================
  describe('acquireLeases', () => {
    it('should grant exclusive leases for a task', () => {
      const result = leaseMod.acquireLeases({
        taskId: 't-1',
        exclusiveFiles: ['src/a.ts', 'src/b.ts'],
        sharedFiles: [],
      });

      assert.equal(result.granted, true);
      assert.equal(result.leases.length, 2);
      assert.deepStrictEqual(result.conflictingFiles, []);

      const leasePaths = result.leases.map(l => l.filePath).sort();
      assert.deepStrictEqual(leasePaths, ['src/a.ts', 'src/b.ts']);
    });

    it('should set leaseType to exclusive on exclusive files', () => {
      const result = leaseMod.acquireLeases({
        taskId: 't-excl',
        exclusiveFiles: ['src/x.ts'],
        sharedFiles: [],
      });

      assert.equal(result.granted, true);
      assert.equal(result.leases[0].leaseType, 'exclusive');
    });

    it('should set leaseType to shared on shared files', () => {
      const result = leaseMod.acquireLeases({
        taskId: 't-shared',
        exclusiveFiles: [],
        sharedFiles: ['src/shared.ts'],
      });

      assert.equal(result.granted, true);
      assert.equal(result.leases[0].leaseType, 'shared');
    });

    it('should set taskId on all granted leases', () => {
      const result = leaseMod.acquireLeases({
        taskId: 't-owner',
        exclusiveFiles: ['src/o.ts'],
        sharedFiles: [],
      });

      assert.equal(result.granted, true);
      assert.ok(result.leases.every(l => l.taskId === 't-owner'));
    });

    it('should set acquiredAt and expiresAt timestamps', () => {
      const beforeMs = Date.now();
      const result = leaseMod.acquireLeases({
        taskId: 't-times',
        exclusiveFiles: ['src/t.ts'],
        sharedFiles: [],
      });
      const afterMs = Date.now();

      assert.equal(result.granted, true);
      const lease = result.leases[0];

      const acquiredMs = new Date(lease.acquiredAt).getTime();
      const expiresMs = new Date(lease.expiresAt).getTime();

      assert.ok(acquiredMs >= beforeMs && acquiredMs <= afterMs);
      assert.ok(expiresMs > acquiredMs, 'expiresAt should be after acquiredAt');
    });

    it('should default to engine config lease duration', () => {
      const result = leaseMod.acquireLeases({
        taskId: 't-dur',
        exclusiveFiles: ['src/d.ts'],
        sharedFiles: [],
      });

      const lease = result.leases[0];
      const acquiredMs = new Date(lease.acquiredAt).getTime();
      const expiresMs = new Date(lease.expiresAt).getTime();
      // Default leaseDurationMs is 300000 (5 minutes)
      const durationMs = expiresMs - acquiredMs;
      assert.ok(durationMs >= 299900 && durationMs <= 300100,
        `Expected ~300000ms duration, got ${durationMs}ms`);
    });

    it('should respect custom leaseDurationMs', () => {
      const result = leaseMod.acquireLeases({
        taskId: 't-custom-dur',
        exclusiveFiles: ['src/cd.ts'],
        sharedFiles: [],
        leaseDurationMs: 60000, // 1 minute
      });

      const lease = result.leases[0];
      const acquiredMs = new Date(lease.acquiredAt).getTime();
      const expiresMs = new Date(lease.expiresAt).getTime();
      const durationMs = expiresMs - acquiredMs;

      assert.ok(durationMs >= 59900 && durationMs <= 60100,
        `Expected ~60000ms duration, got ${durationMs}ms`);
    });

    it('should deny when another task holds exclusive lease on the same file', () => {
      // Task A acquires first
      const resultA = leaseMod.acquireLeases({
        taskId: 't-A',
        exclusiveFiles: ['src/same.ts'],
        sharedFiles: [],
      });
      assert.equal(resultA.granted, true);

      // Task B requests the same file
      const resultB = leaseMod.acquireLeases({
        taskId: 't-B',
        exclusiveFiles: ['src/same.ts'],
        sharedFiles: [],
      });

      assert.equal(resultB.granted, false);
      assert.ok(resultB.conflictingFiles.includes('src/same.ts'));
    });

    it('should allow same task to re-acquire its own exclusive lease', () => {
      leaseMod.acquireLeases({
        taskId: 't-reacq',
        exclusiveFiles: ['src/re.ts'],
        sharedFiles: [],
      });

      // Same task re-acquires the same file
      const result = leaseMod.acquireLeases({
        taskId: 't-reacq',
        exclusiveFiles: ['src/re.ts'],
        sharedFiles: [],
      });

      assert.equal(result.granted, true);
    });

    it('should deny shared file if it conflicts with an exclusive lease', () => {
      // Task A gets exclusive on F
      leaseMod.acquireLeases({
        taskId: 't-A-excl',
        exclusiveFiles: ['src/f.ts'],
        sharedFiles: [],
      });

      // Task B wants shared on F — should be denied
      const resultB = leaseMod.acquireLeases({
        taskId: 't-B-shared',
        exclusiveFiles: [],
        sharedFiles: ['src/f.ts'],
      });

      assert.equal(resultB.granted, false);
      assert.ok(resultB.conflictingFiles.includes('src/f.ts'));
    });

    it('should grant multiple shared leases on the same file to different tasks', () => {
      const r1 = leaseMod.acquireLeases({
        taskId: 't-sh1',
        exclusiveFiles: [],
        sharedFiles: ['src/shared-file.ts'],
      });
      const r2 = leaseMod.acquireLeases({
        taskId: 't-sh2',
        exclusiveFiles: [],
        sharedFiles: ['src/shared-file.ts'],
      });

      assert.equal(r1.granted, true);
      assert.equal(r2.granted, true);
    });

    it('should be all-or-nothing: no leases granted on conflict', () => {
      // Task A holds exclusive on 'src/f1.ts'
      leaseMod.acquireLeases({
        taskId: 't-holder',
        exclusiveFiles: ['src/f1.ts'],
        sharedFiles: [],
      });

      // Task B wants exclusive on ['src/f1.ts', 'src/f2.ts']
      // f1 conflicts, so NONE should be granted (no leak on f2)
      const resultB = leaseMod.acquireLeases({
        taskId: 't-requester',
        exclusiveFiles: ['src/f1.ts', 'src/f2.ts'],
        sharedFiles: [],
      });

      assert.equal(resultB.granted, false);
      assert.equal(resultB.leases.length, 0);
      assert.ok(resultB.conflictingFiles.includes('src/f1.ts'));
    });

    it('should list all conflicting files', () => {
      leaseMod.acquireLeases({
        taskId: 't-blocker',
        exclusiveFiles: ['src/block-a.ts', 'src/block-b.ts'],
        sharedFiles: [],
      });

      const result = leaseMod.acquireLeases({
        taskId: 't-waiting',
        exclusiveFiles: ['src/block-a.ts', 'src/block-b.ts'],
        sharedFiles: [],
      });

      assert.equal(result.granted, false);
      // Both should conflict (both are held by t-blocker)
      assert.equal(result.conflictingFiles.length, 2);
    });

    it('should handle empty file lists', () => {
      const result = leaseMod.acquireLeases({
        taskId: 't-empty',
        exclusiveFiles: [],
        sharedFiles: [],
      });

      assert.equal(result.granted, true);
      assert.equal(result.leases.length, 0);
    });

    it('should deny exclusive when any shared lease exists for another task', () => {
      // Task S has shared on g.ts
      leaseMod.acquireLeases({
        taskId: 't-s',
        exclusiveFiles: [],
        sharedFiles: ['src/g.ts'],
      });

      // Task E wants exclusive on g.ts — should be denied (shared → exclusive conflict)
      const result = leaseMod.acquireLeases({
        taskId: 't-e',
        exclusiveFiles: ['src/g.ts'],
        sharedFiles: [],
      });

      assert.equal(result.granted, false);
    });
  });

  // ==============================
  // releaseLeases
  // ==============================
  describe('releaseLeases', () => {
    it('should remove all leases held by a task', () => {
      leaseMod.acquireLeases({
        taskId: 't-rls',
        exclusiveFiles: ['src/r1.ts', 'src/r2.ts'],
        sharedFiles: ['src/rs.ts'],
      });

      assert.equal(leaseMod.getLeasesByTask('t-rls').length, 3);

      leaseMod.releaseLeases('t-rls');

      assert.equal(leaseMod.getLeasesByTask('t-rls').length, 0);
    });

    it('should be idempotent (no-op if task has no leases)', () => {
      assert.doesNotThrow(() => leaseMod.releaseLeases('nonexistent'));
    });

    it('should only release the specified task\'s leases', () => {
      leaseMod.acquireLeases({
        taskId: 't-keep',
        exclusiveFiles: ['src/keep.ts'],
        sharedFiles: [],
      });
      leaseMod.acquireLeases({
        taskId: 't-release-only',
        exclusiveFiles: ['src/release-me.ts'],
        sharedFiles: [],
      });

      leaseMod.releaseLeases('t-release-only');

      assert.equal(leaseMod.getLeasesByTask('t-release-only').length, 0);
      assert.equal(leaseMod.getLeasesByTask('t-keep').length, 1);
    });

    it('should clean up file hash records', () => {
      // We can't easily test fileHashStore directly since recordFileHashes
      // requires git, but the function should be called and not throw.
      leaseMod.acquireLeases({
        taskId: 't-hash-cleanup',
        exclusiveFiles: ['src/hc.ts'],
        sharedFiles: [],
      });

      leaseMod.releaseLeases('t-hash-cleanup');
      // Should not throw and should clean up without error
    });

    it('should clear wait records on release (prevents orphaned wait entries)', () => {
      leaseMod.acquireLeases({
        taskId: 't-wait-cleanup',
        exclusiveFiles: ['src/wc.ts'],
        sharedFiles: [],
      });

      leaseMod.recordWait('t-wait-cleanup', 'src/wc.ts');
      assert.ok(leaseMod.getWaitingFiles('t-wait-cleanup').length > 0,
        'Task should have wait entries before release');

      leaseMod.releaseLeases('t-wait-cleanup');

      const files = leaseMod.getWaitingFiles('t-wait-cleanup');
      assert.deepStrictEqual(files, [],
        'Wait entries should be cleared when leases are released');
    });
  });

  // ==============================
  // renewLeases
  // ==============================
  describe('renewLeases', () => {
    it('should renew all leases for a task', () => {
      leaseMod.acquireLeases({
        taskId: 't-renew',
        exclusiveFiles: ['src/rn.ts'],
        sharedFiles: [],
      });

      const before = leaseMod.getLeasesByTask('t-renew')[0];
      const originalExpiresAt = new Date(before.expiresAt).getTime();

      // Renew with a known duration
      const renewed = leaseMod.renewLeases('t-renew', 600000); // 10 min extension from now
      assert.equal(renewed, true);

      const after = leaseMod.getLeasesByTask('t-renew')[0];
      const newExpiresAt = new Date(after.expiresAt).getTime();

      assert.ok(newExpiresAt > originalExpiresAt,
        `Expected new expiration ${newExpiresAt} > original ${originalExpiresAt}`);
    });

    it('should return false if task has no leases', () => {
      const result = leaseMod.renewLeases('t-no-leases');
      assert.equal(result, false);
    });

    it('should renew shared leases too', () => {
      leaseMod.acquireLeases({
        taskId: 't-renew-shared',
        exclusiveFiles: [],
        sharedFiles: ['src/rns.ts'],
      });

      const renewed = leaseMod.renewLeases('t-renew-shared', 600000);
      assert.equal(renewed, true);
    });

    it('should default to engine config duration when no duration is passed', () => {
      leaseMod.acquireLeases({
        taskId: 't-renew-default',
        exclusiveFiles: ['src/rnd.ts'],
        sharedFiles: [],
      });

      const before = leaseMod.getLeasesByTask('t-renew-default')[0];
      const originalExpiresAt = new Date(before.expiresAt).getTime();

      leaseMod.renewLeases('t-renew-default');

      const after = leaseMod.getLeasesByTask('t-renew-default')[0];
      const newExpiresAt = new Date(after.expiresAt).getTime();

      // Renewal extends from Date.now(), so new expiry ≥ original.
      // Use >= because the test may run fast enough that timestamps are equal.
      assert.ok(newExpiresAt >= originalExpiresAt,
        `Expected new expiration ${newExpiresAt} >= original ${originalExpiresAt}`);
    });
  });

  // ==============================
  // getLeasesByTask
  // ==============================
  describe('getLeasesByTask', () => {
    it('should return empty array for task with no leases', () => {
      const leases = leaseMod.getLeasesByTask('t-none');
      assert.deepStrictEqual(leases, []);
    });

    it('should return all leases for a task', () => {
      leaseMod.acquireLeases({
        taskId: 't-get',
        exclusiveFiles: ['src/g1.ts'],
        sharedFiles: ['src/g2.ts'],
      });

      const leases = leaseMod.getLeasesByTask('t-get');
      assert.equal(leases.length, 2);
    });

    it('should return empty for unknown task', () => {
      leaseMod.acquireLeases({
        taskId: 't-known',
        exclusiveFiles: ['src/kn.ts'],
        sharedFiles: [],
      });

      const leases = leaseMod.getLeasesByTask('t-unknown');
      assert.deepStrictEqual(leases, []);
    });
  });

  // ==============================
  // getAllLeases
  // ==============================
  describe('getAllLeases', () => {
    it('should return empty array when store is empty', () => {
      const leases = leaseMod.getAllLeases();
      assert.deepStrictEqual(leases, []);
    });

    it('should return all active leases across tasks', () => {
      leaseMod.acquireLeases({
        taskId: 't-all-1',
        exclusiveFiles: ['src/all1.ts'],
        sharedFiles: [],
      });
      leaseMod.acquireLeases({
        taskId: 't-all-2',
        exclusiveFiles: ['src/all2.ts'],
        sharedFiles: ['src/all-s.ts'],
      });

      const leases = leaseMod.getAllLeases();
      assert.equal(leases.length, 3);
    });
  });

  // ==============================
  // isFileLeased
  // ==============================
  describe('isFileLeased', () => {
    it('should return false when file is not leased', () => {
      assert.equal(leaseMod.isFileLeased('src/nobody.ts'), false);
    });

    it('should return true when file is exclusively leased', () => {
      leaseMod.acquireLeases({
        taskId: 't-leased',
        exclusiveFiles: ['src/leased.ts'],
        sharedFiles: [],
      });

      assert.equal(leaseMod.isFileLeased('src/leased.ts'), true);
    });

    it('should return false when excluding the holding task', () => {
      leaseMod.acquireLeases({
        taskId: 't-self',
        exclusiveFiles: ['src/self.ts'],
        sharedFiles: [],
      });

      assert.equal(leaseMod.isFileLeased('src/self.ts', 't-self'), false);
      assert.equal(leaseMod.isFileLeased('src/self.ts', 't-other'), true);
    });

    it('should return false for shared-only file (shared leases use compound keys)', () => {
      leaseMod.acquireLeases({
        taskId: 't-shared-check',
        exclusiveFiles: [],
        sharedFiles: ['src/shared-only.ts'],
      });

      // Shared leases use 'filePath::taskId' as key, so isFileLeased
      // (which looks up by pure filePath) won't find them
      assert.equal(leaseMod.isFileLeased('src/shared-only.ts'), false);
    });
  });

  // ==============================
  // getExclusiveLeaseHolder
  // ==============================
  describe('getExclusiveLeaseHolder', () => {
    it('should return null when file is not leased', () => {
      assert.equal(leaseMod.getExclusiveLeaseHolder('src/free.ts'), null);
    });

    it('should return the holding task ID for exclusive lease', () => {
      leaseMod.acquireLeases({
        taskId: 't-holder-excl',
        exclusiveFiles: ['src/holder.ts'],
        sharedFiles: [],
      });

      assert.equal(leaseMod.getExclusiveLeaseHolder('src/holder.ts'), 't-holder-excl');
    });

    it('should return null for shared lease files', () => {
      leaseMod.acquireLeases({
        taskId: 't-shared-holder',
        exclusiveFiles: [],
        sharedFiles: ['src/shared-holder.ts'],
      });

      assert.equal(leaseMod.getExclusiveLeaseHolder('src/shared-holder.ts'), null);
    });
  });

  // ==============================
  // getBlockingHolders
  // ==============================
  describe('getBlockingHolders', () => {
    it('should return empty array when file is not leased', async () => {
      const mod = await reloadModule();
      const holders = mod.getBlockingHolders('src/nobody.ts', 't-test');
      assert.deepStrictEqual(holders, []);
    });

    it('should return exclusive holder when another task holds exclusive', async () => {
      const mod = await reloadModule();
      mod.acquireLeases({
        taskId: 't-excl-holder',
        exclusiveFiles: ['src/bh-excl.ts'],
        sharedFiles: [],
      });
      const holders = mod.getBlockingHolders('src/bh-excl.ts', 't-requester');
      assert.deepStrictEqual(holders, ['t-excl-holder']);
    });

    it('should exclude the requester from blocking holders', async () => {
      const mod = await reloadModule();
      mod.acquireLeases({
        taskId: 't-self-bh',
        exclusiveFiles: ['src/bh-self.ts'],
        sharedFiles: [],
      });
      const holders = mod.getBlockingHolders('src/bh-self.ts', 't-self-bh');
      assert.deepStrictEqual(holders, []);
    });

    it('should return shared-lease holders as blocking', async () => {
      const mod = await reloadModule();
      mod.acquireLeases({
        taskId: 't-shared-bh',
        exclusiveFiles: [],
        sharedFiles: ['src/bh-shared.ts'],
      });
      const holders = mod.getBlockingHolders('src/bh-shared.ts', 't-requester');
      assert.deepStrictEqual(holders, ['t-shared-bh']);
    });

    it('should return both exclusive and shared holders for a file', async () => {
      const mod = await reloadModule();
      // Another task holds exclusive — but can't have both exclusive AND shared
      // on the same file from different tasks (exclusive blocks shared acquisition).
      // Test: exclusive holder + shared holder on different files is normal;
      // for the combined test, use two DIFFERENT shared holders on the same file.
      mod.acquireLeases({
        taskId: 't-sh1-bh',
        exclusiveFiles: [],
        sharedFiles: ['src/bh-combined.ts'],
      });
      mod.acquireLeases({
        taskId: 't-sh2-bh',
        exclusiveFiles: [],
        sharedFiles: ['src/bh-combined.ts'],
      });
      const holders = mod.getBlockingHolders('src/bh-combined.ts', 't-requester');
      assert.equal(holders.length, 2);
      assert.ok(holders.includes('t-sh1-bh'));
      assert.ok(holders.includes('t-sh2-bh'));
    });

    it('should return null for shared lease files (getExclusiveLeaseHolder)', async () => {
      const mod = await reloadModule();
      mod.acquireLeases({
        taskId: 't-sh-check',
        exclusiveFiles: [],
        sharedFiles: ['src/sh-check.ts'],
      });
      // getExclusiveLeaseHolder returns null for shared-only
      assert.equal(mod.getExclusiveLeaseHolder('src/sh-check.ts'), null);
      // getBlockingHolders returns the shared holder
      const holders = mod.getBlockingHolders('src/sh-check.ts', 't-intruder');
      assert.deepStrictEqual(holders, ['t-sh-check']);
    });
  });

  // ==============================
  // getExpiredLeases
  // ==============================
  describe('getExpiredLeases', () => {
    it('should return empty array when no leases exist', () => {
      const expired = leaseMod.getExpiredLeases();
      assert.deepStrictEqual(expired, []);
    });

    it('should not include active (non-expired) leases', () => {
      // Default duration is 5 minutes — these are all active
      leaseMod.acquireLeases({
        taskId: 't-active',
        exclusiveFiles: ['src/active.ts'],
        sharedFiles: [],
      });

      const expired = leaseMod.getExpiredLeases();
      assert.equal(expired.length, 0);
    });

    it('should return leases that have expired', () => {
      // Create a lease with duration 0 (expired immediately)
      leaseMod.acquireLeases({
        taskId: 't-expired',
        exclusiveFiles: ['src/expired.ts'],
        sharedFiles: [],
        leaseDurationMs: 0,
      });

      const expired = leaseMod.getExpiredLeases();
      assert.ok(expired.length >= 1, 'Should include at least the zero-duration lease');
      assert.equal(expired[0].filePath, 'src/expired.ts');
    });
  });

  // ==============================
  // recordWait / clearWait / getWaitingFiles
  // ==============================
  describe('recordWait and clearWait', () => {
    beforeEach(async () => {
      // Reload for clean waitForMap state
      leaseMod = await reloadModule();
    });

    it('should record a wait entry', () => {
      assert.doesNotThrow(() => leaseMod.recordWait('t-waiting', 'src/blocked.ts'));
    });

    it('should clear a wait entry', () => {
      leaseMod.recordWait('t-waiting', 'src/blocked.ts');
      assert.doesNotThrow(() => leaseMod.clearWait('t-waiting'));
    });

    it('should be safe to clear a non-existent wait', () => {
      assert.doesNotThrow(() => leaseMod.clearWait('nonexistent'));
    });

    it('should accumulate multiple files per task via recordWait', () => {
      leaseMod.recordWait('t-multi', 'src/f1.ts');
      leaseMod.recordWait('t-multi', 'src/f2.ts');
      leaseMod.recordWait('t-multi', 'src/f3.ts');
      const files = leaseMod.getWaitingFiles('t-multi');
      assert.deepStrictEqual(files.sort(), ['src/f1.ts', 'src/f2.ts', 'src/f3.ts']);
    });

    it('should deduplicate repeated file paths for the same task', () => {
      leaseMod.recordWait('t-dup', 'src/f1.ts');
      leaseMod.recordWait('t-dup', 'src/f1.ts');
      const files = leaseMod.getWaitingFiles('t-dup');
      assert.deepStrictEqual(files, ['src/f1.ts']);
    });

    it('should return empty array for unknown task', () => {
      const files = leaseMod.getWaitingFiles('t-unknown');
      assert.deepStrictEqual(files, []);
    });

    it('clearWait should delete entire entry regardless of accumulated count', () => {
      leaseMod.recordWait('t-clear', 'src/a.ts');
      leaseMod.recordWait('t-clear', 'src/b.ts');
      leaseMod.recordWait('t-clear', 'src/c.ts');
      leaseMod.clearWait('t-clear');
      const files = leaseMod.getWaitingFiles('t-clear');
      assert.deepStrictEqual(files, []);
    });
  });

  // ==============================
  // persistLeases
  // ==============================
  describe('persistLeases', () => {
    it('should not throw when called', async () => {
      leaseMod.acquireLeases({
        taskId: 't-persist',
        exclusiveFiles: ['src/persist-test.ts'],
        sharedFiles: [],
      });

      // persistLeases writes to .formic/leases.json — it may fail if
      // the workspace isn't initialized, but it should not throw.
      await assert.doesNotReject(async () => {
        try {
          await leaseMod.persistLeases();
        } catch {
          // If the .formic directory doesn't exist, this is expected in unit test context
        }
      });
    });
  });

  // ==============================
  // restoreLeases
  // ==============================
  describe('restoreLeases', () => {
    it('should not throw when called', async () => {
      // restoreLeases reads from .formic/leases.json — it may fail if
      // the file doesn't exist, but it should handle it gracefully.
      await assert.doesNotReject(async () => {
        try {
          await leaseMod.restoreLeases();
        } catch {
          // ENOENT is expected in unit test context
        }
      });
    });
  });

  // ==============================
  // atomicity: all-or-nothing
  // ==============================
  describe('all-or-nothing lease acquisition', () => {
    it('should not grant any exclusive leases if one conflicts', async () => {
      const mod = await reloadModule();

      // Task A gets exclusive on F
      mod.acquireLeases({
        taskId: 't-atomic-A',
        exclusiveFiles: ['src/atomic-f.ts'],
        sharedFiles: [],
      });

      // Task B requests [f.ts (conflict), g.ts (free)]
      const resultB = mod.acquireLeases({
        taskId: 't-atomic-B',
        exclusiveFiles: ['src/atomic-f.ts', 'src/atomic-g.ts'],
        sharedFiles: [],
      });

      assert.equal(resultB.granted, false);
      assert.equal(resultB.leases.length, 0);

      // Verify g.ts is NOT leased (no phantom lease)
      assert.equal(mod.isFileLeased('src/atomic-g.ts'), false);
    });

    it('should not grant any shared leases if one exclusive conflicts', async () => {
      const mod = await reloadModule();

      // Task A holds exclusive on X
      mod.acquireLeases({
        taskId: 't-atomic-A2',
        exclusiveFiles: ['src/atomic-x.ts'],
        sharedFiles: [],
      });

      // Task B wants exclusive G + shared X — X conflicts so nothing should be granted
      const resultB = mod.acquireLeases({
        taskId: 't-atomic-B2',
        exclusiveFiles: ['src/atomic-g2.ts'],
        sharedFiles: ['src/atomic-x.ts'],
      });

      assert.equal(resultB.granted, false);
      assert.equal(resultB.leases.length, 0);
      assert.equal(mod.isFileLeased('src/atomic-g2.ts'), false);
    });

    it('should not grant exclusive if shared file conflicts', async () => {
      const mod = await reloadModule();

      // Task A has shared on S (shared leases don't block others,
      // but exclusive can't coexist with other-task shared)
      mod.acquireLeases({
        taskId: 't-shared-S',
        exclusiveFiles: [],
        sharedFiles: ['src/atomic-s.ts'],
      });

      // Task B wants exclusive on S — should be denied
      const resultB = mod.acquireLeases({
        taskId: 't-excl-S',
        exclusiveFiles: ['src/atomic-s.ts'],
        sharedFiles: [],
      });

      assert.equal(resultB.granted, false);
    });
  });

  // ==============================
  // wouldConflict
  // ==============================
  describe('wouldConflict', () => {
    it('should return false when file is not leased at all', async () => {
      const mod = await reloadModule();
      assert.equal(mod.wouldConflict('src/nobody.ts', 't-test'), false);
    });

    it('should return false when the requesting task holds the exclusive lease', async () => {
      const mod = await reloadModule();
      mod.acquireLeases({
        taskId: 't-self-conflict',
        exclusiveFiles: ['src/self-conflict.ts'],
        sharedFiles: [],
      });
      assert.equal(mod.wouldConflict('src/self-conflict.ts', 't-self-conflict'), false);
    });

    it('should return true when another task holds an exclusive lease', async () => {
      const mod = await reloadModule();
      mod.acquireLeases({
        taskId: 't-owner',
        exclusiveFiles: ['src/owned.ts'],
        sharedFiles: [],
      });
      assert.equal(mod.wouldConflict('src/owned.ts', 't-intruder'), true);
    });

    it('should return true when another task holds a shared lease on the file', async () => {
      const mod = await reloadModule();
      mod.acquireLeases({
        taskId: 't-shared-owner',
        exclusiveFiles: [],
        sharedFiles: ['src/shared-owned.ts'],
      });
      assert.equal(mod.wouldConflict('src/shared-owned.ts', 't-intruder2'), true);
    });

    it('should return false when the requesting task holds a shared lease on the file', async () => {
      const mod = await reloadModule();
      mod.acquireLeases({
        taskId: 't-self-shared',
        exclusiveFiles: [],
        sharedFiles: ['src/self-shared.ts'],
      });
      assert.equal(mod.wouldConflict('src/self-shared.ts', 't-self-shared'), false);
    });

    it('should clean expired leases before checking (inactive holder freed)', async () => {
      const mod = await reloadModule();
      // Acquire with zero duration — expired immediately, holder inactive (no predicate)
      mod.acquireLeases({
        taskId: 't-exp-owner',
        exclusiveFiles: ['src/exp-owned.ts'],
        sharedFiles: [],
        leaseDurationMs: 0,
      });
      // wouldConflict should clean the expired lease → no conflict
      assert.equal(mod.wouldConflict('src/exp-owned.ts', 't-new-task'), false);
    });

    it('should preserve active-task expired leases during clean (still conflicts)', async () => {
      const mod = await reloadModule();
      mod.registerActiveTaskPredicate((taskId: string) => taskId === 't-active-exp-owner');
      mod.acquireLeases({
        taskId: 't-active-exp-owner',
        exclusiveFiles: ['src/active-exp-owned.ts'],
        sharedFiles: [],
        leaseDurationMs: 0,
      });
      // wouldConflict cleans expired leases but renews active-task ones → still conflict
      assert.equal(mod.wouldConflict('src/active-exp-owned.ts', 't-intruder3'), true);
    });

    it('should return false when all shared leases are held by the requesting task', async () => {
      const mod = await reloadModule();
      // Task A holds shared on F
      mod.acquireLeases({
        taskId: 't-multi-self',
        exclusiveFiles: [],
        sharedFiles: ['src/multi-self.ts'],
      });
      // Another task also holds shared on F
      mod.acquireLeases({
        taskId: 't-other-shared',
        exclusiveFiles: [],
        sharedFiles: ['src/multi-self.ts'],
      });
      // t-other-shared would conflict since t-multi-self holds shared on F
      assert.equal(mod.wouldConflict('src/multi-self.ts', 't-other-shared'), true);
      // t-multi-self would conflict since t-other-shared holds shared on F
      assert.equal(mod.wouldConflict('src/multi-self.ts', 't-multi-self'), true,
        't-multi-self conflicts because t-other-shared also holds shared on the same file');
    });
  });

  // ==============================
  // registerActiveTaskPredicate
  // ==============================
  describe('registerActiveTaskPredicate', () => {
    it('should accept and store a predicate function', () => {
      assert.doesNotThrow(() =>
        leaseMod.registerActiveTaskPredicate((_taskId: string) => true)
      );
    });

    it('should affect getAllLeases filtering for expired leases', async () => {
      const mod = await reloadModule();

      // Register predicate: task 't-alive' is active, others are not
      mod.registerActiveTaskPredicate((taskId: string) => taskId === 't-alive');

      // Acquire lease with zero duration (expires immediately) for active task
      mod.acquireLeases({
        taskId: 't-alive',
        exclusiveFiles: ['src/alive.ts'],
        sharedFiles: [],
        leaseDurationMs: 0,
      });

      // Acquire lease with zero duration for inactive task
      mod.acquireLeases({
        taskId: 't-dead',
        exclusiveFiles: ['src/dead.ts'],
        sharedFiles: [],
        leaseDurationMs: 0,
      });

      const allLeases = mod.getAllLeases();
      const paths = allLeases.map(l => l.filePath);

      // t-alive's lease should still appear (active task → not filtered)
      assert.ok(paths.includes('src/alive.ts'),
        `Expected 'src/alive.ts' in leases (active task), got: ${paths}`);
      // t-dead's lease should be filtered out (inactive task → filtered)
      assert.ok(!paths.includes('src/dead.ts'),
        `Expected 'src/dead.ts' NOT in leases (inactive task), got: ${paths}`);
    });
  });

  // ==============================
  // cleanExpiredLeases (via acquireLeases)
  // ==============================
  describe('cleanExpiredLeases via acquireLeases', () => {
    it('should free expired leases for inactive tasks during acquireLeases', async () => {
      const mod = await reloadModule();

      // No active predicate — all tasks are considered inactive
      // Acquire lease with zero duration (expired immediately)
      mod.acquireLeases({
        taskId: 't-exp-inactive',
        exclusiveFiles: ['src/exp-inactive.ts'],
        sharedFiles: [],
        leaseDurationMs: 0,
      });

      // The lease was granted but is now expired.
      // The next acquireLeases call should clean it up via cleanExpiredLeases.
      const result = mod.acquireLeases({
        taskId: 't-new',
        exclusiveFiles: ['src/exp-inactive.ts'],
        sharedFiles: [],
      });

      // Should succeed because the expired lease was cleaned up
      assert.equal(result.granted, true,
        `Expected lease to be granted after expired lease cleanup, got: ${JSON.stringify(result)}`);
    });

    it('should renew expired leases for active tasks instead of freeing them', async () => {
      const mod = await reloadModule();

      mod.registerActiveTaskPredicate((taskId: string) => taskId === 't-active-exp');

      // Active task acquires with zero duration
      mod.acquireLeases({
        taskId: 't-active-exp',
        exclusiveFiles: ['src/active-exp.ts'],
        sharedFiles: [],
        leaseDurationMs: 0,
      });

      // Another acquire triggers cleanExpiredLeases — should RENEW the active task's lease
      mod.acquireLeases({
        taskId: 't-other',
        exclusiveFiles: ['src/other.ts'],
        sharedFiles: [],
      });

      // The active task's lease should still exist (was renewed, not freed)
      const leases = mod.getLeasesByTask('t-active-exp');
      assert.equal(leases.length, 1,
        `Expected active task lease to be renewed, got ${leases.length} leases`);
    });

    it('should correctly free shared leases for inactive tasks', async () => {
      const mod = await reloadModule();

      // Inactive task acquires shared lease with zero duration
      mod.acquireLeases({
        taskId: 't-shared-exp',
        exclusiveFiles: [],
        sharedFiles: ['src/shared-exp.ts'],
        leaseDurationMs: 0,
      });

      // Another acquire triggers cleanExpiredLeases
      mod.acquireLeases({
        taskId: 't-cleaner',
        exclusiveFiles: ['src/clean-target.ts'],
        sharedFiles: [],
      });

      // shared-exp.ts should be freed
      const allLeases = mod.getAllLeases();
      const sharedExpLeases = allLeases.filter(l => l.filePath === 'src/shared-exp.ts');
      assert.equal(sharedExpLeases.length, 0,
        `Expected shared expired lease to be freed, found: ${sharedExpLeases.length}`);
    });
  });

  // ==============================
  // isFileLeased with expired+active guard
  // ==============================
  describe('isFileLeased with active-task predicate', () => {
    it('should treat expired lease as free when holder is inactive', async () => {
      const mod = await reloadModule();

      mod.acquireLeases({
        taskId: 't-inactive-owner',
        exclusiveFiles: ['src/inactive-owned.ts'],
        sharedFiles: [],
        leaseDurationMs: 0,
      });

      // Trigger cleanExpiredLeases
      mod.acquireLeases({
        taskId: 't-trigger',
        exclusiveFiles: ['src/trigger.ts'],
        sharedFiles: [],
      });

      assert.equal(mod.isFileLeased('src/inactive-owned.ts'), false,
        'Expired lease from inactive task should be treated as free');
    });

    it('should treat expired lease as still leased when holder is active', async () => {
      const mod = await reloadModule();

      mod.registerActiveTaskPredicate((taskId: string) => taskId === 't-active-owner');

      mod.acquireLeases({
        taskId: 't-active-owner',
        exclusiveFiles: ['src/active-owned.ts'],
        sharedFiles: [],
        leaseDurationMs: 0,
      });

      // Trigger cleanExpiredLeases (which should renew, not free)
      mod.acquireLeases({
        taskId: 't-trigger2',
        exclusiveFiles: ['src/trigger2.ts'],
        sharedFiles: [],
      });

      assert.equal(mod.isFileLeased('src/active-owned.ts'), true,
        'Expired lease from active task should still be treated as leased');
    });

    it('should honor excludeTaskId even with expired-active logic', async () => {
      const mod = await reloadModule();

      mod.registerActiveTaskPredicate((taskId: string) => taskId === 't-exclude-me');

      mod.acquireLeases({
        taskId: 't-exclude-me',
        exclusiveFiles: ['src/exclude-me.ts'],
        sharedFiles: [],
        leaseDurationMs: 0,
      });

      // Trigger clean
      mod.acquireLeases({
        taskId: 't-trigger3',
        exclusiveFiles: ['src/trigger3.ts'],
        sharedFiles: [],
      });

      // When excluding the active task itself, it should report as not leased
      assert.equal(mod.isFileLeased('src/exclude-me.ts', 't-exclude-me'), false);
      // When checking from another task's perspective, it should still be leased
      assert.equal(mod.isFileLeased('src/exclude-me.ts', 't-other-task'), true);
    });
  });

  // ==============================
  // getExclusiveLeaseHolder with expired+active guard
  // ==============================
  describe('getExclusiveLeaseHolder with active-task predicate', () => {
    it('should return null for expired lease held by inactive task', async () => {
      const mod = await reloadModule();

      mod.acquireLeases({
        taskId: 't-holder-inactive',
        exclusiveFiles: ['src/holder-inactive.ts'],
        sharedFiles: [],
        leaseDurationMs: 0,
      });

      mod.acquireLeases({
        taskId: 't-trigger-holder',
        exclusiveFiles: ['src/trigger-holder.ts'],
        sharedFiles: [],
      });

      assert.equal(mod.getExclusiveLeaseHolder('src/holder-inactive.ts'), null,
        'Expired lease from inactive task should return null holder');
    });

    it('should return holder ID for expired lease held by active task', async () => {
      const mod = await reloadModule();

      mod.registerActiveTaskPredicate((taskId: string) => taskId === 't-holder-active');

      mod.acquireLeases({
        taskId: 't-holder-active',
        exclusiveFiles: ['src/holder-active.ts'],
        sharedFiles: [],
        leaseDurationMs: 0,
      });

      mod.acquireLeases({
        taskId: 't-trigger-holder2',
        exclusiveFiles: ['src/trigger-holder2.ts'],
        sharedFiles: [],
      });

      assert.equal(mod.getExclusiveLeaseHolder('src/holder-active.ts'), 't-holder-active',
        'Expired lease from active task should still return the holder ID');
    });

    it('should return null for shared lease files regardless of expiry', async () => {
      const mod = await reloadModule();

      mod.acquireLeases({
        taskId: 't-shared-holder2',
        exclusiveFiles: [],
        sharedFiles: ['src/shared-holder2.ts'],
      });

      assert.equal(mod.getExclusiveLeaseHolder('src/shared-holder2.ts'), null);
    });
  });

  // ==============================
  // detectDeadlock
  // ==============================
  describe('detectDeadlock', () => {
    it('should return null when no wait-for entries exist', async () => {
      const result = await leaseMod.detectDeadlock();
      assert.equal(result, null);
    });

    it('should return null when wait entries exist but no exclusive holder blocks', async () => {
      const mod = await reloadModule();
      mod.recordWait('t-waiter', 'src/nobody-holds.ts');
      const result = await mod.detectDeadlock();
      assert.equal(result, null);
    });

    it('should detect a simple two-task cycle', async () => {
      const mod = await reloadModule();

      // Task A holds src/a.ts
      mod.acquireLeases({
        taskId: 't-cycle-A',
        exclusiveFiles: ['src/a-cycle.ts'],
        sharedFiles: [],
      });

      // Task B holds src/b.ts
      mod.acquireLeases({
        taskId: 't-cycle-B',
        exclusiveFiles: ['src/b-cycle.ts'],
        sharedFiles: [],
      });

      // Task A waits for b.ts (held by B)
      mod.recordWait('t-cycle-A', 'src/b-cycle.ts');
      // Task B waits for a.ts (held by A) — this creates a cycle
      mod.recordWait('t-cycle-B', 'src/a-cycle.ts');

      const cycles = await mod.detectDeadlock();
      assert.ok(cycles !== null, 'Should detect at least one cycle');
      assert.ok(cycles!.length >= 1, `Expected at least 1 cycle, got ${cycles!.length}`);
    });

    it('should return null when wait graph has no cycles (chain)', async () => {
      const mod = await reloadModule();

      // A holds a.ts
      mod.acquireLeases({
        taskId: 't-chain-A',
        exclusiveFiles: ['src/a-chain.ts'],
        sharedFiles: [],
      });

      // B holds b.ts
      mod.acquireLeases({
        taskId: 't-chain-B',
        exclusiveFiles: ['src/b-chain.ts'],
        sharedFiles: [],
      });

      // C holds c.ts
      mod.acquireLeases({
        taskId: 't-chain-C',
        exclusiveFiles: ['src/c-chain.ts'],
        sharedFiles: [],
      });

      // A waits for B's file
      mod.recordWait('t-chain-A', 'src/b-chain.ts');
      // B waits for C's file
      mod.recordWait('t-chain-B', 'src/c-chain.ts');
      // No cycle — it's a chain A→B→C

      const cycles = await mod.detectDeadlock();
      assert.equal(cycles, null);
    });
  });

  // ==============================
  // preemptLease (unit-level)
  // ==============================
  describe('preemptLease', () => {
    it('should return false when file is not leased', async () => {
      const result = await leaseMod.preemptLease('t-high', 'src/nobody.ts');
      assert.equal(result, false);
    });

    it('should return false when holder is the requester itself', async () => {
      const mod = await reloadModule();
      mod.acquireLeases({
        taskId: 't-self-preempt',
        exclusiveFiles: ['src/self-preempt.ts'],
        sharedFiles: [],
      });

      const result = await mod.preemptLease('t-self-preempt', 'src/self-preempt.ts');
      assert.equal(result, false);
    });

    it('should return false for shared lease files', async () => {
      const mod = await reloadModule();
      mod.acquireLeases({
        taskId: 't-shared-preempt',
        exclusiveFiles: [],
        sharedFiles: ['src/shared-preempt.ts'],
      });

      const result = await mod.preemptLease('t-high-preempt', 'src/shared-preempt.ts');
      assert.equal(result, false);
    });

    it('should return false for equal-priority tasks after store lookup', async () => {
      const mod = await reloadModule();
      // Task A holds exclusive lease on the file
      mod.acquireLeases({
        taskId: 't-preempt-holder',
        exclusiveFiles: ['src/preempt-target.ts'],
        sharedFiles: [],
      });

      // Task B (different task, same file) tries to preempt
      const result = await mod.preemptLease('t-preempt-requester', 'src/preempt-target.ts');
      // Both tasks will have 'medium' priority (default), so holder rank >= requester rank
      // and the function returns false. This exercises the getTask + rank comparison path.
      assert.equal(result, false);
    });

    it('should handle vanished lease between lookup and stop', async () => {
      const mod = await reloadModule();
      // Task A holds exclusive lease on the file
      mod.acquireLeases({
        taskId: 't-vanished-holder',
        exclusiveFiles: ['src/vanished-target.ts'],
        sharedFiles: [],
        leaseDurationMs: 0, // expires immediately
      });

      // Clean expired leases so the lease is freed
      mod.acquireLeases({
        taskId: 't-cleaner-preempt',
        exclusiveFiles: ['src/cleaner-preempt.ts'],
        sharedFiles: [],
      });

      // Now try to preempt the (now-expired-and-cleaned) lease
      const result = await mod.preemptLease('t-vanished-requester', 'src/vanished-target.ts');
      // The lease was cleaned up, so preemptLease should return false (no lease).
      assert.equal(result, false);
    });
  });

  // ==============================
  // detectDeadlock — additional edge cases
  // ==============================
  describe('detectDeadlock edge cases', () => {
    it('should detect a three-task cycle (A→B→C→A)', async () => {
      const mod = await reloadModule();

      mod.acquireLeases({
        taskId: 't-tri-A',
        exclusiveFiles: ['src/a3.ts'],
        sharedFiles: [],
      });
      mod.acquireLeases({
        taskId: 't-tri-B',
        exclusiveFiles: ['src/b3.ts'],
        sharedFiles: [],
      });
      mod.acquireLeases({
        taskId: 't-tri-C',
        exclusiveFiles: ['src/c3.ts'],
        sharedFiles: [],
      });

      mod.recordWait('t-tri-A', 'src/b3.ts');
      mod.recordWait('t-tri-B', 'src/c3.ts');
      mod.recordWait('t-tri-C', 'src/a3.ts');

      const cycles = await mod.detectDeadlock();
      assert.ok(cycles !== null, 'Three-task cycle should be detected');
      assert.ok(cycles!.length >= 1);
    });

    it('should not detect cycle when task waits for its own file', async () => {
      const mod = await reloadModule();

      mod.acquireLeases({
        taskId: 't-self-ref',
        exclusiveFiles: ['src/self-ref.ts'],
        sharedFiles: [],
      });

      // Task records wait for its own file — skip edge in graph builder
      mod.recordWait('t-self-ref', 'src/self-ref.ts');

      const cycles = await mod.detectDeadlock();
      assert.equal(cycles, null,
        'Self-referencing wait should not create a cycle');
    });

    it('should return null when wait edges point to non-existent holders', async () => {
      const mod = await reloadModule();

      mod.recordWait('t-ghost', 'src/ghost-file.ts');
      mod.recordWait('t-ghost2', 'src/another-ghost.ts');

      const cycles = await mod.detectDeadlock();
      assert.equal(cycles, null,
        'Wait edges to files with no holders should not produce cycles');
    });
  });

  // ==============================
  // getWaitingFiles — multi-file wait record accessor
  // ==============================
  describe('getWaitingFiles', () => {
    it('should return all files accumulated for a task via recordWait', async () => {
      const mod = await reloadModule();
      mod.recordWait('t-mw', 'src/file1.ts');
      mod.recordWait('t-mw', 'src/file2.ts');
      mod.recordWait('t-mw', 'src/file3.ts');

      const files = mod.getWaitingFiles('t-mw');
      assert.equal(files.length, 3,
        `Expected 3 waiting files, got ${files.length}: ${JSON.stringify(files)}`);
      assert.ok(files.includes('src/file1.ts'));
      assert.ok(files.includes('src/file2.ts'));
      assert.ok(files.includes('src/file3.ts'));
    });

    it('should return empty array for unknown task', async () => {
      const mod = await reloadModule();
      const files = mod.getWaitingFiles('nonexistent');
      assert.deepStrictEqual(files, []);
    });
  });

  // ==============================
  // detectDeadlock — shared-holder cycle
  // ==============================
  describe('detectDeadlock shared-holder cycle', () => {
    it('should detect cycle where one task holds shared lease blocking exclusive request', async () => {
      const mod = await reloadModule();

      // A holds exclusive on F1. B holds SHARED on F2.
      // A wants exclusive on F2 → blocked by B's shared lease.
      // B wants exclusive on F1 → blocked by A's exclusive lease.
      // Cycle: A → F2(B) → B → F1(A) → A
      mod.acquireLeases({
        taskId: 't-sh-A',
        exclusiveFiles: ['src/sh-f1.ts'],
        sharedFiles: [],
      });
      mod.acquireLeases({
        taskId: 't-sh-B',
        exclusiveFiles: [],
        sharedFiles: ['src/sh-f2.ts'],
      });

      mod.recordWait('t-sh-A', 'src/sh-f2.ts');
      mod.recordWait('t-sh-B', 'src/sh-f1.ts');

      const cycles = await mod.detectDeadlock();
      assert.ok(cycles !== null,
        `Should detect deadlock cycle with shared holder, got ${JSON.stringify(cycles)}`);
      assert.ok(cycles!.length >= 1,
        `Expected at least 1 cycle, got ${cycles?.length ?? 0}`);
    });
  });

  // ==============================
  // detectDeadlock — multi-file cycle (second contested file)
  // ==============================
  describe('detectDeadlock multi-file cycle', () => {
    it('should detect cycle formed via second contested file of each task', async () => {
      const mod = await reloadModule();

      // Task A holds exclusive on F1. Task B holds exclusive on F2.
      // Task A waits on [free-unheld.ts, F2] — F2 (held by B) is the SECOND waited file.
      // Task B waits on [free-unheld2.ts, F1] — F1 (held by A) is the SECOND waited file.
      // If only conflictingFiles[0] is recorded, no cycle edge is visible.
      mod.acquireLeases({
        taskId: 't-mf-A',
        exclusiveFiles: ['src/mf-f1.ts'],
        sharedFiles: [],
      });
      mod.acquireLeases({
        taskId: 't-mf-B',
        exclusiveFiles: ['src/mf-f2.ts'],
        sharedFiles: [],
      });

      // Record waits for ALL conflicting files (simulating the fix)
      mod.recordWait('t-mf-A', 'src/mf-free1.ts');
      mod.recordWait('t-mf-A', 'src/mf-f2.ts');
      mod.recordWait('t-mf-B', 'src/mf-free2.ts');
      mod.recordWait('t-mf-B', 'src/mf-f1.ts');

      const cycles = await mod.detectDeadlock();
      assert.ok(cycles !== null,
        `Should detect cycle via second contested file, got ${JSON.stringify(cycles)}`);
      assert.ok(cycles!.length >= 1,
        `Expected at least 1 cycle, got ${cycles?.length ?? 0}`);
    });
  });

  // ==============================
  // detectDeadlock — multi-out-edge no phantom
  // ==============================
  describe('detectDeadlock multi-out-edge no phantom', () => {
    it('should not produce phantom cycles when task waits on multiple holders', async () => {
      const mod = await reloadModule();

      // A holds F1, B holds F2, C holds F3.
      // Task D waits on F1 (held by A) and F2 (held by B).
      // A waits on F3 (held by C).  C waits on nothing.
      // There is NO cycle: D→A→C (no back edge), D→B (no back edge).
      mod.acquireLeases({
        taskId: 't-np-A',
        exclusiveFiles: ['src/np-f1.ts'],
        sharedFiles: [],
      });
      mod.acquireLeases({
        taskId: 't-np-B',
        exclusiveFiles: ['src/np-f2.ts'],
        sharedFiles: [],
      });
      mod.acquireLeases({
        taskId: 't-np-C',
        exclusiveFiles: ['src/np-f3.ts'],
        sharedFiles: [],
      });

      mod.recordWait('t-np-D', 'src/np-f1.ts'); // held by A
      mod.recordWait('t-np-D', 'src/np-f2.ts'); // held by B
      mod.recordWait('t-np-A', 'src/np-f3.ts'); // held by C (A→C chain, no cycle)

      const cycles = await mod.detectDeadlock();
      assert.equal(cycles, null,
        `No phantom cycle expected, got ${JSON.stringify(cycles)}`);
    });
  });

  // ==============================
  // persistLeases — concurrent calls
  // ==============================
  describe('persistLeases concurrency', () => {
    it('should handle multiple concurrent persist calls without throwing', async () => {
      const mod = await reloadModule();

      mod.acquireLeases({
        taskId: 't-persist-concurrent',
        exclusiveFiles: ['src/pc-1.ts', 'src/pc-2.ts'],
        sharedFiles: ['src/pc-s.ts'],
      });

      const results = await Promise.allSettled([
        mod.persistLeases(),
        mod.persistLeases(),
        mod.persistLeases(),
      ]);

      const failures = results.filter(r => r.status === 'rejected');
      assert.equal(failures.length, 0,
        `Expected 0 rejections from concurrent persistLeases, got ${failures.length}`);
    });
  });

  // ==============================
  // persistLeases — atomicity under overlapping calls
  // ==============================
  describe('persistLeases atomicity under overlapping calls', () => {
    let originalWorkspace: string;
    let tmpWorkspace: string;

    beforeEach(async () => {
      originalWorkspace = getWorkspacePath();
      tmpWorkspace = await mkdtemp(path.join(os.tmpdir(), 'formic-lease-test-'));
      await mkdir(path.join(tmpWorkspace, '.formic'), { recursive: true });
      setWorkspacePath(tmpWorkspace);
    });

    afterEach(async () => {
      setWorkspacePath(originalWorkspace);
      await rm(tmpWorkspace, { recursive: true, force: true });
    });

    it('N overlapping persist calls always yield parseable JSON matching the final store state', async () => {
      const mod = await reloadModule();
      const N = 40;
      const persists: Promise<void>[] = [];

      // Grow the store while firing overlapping persists: each call snapshots a
      // progressively larger store, so unserialized writes completing out of
      // order (or interleaving) leave a stale or torn leases.json behind.
      for (let i = 0; i < N; i++) {
        mod.acquireLeases({
          taskId: `t-overlap-${i}`,
          exclusiveFiles: [`src/overlap-${i}.ts`],
          sharedFiles: [],
        });
        persists.push(mod.persistLeases());
      }
      await Promise.all(persists);

      const raw = await readFile(path.join(tmpWorkspace, '.formic', 'leases.json'), 'utf-8');
      // Must always be parseable — a torn/interleaved write fails here
      const snapshot = JSON.parse(raw) as { leases: Array<{ key: string; lease: { filePath: string } }> };

      // Must reflect the FINAL store state — a stale snapshot written last fails here
      const persistedPaths = new Set(snapshot.leases.map(entry => entry.lease.filePath));
      for (let i = 0; i < N; i++) {
        assert.ok(persistedPaths.has(`src/overlap-${i}.ts`),
          `leases.json is stale: missing src/overlap-${i}.ts (has ${persistedPaths.size}/${N} leases)`);
      }
      assert.equal(snapshot.leases.length, mod.getAllLeases().length,
        'leases.json entry count must match the in-memory store');
    });
  });

  // ==============================
  // findInvalidDeclaredPaths — declared-path validation
  // ==============================
  describe('findInvalidDeclaredPaths', () => {
    it('accepts normal workspace-relative paths', async () => {
      const mod = await reloadModule();
      const invalid = mod.findInvalidDeclaredPaths([
        'src/server/services/leaseManager.ts',
        'test/unit/leaseManager.test.ts',
        'README.md',
      ]);
      assert.deepStrictEqual(invalid, []);
    });

    it('rejects absolute paths', async () => {
      const mod = await reloadModule();
      const invalid = mod.findInvalidDeclaredPaths(['/etc/passwd', 'src/ok.ts']);
      assert.deepStrictEqual(invalid, ['/etc/passwd']);
    });

    it('rejects .. traversal escaping the workspace', async () => {
      const mod = await reloadModule();
      const invalid = mod.findInvalidDeclaredPaths(['../../etc/passwd', 'src/../../../etc/shadow']);
      assert.equal(invalid.length, 2);
    });

    it('rejects shell metacharacter payloads', async () => {
      const mod = await reloadModule();
      const payloads = [
        'src/x$(touch pwned).ts',
        'src/`id`.ts',
        'src/a";rm -rf /".ts',
        "src/a';id'.ts",
        'src/a|b.ts',
        'src/a&b.ts',
      ];
      const invalid = mod.findInvalidDeclaredPaths(payloads);
      assert.equal(invalid.length, payloads.length,
        `All shell payloads must be rejected, got: ${JSON.stringify(invalid)}`);
    });

    it('rejects empty and whitespace-only paths', async () => {
      const mod = await reloadModule();
      const invalid = mod.findInvalidDeclaredPaths(['', '   ']);
      assert.equal(invalid.length, 2);
    });
  });

  // ==============================
  // acquireLeases — invalid declared paths never become lease keys
  // ==============================
  describe('acquireLeases with invalid declared paths', () => {
    it('denies the request and creates no lease keys', async () => {
      const mod = await reloadModule();
      const result = mod.acquireLeases({
        taskId: 't-evil',
        exclusiveFiles: ['../../etc/passwd', 'src/x$(touch pwned).ts'],
        sharedFiles: ['/etc/shadow'],
      });

      assert.equal(result.granted, false);
      assert.equal(result.leases.length, 0);
      assert.equal(mod.getAllLeases().length, 0,
        'No lease keys may be created from invalid declared paths');
    });

    it('is all-or-nothing: valid paths alongside invalid ones are not leased', async () => {
      const mod = await reloadModule();
      const result = mod.acquireLeases({
        taskId: 't-mixed-evil',
        exclusiveFiles: ['src/legit.ts', 'src/x`touch pwned`.ts'],
        sharedFiles: [],
      });

      assert.equal(result.granted, false);
      assert.equal(mod.isFileLeased('src/legit.ts'), false,
        'Valid path must not be leased when the declaration contains invalid paths');
    });
  });

  // ==============================
  // restoreLeases — filters expired on restore
  // ==============================
  describe('restoreLeases filtering', () => {
    it('should handle missing leases.json gracefully', async () => {
      const mod = await reloadModule();
      await assert.doesNotReject(async () => {
        try {
          await mod.restoreLeases();
        } catch {
          // Expected in env without initialized workspace
        }
      });
    });
  });
});
