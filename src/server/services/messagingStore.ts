import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type {
  MessagingStore,
  MessagingSession,
  MessagingPlatform,
  NotificationPreferences,
  AIConversationMessage,
  AIConversationHistory,
  MessagingSessionAI,
} from '../../types/index.js';
import { getFormicDir } from '../utils/paths.js';

/**
 * Messaging Store Service
 *
 * Manages persistent storage of messaging sessions in .formic/messaging.json.
 * Sessions link platform chat IDs to workspaces for command handling and notifications.
 */

const MESSAGING_FILE = 'messaging.json';
const STORE_VERSION = '1.0';

/**
 * Get the path to the messaging.json file
 */
function getMessagingPath(): string {
  return path.join(getFormicDir(), MESSAGING_FILE);
}

/**
 * Create a default messaging store structure
 */
function createDefaultStore(): MessagingStore {
  return {
    version: STORE_VERSION,
    sessions: [],
  };
}

/**
 * Ensure the .formic directory exists
 */
async function ensureFormicDir(): Promise<void> {
  const formicDir = getFormicDir();
  if (!existsSync(formicDir)) {
    await mkdir(formicDir, { recursive: true });
  }
}

/**
 * Load the messaging store from disk
 */
export async function loadMessagingStore(): Promise<MessagingStore> {
  await ensureFormicDir();

  const messagingPath = getMessagingPath();

  if (!existsSync(messagingPath)) {
    const defaultStore = createDefaultStore();
    await saveMessagingStore(defaultStore);
    return defaultStore;
  }

  try {
    const data = await readFile(messagingPath, 'utf-8');
    return JSON.parse(data) as MessagingStore;
  } catch (error) {
    const err = error as Error;
    console.error('[MessagingStore] Failed to load messaging.json:', err.message);
    return createDefaultStore();
  }
}

/**
 * Save the messaging store to disk
 */
export async function saveMessagingStore(store: MessagingStore): Promise<void> {
  await ensureFormicDir();
  const messagingPath = getMessagingPath();
  await writeFile(messagingPath, JSON.stringify(store, null, 2), 'utf-8');
}

/**
 * Generate a unique session ID from platform and chat ID
 */
export function generateSessionId(platform: MessagingPlatform, chatId: string): string {
  return `${platform}:${chatId}`;
}

/**
 * Get a session by platform and chat ID
 */
export async function getSession(
  platform: MessagingPlatform,
  chatId: string
): Promise<MessagingSession | undefined> {
  const store = await loadMessagingStore();
  const sessionId = generateSessionId(platform, chatId);
  return store.sessions.find((s) => s.id === sessionId);
}

/**
 * Get all sessions for a specific workspace
 */
export async function getSessionsByWorkspace(workspacePath: string): Promise<MessagingSession[]> {
  const store = await loadMessagingStore();
  return store.sessions.filter((s) => s.workspacePath === workspacePath);
}

/**
 * Get all sessions for a specific platform
 */
export async function getSessionsByPlatform(
  platform: MessagingPlatform
): Promise<MessagingSession[]> {
  const store = await loadMessagingStore();
  return store.sessions.filter((s) => s.platform === platform);
}

/**
 * Create or update a messaging session
 */
export async function upsertSession(
  platform: MessagingPlatform,
  chatId: string,
  userId: string,
  workspacePath: string,
  userName?: string
): Promise<MessagingSession> {
  const store = await loadMessagingStore();
  const sessionId = generateSessionId(platform, chatId);

  const existingIndex = store.sessions.findIndex((s) => s.id === sessionId);
  const now = new Date().toISOString();

  if (existingIndex >= 0) {
    // Update existing session
    store.sessions[existingIndex] = {
      ...store.sessions[existingIndex],
      userId,
      userName,
      workspacePath,
      lastActiveAt: now,
    };
    await saveMessagingStore(store);
    console.log(`[MessagingStore] Updated session ${sessionId}`);
    return store.sessions[existingIndex];
  }

  // Create new session with default notification preferences
  const newSession: MessagingSession = {
    id: sessionId,
    platform,
    chatId,
    userId,
    userName,
    workspacePath,
    notifications: {
      onTaskComplete: true,
      onTaskFailed: true,
      onReviewReady: true,
    },
    createdAt: now,
    lastActiveAt: now,
  };

  store.sessions.push(newSession);
  await saveMessagingStore(store);
  console.log(`[MessagingStore] Created new session ${sessionId}`);
  return newSession;
}

/**
 * Update a session's last active timestamp
 */
export async function touchSession(
  platform: MessagingPlatform,
  chatId: string
): Promise<void> {
  const store = await loadMessagingStore();
  const sessionId = generateSessionId(platform, chatId);

  const session = store.sessions.find((s) => s.id === sessionId);
  if (session) {
    session.lastActiveAt = new Date().toISOString();
    await saveMessagingStore(store);
  }
}

/**
 * Update notification preferences for a session
 */
export async function updateNotificationPreferences(
  platform: MessagingPlatform,
  chatId: string,
  preferences: Partial<NotificationPreferences>
): Promise<MessagingSession | null> {
  const store = await loadMessagingStore();
  const sessionId = generateSessionId(platform, chatId);

  const session = store.sessions.find((s) => s.id === sessionId);
  if (!session) {
    return null;
  }

  session.notifications = {
    ...session.notifications,
    ...preferences,
  };
  session.lastActiveAt = new Date().toISOString();

  await saveMessagingStore(store);
  console.log(`[MessagingStore] Updated notifications for ${sessionId}`);
  return session;
}

/**
 * Delete a session
 */
export async function deleteSession(
  platform: MessagingPlatform,
  chatId: string
): Promise<boolean> {
  const store = await loadMessagingStore();
  const sessionId = generateSessionId(platform, chatId);

  const initialLength = store.sessions.length;
  store.sessions = store.sessions.filter((s) => s.id !== sessionId);

  if (store.sessions.length < initialLength) {
    await saveMessagingStore(store);
    console.log(`[MessagingStore] Deleted session ${sessionId}`);
    return true;
  }

  return false;
}

/**
 * Get all sessions (for debugging/admin)
 */
export async function getAllSessions(): Promise<MessagingSession[]> {
  const store = await loadMessagingStore();
  return store.sessions;
}

/**
 * Clear all sessions (for testing)
 */
export async function clearAllSessions(): Promise<void> {
  const store = createDefaultStore();
  await saveMessagingStore(store);
  console.log('[MessagingStore] Cleared all sessions');
}

// ==================== AI Conversation History Functions ====================

/** Maximum number of messages to keep in conversation history */
const MAX_HISTORY = 100;

/**
 * Get a session as MessagingSessionAI with AI fields
 */
export async function getSessionAI(
  platform: MessagingPlatform,
  chatId: string
): Promise<MessagingSessionAI | undefined> {
  const session = await getSession(platform, chatId);
  if (!session) {
    return undefined;
  }
  // Return session with AI defaults if not present
  return {
    ...session,
    aiEnabled: (session as MessagingSessionAI).aiEnabled ?? false,
    conversationHistory: (session as MessagingSessionAI).conversationHistory,
  };
}

/**
 * Set AI mode enabled/disabled for a session
 */
export async function setAIModeEnabled(
  platform: MessagingPlatform,
  chatId: string,
  enabled: boolean
): Promise<MessagingSessionAI | null> {
  const store = await loadMessagingStore();
  const sessionId = generateSessionId(platform, chatId);

  const session = store.sessions.find((s) => s.id === sessionId) as MessagingSessionAI | undefined;
  if (!session) {
    return null;
  }

  session.aiEnabled = enabled;
  session.lastActiveAt = new Date().toISOString();

  // Initialize conversation history if enabling AI and not present
  if (enabled && !session.conversationHistory) {
    session.conversationHistory = {
      messages: [],
      lastUpdatedAt: new Date().toISOString(),
    };
  }

  await saveMessagingStore(store);
  console.log(`[MessagingStore] AI mode ${enabled ? 'enabled' : 'disabled'} for ${sessionId}`);
  return session;
}

/**
 * Get conversation history for a session
 */
export async function getConversationHistory(
  platform: MessagingPlatform,
  chatId: string
): Promise<AIConversationHistory | null> {
  const session = await getSessionAI(platform, chatId);
  if (!session) {
    return null;
  }
  return session.conversationHistory || { messages: [], lastUpdatedAt: new Date().toISOString() };
}

/**
 * Append a message to conversation history
 */
export async function appendConversationMessage(
  platform: MessagingPlatform,
  chatId: string,
  message: AIConversationMessage
): Promise<AIConversationHistory | null> {
  const store = await loadMessagingStore();
  const sessionId = generateSessionId(platform, chatId);

  const session = store.sessions.find((s) => s.id === sessionId) as MessagingSessionAI | undefined;
  if (!session) {
    return null;
  }

  // Initialize history if not present
  if (!session.conversationHistory) {
    session.conversationHistory = {
      messages: [],
      lastUpdatedAt: new Date().toISOString(),
    };
  }

  // Append message
  session.conversationHistory.messages.push(message);

  // Enforce MAX_HISTORY limit
  while (session.conversationHistory.messages.length > MAX_HISTORY) {
    session.conversationHistory.messages.shift();
  }

  session.conversationHistory.lastUpdatedAt = new Date().toISOString();
  session.lastActiveAt = new Date().toISOString();

  await saveMessagingStore(store);
  return session.conversationHistory;
}

/**
 * Clear conversation history for a session
 */
export async function clearConversationHistory(
  platform: MessagingPlatform,
  chatId: string
): Promise<boolean> {
  const store = await loadMessagingStore();
  const sessionId = generateSessionId(platform, chatId);

  const session = store.sessions.find((s) => s.id === sessionId) as MessagingSessionAI | undefined;
  if (!session) {
    return false;
  }

  session.conversationHistory = {
    messages: [],
    lastUpdatedAt: new Date().toISOString(),
  };
  session.lastActiveAt = new Date().toISOString();

  await saveMessagingStore(store);
  console.log(`[MessagingStore] Cleared conversation history for ${sessionId}`);
  return true;
}
