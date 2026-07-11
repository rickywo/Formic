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
      ['Chat Assistant', '#step-model-assistant'],
    ] as const;

    for (const [label, selector] of modelControls) {
      await expect(page.getByLabel(label, { exact: true })).toHaveAttribute('id', selector.slice(1));
      await expect(page.locator(`${selector} option`).first()).toHaveText('Agent default');
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
});
