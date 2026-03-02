/**
 * Watchdog Service
 * Periodically scans for expired leases, kills orphaned agent processes,
 * reverts uncommitted file changes, and re-queues affected tasks.
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { getExpiredLeases, releaseLeases } from './leaseManager.js';
import { stopAgent } from './runner.js';
import { stopWorkflow } from './workflow.js';
import { updateTaskStatus } from './store.js';
import { broadcastBoardUpdate } from './boardNotifier.js';
import { getWorkspacePath } from '../utils/paths.js';

const execAsync = promisify(exec);

const WATCHDOG_INTERVAL_MS = parseInt(process.env.WATCHDOG_INTERVAL_MS || '30000', 10);

let watchdogInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Scan for expired leases and handle cleanup
 */
async function scanExpiredLeases(): Promise<void> {
  const expired = getExpiredLeases();
  if (expired.length === 0) return;

  // Group expired leases by taskId
  const taskFiles = new Map<string, string[]>();
  for (const lease of expired) {
    const files = taskFiles.get(lease.taskId) || [];
    files.push(lease.filePath);
    taskFiles.set(lease.taskId, files);
  }

  for (const [taskId, files] of taskFiles.entries()) {
    console.log(`[Watchdog] Expired leases for task ${taskId}: ${files.join(', ')}`);

    try {
      // 1. Stop the agent/workflow process
      const workflowStopped = await stopWorkflow(taskId);
      if (!workflowStopped) {
        await stopAgent(taskId);
      }

      // 2. Revert uncommitted changes on leased files
      const exclusiveFiles = files.filter(f => !f.includes('::'));
      if (exclusiveFiles.length > 0) {
        try {
          const fileList = exclusiveFiles.map(f => `"${f}"`).join(' ');
          await execAsync(`git checkout -- ${fileList}`, { cwd: getWorkspacePath() });
          console.log(`[Watchdog] Reverted files for task ${taskId}`);
        } catch (error) {
          console.warn(`[Watchdog] Failed to revert files for task ${taskId}:`, error);
        }
      }

      // 3. Release all leases
      releaseLeases(taskId);

      // 4. Re-queue the task
      await updateTaskStatus(taskId, 'queued', null);
      console.log(`[Watchdog] Re-queued task ${taskId} after lease expiration`);

      // 5. Broadcast board update
      broadcastBoardUpdate();

    } catch (error) {
      console.warn(`[Watchdog] Error handling expired leases for task ${taskId}:`, error);
    }
  }
}

/**
 * Start the watchdog timer
 */
export function startWatchdog(): void {
  if (watchdogInterval !== null) {
    console.log('[Watchdog] Already running');
    return;
  }

  console.log(`[Watchdog] Starting watchdog (interval: ${WATCHDOG_INTERVAL_MS}ms)`);
  watchdogInterval = setInterval(() => {
    scanExpiredLeases().catch(error => {
      console.warn('[Watchdog] Scan error:', error);
    });
  }, WATCHDOG_INTERVAL_MS);
}

/**
 * Stop the watchdog timer
 */
export function stopWatchdog(): void {
  if (watchdogInterval !== null) {
    clearInterval(watchdogInterval);
    watchdogInterval = null;
    console.log('[Watchdog] Stopped');
  }
}
