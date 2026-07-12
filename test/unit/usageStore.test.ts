import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { UsageEvent } from '../../src/types/index.js';
import {
  appendUsageEvent,
  computePeriodWindows,
  readUsageEvents,
  summarizeUsage,
  taskUsageBreakdown,
  taskUsageTotals,
} from '../../src/server/services/usageStore.js';
import { getWorkspacePath, setWorkspacePath } from '../../src/server/utils/paths.js';

function usageEvent(overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    id: 'event-1', timestamp: '2026-07-12T10:00:00.000Z', taskId: 't-1', step: 'execute',
    agentType: 'claude', source: 'transcript', sessionId: 'session-1', model: 'claude-sonnet-5',
    inputTokens: 1_000_000, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0,
    ...overrides,
  };
}

describe('usageStore', () => {
  let workspacePath: string;
  let savedWorkspacePath: string;

  before(async () => {
    savedWorkspacePath = getWorkspacePath();
    workspacePath = await mkdtemp(path.join(os.tmpdir(), 'formic-usage-store-'));
    setWorkspacePath(workspacePath);
  });

  after(async () => {
    setWorkspacePath(savedWorkspacePath);
    await rm(workspacePath, { recursive: true, force: true });
  });

  it('serializes appends and reads valid filtered events', async () => {
    await Promise.all([
      appendUsageEvent(usageEvent()),
      appendUsageEvent(usageEvent({ id: 'event-2', taskId: 't-2', sessionId: 'session-2' })),
    ]);
    assert.equal((await readUsageEvents()).length, 2);
    assert.deepEqual((await readUsageEvents({ taskId: 't-2' })).map((event) => event.id), ['event-2']);
    await assert.rejects(() => appendUsageEvent({ ...usageEvent(), inputTokens: -1 }));
  });

  it('estimates known pricing and returns null for unknown models', async () => {
    const summary = await summarizeUsage({ period: 'all', groupBy: 'model' });
    assert.equal(summary.groups['claude-sonnet-5'].estCostUsd, 6);
    await appendUsageEvent(usageEvent({ id: 'event-unknown', model: 'unknown/model' }));
    const unknown = await summarizeUsage({ period: 'all', groupBy: 'model' });
    assert.equal(unknown.groups['unknown/model'].estCostUsd, null);
  });

  it('groups usage by model, task, and session', async () => {
    const byModel = await summarizeUsage({ period: 'all', groupBy: 'model' });
    const byTask = await taskUsageTotals();
    const breakdown = await taskUsageBreakdown('t-1');
    assert.equal(byModel.groups['claude-sonnet-5'].requests, 2);
    assert.equal(byTask['t-2'].requests, 1);
    assert.equal(breakdown.total.requests, 2);
    assert.equal(breakdown.byModel['unknown/model'].estCostUsd, null);
  });

  it('computes local day and month ends across midnight and month rollover', () => {
    const beforeMidnight = new Date(2026, 0, 31, 23, 59, 59);
    const afterMidnight = new Date(2026, 1, 1, 0, 0, 1);
    const january = computePeriodWindows(beforeMidnight);
    const february = computePeriodWindows(afterMidnight);
    assert.equal(january.today.key, '2026-01-31');
    assert.equal(january.month.key, '2026-01');
    assert.equal(january.today.endsAt, new Date(2026, 1, 1).toISOString());
    assert.equal(january.month.endsAt, new Date(2026, 1, 1).toISOString());
    assert.equal(february.today.key, '2026-02-01');
    assert.equal(february.month.key, '2026-02');
  });

  it('includes local period starts and excludes events before local midnight and month rollover', async () => {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    await Promise.all([
      appendUsageEvent(usageEvent({ id: 'before-midnight', taskId: 'before-midnight', timestamp: new Date(todayStart.getTime() - 1).toISOString() })),
      appendUsageEvent(usageEvent({ id: 'after-midnight', taskId: 'after-midnight', timestamp: todayStart.toISOString() })),
      appendUsageEvent(usageEvent({ id: 'before-month', taskId: 'before-month', timestamp: new Date(monthStart.getTime() - 1).toISOString() })),
      appendUsageEvent(usageEvent({ id: 'after-month', taskId: 'after-month', timestamp: monthStart.toISOString() })),
    ]);
    const today = await summarizeUsage({ period: 'today', groupBy: 'task' });
    const month = await summarizeUsage({ period: 'month', groupBy: 'task' });
    assert.equal(today.groups['before-midnight'], undefined);
    assert.equal(today.groups['after-midnight'].requests, 1);
    assert.equal(month.groups['before-month'], undefined);
    assert.equal(month.groups['after-month'].requests, 1);
  });
});
