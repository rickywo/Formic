/**
 * Queue Processor Service - Automatic task execution from queue
 *
 * Monitors the queued tasks and automatically triggers execution
 * based on priority (high > medium > low) and FIFO within same priority.
 */

import { loadBoard, updateTask } from './store.js';
import { runWorkflow } from './workflow.js';
import { createBranch, generateBranchName, hasUncommittedChanges, getCurrentBranch, getDefaultBaseBranch } from './git.js';
import { generateSlug } from '../utils/slug.js';
import type { Task } from '../../types/index.js';

// Configuration
const POLL_INTERVAL_MS = parseInt(process.env.QUEUE_POLL_INTERVAL || '5000', 10);
const MAX_CONCURRENT_TASKS = parseInt(process.env.MAX_CONCURRENT_TASKS || '1', 10);

let isProcessing = false;
let pollIntervalId: NodeJS.Timeout | null = null;

/**
 * Priority order mapping (lower number = higher priority)
 */
const PRIORITY_ORDER: Record<string, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

/**
 * Get all queued tasks sorted by priority (high first) then by createdAt (FIFO)
 */
export async function getQueuedTasks(): Promise<Task[]> {
  const board = await loadBoard();
  const queuedTasks = board.tasks.filter((task) => task.status === 'queued');

  // Sort by priority (high > medium > low), then by createdAt (oldest first)
  return queuedTasks.sort((a, b) => {
    const priorityDiff = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    if (priorityDiff !== 0) {
      return priorityDiff;
    }
    // FIFO: older tasks first
    const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return aTime - bTime;
  });
}

/**
 * Get the count of currently running tasks
 */
export async function getRunningTasksCount(): Promise<number> {
  const board = await loadBoard();
  return board.tasks.filter((task) =>
    task.status === 'running' || task.status === 'briefing' || task.status === 'planning'
  ).length;
}

/**
 * Start a queued task - creates branch and triggers workflow
 */
async function startQueuedTask(task: Task): Promise<void> {
  console.log(`[Queue] Starting task: ${task.id} - ${task.title}`);

  // Check for uncommitted changes
  if (hasUncommittedChanges()) {
    console.log(`[Queue] Skipping task ${task.id}: workspace has uncommitted changes`);
    return;
  }

  // Store current branch to return to later (if needed)
  const originalBranch = getCurrentBranch();

  // Generate branch name
  const slug = generateSlug(task.title);
  const branchName = generateBranchName(task.id, slug);
  const baseBranch = task.baseBranch || getDefaultBaseBranch();

  try {
    // Create the task branch
    console.log(`[Queue] Creating branch: ${branchName} from ${baseBranch}`);
    await createBranch(branchName, baseBranch);

    // Update task with branch info
    await updateTask(task.id, {
      branch: branchName,
      branchStatus: 'created',
    });

    // Start the workflow (this will update status to briefing/planning/running)
    console.log(`[Queue] Triggering workflow for task: ${task.id}`);
    await runWorkflow(task.id);
  } catch (error) {
    console.error(`[Queue] Failed to start task ${task.id}:`, error);

    // Try to return to original branch on error
    try {
      const { checkoutBranch } = await import('./git.js');
      await checkoutBranch(originalBranch);
    } catch {
      // Ignore errors when returning to original branch
    }

    // Keep task in queue for retry (don't change status)
    throw error;
  }
}

/**
 * Process the queue - check for available slots and start next task
 */
export async function processQueue(): Promise<void> {
  // Prevent concurrent processing
  if (isProcessing) {
    return;
  }

  isProcessing = true;

  try {
    // Check how many tasks are currently running
    const runningCount = await getRunningTasksCount();

    if (runningCount >= MAX_CONCURRENT_TASKS) {
      // At capacity, skip this cycle
      return;
    }

    // Get next queued task
    const queuedTasks = await getQueuedTasks();

    if (queuedTasks.length === 0) {
      // No tasks in queue
      return;
    }

    // Calculate how many tasks we can start
    const availableSlots = MAX_CONCURRENT_TASKS - runningCount;
    const tasksToStart = queuedTasks.slice(0, availableSlots);

    // Start tasks (sequentially to avoid git conflicts)
    for (const task of tasksToStart) {
      try {
        await startQueuedTask(task);
      } catch (error) {
        console.error(`[Queue] Error starting task ${task.id}:`, error);
        // Continue with next task
      }
    }
  } catch (error) {
    console.error('[Queue] Error processing queue:', error);
  } finally {
    isProcessing = false;
  }
}

/**
 * Start the queue processor polling
 */
export function startQueueProcessor(): void {
  if (pollIntervalId) {
    console.log('[Queue] Processor already running');
    return;
  }

  console.log(`[Queue] Starting processor (interval: ${POLL_INTERVAL_MS}ms, max concurrent: ${MAX_CONCURRENT_TASKS})`);

  // Initial processing
  processQueue().catch(console.error);

  // Set up polling interval
  pollIntervalId = setInterval(() => {
    processQueue().catch(console.error);
  }, POLL_INTERVAL_MS);
}

/**
 * Stop the queue processor
 */
export function stopQueueProcessor(): void {
  if (pollIntervalId) {
    clearInterval(pollIntervalId);
    pollIntervalId = null;
    console.log('[Queue] Processor stopped');
  }
}

/**
 * Get queue processor configuration
 */
export function getQueueConfig(): { pollIntervalMs: number; maxConcurrentTasks: number } {
  return {
    pollIntervalMs: POLL_INTERVAL_MS,
    maxConcurrentTasks: MAX_CONCURRENT_TASKS,
  };
}
