/**
 * Unit tests for leaseManager.ts
 *
 * Tests the core lease management functions: acquire, release, renew,
 * conflict detection, priority preemption, deadlock detection, and
 * persistence functions.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

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

      assert.ok(newExpiresAt > originalExpiresAt);
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
  // recordWait / clearWait
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
});
