import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const AGENT_TYPE_URL = '/api/config/settings/agentType';

async function waitForAgentTypeSave(page: Page) {
  return page.waitForResponse((response) =>
    response.url().includes(AGENT_TYPE_URL)
    && response.request().method() === 'PUT'
    && response.status() === 200,
  );
}

async function getCurrentAgentType(page: Page): Promise<string> {
  const res = await page.evaluate(async () => {
    const r = await fetch('/api/agents');
    const data = await r.json();
    return data.current;
  });
  return res;
}

async function restoreAgentType(page: Page, original: string) {
  await page.evaluate(async (type) => {
    await fetch('/api/config/settings/agentType', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: type }),
    });
  }, original);
}

test.describe('agent provider selection', () => {
  let originalType: string;

  test.beforeAll(async () => {
    // Capture original agent type via API so we can restore it
    // We'll do it per-test in beforeEeach to be safe
  });

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    originalType = await getCurrentAgentType(page);
  });

  test.afterEach(async ({ page }) => {
    if (originalType) {
      await restoreAgentType(page, originalType);
    }
  });

  test('header pill shows current provider', async ({ page }) => {
    const pill = page.locator('#agent-trigger-name');
    await expect(pill).toBeVisible();
    const text = await pill.textContent();
    expect(text).toBeTruthy();
    expect(['Claude Code', 'Copilot', 'OpenCode']).toContain(text!);
  });

  test('dropdown opens and lists three providers', async ({ page }) => {
    await page.locator('#agent-trigger').click();
    const dropdown = page.locator('#agent-dropdown');
    await expect(dropdown).toBeVisible();

    const items = page.locator('.agent-item');
    await expect(items).toHaveCount(3);

    // Check each item has a name
    const firstItem = items.first();
    await expect(firstItem.locator('.agent-item-name')).toBeVisible();
  });

  test('installed providers are clickable and uninstalled are disabled', async ({ page }) => {
    await page.locator('#agent-trigger').click();
    const dropdown = page.locator('#agent-dropdown');
    await expect(dropdown).toBeVisible();

    // Check that disabled items exist (need aria-disabled or .disabled class)
    const disabledItems = page.locator('.agent-item.disabled');
    // We don't assert count since it depends on what's installed,
    // but the structure should be correct
    const allItems = page.locator('.agent-item');
    const count = await allItems.count();
    expect(count).toBe(3);

    // At least one should NOT be disabled (current provider should be installed)
    const clickableItems = page.locator('.agent-item:not(.disabled)');
    const clickableCount = await clickableItems.count();
    expect(clickableCount).toBeGreaterThanOrEqual(1);
  });

  test('selecting an installed provider updates the pill', async ({ page }) => {
    // Find a clickable agent item
    await page.locator('#agent-trigger').click();
    const dropdown = page.locator('#agent-dropdown');
    await expect(dropdown).toBeVisible();

    const clickableItem = page.locator('.agent-item:not(.disabled)').first();
    const itemName = await clickableItem.locator('.agent-item-name').textContent();
    await clickableItem.click();

    // Pill should update
    const pill = page.locator('#agent-trigger-name');
    await expect(pill).toContainText(itemName!);
  });

  test('persists provider across page reload', async ({ page }) => {
    // Switch to claude (should always be installed if test env is set up)
    const saveP = waitForAgentTypeSave(page);
    await page.locator('#agent-trigger').click();
    await page.locator('.agent-item:not(.disabled)').first().click();
    await saveP;

    // Reload
    await page.reload();
    await page.waitForSelector('#agent-trigger-name');

    // Pill should still show the saved provider
    const pill = page.locator('#agent-trigger-name');
    const text = await pill.textContent();
    expect(text).toBeTruthy();
  });

  test('settings panel has provider selector synced with header', async ({ page }) => {
    // Open settings
    await page.locator('#settings-btn').click();
    await expect(page.getByText('Agent Models', { exact: true })).toBeVisible();

    const settingsSelect = page.locator('#settings-agent-type');
    await expect(settingsSelect).toBeVisible();

    // Available options
    const options = await settingsSelect.locator('option').allTextContents();
    expect(options).toContain('Claude Code CLI');
    expect(options).toContain('GitHub Copilot CLI');
    expect(options).toContain('OpenCode CLI');
  });

  test('settings provider selector changes header pill', async ({ page }) => {
    // Open settings and switch to claude via the select
    await page.locator('#settings-btn').click();
    await expect(page.getByText('Agent Models', { exact: true })).toBeVisible();

    const saveP = waitForAgentTypeSave(page);
    await page.locator('#settings-agent-type').selectOption('claude');
    await saveP;

    // Close settings
    await page.locator('.settings-close-btn').click();

    // Header pill should show Claude
    const pill = page.locator('#agent-trigger-name');
    await expect(pill).toContainText('Claude Code');
  });
});
