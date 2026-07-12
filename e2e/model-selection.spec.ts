import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const SETTINGS_URL = '/api/config/settings/stepModels';

function waitForStepModelsSave(page: Page) {
  return page.waitForResponse((response) =>
    response.url().includes(SETTINGS_URL)
    && response.request().method() === 'PUT'
    && response.status() === 200,
  );
}

async function openSettings(page: Page) {
  await page.locator('#settings-btn').click();
  await expect(page.getByText('Agent Models', { exact: true })).toBeVisible();
  await expect(page.locator('#step-model-execute option').nth(1)).not.toHaveAttribute('value', '__custom__');
}

test.describe('per-step model selection', () => {
  test('persists catalog and custom model selections', async ({ page }) => {
    await page.goto('/');
    await openSettings(page);

    const modelControls = [
      ['Briefing', '#step-model-brief'],
      ['Planning', '#step-model-plan'],
      ['Declaring', '#step-model-declare'],
      ['Executing', '#step-model-execute'],
      ['Architecting', '#step-model-architect'],
    ] as const;

    for (const [label, selector] of modelControls) {
      await expect(page.getByLabel(label, { exact: true })).toHaveAttribute('id', selector.slice(1));
      const defaultOptions = page.locator(`${selector} option[value=""]`);
      await expect(defaultOptions).toHaveCount(1);
      await expect(defaultOptions).toHaveText('Agent default');
    }

    try {
      const executingSelect = page.locator('#step-model-execute');
      const chosenModel = await executingSelect.locator('option').nth(1).getAttribute('value');
      expect(chosenModel).not.toBeNull();

      const catalogSave = waitForStepModelsSave(page);
      await executingSelect.selectOption({ index: 1 });
      await catalogSave;

      await page.reload();
      await openSettings(page);
      await expect(page.locator('#step-model-execute')).toHaveValue(chosenModel!);

      const briefingSelect = page.locator('#step-model-brief');
      await briefingSelect.selectOption('__custom__');
      const customBriefingInput = page.locator('#step-model-custom-brief');
      await expect(customBriefingInput).toBeVisible();
      await customBriefingInput.fill('my/custom-model');
      const customSave = waitForStepModelsSave(page);
      await customBriefingInput.press('Enter');
      await customSave;

      await page.reload();
      await openSettings(page);
      await expect(page.locator('#step-model-brief')).toHaveValue('__custom__');
      await expect(page.locator('#step-model-custom-brief')).toHaveValue('my/custom-model');
    } finally {
      const resetExecuting = waitForStepModelsSave(page);
      await page.locator('#step-model-execute').selectOption('');
      await resetExecuting;

      const resetBriefing = waitForStepModelsSave(page);
      await page.locator('#step-model-brief').selectOption('');
      await resetBriefing;
    }
  });

  test('persists the chat model from the assistant panel', async ({ page }) => {
    await page.goto('/');
    await page.locator('#assistant-fab').click();

    const assistantSelect = page.locator('#assistant-model-select');
    const defaultOptions = assistantSelect.locator('option[value=""]');
    await expect(defaultOptions).toHaveCount(1);
    await expect(defaultOptions).toHaveText('Agent default');
    await expect(assistantSelect.locator('option').nth(1)).not.toHaveAttribute('value', '__custom__');
    const chosenModel = await assistantSelect.locator('option').nth(1).getAttribute('value');
    expect(chosenModel).not.toBeNull();

    try {
      const catalogSave = waitForStepModelsSave(page);
      await assistantSelect.selectOption(chosenModel!);
      await catalogSave;
      await expect(assistantSelect).toHaveValue(chosenModel!);
      await expect(page.locator('#assistant-model-hint')).toBeVisible();

      await page.reload();
      await page.locator('#assistant-fab').click();
      await expect(page.locator('#assistant-model-select')).toHaveValue(chosenModel!);

      await page.locator('#assistant-model-select').selectOption('__custom__');
      const customInput = page.locator('#assistant-model-custom');
      await expect(customInput).toBeVisible();
      await customInput.fill('my/custom-chat-model');
      const customSave = waitForStepModelsSave(page);
      await customInput.press('Enter');
      await customSave;

      await page.reload();
      await page.locator('#assistant-fab').click();
      await expect(page.locator('#assistant-model-select')).toHaveValue('__custom__');
      await expect(page.locator('#assistant-model-custom')).toHaveValue('my/custom-chat-model');
    } finally {
      await page.reload();
      await page.locator('#assistant-fab').click();
      await expect(page.locator('#assistant-model-select option').nth(1)).not.toHaveAttribute('value', '__custom__');
      const resetAssistant = waitForStepModelsSave(page);
      await page.locator('#assistant-model-select').selectOption('');
      await resetAssistant;
    }
  });

  test('keeps all settings content reachable without horizontal clipping', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 500 });
    await page.goto('/');
    await openSettings(page);

    const content = page.locator('.settings-content');
    const dimensions = await content.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
    expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight);

    await content.evaluate((element) => element.scrollTo(0, element.scrollHeight));
    await expect(page.locator('#settings-panel .settings-section-title', { hasText: 'Workspaces' })).toBeVisible();
  });
});
