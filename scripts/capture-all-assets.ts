/**
 * Comprehensive Playwright capture script for Formic marketing assets.
 * Produces screenshots (t-18) and video recordings for GIF conversion (t-19).
 *
 * Usage:
 *   npx tsx scripts/capture-all-assets.ts
 *
 * Prerequisites:
 *   - Formic dev server running (default: http://localhost:9010)
 *   - npx playwright install chromium
 *
 * Output:
 *   - images/screenshots/showcase-*.png  (6 screenshots for t-18)
 *   - images/gifs/raw/*.webm             (4 video clips for t-19 → encode with scripts/encode-gifs.sh)
 */

import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs/promises';

const BASE_URL = process.env.BASE_URL || 'http://localhost:9010';
const SCREENSHOT_DIR = path.resolve('images/screenshots');
const GIF_RAW_DIR = path.resolve('images/gifs/raw');
const VIEWPORT = { width: 1280, height: 800 };

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function closeModals(page: import('playwright').Page) {
  // Close any open modals by clicking outside or pressing Escape
  const modal = page.locator('.modal-overlay.open');
  if (await modal.isVisible({ timeout: 500 }).catch(() => false)) {
    await page.keyboard.press('Escape');
    await sleep(500);
  }
  // Double-check
  if (await modal.isVisible({ timeout: 300 }).catch(() => false)) {
    // Try clicking the overlay background itself
    await page.evaluate(() => {
      const m = document.querySelector('.modal-overlay.open') as HTMLElement;
      if (m) m.click();
    });
    await sleep(500);
  }
}

// ────────────────────────────────────────────────
// PART 1: Screenshots (t-18)
// ────────────────────────────────────────────────

async function captureScreenshots() {
  console.warn('\n══════════════════════════════════════════');
  console.warn('  PART 1: Screenshots (t-18)');
  console.warn('══════════════════════════════════════════\n');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    colorScheme: 'dark',
    deviceScaleFactor: 2, // retina-quality
  });
  const page = await context.newPage();

  // Screenshot 1: Kanban Board Overview
  console.warn('[Screenshot 1/6] Kanban board overview...');
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  await sleep(3000); // let all cards render + animations settle
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, 'showcase-01-kanban-board.png'),
    fullPage: false,
  });
  console.warn('  ✅ showcase-01-kanban-board.png');

  // Screenshot 2: Goal Decomposition — click a goal task to show parent/child
  console.warn('[Screenshot 2/6] Goal decomposition...');
  // t-1 is a goal task, and t-8 is also a goal; click one to show details
  const goalCard = page.locator('.task-card').filter({ hasText: /resilience.*validation|log panel.*disk logs/i }).first();
  if (await goalCard.isVisible()) {
    await goalCard.click();
    await sleep(1500);
  }
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, 'showcase-02-goal-decomposition.png'),
    fullPage: false,
  });
  console.warn('  ✅ showcase-02-goal-decomposition.png');

  // Close any open modal
  await closeModals(page);

  // Screenshot 3: AI Assistant panel
  console.warn('[Screenshot 3/6] AI Assistant panel...');
  await closeModals(page);
  const assistantFab = page.locator('#assistant-fab');
  if (await assistantFab.isVisible({ timeout: 2000 }).catch(() => false)) {
    await assistantFab.click({ force: true });
    await sleep(1500);
  }
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, 'showcase-03-ai-assistant.png'),
    fullPage: false,
  });
  console.warn('  ✅ showcase-03-ai-assistant.png');

  // Close assistant
  await closeModals(page);
  await page.keyboard.press('Escape');
  await sleep(500);
  await closeModals(page);

  // Screenshot 4: Task detail / execution view — click a review task
  console.warn('[Screenshot 4/6] Task execution detail...');
  await closeModals(page);
  const reviewCard = page.locator('.column[data-status="review"] .task-card').first();
  if (await reviewCard.isVisible()) {
    await reviewCard.click();
    await sleep(2000);
  }
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, 'showcase-04-task-execution.png'),
    fullPage: false,
  });
  console.warn('  ✅ showcase-04-task-execution.png');

  // Close modal
  await closeModals(page);

  // Screenshot 5: Task in review — show the review actions
  console.warn('[Screenshot 5/6] Task review actions...');
  await closeModals(page);
  const reviewCard2 = page.locator('.column[data-status="review"] .task-card').nth(1);
  if (await reviewCard2.isVisible()) {
    await reviewCard2.click();
    await sleep(1500);
  }
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, 'showcase-05-task-review.png'),
    fullPage: false,
  });
  console.warn('  ✅ showcase-05-task-review.png');

  // Close
  await closeModals(page);

  // Screenshot 6: Usage meter in header (cropped)
  console.warn('[Screenshot 6/6] Usage meter header...');
  // Full page screenshot first, then we'll capture the header area
  const usageMeter = page.locator('.usage-meter, #usage-meter');
  if (await usageMeter.isVisible()) {
    // Capture just the header region with some context
    const header = page.locator('header, .header, nav').first();
    if (await header.isVisible()) {
      await header.screenshot({
        path: path.join(SCREENSHOT_DIR, 'showcase-06-usage-meter.png'),
      });
    } else {
      // Fallback: capture top 100px of page
      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, 'showcase-06-usage-meter.png'),
        clip: { x: 0, y: 0, width: VIEWPORT.width, height: 100 },
      });
    }
  } else {
    // Just capture the full board as fallback
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'showcase-06-usage-meter.png'),
      clip: { x: 0, y: 0, width: VIEWPORT.width, height: 120 },
    });
  }
  console.warn('  ✅ showcase-06-usage-meter.png');

  await context.close();
  await browser.close();
  console.warn('\n📸 All 6 screenshots saved to images/screenshots/\n');
}

// ────────────────────────────────────────────────
// PART 2: Video Recordings for GIFs (t-19)
// ────────────────────────────────────────────────

async function captureVideos() {
  console.warn('\n══════════════════════════════════════════');
  console.warn('  PART 2: Video Recordings (t-19)');
  console.warn('══════════════════════════════════════════\n');

  const browser = await chromium.launch({ headless: true });

  // GIF 1: Board Flow — pan across the board showing task pipeline
  console.warn('[Video 1/4] Board flow...');
  {
    const context = await browser.newContext({
      viewport: VIEWPORT,
      colorScheme: 'dark',
      recordVideo: { dir: GIF_RAW_DIR, size: VIEWPORT },
    });
    const page = await context.newPage();
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    await sleep(2000);

    // Slowly scroll the board horizontally to show all columns
    const board = page.locator('.board, main.board').first();
    if (await board.isVisible()) {
      // Scroll right slowly to reveal all columns
      for (let i = 0; i < 5; i++) {
        await board.evaluate((el) => {
          el.scrollBy({ left: 250, behavior: 'smooth' });
        });
        await sleep(1500);
      }
      // Scroll back
      await sleep(500);
      await board.evaluate((el) => {
        el.scrollTo({ left: 0, behavior: 'smooth' });
      });
      await sleep(2000);
    }
    await page.close();
    await context.close();

    // Rename the video file
    const rawFiles = await fs.readdir(GIF_RAW_DIR);
    const latestVideo = rawFiles
      .filter(f => f.endsWith('.webm'))
      .sort()
      .pop();
    if (latestVideo) {
      await fs.rename(
        path.join(GIF_RAW_DIR, latestVideo),
        path.join(GIF_RAW_DIR, 'clip-01-board-flow.webm')
      );
    }
    console.warn('  ✅ clip-01-board-flow.webm');
  }

  // GIF 2: Goal Decomposition — open a goal task to show children
  console.warn('[Video 2/4] Goal decomposition...');
  {
    const context = await browser.newContext({
      viewport: VIEWPORT,
      colorScheme: 'dark',
      recordVideo: { dir: GIF_RAW_DIR, size: VIEWPORT },
    });
    const page = await context.newPage();
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    await sleep(2000);

    // Click the "New Task" / create-task button or card
    const createCard = page.locator('.create-task-card').first();
    const newTaskBtn = page.locator('button:has-text("New Task")').first();

    if (await createCard.isVisible()) {
      await createCard.click();
    } else if (await newTaskBtn.isVisible()) {
      await newTaskBtn.click();
    }
    await sleep(1500);

    // Try to find and interact with the task creation modal
    const titleInput = page.locator('input[placeholder*="title" i], input[name="title"], #task-title, input[type="text"]').first();
    if (await titleInput.isVisible()) {
      await titleInput.fill('');
      // Type slowly for visual effect
      await titleInput.type('Improve onboarding experience', { delay: 50 });
      await sleep(1000);

      // Try to find context/description field
      const contextInput = page.locator('textarea, [contenteditable="true"]').first();
      if (await contextInput.isVisible()) {
        await contextInput.type('Redesign the first-run experience with guided setup and sample tasks.', { delay: 30 });
      }
      await sleep(1000);

      // Try to select Goal type
      const goalBtn = page.locator('button:has-text("Goal"), [data-type="goal"], label:has-text("Goal")').first();
      if (await goalBtn.isVisible()) {
        await goalBtn.click();
      }
      await sleep(2000);
    }

    // Close/cancel without actually creating
    await page.keyboard.press('Escape');
    await sleep(1500);

    await page.close();
    await context.close();

    const rawFiles = await fs.readdir(GIF_RAW_DIR);
    const latestVideo = rawFiles
      .filter(f => f.endsWith('.webm') && !f.startsWith('clip-'))
      .sort()
      .pop();
    if (latestVideo) {
      await fs.rename(
        path.join(GIF_RAW_DIR, latestVideo),
        path.join(GIF_RAW_DIR, 'clip-02-goal-decompose.webm')
      );
    }
    console.warn('  ✅ clip-02-goal-decompose.webm');
  }

  // GIF 3: Usage Meter — zoom into the header area
  console.warn('[Video 3/4] Usage meter...');
  {
    // Use a smaller viewport focused on the header for tighter framing
    const context = await browser.newContext({
      viewport: { width: 1280, height: 200 },
      colorScheme: 'dark',
      recordVideo: { dir: GIF_RAW_DIR, size: { width: 1280, height: 200 } },
    });
    const page = await context.newPage();
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    await sleep(2000);

    // Hover over the usage meter
    const meter = page.locator('.usage-meter, #usage-meter').first();
    if (await meter.isVisible()) {
      await meter.hover();
      await sleep(3000);
    } else {
      await sleep(3000);
    }

    await page.close();
    await context.close();

    const rawFiles = await fs.readdir(GIF_RAW_DIR);
    const latestVideo = rawFiles
      .filter(f => f.endsWith('.webm') && !f.startsWith('clip-'))
      .sort()
      .pop();
    if (latestVideo) {
      await fs.rename(
        path.join(GIF_RAW_DIR, latestVideo),
        path.join(GIF_RAW_DIR, 'clip-03-usage-meter.webm')
      );
    }
    console.warn('  ✅ clip-03-usage-meter.webm');
  }

  // GIF 4: Live Logs — open a task and show the log panel
  console.warn('[Video 4/4] Live logs...');
  {
    const context = await browser.newContext({
      viewport: VIEWPORT,
      colorScheme: 'dark',
      recordVideo: { dir: GIF_RAW_DIR, size: VIEWPORT },
    });
    const page = await context.newPage();
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    await sleep(2000);

    // Click on a review/done task to show its log panel
    const taskCard = page.locator('.column[data-status="review"] .task-card, .column[data-status="done"] .task-card').first();
    if (await taskCard.isVisible()) {
      await taskCard.click();
      await sleep(6000); // let log panel load and scroll
    } else {
      // Click any task card
      const anyCard = page.locator('.task-card').first();
      if (await anyCard.isVisible()) {
        await anyCard.click();
        await sleep(6000);
      }
    }

    await page.close();
    await context.close();

    const rawFiles = await fs.readdir(GIF_RAW_DIR);
    const latestVideo = rawFiles
      .filter(f => f.endsWith('.webm') && !f.startsWith('clip-'))
      .sort()
      .pop();
    if (latestVideo) {
      await fs.rename(
        path.join(GIF_RAW_DIR, latestVideo),
        path.join(GIF_RAW_DIR, 'clip-04-live-logs.webm')
      );
    }
    console.warn('  ✅ clip-04-live-logs.webm');
  }

  await browser.close();
  console.warn('\n🎬 All 4 video clips saved to images/gifs/raw/');
  console.warn('   Run: bash scripts/encode-gifs.sh  to convert to GIF\n');
}

// ────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────

async function main() {
  await ensureDir(SCREENSHOT_DIR);
  await ensureDir(GIF_RAW_DIR);

  console.warn(`\n🐜 Formic Asset Capture — targeting ${BASE_URL}\n`);

  // Verify server is reachable
  try {
    const res = await fetch(BASE_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    console.warn('✅ Server is reachable\n');
  } catch (err) {
    console.error(`❌ Cannot reach ${BASE_URL} — is the dev server running?`);
    console.error('   Start with: npm run dev');
    process.exit(1);
  }

  await captureScreenshots();
  await captureVideos();

  console.warn('══════════════════════════════════════════');
  console.warn('  DONE — All assets captured!');
  console.warn('══════════════════════════════════════════');
  console.warn('');
  console.warn('Screenshots: images/screenshots/showcase-*.png');
  console.warn('Videos:      images/gifs/raw/clip-*.webm');
  console.warn('');
  console.warn('Next steps:');
  console.warn('  1. bash scripts/encode-gifs.sh   (convert videos → GIFs)');
  console.warn('  2. Review & crop as needed');
  console.warn('');
}

main().catch((err) => {
  console.error('[Capture] Fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
