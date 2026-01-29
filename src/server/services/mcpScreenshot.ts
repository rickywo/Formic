/**
 * MCP Screenshot Service
 *
 * Captures screenshots of web pages using Playwright MCP tools.
 * This service is designed to be called from messaging adapters (Telegram, LINE)
 * and relies on MCP Playwright tools being available in the execution environment.
 *
 * Note: MCP tools are available when this code runs within an AI agent context
 * (e.g., Claude Code with MCP configured). For direct API usage without MCP,
 * consider using Puppeteer or Playwright directly.
 */

import { spawn } from 'node:child_process';
import { writeFile, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

// Screenshot timeout: 30 seconds default (configurable via environment)
const SCREENSHOT_TIMEOUT_MS = parseInt(process.env.SCREENSHOT_TIMEOUT_MS || '30000', 10);

// Temporary directory for screenshots
const TEMP_DIR = process.env.TEMP_DIR || '/tmp/formic-screenshots';

/**
 * Screenshot capture result
 */
export interface ScreenshotResult {
  success: boolean;
  /** Base64-encoded PNG data (on success) */
  data?: string;
  /** Source type (always 'buffer' for MCP screenshots) */
  source?: 'buffer';
  /** Error message (on failure) */
  error?: string;
}

/**
 * Check if Playwright is available by attempting to run a simple command
 * This is a lightweight check that doesn't require a full browser launch
 */
export async function isPlaywrightAvailable(): Promise<boolean> {
  try {
    // Try to import playwright to check if it's installed
    const result = await new Promise<boolean>((resolve) => {
      const proc = spawn('npx', ['playwright', '--version'], {
        stdio: 'pipe',
        timeout: 5000,
      });

      let resolved = false;

      proc.on('close', (code) => {
        if (!resolved) {
          resolved = true;
          resolve(code === 0);
        }
      });

      proc.on('error', () => {
        if (!resolved) {
          resolved = true;
          resolve(false);
        }
      });

      // Timeout fallback
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          proc.kill();
          resolve(false);
        }
      }, 5000);
    });

    if (result) {
      console.log('[McpScreenshot] Playwright is available');
    } else {
      console.log('[McpScreenshot] Playwright is not available');
    }

    return result;
  } catch (error) {
    const err = error as Error;
    console.log('[McpScreenshot] Playwright availability check failed:', err.message);
    return false;
  }
}

/**
 * Validate and normalize a URL for screenshot capture
 */
function validateUrl(url: string): { valid: boolean; url?: string; error?: string } {
  let normalizedUrl = url.trim();

  // Add https:// if no protocol specified
  if (!normalizedUrl.startsWith('http://') && !normalizedUrl.startsWith('https://')) {
    normalizedUrl = 'https://' + normalizedUrl;
  }

  try {
    const parsed = new URL(normalizedUrl);

    // Only allow http and https protocols
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { valid: false, error: 'Only HTTP and HTTPS URLs are supported' };
    }

    return { valid: true, url: normalizedUrl };
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }
}

/**
 * Ensure the temporary directory exists
 */
async function ensureTempDir(): Promise<void> {
  try {
    await mkdir(TEMP_DIR, { recursive: true });
  } catch (error) {
    const err = error as Error;
    console.error('[McpScreenshot] Failed to create temp directory:', err.message);
    throw new Error(`Failed to create temp directory: ${err.message}`);
  }
}

/**
 * Generate a unique filename for the screenshot
 */
function generateTempFilename(): string {
  const id = randomBytes(8).toString('hex');
  return join(TEMP_DIR, `screenshot-${id}.png`);
}

/**
 * Take a screenshot using Playwright
 * Uses a headless browser to navigate to the URL and capture a screenshot
 *
 * @param url - The URL to capture
 * @returns ScreenshotResult with base64-encoded PNG data or error
 */
export async function takeScreenshot(url: string): Promise<ScreenshotResult> {
  console.log(`[McpScreenshot] Taking screenshot of: ${url}`);

  // Validate URL
  const validation = validateUrl(url);
  if (!validation.valid) {
    console.log(`[McpScreenshot] Invalid URL: ${validation.error}`);
    return { success: false, error: validation.error };
  }

  const normalizedUrl = validation.url!;
  console.log(`[McpScreenshot] Normalized URL: ${normalizedUrl}`);

  // Check if Playwright is available
  const playwrightAvailable = await isPlaywrightAvailable();
  if (!playwrightAvailable) {
    return {
      success: false,
      error: 'Playwright is not installed. Please run: npm install playwright && npx playwright install chromium',
    };
  }

  // Ensure temp directory exists
  await ensureTempDir();

  // Generate temp filename for screenshot
  const tempFile = generateTempFilename();

  try {
    // Use a Node.js script to take the screenshot with Playwright
    const screenshotScript = `
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto('${normalizedUrl.replace(/'/g, "\\'")}', {
      waitUntil: 'networkidle',
      timeout: ${SCREENSHOT_TIMEOUT_MS - 5000} // Leave 5s buffer for browser startup
    });

    await page.screenshot({
      path: '${tempFile.replace(/'/g, "\\'")}',
      type: 'png'
    });

    console.log('SCREENSHOT_SUCCESS');
  } catch (err) {
    console.error('SCREENSHOT_ERROR:', err.message);
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
`;

    // Execute the screenshot script
    const result = await new Promise<{ success: boolean; error?: string }>((resolve) => {
      const proc = spawn('node', ['-e', screenshotScript], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: SCREENSHOT_TIMEOUT_MS,
      });

      let stdout = '';
      let stderr = '';
      let resolved = false;

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (resolved) return;
        resolved = true;

        if (code === 0 && stdout.includes('SCREENSHOT_SUCCESS')) {
          resolve({ success: true });
        } else {
          // Extract error message
          const errorMatch = stderr.match(/SCREENSHOT_ERROR:\s*(.+)/);
          const errorMsg = errorMatch ? errorMatch[1] : stderr || 'Screenshot capture failed';
          resolve({ success: false, error: errorMsg.trim() });
        }
      });

      proc.on('error', (err) => {
        if (resolved) return;
        resolved = true;
        resolve({ success: false, error: `Process error: ${err.message}` });
      });

      // Timeout fallback
      setTimeout(() => {
        if (resolved) return;
        resolved = true;
        proc.kill('SIGKILL');
        resolve({ success: false, error: `Screenshot timed out after ${SCREENSHOT_TIMEOUT_MS / 1000}s` });
      }, SCREENSHOT_TIMEOUT_MS);
    });

    if (!result.success) {
      console.log(`[McpScreenshot] Screenshot failed: ${result.error}`);
      return { success: false, error: result.error };
    }

    // Read the screenshot file and convert to base64
    const { readFile } = await import('node:fs/promises');
    const screenshotBuffer = await readFile(tempFile);
    const base64Data = screenshotBuffer.toString('base64');

    console.log(`[McpScreenshot] Screenshot captured successfully (${Math.round(screenshotBuffer.length / 1024)}KB)`);

    // Clean up temp file
    try {
      await unlink(tempFile);
    } catch {
      // Ignore cleanup errors
    }

    return {
      success: true,
      data: base64Data,
      source: 'buffer',
    };
  } catch (error) {
    const err = error as Error;
    console.error('[McpScreenshot] Screenshot error:', err.message);

    // Clean up temp file on error
    try {
      await unlink(tempFile);
    } catch {
      // Ignore cleanup errors
    }

    return {
      success: false,
      error: `Screenshot failed: ${err.message}`,
    };
  }
}

/**
 * Take a screenshot with MCP Playwright tools
 * This is a wrapper that attempts to use MCP tools if available,
 * falling back to direct Playwright usage
 *
 * @param url - The URL to capture
 * @returns ScreenshotResult with base64-encoded PNG data or error
 */
export async function takeScreenshotWithMCP(url: string): Promise<ScreenshotResult> {
  // For now, we use direct Playwright since MCP tools are only available
  // in the AI agent execution context (Claude Code, etc.)
  // The MCP integration would require being inside an AI session
  return takeScreenshot(url);
}
