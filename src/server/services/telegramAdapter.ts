import { readFile } from 'node:fs/promises';
import type {
  IncomingMessage,
  OutgoingMessage,
  SendMessageResult,
  MediaAttachment,
} from '../../types/index.js';
import {
  handleIncomingMessage,
  handleCallback,
  getMessagingConfig,
  parseCommand,
} from './messagingAdapter.js';
import { getSessionAI } from './messagingStore.js';

/**
 * Telegram Adapter Service
 *
 * Handles Telegram-specific webhook parsing, signature verification,
 * and Bot API calls. Uses the generic messaging adapter for command handling.
 */

const TELEGRAM_API_BASE = 'https://api.telegram.org';

// Telegram update types
interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
}

interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  chat_instance: string;
  data?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

interface TelegramInlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

interface TelegramInlineKeyboardMarkup {
  inline_keyboard: TelegramInlineKeyboardButton[][];
}

interface TelegramSendMessageParams {
  chat_id: number | string;
  text: string;
  parse_mode?: 'Markdown' | 'HTML';
  reply_markup?: TelegramInlineKeyboardMarkup;
}

interface TelegramSendPhotoParams {
  chat_id: number | string;
  photo: string; // URL or file_id
  caption?: string;
  parse_mode?: 'Markdown' | 'HTML';
  reply_markup?: TelegramInlineKeyboardMarkup;
}

/**
 * Check if Telegram is configured
 */
export function isTelegramConfigured(): boolean {
  const config = getMessagingConfig();
  return config.telegram.enabled;
}

/**
 * Get the Telegram bot token
 */
function getBotToken(): string {
  const config = getMessagingConfig();
  if (!config.telegram.botToken) {
    throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  }
  return config.telegram.botToken;
}

/**
 * Make a Telegram Bot API call
 */
async function callTelegramApi<T>(
  method: string,
  params: object
): Promise<T> {
  const token = getBotToken();
  const url = `${TELEGRAM_API_BASE}/bot${token}/${method}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params),
  });

  const result = await response.json() as { ok: boolean; result?: T; description?: string };

  if (!result.ok) {
    throw new Error(`Telegram API error: ${result.description || 'Unknown error'}`);
  }

  return result.result as T;
}

/**
 * Make a Telegram Bot API call with multipart/form-data (for file uploads)
 */
async function callTelegramApiMultipart<T>(
  method: string,
  formData: FormData
): Promise<T> {
  const token = getBotToken();
  const url = `${TELEGRAM_API_BASE}/bot${token}/${method}`;

  const response = await fetch(url, {
    method: 'POST',
    body: formData,
  });

  const result = await response.json() as { ok: boolean; result?: T; description?: string };

  if (!result.ok) {
    throw new Error(`Telegram API error: ${result.description || 'Unknown error'}`);
  }

  return result.result as T;
}

/**
 * Send a photo via Telegram Bot API
 * Supports URL, file path, or base64 buffer sources
 */
export async function sendTelegramPhoto(
  chatId: string,
  media: MediaAttachment,
  parseMode?: 'markdown' | 'html' | 'plain',
  buttons?: OutgoingMessage['buttons']
): Promise<SendMessageResult> {
  try {
    if (media.source === 'url') {
      // For URLs, use the simple JSON API
      const params: TelegramSendPhotoParams = {
        chat_id: chatId,
        photo: media.data,
      };

      if (media.caption) {
        params.caption = media.caption;
      }

      if (parseMode === 'markdown') {
        params.parse_mode = 'Markdown';
      } else if (parseMode === 'html') {
        params.parse_mode = 'HTML';
      }

      if (buttons && buttons.length > 0) {
        const keyboard: TelegramInlineKeyboardButton[][] = [];
        const row: TelegramInlineKeyboardButton[] = [];
        for (const button of buttons) {
          if (button.type === 'url') {
            row.push({ text: button.label, url: button.data });
          } else {
            row.push({ text: button.label, callback_data: button.data });
          }
        }
        keyboard.push(row);
        params.reply_markup = { inline_keyboard: keyboard };
      }

      const result = await callTelegramApi<{ message_id: number }>('sendPhoto', params);
      return {
        success: true,
        messageId: String(result.message_id),
      };
    }

    // For file or buffer sources, use multipart/form-data
    const formData = new FormData();
    formData.append('chat_id', chatId);

    if (media.source === 'file') {
      // Read file from disk
      const fileBuffer = await readFile(media.data);
      const fileName = media.data.split('/').pop() || 'photo.png';
      const blob = new Blob([fileBuffer], { type: 'image/png' });
      formData.append('photo', blob, fileName);
    } else if (media.source === 'buffer') {
      // media.data is base64-encoded
      const buffer = Buffer.from(media.data, 'base64');
      const blob = new Blob([buffer], { type: 'image/png' });
      formData.append('photo', blob, 'screenshot.png');
    }

    if (media.caption) {
      formData.append('caption', media.caption);
    }

    if (parseMode === 'markdown') {
      formData.append('parse_mode', 'Markdown');
    } else if (parseMode === 'html') {
      formData.append('parse_mode', 'HTML');
    }

    if (buttons && buttons.length > 0) {
      const keyboard: TelegramInlineKeyboardButton[][] = [];
      const row: TelegramInlineKeyboardButton[] = [];
      for (const button of buttons) {
        if (button.type === 'url') {
          row.push({ text: button.label, url: button.data });
        } else {
          row.push({ text: button.label, callback_data: button.data });
        }
      }
      keyboard.push(row);
      formData.append('reply_markup', JSON.stringify({ inline_keyboard: keyboard }));
    }

    const result = await callTelegramApiMultipart<{ message_id: number }>('sendPhoto', formData);
    return {
      success: true,
      messageId: String(result.message_id),
    };
  } catch (error) {
    const err = error as Error;
    console.error('[TelegramAdapter] Failed to send photo:', err.message);
    return {
      success: false,
      error: err.message,
    };
  }
}

/**
 * Parse a Telegram webhook update into a normalized IncomingMessage
 */
export function parseTelegramUpdate(update: TelegramUpdate): IncomingMessage | null {
  const message = update.message;

  if (!message || !message.text || !message.from) {
    return null;
  }

  // Build user display name
  let userName = message.from.first_name;
  if (message.from.last_name) {
    userName += ` ${message.from.last_name}`;
  }
  if (message.from.username) {
    userName = `@${message.from.username}`;
  }

  return {
    platform: 'telegram',
    chatId: String(message.chat.id),
    userId: String(message.from.id),
    userName,
    text: message.text,
    messageId: String(message.message_id),
    timestamp: new Date(message.date * 1000).toISOString(),
  };
}

/**
 * Convert OutgoingMessage to Telegram API parameters
 */
function toTelegramParams(message: OutgoingMessage): TelegramSendMessageParams {
  const params: TelegramSendMessageParams = {
    chat_id: message.chatId,
    text: message.text,
  };

  // Set parse mode
  if (message.parseMode === 'markdown') {
    params.parse_mode = 'Markdown';
  } else if (message.parseMode === 'html') {
    params.parse_mode = 'HTML';
  }

  // Convert buttons to inline keyboard
  if (message.buttons && message.buttons.length > 0) {
    const keyboard: TelegramInlineKeyboardButton[][] = [];
    const row: TelegramInlineKeyboardButton[] = [];

    for (const button of message.buttons) {
      if (button.type === 'url') {
        row.push({ text: button.label, url: button.data });
      } else {
        row.push({ text: button.label, callback_data: button.data });
      }
    }

    keyboard.push(row);
    params.reply_markup = { inline_keyboard: keyboard };
  }

  return params;
}

/**
 * Send a message via Telegram Bot API
 * Routes to sendTelegramPhoto if media is present
 */
export async function sendTelegramMessage(message: OutgoingMessage): Promise<SendMessageResult> {
  try {
    // Check if message contains media - route to photo handler
    if (message.media && message.media.type === 'photo') {
      return sendTelegramPhoto(
        message.chatId,
        message.media,
        message.parseMode,
        message.buttons
      );
    }

    const params = toTelegramParams(message);
    const result = await callTelegramApi<{ message_id: number }>('sendMessage', params);

    return {
      success: true,
      messageId: String(result.message_id),
    };
  } catch (error) {
    const err = error as Error;
    console.error('[TelegramAdapter] Failed to send message:', err.message);
    return {
      success: false,
      error: err.message,
    };
  }
}

/**
 * Send typing indicator to show the bot is processing
 */
export async function sendTypingIndicator(chatId: string): Promise<void> {
  try {
    await callTelegramApi('sendChatAction', {
      chat_id: chatId,
      action: 'typing',
    });
  } catch (error) {
    const err = error as Error;
    console.error('[TelegramAdapter] Failed to send typing indicator:', err.message);
    // Don't throw - typing indicator is optional
  }
}

/**
 * Answer a callback query (acknowledge button press)
 */
async function answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
  try {
    await callTelegramApi('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text,
    });
  } catch (error) {
    const err = error as Error;
    console.error('[TelegramAdapter] Failed to answer callback query:', err.message);
  }
}

/**
 * Check if a message will require AI processing (potentially slow)
 */
async function willUseAIProcessing(message: IncomingMessage): Promise<boolean> {
  // Commands are always fast
  const command = parseCommand(message.text);
  if (command) {
    return false;
  }

  // Check if AI mode is enabled for this session
  const sessionAI = await getSessionAI(message.platform, message.chatId);
  return sessionAI?.aiEnabled ?? false;
}

/**
 * Handle a Telegram webhook update
 * Returns the response message to send back
 */
export async function handleTelegramWebhook(
  update: TelegramUpdate
): Promise<SendMessageResult> {
  // Handle callback query (button press)
  if (update.callback_query) {
    const query = update.callback_query;
    const chatId = query.message?.chat.id;

    if (!chatId || !query.data) {
      await answerCallbackQuery(query.id);
      return { success: true };
    }

    // Acknowledge the callback
    await answerCallbackQuery(query.id);

    // Handle the callback
    const response = await handleCallback(
      'telegram',
      String(chatId),
      String(query.from.id),
      query.data
    );

    if (response) {
      response.chatId = String(chatId);
      return sendTelegramMessage(response);
    }

    return { success: true };
  }

  // Handle regular message
  const incomingMessage = parseTelegramUpdate(update);

  if (!incomingMessage) {
    // No processable content (e.g., sticker, photo, etc.)
    return { success: true };
  }

  console.log(`[TelegramAdapter] Received message from ${incomingMessage.userName}: ${incomingMessage.text}`);

  // Check if this will use AI processing (potentially slow)
  const useAI = await willUseAIProcessing(incomingMessage);

  if (useAI) {
    // Send typing indicator while AI processes
    await sendTypingIndicator(incomingMessage.chatId);

    // Process asynchronously - send typing indicator periodically
    const typingInterval = setInterval(() => {
      sendTypingIndicator(incomingMessage.chatId).catch(() => {
        // Ignore errors for typing indicator
      });
    }, 4000); // Telegram typing indicator lasts ~5 seconds

    try {
      // Process the message through the generic handler
      const response = await handleIncomingMessage(incomingMessage);
      clearInterval(typingInterval);
      return sendTelegramMessage(response);
    } catch (error) {
      clearInterval(typingInterval);
      const err = error as Error;
      console.error('[TelegramAdapter] AI processing error:', err.message);
      return sendTelegramMessage({
        chatId: incomingMessage.chatId,
        text: `❌ Error processing message: ${err.message}`,
        parseMode: 'markdown',
      });
    }
  }

  // Fast path for non-AI messages
  const response = await handleIncomingMessage(incomingMessage);
  return sendTelegramMessage(response);
}

/**
 * Handle a Telegram webhook update asynchronously
 * Returns immediately with success, processes in background
 * Use this for webhooks that need to respond quickly
 */
export function handleTelegramWebhookAsync(
  update: TelegramUpdate
): { immediate: Promise<SendMessageResult>; background: Promise<SendMessageResult> | null } {
  // Handle callback query immediately
  if (update.callback_query) {
    return {
      immediate: handleTelegramWebhook(update),
      background: null,
    };
  }

  const incomingMessage = parseTelegramUpdate(update);

  if (!incomingMessage) {
    return {
      immediate: Promise.resolve({ success: true }),
      background: null,
    };
  }

  // For messages, return immediately and process in background
  return {
    immediate: Promise.resolve({ success: true }),
    background: (async () => {
      console.log(`[TelegramAdapter] Processing message async from ${incomingMessage.userName}`);

      // Check if AI processing needed
      const useAI = await willUseAIProcessing(incomingMessage);

      if (useAI) {
        await sendTypingIndicator(incomingMessage.chatId);

        const typingInterval = setInterval(() => {
          sendTypingIndicator(incomingMessage.chatId).catch(() => {});
        }, 4000);

        try {
          const response = await handleIncomingMessage(incomingMessage);
          clearInterval(typingInterval);
          return sendTelegramMessage(response);
        } catch (error) {
          clearInterval(typingInterval);
          const err = error as Error;
          return sendTelegramMessage({
            chatId: incomingMessage.chatId,
            text: `❌ Error: ${err.message}`,
            parseMode: 'markdown',
          });
        }
      }

      const response = await handleIncomingMessage(incomingMessage);
      return sendTelegramMessage(response);
    })(),
  };
}

/**
 * Set the webhook URL for the bot
 */
export async function setTelegramWebhook(webhookUrl: string): Promise<boolean> {
  try {
    await callTelegramApi('setWebhook', {
      url: webhookUrl,
      allowed_updates: ['message', 'callback_query'],
    });
    console.log(`[TelegramAdapter] Webhook set to: ${webhookUrl}`);
    return true;
  } catch (error) {
    const err = error as Error;
    console.error('[TelegramAdapter] Failed to set webhook:', err.message);
    return false;
  }
}

/**
 * Delete the webhook (switch to polling mode)
 */
export async function deleteTelegramWebhook(): Promise<boolean> {
  try {
    await callTelegramApi('deleteWebhook', {});
    console.log('[TelegramAdapter] Webhook deleted');
    return true;
  } catch (error) {
    const err = error as Error;
    console.error('[TelegramAdapter] Failed to delete webhook:', err.message);
    return false;
  }
}

/**
 * Get bot info
 */
export async function getTelegramBotInfo(): Promise<{ id: number; username: string; first_name: string } | null> {
  try {
    const result = await callTelegramApi<{ id: number; username: string; first_name: string }>('getMe', {});
    return result;
  } catch (error) {
    const err = error as Error;
    console.error('[TelegramAdapter] Failed to get bot info:', err.message);
    return null;
  }
}

/**
 * Send a notification to a specific chat
 */
export async function sendTelegramNotification(
  chatId: string,
  message: OutgoingMessage
): Promise<SendMessageResult> {
  return sendTelegramMessage({
    ...message,
    chatId,
  });
}
