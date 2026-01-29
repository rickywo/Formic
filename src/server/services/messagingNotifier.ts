import type { Task, MessagingSession, OutgoingMessage } from '../../types/index.js';
import { getSessionsByWorkspace } from './messagingStore.js';
import { formatTaskNotification } from './messagingAdapter.js';
import { sendTelegramNotification, isTelegramConfigured } from './telegramAdapter.js';
import { sendLineNotification, isLineConfigured } from './lineAdapter.js';
import { getWorkspacePath } from '../utils/paths.js';

/**
 * Messaging Notifier Service
 *
 * Sends notifications to linked messaging sessions when task status changes.
 * Integrates with the boardNotifier system to receive task events.
 */

// Track previous task statuses to detect changes
const taskStatusCache = new Map<string, Task['status']>();

/**
 * Send a notification to a specific session
 */
async function sendNotificationToSession(
  session: MessagingSession,
  message: OutgoingMessage
): Promise<void> {
  const notificationMessage = { ...message, chatId: session.chatId };

  switch (session.platform) {
    case 'telegram':
      if (isTelegramConfigured()) {
        await sendTelegramNotification(session.chatId, notificationMessage);
      }
      break;
    case 'line':
      if (isLineConfigured()) {
        await sendLineNotification(session.chatId, notificationMessage);
      }
      break;
  }
}

/**
 * Notify all relevant sessions about a task event
 */
async function notifyTaskEvent(
  task: Task,
  event: 'completed' | 'failed' | 'review'
): Promise<void> {
  const workspacePath = getWorkspacePath();
  const sessions = await getSessionsByWorkspace(workspacePath);

  if (sessions.length === 0) {
    return;
  }

  const notification = formatTaskNotification(task, event);

  // Filter sessions based on notification preferences
  const eligibleSessions = sessions.filter((session) => {
    switch (event) {
      case 'completed':
        return session.notifications.onTaskComplete;
      case 'failed':
        return session.notifications.onTaskFailed;
      case 'review':
        return session.notifications.onReviewReady;
      default:
        return false;
    }
  });

  console.log(`[MessagingNotifier] Sending '${event}' notification for task ${task.id} to ${eligibleSessions.length} sessions`);

  // Send notifications to all eligible sessions
  await Promise.all(
    eligibleSessions.map((session) => sendNotificationToSession(session, notification))
  );
}

/**
 * Check if a task status changed and send appropriate notifications
 */
export async function checkTaskStatusChange(task: Task): Promise<void> {
  const previousStatus = taskStatusCache.get(task.id);
  const currentStatus = task.status;

  // Update cache
  taskStatusCache.set(task.id, currentStatus);

  // No previous status means this is a new task - no notification needed
  if (!previousStatus) {
    return;
  }

  // Status didn't change
  if (previousStatus === currentStatus) {
    return;
  }

  console.log(`[MessagingNotifier] Task ${task.id} status changed: ${previousStatus} -> ${currentStatus}`);

  // Determine notification type based on transition
  if (currentStatus === 'done') {
    // Task completed successfully
    await notifyTaskEvent(task, 'completed');
  } else if (currentStatus === 'review' && previousStatus !== 'done') {
    // Task moved to review (could be success or failure)
    // Check if it came from an active state (might indicate failure)
    const activeStates: Task['status'][] = ['briefing', 'planning', 'running'];
    if (activeStates.includes(previousStatus)) {
      // Check workflow step to determine if it completed normally
      if (task.workflowStep === 'complete') {
        await notifyTaskEvent(task, 'review');
      } else {
        // Task was stopped or failed mid-workflow
        await notifyTaskEvent(task, 'failed');
      }
    } else {
      await notifyTaskEvent(task, 'review');
    }
  }
}

/**
 * Initialize status cache with current tasks
 * Called at server startup to avoid false notifications
 */
export function initializeStatusCache(tasks: Task[]): void {
  taskStatusCache.clear();
  for (const task of tasks) {
    taskStatusCache.set(task.id, task.status);
  }
  console.log(`[MessagingNotifier] Initialized status cache with ${tasks.length} tasks`);
}

/**
 * Clear status cache (for testing)
 */
export function clearStatusCache(): void {
  taskStatusCache.clear();
}

/**
 * Get current cache size (for debugging)
 */
export function getStatusCacheSize(): number {
  return taskStatusCache.size;
}

/**
 * Check all tasks for status changes
 * This can be called periodically or after board updates
 */
export async function checkAllTasksForChanges(tasks: Task[]): Promise<void> {
  for (const task of tasks) {
    await checkTaskStatusChange(task);
  }
}

/**
 * Send a custom notification to all sessions for a workspace
 */
export async function broadcastToWorkspace(
  workspacePath: string,
  message: OutgoingMessage
): Promise<void> {
  const sessions = await getSessionsByWorkspace(workspacePath);

  if (sessions.length === 0) {
    return;
  }

  console.log(`[MessagingNotifier] Broadcasting to ${sessions.length} sessions`);

  await Promise.all(
    sessions.map((session) => sendNotificationToSession(session, message))
  );
}

/**
 * Send a test notification to verify messaging is working
 */
export async function sendTestNotification(
  workspacePath: string
): Promise<{ sent: number; failed: number }> {
  const sessions = await getSessionsByWorkspace(workspacePath);

  const results = { sent: 0, failed: 0 };

  const testMessage: OutgoingMessage = {
    chatId: '',
    text: '🧪 *Test Notification*\n\nThis is a test message from Formic. If you see this, notifications are working!',
    parseMode: 'markdown',
  };

  for (const session of sessions) {
    try {
      await sendNotificationToSession(session, testMessage);
      results.sent++;
    } catch (error) {
      results.failed++;
    }
  }

  return results;
}
