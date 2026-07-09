/**
 * Unit tests for prioritizer.ts
 *
 * Tests the queue re-prioritization functions directly in TypeScript
 * (complements the Python integration tests in test_prioritizer_unit.py).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { prioritizeQueue, getQueueAnalysis } from '../../src/server/services/prioritizer.js';
import type { Task } from '../../src/types/index.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  const now = new Date().toISOString();
  return {
    id: overrides.id,
    title: `Task ${overrides.id}`,
    status: 'queued' as const,
    priority: 'medium' as const,
    context: '',
    docsPath: '',
    agentLogs: [],
    pid: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    queuedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// ==============================
// prioritizeQueue
// ==============================

describe('prioritizeQueue', () => {
  it('should return empty for empty input', () => {
    assert.deepStrictEqual(prioritizeQueue([], []), []);
  });

  it('should return single task unchanged', () => {
    const tasks = [makeTask({ id: 't-1' })];
    const result = prioritizeQueue(tasks, tasks);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 't-1');
  });

  it('should sort high priority before low', () => {
    const low = makeTask({ id: 'low', priority: 'low' });
    const high = makeTask({ id: 'high', priority: 'high' });
    const result = prioritizeQueue([low, high], [low, high]);
    assert.equal(result[0].id, 'high');
  });

  it('should sort medium before low', () => {
    const low = makeTask({ id: 'low', priority: 'low' });
    const med = makeTask({ id: 'med', priority: 'medium' });
    const result = prioritizeQueue([low, med], [low, med]);
    assert.equal(result[0].id, 'med');
  });

  it('should put fix tasks first regardless of priority', () => {
    const high = makeTask({ id: 'high', priority: 'high' });
    const fix = makeTask({ id: 'fix', priority: 'low', fixForTaskId: 't-broken' });
    const result = prioritizeQueue([high, fix], [high, fix]);
    assert.equal(result[0].id, 'fix');
  });

  it('should rank unblocking task above same-priority task', () => {
    const blocker = makeTask({ id: 'blocker', priority: 'medium' });
    const blocked = makeTask({
      id: 'dep',
      priority: 'medium',
      status: 'blocked',
      dependsOnResolved: ['blocker'],
    });
    const regular = makeTask({ id: 'regular', priority: 'medium' });
    const result = prioritizeQueue([regular, blocker], [blocker, blocked, regular]);
    assert.equal(result[0].id, 'blocker');
  });

  it('should preserve all tasks in output', () => {
    const tasks = [makeTask({ id: 't1' }), makeTask({ id: 't2' }), makeTask({ id: 't3' })];
    const result = prioritizeQueue(tasks, tasks);
    assert.equal(result.length, 3);
    const ids = new Set(result.map(t => t.id));
    assert.deepStrictEqual(ids, new Set(['t1', 't2', 't3']));
  });

  it('should rank older queued task higher when all else equal', () => {
    const old = makeTask({ id: 'old', queuedAt: '2020-01-01T00:00:00.000Z' });
    const fresh = makeTask({ id: 'fresh', queuedAt: new Date().toISOString() });
    const result = prioritizeQueue([fresh, old], [fresh, old]);
    assert.equal(result[0].id, 'old');
  });

  it('should rank task with older firstBlockedAt higher (fairness tiebreaker)', () => {
    const now = new Date().toISOString();
    const oldBlocked = new Date(Date.now() - 30000).toISOString(); // 30s ago
    const blockedLonger = makeTask({ id: 'blocked-old', firstBlockedAt: oldBlocked, queuedAt: now });
    const notBlocked = makeTask({ id: 'not-blocked', queuedAt: now });
    const result = prioritizeQueue([notBlocked, blockedLonger], [notBlocked, blockedLonger]);
    assert.equal(result[0].id, 'blocked-old');
  });

  it('should not mutate the input array', () => {
    const low = makeTask({ id: 'low', priority: 'low' });
    const high = makeTask({ id: 'high', priority: 'high' });
    const original = [low, high];
    const copy = [...original];
    prioritizeQueue(original, original);
    assert.deepStrictEqual(original, copy);
  });

  it('should return same instance for single-task input', () => {
    const tasks = [makeTask({ id: 'only' })];
    const result = prioritizeQueue(tasks, tasks);
    assert.strictEqual(result, tasks); // Returns same reference when length <= 1
  });
});

// ==============================
// getQueueAnalysis
// ==============================

describe('getQueueAnalysis', () => {
  it('should return empty for empty input', () => {
    assert.deepStrictEqual(getQueueAnalysis([], []), []);
  });

  it('should return one entry per task', () => {
    const tasks = [makeTask({ id: 'a' }), makeTask({ id: 'b' }), makeTask({ id: 'c' })];
    const result = getQueueAnalysis(tasks, tasks);
    assert.equal(result.length, 3);
  });

  it('should include required fields in each entry', () => {
    const tasks = [makeTask({ id: 't1' })];
    const result = getQueueAnalysis(tasks, tasks);
    assert.ok('taskId' in result[0]);
    assert.ok('score' in result[0]);
    assert.ok('unblockingPotential' in result[0]);
    assert.ok('reasoning' in result[0]);
  });

  it('should assign higher score to high priority over medium', () => {
    const high = makeTask({ id: 'h', priority: 'high' });
    const med = makeTask({ id: 'm', priority: 'medium' });
    const result = getQueueAnalysis([high, med], [high, med]);
    const scores = new Map(result.map(e => [e.taskId, e.score]));
    assert.ok(scores.get('h')! > scores.get('m')!);
  });

  it('should assign highest score to fix task', () => {
    const fix = makeTask({ id: 'fix', priority: 'low', fixForTaskId: 't-other' });
    const high = makeTask({ id: 'high', priority: 'high' });
    const result = getQueueAnalysis([fix, high], [fix, high]);
    const scores = new Map(result.map(e => [e.taskId, e.score]));
    assert.ok(scores.get('fix')! > scores.get('high')!);
  });

  it('should count unblocking potential', () => {
    const blocker = makeTask({ id: 'blocker', priority: 'medium' });
    const blocked = makeTask({
      id: 'dep',
      priority: 'medium',
      status: 'blocked',
      dependsOnResolved: ['blocker'],
    });
    const regular = makeTask({ id: 'regular', priority: 'medium' });
    const result = getQueueAnalysis([blocker, regular], [blocker, blocked, regular]);
    const entries = new Map(result.map(e => [e.taskId, e]));
    assert.ok(entries.get('blocker')!.unblockingPotential > 0);
    assert.equal(entries.get('regular')!.unblockingPotential, 0);
  });

  it('should include score in reasoning string', () => {
    const tasks = [makeTask({ id: 't1' })];
    const result = getQueueAnalysis(tasks, tasks);
    assert.ok(result[0].reasoning.includes('score='));
  });

  it('should have numeric score', () => {
    const tasks = [makeTask({ id: 't1' })];
    const result = getQueueAnalysis(tasks, tasks);
    assert.equal(typeof result[0].score, 'number');
  });

  it('should have non-negative unblockingPotential', () => {
    const tasks = [makeTask({ id: 't1' })];
    const result = getQueueAnalysis(tasks, tasks);
    assert.ok(result[0].unblockingPotential >= 0);
  });

  it('should include fairness in reasoning when firstBlockedAt is set', () => {
    const blockedTask = makeTask({
      id: 'blocked',
      firstBlockedAt: new Date(Date.now() - 30000).toISOString(),
    });
    const regular = makeTask({ id: 'regular' });
    const result = getQueueAnalysis([blockedTask, regular], [blockedTask, regular]);
    const entries = new Map(result.map(e => [e.taskId, e]));
    assert.ok(entries.get('blocked')!.reasoning.includes('fairness'));
  });

  it('should not include fairness in reasoning when no firstBlockedAt', () => {
    const regular = makeTask({ id: 'regular' });
    const result = getQueueAnalysis([regular], [regular]);
    assert.ok(!result[0].reasoning.includes('fairness'));
  });

  it('should assign zero unblocking when no dependencies exist', () => {
    const tasks = [makeTask({ id: 'standalone', priority: 'high' })];
    const result = getQueueAnalysis(tasks, tasks);
    assert.equal(result[0].unblockingPotential, 0);
  });

  it('should count transitive unblocking (chain)', () => {
    const tA = makeTask({ id: 'A', priority: 'medium' });
    const tB = makeTask({
      id: 'B',
      priority: 'medium',
      status: 'blocked',
      dependsOnResolved: ['A'],
    });
    const tC = makeTask({
      id: 'C',
      priority: 'medium',
      status: 'blocked',
      dependsOnResolved: ['B'],
    });
    const result = getQueueAnalysis([tA], [tA, tB, tC]);
    assert.equal(result[0].unblockingPotential, 2);
  });
});
