import { expect, test } from '@playwright/test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { OpenCodeUsageStreamCollector, openCodeRecordToUsageEvent } from '../src/server/services/opencodeJsonUsage.js';
import type { UsageEvent } from '../src/types/index.js';

test.use({ serviceWorkers: 'block' });

const usageDir = path.join(process.cwd(), '.formic', 'usage');
const eventsPath = path.join(usageDir, 'events.ndjson');
const pricingPath = path.join(usageDir, 'pricing.json');
let originalEvents: string | undefined;
let originalPricing: string | undefined;

async function readOptionalFile(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (code === 'ENOENT') return undefined;
    throw error;
  }
}

async function restoreFile(filePath: string, contents: string | undefined): Promise<void> {
  if (contents === undefined) {
    await rm(filePath, { force: true });
    return;
  }
  await writeFile(filePath, contents, 'utf8');
}

function openCodeLine(options: {
  sessionId: string;
  messageId: string;
  partId: string;
  providerId: string;
  modelId: string;
  input: number;
  output: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
}): string {
  return JSON.stringify({
    type: 'step_finish',
    timestamp: Date.now(),
    sessionID: options.sessionId,
    part: {
      id: options.partId,
      messageID: options.messageId,
      providerID: options.providerId,
      modelID: options.modelId,
      // `total` is deliberately present because it is emitted by OpenCode,
      // but the collector must not count this overlapping value.
      tokens: { total: 999_999, input: options.input, output: options.output, reasoning: options.reasoning ?? 0, cache: { read: options.cacheRead ?? 0, write: options.cacheWrite ?? 0 } },
    },
  });
}

function directOpenCodeEvents(): UsageEvent[] {
  const collector = new OpenCodeUsageStreamCollector();
  const execute = openCodeLine({ sessionId: 'oc-session-execute', messageId: 'oc-message-1', partId: 'oc-part-1', providerId: 'openai', modelId: 'gpt-5', input: 100_000, output: 20_000, reasoning: 5_000, cacheRead: 65_000, cacheWrite: 10_000 });
  const reflection = openCodeLine({ sessionId: 'oc-session-reflection', messageId: 'oc-message-2', partId: 'oc-part-2', providerId: 'unknown-provider', modelId: 'unpriced-model', input: 40_000, output: 10_000, cacheRead: 10_000 });
  const messaging = openCodeLine({ sessionId: 'oc-session-message', messageId: 'oc-message-3', partId: 'oc-part-3', providerId: 'anthropic', modelId: 'claude-test', input: 500, output: 100 });

  // The first record crosses a stdout chunk boundary, and the retry plus the
  // repeated part ID model the duplicate observations seen at process exit.
  const taskRecords = [
    ...collector.push(execute.slice(0, 73)),
    ...collector.push(`${execute.slice(73)}\n${reflection}\n${execute}\n`),
  ];
  const events = [
    ...taskRecords.map(record => openCodeRecordToUsageEvent(record, { scope: 'task' as const, taskId: 't-opencode', step: record.sessionId === 'oc-session-execute' ? 'execute' : 'reflection' })),
    // Non-task usage is deliberately retained in global model/session reports
    // while task endpoints and badges must exclude it.
    ...collector.push(messaging).concat(collector.flush()).map(record => openCodeRecordToUsageEvent(record, { scope: 'messaging' as const, scopeId: 'telegram:usage-test', step: 'assistant' })),
  ];
  return [...new Map(events.map(event => [event.id, event])).values()];
}

test.describe('token usage dashboard', () => {
  test.beforeAll(async () => {
    await mkdir(usageDir, { recursive: true });
    originalEvents = await readOptionalFile(eventsPath);
    originalPricing = await readOptionalFile(pricingPath);
    const timestamp = new Date().toISOString();
    const events = [
      { id: 'usage-session-a:1', timestamp, taskId: 't-usage', step: 'execute', agentType: 'claude', source: 'transcript', sessionId: 'usage-session-a', model: 'usage-test-model', inputTokens: 8000, outputTokens: 1000, cacheCreationTokens: 500, cacheReadTokens: 500 },
      { id: 'usage-session-b:2', timestamp, taskId: 't-usage', step: 'execute', agentType: 'claude', source: 'transcript', sessionId: 'usage-session-b', model: 'usage-test-model', inputTokens: 2000, outputTokens: 1000, cacheCreationTokens: 0, cacheReadTokens: 0 },
    ];
    await writeFile(eventsPath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');
    await writeFile(pricingPath, JSON.stringify({ 'usage-test-model': { inputPerMTok: 2, outputPerMTok: 10, cacheWritePerMTok: 0, cacheReadPerMTok: 0 } }), 'utf8');
  });

  test.afterAll(async () => {
    await restoreFile(eventsPath, originalEvents);
    await restoreFile(pricingPath, originalPricing);
  });

  test('renders task badges, grouped summaries, estimated costs, and cache-hit percentages', async ({ page }) => {
    await page.route('**/api/board', async (route) => route.fulfill({ json: {
      meta: {}, bootstrapRequired: false,
      tasks: [{ id: 't-usage', title: 'Seeded usage task', context: 'Task with transcript usage', priority: 'medium', status: 'todo', type: 'standard' }],
    } }));

    await page.goto('/');
    await expect(page.locator('.task-usage-badge')).toHaveText('⚡ 13.0k · $0.04');
    await expect(page.locator('.task-usage-badge')).toHaveAttribute('title', /Cache hit: 5%/);

    await page.locator('#usage-btn').click();
    await expect(page.locator('#usage-panel')).toHaveClass(/open/);
    await expect(page.locator('#usage-summary-content')).toContainText('usage-test-model');
    await expect(page.locator('#usage-summary-content')).toContainText('$0.04');
    await expect(page.locator('#usage-summary-content')).toContainText('5%');
    await expect(page.locator('.usage-cost-disclaimer')).toContainText('estimated');

    await page.getByRole('button', { name: 'Task', exact: true }).click();
    await expect(page.locator('#usage-summary-content')).toContainText('t-usage');
    await page.getByRole('button', { name: 'Session', exact: true }).click();
    await expect(page.locator('#usage-summary-content')).toContainText('usage-session-a');
    await page.getByRole('button', { name: 'Today', exact: true }).click();
    await expect(page.locator('#usage-summary-content')).toContainText('usage-session-b');
  });

  test('ingests realistic chunked OpenCode JSONL into all reporting APIs and renders mixed usage', async ({ page, request }) => {
    const events = directOpenCodeEvents();
    await writeFile(eventsPath, `${events.map(event => JSON.stringify(event)).join('\n')}\n`, 'utf8');
    await writeFile(pricingPath, JSON.stringify({
      'openai/gpt-5': { inputPerMTok: 1, outputPerMTok: 2, cacheWritePerMTok: 3, cacheReadPerMTok: 0.5 },
    }), 'utf8');

    const byModel = await request.get('/api/usage/summary?period=all&groupBy=model');
    expect(byModel.ok()).toBeTruthy();
    expect(await byModel.json()).toMatchObject({ groups: {
      'openai/gpt-5': { inputTokens: 100_000, outputTokens: 20_000, reasoningTokens: 5_000, cacheCreationTokens: 10_000, cacheReadTokens: 65_000, totalTokens: 200_000, requests: 1, estCostUsd: 0.2125 },
      'unknown-provider/unpriced-model': { totalTokens: 60_000, estCostUsd: null, requests: 1 },
      'anthropic/claude-test': { totalTokens: 600, estCostUsd: null, requests: 1 },
    } });
    const byTask = await request.get('/api/usage/summary?period=all&groupBy=task');
    expect(await byTask.json()).toMatchObject({ groups: { 't-opencode': { totalTokens: 260_000, requests: 2, cacheReadTokens: 75_000, estCostUsd: null } } });
    const bySession = await request.get('/api/usage/summary?period=all&groupBy=session');
    expect(await bySession.json()).toMatchObject({ groups: { 'oc-session-execute': { totalTokens: 200_000 }, 'oc-session-reflection': { totalTokens: 60_000 }, 'telegram:usage-test': { totalTokens: 600 } } });

    const tasks = await request.get('/api/usage/tasks');
    expect(await tasks.json()).toMatchObject({ tasks: { 't-opencode': { totalTokens: 260_000, requests: 2, cacheReadTokens: 75_000, estCostUsd: null } } });
    const task = await request.get('/api/usage/task/t-opencode');
    expect(await task.json()).toMatchObject({
      total: { totalTokens: 260_000, requests: 2, inputTokens: 140_000, cacheReadTokens: 75_000, estCostUsd: null },
      byModel: { 'openai/gpt-5': { totalTokens: 200_000 }, 'unknown-provider/unpriced-model': { totalTokens: 60_000 } },
      bySession: { 'oc-session-execute': { totalTokens: 200_000 }, 'oc-session-reflection': { totalTokens: 60_000 } },
    });

    await page.route('**/api/board', async route => route.fulfill({ json: {
      meta: {}, bootstrapRequired: false,
      tasks: [
        { id: 't-opencode', title: 'OpenCode workflow task', context: 'Direct stdout usage', priority: 'medium', status: 'todo', type: 'standard' },
        { id: 't-unaffected', title: 'Unaffected task', context: '', priority: 'low', status: 'todo', type: 'quick' },
      ],
    } }));
    await page.goto('/');
    await expect(page.locator('.task-usage-badge')).toHaveText('⚡ 260.0k');
    await expect(page.locator('.task-usage-badge')).toHaveAttribute('title', /Cache hit: 35%/);

    await page.locator('#usage-btn').click();
    await expect(page.locator('#usage-summary-content')).toContainText('openai/gpt-5');
    await expect(page.locator('#usage-summary-content')).toContainText('$0.21');
    await expect(page.locator('#usage-summary-content')).toContainText('—');
    await expect(page.locator('#usage-summary-content')).toContainText('35%');
    await expect(page.locator('.usage-cost-disclaimer')).toContainText('estimated');
    await page.getByRole('button', { name: 'Task', exact: true }).click();
    await expect(page.locator('#usage-summary-content')).toContainText('t-opencode');
    await page.getByRole('button', { name: 'Session', exact: true }).click();
    await expect(page.locator('#usage-summary-content')).toContainText('oc-session-reflection');
  });

  test('refreshes an open usage panel and only the affected badge after a usage update', async ({ page }) => {
    let refreshed = false;
    await page.route('**/api/board', async route => route.fulfill({ json: {
      meta: {}, bootstrapRequired: false,
      tasks: [
        { id: 't-opencode', title: 'OpenCode workflow task', context: '', priority: 'medium', status: 'todo', type: 'standard' },
        { id: 't-unaffected', title: 'Unaffected task', context: '', priority: 'low', status: 'todo', type: 'quick' },
      ],
    } }));
    await page.route('**/api/usage/tasks', async route => route.fulfill({ json: {
      tasks: {
        't-opencode': { inputTokens: refreshed ? 200 : 100, outputTokens: 0, reasoningTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: refreshed ? 200 : 100, requests: 1, estCostUsd: null, costBasis: 'ESTIMATED' },
      },
    } }));
    await page.route('**/api/usage/summary**', async route => route.fulfill({ json: {
      groups: {
        'openai/gpt-5': { inputTokens: refreshed ? 200 : 100, outputTokens: 0, reasoningTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: refreshed ? 200 : 100, requests: 1, estCostUsd: null, costBasis: 'ESTIMATED' },
      },
    } }));
    await page.goto('/');
    await page.locator('#usage-btn').click();
    await expect(page.locator('#usage-summary-content')).toContainText('100');
    refreshed = true;
    // This is the exact browser-side operation performed by the board WebSocket
    // handler for { type: 'usage-updated', taskIds: ['t-opencode'] }.
    await page.evaluate(() => (window as Window & { refreshUsageBadges: (taskIds: string[]) => Promise<void> }).refreshUsageBadges(['t-opencode']));
    await expect(page.locator('#usage-summary-content')).toContainText('200');
    await expect(page.locator('.task-usage-badge')).toHaveText('⚡ 200');
    await expect(page.locator('.task-card', { hasText: 'Unaffected task' }).locator('.task-usage-badge')).toHaveCount(0);
  });
});
