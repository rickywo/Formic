import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
    id: 'event-1', timestamp: '2026-07-12T10:00:00.000Z', scope: 'task', taskId: 't-1', step: 'execute',
    agentType: 'claude', source: 'transcript', sessionId: 'session-1', model: 'claude-sonnet-5',
    inputTokens: 1_000_000, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0,
    ...overrides,
  };
}

function legacyUsageEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'legacy-event-1', timestamp: '2026-07-12T10:00:00.000Z', agentId: 'brief', taskId: 't-legacy',
    provider: 'anthropic', model: 'unknown', inputTokens: 10, outputTokens: 20,
    cacheCreationTokens: 30, cacheReadTokens: 40, latencyMs: 100, partial: false, requestId: 'legacy-request-1',
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

  async function writeEvents(records: Array<Record<string, unknown> | string>): Promise<void> {
    const usageDir = path.join(workspacePath, '.formic', 'usage');
    await mkdir(usageDir, { recursive: true });
    await writeFile(
      path.join(usageDir, 'events.ndjson'),
      `${records.map((record) => typeof record === 'string' ? record : JSON.stringify(record)).join('\n')}\n`,
      'utf8',
    );
  }

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

  it('normalizes the observed proxy-era event shape without changing current collector events', async () => {
    const current = usageEvent({ id: 'collector-event', taskId: 't-current', sessionId: 'collector-session' });
    await writeEvents([legacyUsageEvent(), current]);

    const events = await readUsageEvents();
    assert.deepEqual(events, [
      {
        id: 'legacy-event-1', timestamp: '2026-07-12T10:00:00.000Z', scope: 'task', taskId: 't-legacy', step: 'brief',
        agentType: 'claude', source: 'transcript', sessionId: 'legacy-request-1', model: 'unknown',
        inputTokens: 10, outputTokens: 20, cacheCreationTokens: 30, cacheReadTokens: 40,
      },
      current,
    ]);
  });

  it('skips corrupt JSON and legacy records with missing attribution, unsupported providers, or invalid tokens', async () => {
    await writeEvents([
      '{not JSON',
      legacyUsageEvent({ id: 'missing-request', requestId: '' }),
      legacyUsageEvent({ id: 'unsupported-provider', provider: 'other-provider', requestId: 'request-2' }),
      legacyUsageEvent({ id: 'negative-tokens', inputTokens: -1, requestId: 'request-3' }),
      legacyUsageEvent({ id: 'non-finite-tokens', outputTokens: 'NaN', requestId: 'request-4' }),
      usageEvent({ id: 'invalid-current-agent', taskId: 't-invalid', agentType: 'invalid' as UsageEvent['agentType'] }),
    ]);

    assert.deepEqual(await readUsageEvents(), []);
  });

  it('aggregates valid current and legacy events in a mixed file while filtering corrupt neighbors', async () => {
    await writeEvents([
      usageEvent({ id: 'mixed-current', taskId: 't-mixed', sessionId: 'current-session', model: 'claude-sonnet-5', inputTokens: 100, outputTokens: 200 }),
      legacyUsageEvent({ id: 'mixed-legacy', taskId: 't-mixed', requestId: 'legacy-session', model: 'claude-sonnet-5', inputTokens: 300, outputTokens: 400, cacheCreationTokens: 5, cacheReadTokens: 6 }),
      '{malformed',
      legacyUsageEvent({ id: 'mixed-corrupt', taskId: 't-mixed', requestId: 'bad-session', cacheReadTokens: -1 }),
    ]);

    const summary = await summarizeUsage({ period: 'all', groupBy: 'model' });
    const totals = await taskUsageTotals();
    const breakdown = await taskUsageBreakdown('t-mixed');
    assert.equal(summary.groups['claude-sonnet-5'].requests, 2);
    assert.equal(summary.groups['claude-sonnet-5'].inputTokens, 400);
    assert.equal(summary.groups['claude-sonnet-5'].outputTokens, 600);
    assert.equal(summary.groups['claude-sonnet-5'].cacheCreationTokens, 5);
    assert.equal(summary.groups['claude-sonnet-5'].cacheReadTokens, 6);
    assert.equal(totals['t-mixed'].requests, 2);
    assert.equal(breakdown.total.inputTokens, 400);
    assert.equal(breakdown.bySession['current-session'].requests, 1);
    assert.equal(breakdown.bySession['legacy-session'].requests, 1);
  });

  it('includes assistant and messaging usage globally without contaminating task totals', async () => {
    const assistant = {
      id: 'assistant-event', timestamp: '2026-07-12T10:00:00.000Z', scope: 'assistant' as const, scopeId: 'assistant:session-1', step: 'assistant',
      agentType: 'opencode' as const, source: 'transcript' as const, sessionId: 'opencode-assistant-session', model: 'claude-sonnet-5',
      inputTokens: 50, outputTokens: 10, cacheCreationTokens: 0, cacheReadTokens: 0,
    };
    const messaging = { ...assistant, id: 'messaging-event', scope: 'messaging' as const, scopeId: 'telegram:123', sessionId: 'opencode-message-session' };
    await writeEvents([usageEvent({ id: 'task-event', taskId: 't-scoped', inputTokens: 100 }), assistant, messaging]);

    const global = await summarizeUsage({ period: 'all', groupBy: 'session' });
    const totals = await taskUsageTotals();
    const task = await taskUsageBreakdown('t-scoped');
    assert.equal(global.groups['assistant:session-1'].requests, 1);
    assert.equal(global.groups['telegram:123'].requests, 1);
    assert.deepEqual(Object.keys(totals), ['t-scoped']);
    assert.equal(task.total.inputTokens, 100);
  });

  it('reports non-sensitive line-specific diagnostics once across repeated reads', async () => {
    const sensitivePayload = 'do-not-log-this-transcript-content';
    await writeEvents([
      usageEvent({ id: 'warning-valid', taskId: 't-warning' }),
      usageEvent({ id: 'warning-valid-2', taskId: 't-warning' }),
      usageEvent({ id: 'warning-valid-3', taskId: 't-warning' }),
      usageEvent({ id: 'warning-valid-4', taskId: 't-warning' }),
      usageEvent({ id: 'warning-valid-5', taskId: 't-warning' }),
      usageEvent({ id: 'warning-valid-6', taskId: 't-warning' }),
      JSON.stringify({ ...legacyUsageEvent({ id: 'warning-invalid', requestId: '' }), transcript: sensitivePayload }),
    ]);
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (message: unknown): void => {
      warnings.push(String(message));
    };
    try {
      await readUsageEvents();
      await readUsageEvents();
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /line 7/);
    assert.match(warnings[0], /requestId/);
    assert.doesNotMatch(warnings[0], new RegExp(sensitivePayload));
  });
});
