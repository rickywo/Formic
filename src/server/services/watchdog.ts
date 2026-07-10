/**
 * Watchdog Service
 * Periodically scans for expired leases, kills orphaned agent processes,
 * reverts uncommitted file changes, and re-queues affected tasks.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { getExpiredLeases, detectDeadlock, renewLeases } from './leaseManager.js';
import { isWorkflowRunning } from './workflow.js';
import { getTask, validateBoard, loadBoard } from './store.js';
import { broadcastBoardUpdate } from './boardNotifier.js';
import { getBoardPath } from '../utils/paths.js';
import { teardownTask } from './taskTeardown.js';

import { engineConfig, refreshEngineConfig } from './engineConfig.js';

let watchdogTimeout: ReturnType<typeof setTimeout> | null = null;

/**
 * Scan for expired leases and handle cleanup
 */
async function scanExpiredLeases(): Promise<void> {
  const expired = getExpiredLeases();
  if (expired.length === 0) {
    try {
      await detectDeadlock();
    } catch (error) {
      console.warn('[Watchdog] deadlock detection error:', error);
    }
    return;
  }

  // Group expired leases by taskId
  const taskFiles = new Map<string, string[]>();
  for (const lease of expired) {
    const files = taskFiles.get(lease.taskId) || [];
    files.push(lease.filePath);
    taskFiles.set(lease.taskId, files);
  }

  for (const [taskId, files] of taskFiles.entries()) {
    console.warn(`[Watchdog] Expired leases for task ${taskId}: ${files.join(', ')}`);

    try {
      // Guard: if the task is still actively running (has a live workflow process),
      // renew its leases instead of killing it. This prevents the watchdog from
      // disrupting long-running execute iterations.
      const task = await getTask(taskId);
      const activeStates = new Set(['running', 'briefing', 'planning', 'declaring', 'architecting', 'verifying']);
      if (task && activeStates.has(task.status) && isWorkflowRunning(taskId)) {
        console.warn(`[Watchdog] Task ${taskId} is actively ${task.status} with live process — renewing leases instead of killing`);
        renewLeases(taskId);
        continue;
      }

      // 1. Tear down the task: stop → revert → release → re-queue.
      await teardownTask(taskId, 'lease_expired');

      // 2. Broadcast board update
      broadcastBoardUpdate();

    } catch (error) {
      console.warn(`[Watchdog] Error handling expired leases for task ${taskId}:`, error);
    }
  }

  // Run deadlock detection after expired-lease cleanup
  try {
    await detectDeadlock();
  } catch (error) {
    console.warn('[Watchdog] deadlock detection error:', error);
  }
}

/**
 * Validate board.json integrity and trigger recovery on corruption.
 * Reads the file directly (bypassing loadBoard) to avoid recovery side effects on every tick.
 */
async function checkBoardHealth(): Promise<void> {
  try {
    const boardPath = getBoardPath();

    if (!existsSync(boardPath)) {
      console.warn('[BoardHealth] board.json does not exist — triggering recovery');
      await loadBoard();
      broadcastBoardUpdate();
      return;
    }

    const raw = await readFile(boardPath, 'utf-8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.warn('[BoardHealth] board.json failed to parse — triggering recovery');
      await loadBoard();
      broadcastBoardUpdate();
      return;
    }

    if (!validateBoard(parsed)) {
      console.warn('[BoardHealth] board.json failed validation — triggering recovery');
      await loadBoard();
      broadcastBoardUpdate();
    }
  } catch (error) {
    console.error('[BoardHealth] Health check failed:', error instanceof Error ? error.message : 'Unknown error');
  }
}

/**
 * Schedule the next watchdog scan using recursive setTimeout
 */
function scheduleWatchdog(): void {
  watchdogTimeout = setTimeout(async () => {
    await refreshEngineConfig();
    await checkBoardHealth().catch(error => {
      console.warn('[BoardHealth] Health check error:', error);
    });
    await scanExpiredLeases().catch(error => {
      console.warn('[Watchdog] Scan error:', error);
    });
    if (watchdogTimeout !== null) {
      scheduleWatchdog();
    }
  }, engineConfig.watchdogIntervalMs);
}

/**
 * Start the watchdog timer
 */
export function startWatchdog(): void {
  if (watchdogTimeout !== null) {
    console.warn('[Watchdog] Already running');
    return;
  }

  void refreshEngineConfig().then(() => {
    console.warn(`[Watchdog] Starting watchdog (interval: ${engineConfig.watchdogIntervalMs}ms)`);
    scheduleWatchdog();
  });
}

/**
 * Stop the watchdog timer
 */
export function stopWatchdog(): void {
  if (watchdogTimeout !== null) {
    clearTimeout(watchdogTimeout);
    watchdogTimeout = null;
    console.warn('[Watchdog] Stopped');
  }
}
