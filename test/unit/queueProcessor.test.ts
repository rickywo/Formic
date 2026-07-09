/**
 * Unit tests for queueProcessor.ts
 *
 * Tests exported helper functions: getQueueProcessorConfig,
 * isQueueProcessorRunning, pauseQueueProcessor, removeInFlightTask,
 * and resetBackoff.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Dynamically reload the module for test isolation — module-level state
// (yieldBackoffMs, yieldUntil, fileBackoffTasks, inFlightTasks, pollTimeoutId)
// is reset on each import.
let qpMod: typeof import('../../src/server/services/queueProcessor.js');

async function reloadModule(): Promise<typeof import('../../src/server/services/queueProcessor.js')> {
  const url = `../../src/server/services/queueProcessor.js?t=${Date.now()}_${Math.random().toString(36).slice(2)}`;
  return await import(url);
}

describe('queueProcessor', () => {
  beforeEach(async () => {
    qpMod = await reloadModule();
  });

  // ==============================
  // getQueueProcessorConfig
  // ==============================
  describe('getQueueProcessorConfig', () => {
    it('should return an object with expected keys', () => {
      const config = qpMod.getQueueProcessorConfig();
      assert.ok(typeof config === 'object');
      assert.ok('enabled' in config);
      assert.ok('pollInterval' in config);
      assert.ok('maxConcurrent' in config);
      assert.ok('isRunning' in config);
    });

    it('should return boolean for enabled', () => {
      const config = qpMod.getQueueProcessorConfig();
      assert.equal(typeof config.enabled, 'boolean');
    });

    it('should return number for pollInterval', () => {
      const config = qpMod.getQueueProcessorConfig();
      assert.equal(typeof config.pollInterval, 'number');
      assert.ok(config.pollInterval > 0, `Expected pollInterval > 0, got ${config.pollInterval}`);
    });

    it('should return number for maxConcurrent', () => {
      const config = qpMod.getQueueProcessorConfig();
      assert.equal(typeof config.maxConcurrent, 'number');
      assert.ok(config.maxConcurrent > 0, `Expected maxConcurrent > 0, got ${config.maxConcurrent}`);
    });

    it('should return false for isRunning when not started', () => {
      const config = qpMod.getQueueProcessorConfig();
      assert.equal(config.isRunning, false);
    });
  });

  // ==============================
  // isQueueProcessorRunning
  // ==============================
  describe('isQueueProcessorRunning', () => {
    it('should return false before startQueueProcessor is called', () => {
      assert.equal(qpMod.isQueueProcessorRunning(), false);
    });

    it('should return a boolean', () => {
      const result = qpMod.isQueueProcessorRunning();
      assert.equal(typeof result, 'boolean');
    });
  });

  // ==============================
  // pauseQueueProcessor
  // ==============================
  describe('pauseQueueProcessor', () => {
    it('should not throw when called (even without prior start)', () => {
      assert.doesNotThrow(() => qpMod.pauseQueueProcessor());
    });

    it('should leave isRunning as false after pause', () => {
      qpMod.pauseQueueProcessor();
      assert.equal(qpMod.isQueueProcessorRunning(), false);
    });
  });

  // ==============================
  // removeInFlightTask
  // ==============================
  describe('removeInFlightTask', () => {
    it('should not throw when removing a non-existent task', () => {
      assert.doesNotThrow(() => qpMod.removeInFlightTask('t-nonexistent'));
    });

    it('should be callable with any task ID string', () => {
      assert.doesNotThrow(() => qpMod.removeInFlightTask('t-1'));
      assert.doesNotThrow(() => qpMod.removeInFlightTask(''));
      assert.doesNotThrow(() => qpMod.removeInFlightTask('some-random-id'));
    });

    it('should be idempotent (multiple calls with same ID)', () => {
      assert.doesNotThrow(() => {
        qpMod.removeInFlightTask('t-abc');
        qpMod.removeInFlightTask('t-abc');
        qpMod.removeInFlightTask('t-abc');
      });
    });
  });

  // ==============================
  // resetBackoff
  // ==============================
  describe('resetBackoff', () => {
    it('should not throw when resetting a task that was never in backoff', () => {
      assert.doesNotThrow(() => qpMod.resetBackoff('t-unknown'));
    });

    it('should be callable with various task ID formats', () => {
      assert.doesNotThrow(() => qpMod.resetBackoff('t-1'));
      assert.doesNotThrow(() => qpMod.resetBackoff('task-xyz'));
      assert.doesNotThrow(() => qpMod.resetBackoff(''));
    });

    it('should be idempotent (multiple calls with same ID)', () => {
      assert.doesNotThrow(() => {
        qpMod.resetBackoff('t-idempotent');
        qpMod.resetBackoff('t-idempotent');
      });
    });
  });

  // ==============================
  // wakeQueueProcessor
  // ==============================
  describe('wakeQueueProcessor', () => {
    it('should not throw when called', () => {
      // With QUEUE_ENABLED='false' (default in test env), it should no-op.
      // Even with QUEUE_ENABLED, it should not throw.
      assert.doesNotThrow(() => qpMod.wakeQueueProcessor());
    });
  });

  // ==============================
  // Integration: pause + config state
  // ==============================
  describe('state consistency', () => {
    it('should report not running after pause', () => {
      qpMod.pauseQueueProcessor();
      assert.equal(qpMod.isQueueProcessorRunning(), false);
      const config = qpMod.getQueueProcessorConfig();
      assert.equal(config.isRunning, false);
    });
  });

  // ==============================
  // start/stop lifecycle (safe: stop/noop operations)
  // ==============================
  describe('start/stop lifecycle', () => {
    it('stopQueueProcessor should be safe to call without prior start', () => {
      assert.doesNotThrow(() => qpMod.stopQueueProcessor());
    });

    it('pause followed by stop should not throw', () => {
      assert.doesNotThrow(() => {
        qpMod.pauseQueueProcessor();
        qpMod.stopQueueProcessor();
      });
    });

    it('isQueueProcessorRunning returns boolean throughout lifecycle', () => {
      assert.equal(typeof qpMod.isQueueProcessorRunning(), 'boolean');
      qpMod.pauseQueueProcessor();
      assert.equal(typeof qpMod.isQueueProcessorRunning(), 'boolean');
    });

    it('stopQueueProcessor should no-op when already stopped (idempotent)', async () => {
      const mod = await reloadModule();
      assert.equal(mod.isQueueProcessorRunning(), false);
      assert.doesNotThrow(() => mod.stopQueueProcessor());
      assert.equal(mod.isQueueProcessorRunning(), false);
      assert.doesNotThrow(() => mod.stopQueueProcessor());
      assert.equal(mod.isQueueProcessorRunning(), false);
    });

    it('multiple pause calls should not throw', () => {
      assert.doesNotThrow(() => {
        qpMod.pauseQueueProcessor();
        qpMod.pauseQueueProcessor();
        qpMod.pauseQueueProcessor();
      });
    });
  });
});
