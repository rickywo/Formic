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

/** Shared internal event emitter instance */
export const internalEvents = new EventEmitter();
