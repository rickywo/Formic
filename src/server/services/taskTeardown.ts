/**
 * Task Teardown Service
 * Shared teardown helper for lease preemption, deadlock resolution, and
 * watchdog lease expiry. Implements the canonical stop→revert→release→requeue
 * sequence so leaseManager never needs to import workflow (circular-import safe).
 *
 * Used by:
 *  - leaseManager.preemptLease()   → teardownTask(holderId, 'preemption')
 *  - leaseManager.detectDeadlock() → teardownTask(victimId, 'deadlock_resolution')
 *  - watchdog.scanExpiredLeases()  → teardownTask(taskId, 'lease_expired')
 */

import { stopWorkflow } from './workflow.js';
import { stopAgent } from './runner.js';
import { checkoutWorkspaceFiles } from '../utils/safeGit.js';
import { releaseLeases, clearWait, getLeasesByTask } from './leaseManager.js';
import { updateTaskStatus } from './store.js';
import { getWorkspacePath } from '../utils/paths.js';

/**
 * Tear down a task: stop its process, revert its exclusive-leased files,
 * release its leases, clear its wait entry, and re-queue it.
 *
 * Callers (watchdog) must perform their own liveness checks before calling
 * this function — teardownTask always tears down; it never renews.
 */
export async function teardownTask(taskId: string, reason: string): Promise<void> {
  console.warn(`[Teardown] Tearing down task ${taskId} (reason: ${reason})`);

  // 1. Capture exclusive files BEFORE stopping the process.
  //    stopWorkflow() calls releaseLeases() internally, which would clear
  //    the lease store before we can inspect it.
  const leases = getLeasesByTask(taskId);
  const exclusiveFiles = leases
    .filter(l => l.leaseType === 'exclusive')
    .map(l => l.filePath);

  // 2. Stop the agent/workflow process.
  //    Graceful stop via stopWorkflow first; fall back to runner-level stopAgent
  //    if no workflow wrapper is managing this task.
  try {
    const workflowStopped = await stopWorkflow(taskId);
    if (!workflowStopped) {
      await stopAgent(taskId);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.warn(`[Teardown] Failed to stop process for task ${taskId}: ${message}`);
  }

  // 3. Revert uncommitted changes on exclusive-leased files.
  if (exclusiveFiles.length > 0) {
    try {
      await checkoutWorkspaceFiles(exclusiveFiles, getWorkspacePath());
      console.warn(`[Teardown] Reverted ${exclusiveFiles.length} file(s) for task ${taskId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.warn(`[Teardown] Failed to revert files for task ${taskId}: ${message}`);
    }
  }

  // 4. Release all remaining leases and clear the wait-for entry.
  //    stopWorkflow may have already released leases — these are safe no-ops
  //    when the task no longer holds any.
  releaseLeases(taskId);
  clearWait(taskId);

  // 5. Re-queue the task so it can be retried.
  await updateTaskStatus(taskId, 'queued', null, `teardown.${reason}`);
  console.warn(`[Teardown] Task ${taskId} re-queued after teardown (reason: ${reason})`);
}
