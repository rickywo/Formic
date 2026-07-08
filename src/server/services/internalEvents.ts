/**
 * Internal Event Emitter
 *
 * Lightweight shared EventEmitter used to decouple service-to-service
 * notifications (e.g., queue wake-up signals) without creating circular imports.
 */

import { EventEmitter } from 'node:events';

/** Event name emitted when a task transitions to 'review' or 'done' */
export const TASK_COMPLETED = 'task-completed';

/** Event name emitted when a task's file leases are released */
export const LEASE_RELEASED = 'lease-released';

/** Event name emitted when a new task is created */
export const TASK_CREATED = 'task-created';

/** Event name emitted when a task moves to queued status */
export const TASK_QUEUED = 'task-queued';

/** Event name emitted before a task execution starts */
export const BEFORE_EXECUTE = 'before-execute';

/** Event name emitted after a task execution completes (success or fail) */
export const AFTER_EXECUTE = 'after-execute';

/** Event name emitted when a task fails */
export const TASK_FAILED = 'task-failed';

/** Event name emitted when a skill file is loaded */
export const SKILL_LOADED = 'skill-loaded';

/** Event name emitted when file leases are acquired */
export const LEASE_ACQUIRED = 'lease-acquired';

/** Event name emitted on any board state change */
export const BOARD_UPDATE = 'board-update';

/** Event name emitted after server initialization completes */
export const SERVER_STARTUP = 'server-startup';

/** Event name emitted on graceful shutdown */
export const SERVER_SHUTDOWN = 'server-shutdown';

/** Event name emitted before a skill file is loaded (allows just-in-time override registration) */
export const BEFORE_SKILL_LOAD = 'before-skill-load';

/** Event name emitted when a plugin stage is registered in the pipeline */
export const STAGE_REGISTERED = 'stage-registered';

/** Event name emitted when a plugin stage is unregistered from the pipeline */
export const STAGE_UNREGISTERED = 'stage-unregistered';

/** Event name emitted when a task is updated */
export const TASK_UPDATED = 'task-updated';

/** Event name emitted when a task transitions between workflow stages */
export const TASK_STAGE_CHANGED = 'task-stage-changed';

/** Event name emitted when a plugin registers a new custom task type */
export const TASK_TYPE_REGISTERED = 'task-type-registered';

/** Shared internal event emitter instance */
export const internalEvents = new EventEmitter();

/**
 * Task stopper callback: stops the process(es) executing a task and resolves
 * true once the stop has been carried out, false if the task could not be stopped.
 */
export type TaskStopper = (taskId: string) => Promise<boolean>;

/** Injected task stopper — registered by workflow.ts at module init */
let taskStopper: TaskStopper | null = null;

/**
 * Register the task stopper callback. Used by workflow.ts to expose its
 * stop capability to lower-level services (e.g., leaseManager) without
 * creating a circular import.
 */
export function registerTaskStopper(fn: TaskStopper): void {
  taskStopper = fn;
}

/**
 * Request that a task's running process be stopped via the registered stopper.
 * Returns false when no stopper is registered or the stopper fails — callers
 * MUST treat false as "the task may still be running" and refuse any action
 * that assumes the process is dead (e.g., force-releasing its file leases).
 */
export async function requestTaskStop(taskId: string): Promise<boolean> {
  if (!taskStopper) {
    console.warn(`[InternalEvents] No task stopper registered — cannot stop task ${taskId}`);
    return false;
  }
  try {
    return await taskStopper(taskId);
  } catch (err) {
    console.error(`[InternalEvents] Task stopper failed for ${taskId}:`, err instanceof Error ? err.message : 'Unknown error');
    return false;
  }
}
