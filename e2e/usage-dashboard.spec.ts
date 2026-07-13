import { expect, test } from '@playwright/test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

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
});
