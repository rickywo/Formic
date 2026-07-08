/**
 * Unit tests for internalEvents.ts
 *
 * Tests the internal event emitter, task stopper registration,
 * and the requestTaskStop bridge function used by leaseManager
 * for preemption and deadlock resolution.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// We must dynamically import the module so we can reset the stopper between tests.
// The module caches its singleton, so we reload via a query parameter trick.
let internalEventsMod: typeof import('../../src/server/services/internalEvents.js');

async function loadModule(): Promise<typeof import('../../src/server/services/internalEvents.js')> {
  // Dynamic import with cache-busting query param to get a fresh module
  const url = `../../src/server/services/internalEvents.js?t=${Date.now()}`;
  return await import(url);
}

describe('internalEvents', () => {
  beforeEach(async () => {
    internalEventsMod = await loadModule();
  });

  afterEach(() => {
    // Clean up listeners
    internalEventsMod.internalEvents.removeAllListeners();
  });

  describe('Event constants', () => {
    it('should export all expected event name constants', () => {
      const events = new Set([
        internalEventsMod.TASK_COMPLETED,
        internalEventsMod.LEASE_RELEASED,
        internalEventsMod.TASK_CREATED,
        internalEventsMod.TASK_QUEUED,
        internalEventsMod.BEFORE_EXECUTE,
        internalEventsMod.AFTER_EXECUTE,
        internalEventsMod.TASK_FAILED,
        internalEventsMod.SKILL_LOADED,
        internalEventsMod.LEASE_ACQUIRED,
        internalEventsMod.BOARD_UPDATE,
        internalEventsMod.SERVER_STARTUP,
        internalEventsMod.SERVER_SHUTDOWN,
        internalEventsMod.BEFORE_SKILL_LOAD,
        internalEventsMod.STAGE_REGISTERED,
        internalEventsMod.STAGE_UNREGISTERED,
        internalEventsMod.TASK_UPDATED,
        internalEventsMod.TASK_STAGE_CHANGED,
        internalEventsMod.TASK_TYPE_REGISTERED,
      ]);

      assert.equal(events.size, 18, 'Should have 18 unique event name constants');
    });

    it('should have correct event name pattern (kebab-case)', () => {
      const eventNames = [
        internalEventsMod.TASK_COMPLETED,
        internalEventsMod.LEASE_RELEASED,
        internalEventsMod.LEASE_ACQUIRED,
        internalEventsMod.BEFORE_EXECUTE,
      ];

      for (const name of eventNames) {
        assert.match(name, /^[a-z]+-[a-z-]+$/);
      }
    });
  });

  describe('internalEvents event emitter', () => {
    it('should emit and receive events', () => {
      const events = internalEventsMod.internalEvents;
      let received = false;

      events.on('test-event', () => {
        received = true;
      });

      events.emit('test-event');
      assert.ok(received, 'Listener should be called when event is emitted');
    });

    it('should pass event data correctly', () => {
      const events = internalEventsMod.internalEvents;
      let captured: unknown = null;

      events.on('data-event', (data: unknown) => {
        captured = data;
      });

      const payload = { taskId: 't-42', leases: [] };
      events.emit('data-event', payload);
      assert.deepStrictEqual(captured, payload);
    });

    it('should support multiple listeners', () => {
      const events = internalEventsMod.internalEvents;
      let count = 0;

      events.on('multi', () => count++);
      events.on('multi', () => count++);
      events.emit('multi');

      assert.equal(count, 2);
    });
  });

  describe('registerTaskStopper', () => {
    it('should accept a task stopper function', () => {
      const stopper = async (_id: string): Promise<boolean> => true;
      assert.doesNotThrow(() => internalEventsMod.registerTaskStopper(stopper));
    });
  });

  describe('requestTaskStop (with no stopper registered)', () => {
    it('should return false when no stopper is registered', async () => {
      // Fresh module has no stopper registered
      const result = await internalEventsMod.requestTaskStop('t-nonexistent');
      assert.equal(result, false);
    });
  });

  describe('requestTaskStop (with stopper registered)', () => {
    it('should call the registered stopper with the task ID', async () => {
      let calledWith: string | null = null;

      internalEventsMod.registerTaskStopper(async (taskId: string): Promise<boolean> => {
        calledWith = taskId;
        return true;
      });

      const result = await internalEventsMod.requestTaskStop('t-to-stop');
      assert.equal(result, true);
      assert.equal(calledWith, 't-to-stop');
    });

    it('should return false when stopper returns false', async () => {
      internalEventsMod.registerTaskStopper(async (_taskId: string): Promise<boolean> => false);
      const result = await internalEventsMod.requestTaskStop('t-cannot-stop');
      assert.equal(result, false);
    });

    it('should return false when stopper throws', async () => {
      internalEventsMod.registerTaskStopper(async (_taskId: string): Promise<boolean> => {
        throw new Error('Stop failed');
      });

      const result = await internalEventsMod.requestTaskStop('t-throws');
      assert.equal(result, false);
    });

    it('should not crash when stopper throws a non-Error', async () => {
      internalEventsMod.registerTaskStopper(async (_taskId: string): Promise<boolean> => {
        throw 'not an Error'; // eslint-disable-line no-throw-literal
      });

      const result = await internalEventsMod.requestTaskStop('t-str-throw');
      assert.equal(result, false);
    });
  });

  describe('registerTaskStopper overwrite', () => {
    it('should allow overwriting the stopper', async () => {
      const calls: string[] = [];

      internalEventsMod.registerTaskStopper(async (id: string): Promise<boolean> => {
        calls.push(`first:${id}`);
        return true;
      });

      internalEventsMod.registerTaskStopper(async (id: string): Promise<boolean> => {
        calls.push(`second:${id}`);
        return true;
      });

      await internalEventsMod.requestTaskStop('t-overwrite');
      // Second registration should override the first
      assert.deepStrictEqual(calls, ['second:t-overwrite']);
    });
  });

  describe('LEASE_RELEASED event', () => {
    it('should emit with taskId and releasedFiles array', () => {
      const events = internalEventsMod.internalEvents;
      const captured: Array<{ taskId: string; files: string[] }> = [];

      events.on(internalEventsMod.LEASE_RELEASED, (taskId: string, releasedFiles: string[]) => {
        captured.push({ taskId, files: releasedFiles });
      });

      events.emit(internalEventsMod.LEASE_RELEASED, 't-release', ['file-a.ts', 'file-b.ts']);

      assert.equal(captured.length, 1);
      assert.equal(captured[0].taskId, 't-release');
      assert.deepStrictEqual(captured[0].files, ['file-a.ts', 'file-b.ts']);
    });
  });

  describe('LEASE_ACQUIRED event', () => {
    it('should emit with lease data', () => {
      const events = internalEventsMod.internalEvents;
      let captured: unknown = null;

      events.on(internalEventsMod.LEASE_ACQUIRED, (data: unknown) => {
        captured = data;
      });

      const leaseData = { taskId: 't-acq', leases: [{ filePath: 'x.ts' }] };
      events.emit(internalEventsMod.LEASE_ACQUIRED, leaseData);

      assert.deepStrictEqual(captured, leaseData);
    });
  });
});
