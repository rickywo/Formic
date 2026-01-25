import type { WebSocket } from 'ws';

/**
 * Board Notifier Service
 *
 * Manages WebSocket connections subscribed to board update notifications.
 * Broadcasts `board-updated` events when the board state changes (e.g., task created).
 */

// Track connections that want board update notifications
const boardConnections = new Set<WebSocket>();

/**
 * Register a WebSocket connection for board update notifications
 */
export function registerBoardConnection(ws: WebSocket): void {
  boardConnections.add(ws);
  console.log('[BoardNotifier] Connection registered, total:', boardConnections.size);
}

/**
 * Unregister a WebSocket connection from board update notifications
 */
export function unregisterBoardConnection(ws: WebSocket): void {
  boardConnections.delete(ws);
  console.log('[BoardNotifier] Connection unregistered, total:', boardConnections.size);
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

  console.log('[BoardNotifier] Broadcast board-updated to', sentCount, 'clients');
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

  console.log('[BoardNotifier] Broadcast workspace-changed to', sentCount, 'clients');
}
