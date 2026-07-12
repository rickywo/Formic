import { readFile, writeFile, mkdir, chmod, rename, unlink } from 'node:fs/promises';
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

/** Serializes complete messaging-store read-modify-write cycles. */
let messagingMutationLock: Promise<void> = Promise.resolve();

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
async function loadMessagingStoreFromDisk(): Promise<MessagingStore> {
  await ensureFormicDir();

  const messagingPath = getMessagingPath();

  if (!existsSync(messagingPath)) {
    return createDefaultStore();
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
 * Persist the messaging store atomically with owner-only permissions.
 */
async function writeMessagingStoreAtomic(store: MessagingStore): Promise<void> {
  await ensureFormicDir();
  const messagingPath = getMessagingPath();
  const tempPath = `${messagingPath}.${process.pid}.${Date.now()}.tmp`;

  try {
    await writeFile(tempPath, JSON.stringify(store, null, 2), { mode: 0o600, encoding: 'utf-8' });
    await chmod(tempPath, 0o600);
    await rename(tempPath, messagingPath);
    await chmod(messagingPath, 0o600);
  } catch (error) {
    try {
      await unlink(tempPath);
    } catch (cleanupError) {
      const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : 'Unknown error';
      if (!cleanupMessage.includes('ENOENT')) {
        console.warn(`[MessagingStore] Failed to clean up temporary store file: ${cleanupMessage}`);
      }
    }
    throw error;
  }
}

/**
 * Run a serialized read-modify-write operation against messaging.json.
 * The lock covers the complete cycle so concurrent session and webhook-secret
 * updates cannot overwrite each other with stale snapshots.
 */
export async function updateMessagingStore<T>(
  mutator: (store: MessagingStore) => T | Promise<T>
): Promise<T> {
  const resultPromise = messagingMutationLock.then(async () => {
    const store = await loadMessagingStoreFromDisk();
    const result = await mutator(store);
    await writeMessagingStoreAtomic(store);
    return result;
  });

  messagingMutationLock = resultPromise.then(() => undefined, () => undefined);
  return resultPromise;
}

/** Load a consistent snapshot after all queued mutations finish. */
export async function loadMessagingStore(): Promise<MessagingStore> {
  await messagingMutationLock;
  return loadMessagingStoreFromDisk();
}

/** Replace the store through the same serialized, atomic write path. */
export async function saveMessagingStore(store: MessagingStore): Promise<void> {
  await updateMessagingStore((current) => {
    current.version = store.version;
    current.sessions = store.sessions;
    current.telegramWebhookSecret = store.telegramWebhookSecret;
  });
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
  return updateMessagingStore((store) => {
    const sessionId = generateSessionId(platform, chatId);
    const existingIndex = store.sessions.findIndex((s) => s.id === sessionId);
    const now = new Date().toISOString();

    if (existingIndex >= 0) {
      store.sessions[existingIndex] = {
        ...store.sessions[existingIndex],
        userId,
        userName,
        workspacePath,
        lastActiveAt: now,
      };
      console.warn(`[MessagingStore] Updated session ${sessionId}`);
      return store.sessions[existingIndex];
    }

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
    console.warn(`[MessagingStore] Created new session ${sessionId}`);
    return newSession;
  });
}

/**
 * Update a session's last active timestamp
 */
export async function touchSession(
  platform: MessagingPlatform,
  chatId: string
): Promise<void> {
  await updateMessagingStore((store) => {
    const sessionId = generateSessionId(platform, chatId);
    const session = store.sessions.find((s) => s.id === sessionId);
    if (session) session.lastActiveAt = new Date().toISOString();
  });
}

/**
 * Update notification preferences for a session
 */
export async function updateNotificationPreferences(
  platform: MessagingPlatform,
  chatId: string,
  preferences: Partial<NotificationPreferences>
): Promise<MessagingSession | null> {
  return updateMessagingStore((store) => {
    const sessionId = generateSessionId(platform, chatId);
    const session = store.sessions.find((s) => s.id === sessionId);
    if (!session) return null;

    session.notifications = { ...session.notifications, ...preferences };
    session.lastActiveAt = new Date().toISOString();
    console.warn(`[MessagingStore] Updated notifications for ${sessionId}`);
    return session;
  });
}

/**
 * Delete a session
 */
export async function deleteSession(
  platform: MessagingPlatform,
  chatId: string
): Promise<boolean> {
  return updateMessagingStore((store) => {
    const sessionId = generateSessionId(platform, chatId);
    const initialLength = store.sessions.length;
    store.sessions = store.sessions.filter((s) => s.id !== sessionId);
    const deleted = store.sessions.length < initialLength;
    if (deleted) console.warn(`[MessagingStore] Deleted session ${sessionId}`);
    return deleted;
  });
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
  await updateMessagingStore((store) => {
    store.sessions = [];
  });
  console.warn('[MessagingStore] Cleared all sessions');
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
  return updateMessagingStore((store) => {
    const sessionId = generateSessionId(platform, chatId);
    const session = store.sessions.find((s) => s.id === sessionId) as MessagingSessionAI | undefined;
    if (!session) return null;

    session.aiEnabled = enabled;
    session.lastActiveAt = new Date().toISOString();
    if (enabled && !session.conversationHistory) {
      session.conversationHistory = { messages: [], lastUpdatedAt: new Date().toISOString() };
    }

    console.warn(`[MessagingStore] AI mode ${enabled ? 'enabled' : 'disabled'} for ${sessionId}`);
    return session;
  });
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
  return updateMessagingStore((store) => {
    const sessionId = generateSessionId(platform, chatId);
    const session = store.sessions.find((s) => s.id === sessionId) as MessagingSessionAI | undefined;
    if (!session) return null;

    if (!session.conversationHistory) {
      session.conversationHistory = { messages: [], lastUpdatedAt: new Date().toISOString() };
    }
    session.conversationHistory.messages.push(message);
    while (session.conversationHistory.messages.length > MAX_HISTORY) {
      session.conversationHistory.messages.shift();
    }
    session.conversationHistory.lastUpdatedAt = new Date().toISOString();
    session.lastActiveAt = new Date().toISOString();
    return session.conversationHistory;
  });
}

/**
 * Clear conversation history for a session
 */
export async function clearConversationHistory(
  platform: MessagingPlatform,
  chatId: string
): Promise<boolean> {
  return updateMessagingStore((store) => {
    const sessionId = generateSessionId(platform, chatId);
    const session = store.sessions.find((s) => s.id === sessionId) as MessagingSessionAI | undefined;
    if (!session) return false;

    session.conversationHistory = { messages: [], lastUpdatedAt: new Date().toISOString() };
    session.lastActiveAt = new Date().toISOString();
    console.warn(`[MessagingStore] Cleared conversation history for ${sessionId}`);
    return true;
  });
}
