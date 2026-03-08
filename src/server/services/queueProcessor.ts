import { getQueuedTasks, getAllTasks, getRunningTasksCount, updateTask } from './store.js';
import { executeFullWorkflow, executeQuickTask, executeGoalWorkflow, isWorkflowRunning } from './workflow.js';
import { isAgentRunning } from './runner.js';
import { isFileLeased } from './leaseManager.js';
import { internalEvents, TASK_COMPLETED, LEASE_RELEASED } from './internalEvents.js';
import { prioritizeQueue } from './prioritizer.js';
import type { Task } from '../../types/index.js';

const POLL_INTERVAL_MS = parseInt(process.env.QUEUE_POLL_INTERVAL || '5000', 10);
const MAX_CONCURRENT_TASKS = parseInt(process.env.MAX_CONCURRENT_TASKS || '1', 10);
const MAX_YIELD_COUNT = parseInt(process.env.MAX_YIELD_COUNT || '50', 10);
const QUEUE_ENABLED = process.env.QUEUE_ENABLED !== 'false';

const YIELD_BACKOFF_INITIAL_MS = 2000;
const YIELD_BACKOFF_MULTIPLIER = 2;
const YIELD_BACKOFF_MAX_MS = 60_000;

/** Per-task exponential backoff delay (ms) for the next retry after a lease conflict */
const yieldBackoffMs = new Map<string, number>();
/** Per-task earliest timestamp (ms) at which the task may be retried */
const yieldUntil = new Map<string, number>();

let pollIntervalId: ReturnType<typeof setInterval> | null = null;
let isProcessing = false;

/**
 * Check if we can process another task (concurrency limit check)
 */
async function canProcessTask(): Promise<boolean> {
  const runningCount = await getRunningTasksCount();
  return runningCount < MAX_CONCURRENT_TASKS;
}

/**
 * Process the queue - check for tasks and start execution if slots available.
 * Loops through queued tasks, skipping those that have exceeded MAX_YIELD_COUNT.
 */
async function processQueue(): Promise<void> {
  // Prevent concurrent processing
  if (isProcessing) {
    return;
  }

  isProcessing = true;

  try {
    // Check if we can process more tasks
    if (!(await canProcessTask())) {
      return;
    }

    // Check if any agent is already running (legacy check for MAX_CONCURRENT_TASKS=1)
    if (MAX_CONCURRENT_TASKS <= 1 && isAgentRunning()) {
      return;
    }

    // Get all queued tasks
    const queuedTasks = await getQueuedTasks();
    if (queuedTasks.length === 0) {
      return;
    }

    // Dependency-aware re-prioritization: elevate tasks on the critical path
    const allTasks = await getAllTasks();
    const prioritizedTasks = prioritizeQueue(queuedTasks, allTasks);

    // Try each queued task until we find one we can start or run out of tasks
    // Track in-flight starts to prevent over-admission in the same poll cycle
    let inFlightCount = 0;

    for (const nextTask of prioritizedTasks) {
      // Re-check capacity before each task, including in-flight starts from this cycle
      const runningCount = await getRunningTasksCount();
      if (runningCount + inFlightCount >= MAX_CONCURRENT_TASKS) {
        break;
      }

      // Skip if workflow already running
      if (isWorkflowRunning(nextTask.id)) {
        continue;
      }

      // Skip tasks that are within their exponential backoff window
      if (Date.now() < (yieldUntil.get(nextTask.id) ?? 0)) {
        continue;
      }

      // Check yield count - skip tasks that have been yielded too many times
      if (nextTask.yieldCount && nextTask.yieldCount >= MAX_YIELD_COUNT) {
        console.warn(`[QueueProcessor] Task ${nextTask.id} exceeded max yield count (${MAX_YIELD_COUNT}), skipping`);
        continue;
      }

      // Detect the first exclusive file currently held by another task
      const exclusiveFiles = nextTask.declaredFiles?.exclusive ?? [];
      let conflictingFile: string | null = null;
      for (const filePath of exclusiveFiles) {
        if (isFileLeased(filePath, nextTask.id)) {
          conflictingFile = filePath;
          break;
        }
      }

      if (conflictingFile !== null) {
        // Compute and record exponential backoff
        const prevBackoff = yieldBackoffMs.get(nextTask.id) ?? (YIELD_BACKOFF_INITIAL_MS / YIELD_BACKOFF_MULTIPLIER);
        const nextBackoff = Math.min(prevBackoff * YIELD_BACKOFF_MULTIPLIER, YIELD_BACKOFF_MAX_MS);
        yieldBackoffMs.set(nextTask.id, nextBackoff);
        yieldUntil.set(nextTask.id, Date.now() + nextBackoff);

        const reason = `lease-conflict:${conflictingFile}`;
        console.log(`[QueueProcessor] Task ${nextTask.id} yielding — ${reason} (backoff ${nextBackoff}ms)`);
        try {
          await updateTask(nextTask.id, { yieldReason: reason });
        } catch (err) {
          console.warn('[QueueProcessor] Failed to persist yieldReason:', err instanceof Error ? err.message : 'Unknown error');
        }
        // Continue scanning — do not wait for next poll cycle
        continue;
      }

      console.log(`[QueueProcessor] Starting task ${nextTask.id}: ${nextTask.title}`);

      // Clear any stale backoff state for this task before dispatching
      yieldBackoffMs.delete(nextTask.id);
      yieldUntil.delete(nextTask.id);

      // Check task type and execute appropriate workflow
      if (nextTask.type === 'quick') {
        console.log(`[QueueProcessor] Task ${nextTask.id} is a quick task - skipping brief/plan stages`);
        await executeQuickTask(nextTask.id);
      } else if (nextTask.type === 'goal') {
        console.log(`[QueueProcessor] Task ${nextTask.id} is a goal task - running architect decomposition`);
        await executeGoalWorkflow(nextTask.id);
      } else {
        await executeFullWorkflow(nextTask.id);
      }

      inFlightCount++;

      // For single-task mode, only start one task per poll cycle
      if (MAX_CONCURRENT_TASKS <= 1) {
        break;
      }
    }

  } catch (error) {
    const err = error as Error;
    console.error('[QueueProcessor] Error processing queue:', err.message);
  } finally {
    isProcessing = false;
  }
}

/**
 * Wake the queue processor immediately — bypasses the polling interval.
 * Called when a task completes or leases are released so queued tasks
 * can proceed without waiting for the next POLL_INTERVAL_MS tick.
 */
export function wakeQueueProcessor(): void {
  if (!QUEUE_ENABLED || isProcessing) {
    return;
  }
  console.log('[QueueProcessor] Woken by event');
  void processQueue();
}

/**
 * Start the queue processor polling loop
 */
export function startQueueProcessor(): void {
  if (!QUEUE_ENABLED) {
    console.log('[QueueProcessor] Queue processing is disabled (QUEUE_ENABLED=false)');
    return;
  }

  if (pollIntervalId !== null) {
    console.log('[QueueProcessor] Queue processor already running');
    return;
  }

  console.log(`[QueueProcessor] Starting queue processor (poll: ${POLL_INTERVAL_MS}ms, max concurrent: ${MAX_CONCURRENT_TASKS})`);

  // Subscribe to internal wake events
  internalEvents.on(TASK_COMPLETED, wakeQueueProcessor);
  internalEvents.on(LEASE_RELEASED, wakeQueueProcessor);

  // Run immediately on start
  processQueue();

  // Set up polling interval
  pollIntervalId = setInterval(processQueue, POLL_INTERVAL_MS);
}

/**
 * Stop the queue processor polling loop
 */
export function stopQueueProcessor(): void {
  if (pollIntervalId !== null) {
    clearInterval(pollIntervalId);
    pollIntervalId = null;

    // Unsubscribe internal wake event listeners
    internalEvents.off(TASK_COMPLETED, wakeQueueProcessor);
    internalEvents.off(LEASE_RELEASED, wakeQueueProcessor);

    console.log('[QueueProcessor] Queue processor stopped');
  }
}

/**
 * Pause the queue processor (called by the kill switch after max retries).
 */
export function pauseQueueProcessor(): void {
  stopQueueProcessor();
  console.log('[QueueProcessor] Queue paused by kill switch');
}

/**
 * Check if queue processor is running
 */
export function isQueueProcessorRunning(): boolean {
  return pollIntervalId !== null;
}

/**
 * Get queue processor configuration
 */
export function getQueueProcessorConfig(): {
  enabled: boolean;
  pollInterval: number;
  maxConcurrent: number;
  isRunning: boolean;
} {
  return {
    enabled: QUEUE_ENABLED,
    pollInterval: POLL_INTERVAL_MS,
    maxConcurrent: MAX_CONCURRENT_TASKS,
    isRunning: isQueueProcessorRunning(),
  };
}

/**
 * Get the position of a task in the queue (1-indexed)
 * Returns 0 if the task is not in the queue
 */
export async function getQueuePosition(taskId: string): Promise<number> {
  const queuedTasks = await getQueuedTasks();
  const index = queuedTasks.findIndex(t => t.id === taskId);
  return index === -1 ? 0 : index + 1;
}
