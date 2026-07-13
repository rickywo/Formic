import type { WebSocket } from 'ws';
import type { LogMessage } from '../../types/index.js';

/**
 * Board Notifier Service
 *
 * Manages WebSocket connections subscribed to board update notifications.
 * Broadcasts `board-updated` events when the board state changes (e.g., task created).
 */

// Track connections that want board update notifications
const boardConnections = new Set<WebSocket>();

// Track per-task WebSocket connections for terminal log streaming
const taskConnections = new Map<string, Set<WebSocket>>();

export function registerTaskConnection(taskId: string, ws: WebSocket): void {
  if (!taskConnections.has(taskId)) {
    taskConnections.set(taskId, new Set());
  }
  taskConnections.get(taskId)!.add(ws);
}

export function unregisterTaskConnection(taskId: string, ws: WebSocket): void {
  const connections = taskConnections.get(taskId);
  if (connections) {
    connections.delete(ws);
    if (connections.size === 0) {
      taskConnections.delete(taskId);
    }
  }
}

export function broadcastToTask(taskId: string, message: LogMessage): void {
  const connections = taskConnections.get(taskId);
  if (!connections) return;

  const data = JSON.stringify(message);
  for (const ws of connections) {
    if (ws.readyState === 1) { // WebSocket.OPEN
      ws.send(data);
    }
  }
}

/**
 * Register a WebSocket connection for board update notifications
 */
export function registerBoardConnection(ws: WebSocket): void {
  boardConnections.add(ws);
  console.warn('[BoardNotifier] Connection registered, total:', boardConnections.size);
}

/**
 * Unregister a WebSocket connection from board update notifications
 */
export function unregisterBoardConnection(ws: WebSocket): void {
  boardConnections.delete(ws);
  console.warn('[BoardNotifier] Connection unregistered, total:', boardConnections.size);
}

/**
 * Broadcast a board-updated event to all connected clients
 * Call this after any operation that modifies the board state
 */
export function broadcastBoardUpdate(): void {
  const message = JSON.stringify({ type: 'board-updated' });

  let sentCount = 0;
  for (const ws of boardConnections) {
    if (ws.readyState === 1) { // WebSocket.OPEN
      ws.send(message);
      sentCount++;
    }
  }

  console.warn('[BoardNotifier] Broadcast board-updated to', sentCount, 'clients');
}

/**
 * Broadcast usage changes to all connected clients. An empty task list means
 * the change is non-task usage and therefore must not update any task badge.
 */
export function broadcastUsageUpdated(taskIds: string[]): void {
  const message = JSON.stringify({ type: 'usage-updated', taskIds });

  let sentCount = 0;
  for (const ws of boardConnections) {
    if (ws.readyState === 1) { // WebSocket.OPEN
      ws.send(message);
      sentCount++;
    }
  }

  console.warn('[BoardNotifier] Broadcast usage-updated to', sentCount, 'clients');
}

/**
 * Broadcast a dependency-resolved event when a blocked task is automatically unblocked
 */
export function broadcastDependencyResolved(taskId: string, parentGoalId: string): void {
  const message = JSON.stringify({ type: 'dependency-resolved', taskId, parentGoalId });

  let sentCount = 0;
  for (const ws of boardConnections) {
    if (ws.readyState === 1) { // WebSocket.OPEN
      ws.send(message);
      sentCount++;
    }
  }

  console.warn(`[BoardNotifier] Broadcast dependency-resolved for task ${taskId} (goal ${parentGoalId}) to ${sentCount} clients`);
}

/**
 * Broadcast that a task has completed (moved to review or done)
 */
export function broadcastTaskCompleted(taskId: string): void {
  const message = JSON.stringify({ type: 'task-completed', taskId });

  let sentCount = 0;
  for (const ws of boardConnections) {
    if (ws.readyState === 1) { // WebSocket.OPEN
      ws.send(message);
      sentCount++;
    }
  }

  console.warn(`[BoardNotifier] Broadcast task-completed for task ${taskId} to ${sentCount} clients`);
}

/**
 * Broadcast that exclusive leases for a task have been released
 */
export function broadcastLeaseReleased(taskId: string, releasedFiles: string[]): void {
  const message = JSON.stringify({ type: 'lease-released', taskId, releasedFiles });

  let sentCount = 0;
  for (const ws of boardConnections) {
    if (ws.readyState === 1) { // WebSocket.OPEN
      ws.send(message);
      sentCount++;
    }
  }

  console.warn(`[BoardNotifier] Broadcast lease-released for task ${taskId} (${releasedFiles.length} file(s)) to ${sentCount} clients`);
}

/**
 * Broadcast a workspace-changed event to all connected clients
 * Call this after switching to a different workspace
 */
export function broadcastWorkspaceChanged(workspacePath: string): void {
  const message = JSON.stringify({
    type: 'workspace-changed',
    path: workspacePath,
  });

  let sentCount = 0;
  for (const ws of boardConnections) {
    if (ws.readyState === 1) { // WebSocket.OPEN
      ws.send(message);
      sentCount++;
    }
  }

  console.warn('[BoardNotifier] Broadcast workspace-changed to', sentCount, 'clients');
}
