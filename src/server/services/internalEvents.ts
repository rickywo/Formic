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

/** Event name emitted when task-scoped transcript usage is persisted */
export const USAGE_UPDATED = 'usage-updated';

/** Shared internal event emitter instance */
export const internalEvents = new EventEmitter();
