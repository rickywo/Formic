/**
 * Watchdog Service
 * Periodically scans for expired leases, kills orphaned agent processes,
 * reverts uncommitted file changes, and re-queues affected tasks.
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { getExpiredLeases, releaseLeases, restoreLeases, detectDeadlock, renewLeases } from './leaseManager.js';
import { stopAgent } from './runner.js';
import { stopWorkflow, isWorkflowRunning } from './workflow.js';
import { updateTaskStatus, getTask } from './store.js';
import { broadcastBoardUpdate } from './boardNotifier.js';
import { getWorkspacePath } from '../utils/paths.js';

const execAsync = promisify(exec);

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
    console.log(`[Watchdog] Expired leases for task ${taskId}: ${files.join(', ')}`);

    try {
      // Guard: if the task is still actively running (has a live workflow process),
      // renew its leases instead of killing it. This prevents the watchdog from
      // disrupting long-running execute iterations.
      const task = await getTask(taskId);
      const activeStates = new Set(['running', 'briefing', 'planning', 'declaring', 'architecting', 'verifying']);
      if (task && activeStates.has(task.status) && isWorkflowRunning(taskId)) {
        console.log(`[Watchdog] Task ${taskId} is actively ${task.status} with live process — renewing leases instead of killing`);
        renewLeases(taskId);
        continue;
      }

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
      await updateTaskStatus(taskId, 'queued', null, 'watchdog.lease_expired');
      console.log(`[Watchdog] Re-queued task ${taskId} after lease expiration`);

      // 5. Broadcast board update
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
 * Schedule the next watchdog scan using recursive setTimeout
 */
function scheduleWatchdog(): void {
  watchdogTimeout = setTimeout(async () => {
    await refreshEngineConfig();
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
    console.log('[Watchdog] Already running');
    return;
  }

  void refreshEngineConfig().then(() => {
    console.log(`[Watchdog] Starting watchdog (interval: ${engineConfig.watchdogIntervalMs}ms)`);
    restoreLeases().catch(e => console.warn('[Watchdog] restore error:', e));
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
    console.log('[Watchdog] Stopped');
  }
}
