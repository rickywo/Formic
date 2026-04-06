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
export const TASK_UPDATED = 'task:updated';

/** Event name emitted when a task transitions between workflow stages */
export const STAGE_CHANGED = 'stage:changed';

/** Shared internal event emitter instance */
export const internalEvents = new EventEmitter();
