import { createHmac } from 'node:crypto';
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
 * Line Adapter Service
 *
 * Handles Line-specific webhook parsing, signature verification,
 * and Messaging API calls. Uses the generic messaging adapter for command handling.
 */

const LINE_API_BASE = 'https://api.line.me/v2/bot';

// Line webhook event types
interface LineSource {
  type: 'user' | 'group' | 'room';
  userId?: string;
  groupId?: string;
  roomId?: string;
}

interface LineTextMessage {
  type: 'text';
  id: string;
  text: string;
}

interface LineMessageEvent {
  type: 'message';
  replyToken: string;
  source: LineSource;
  timestamp: number;
  message: LineTextMessage;
}

interface LinePostbackEvent {
  type: 'postback';
  replyToken: string;
  source: LineSource;
  timestamp: number;
  postback: {
    data: string;
  };
}

interface LineFollowEvent {
  type: 'follow';
  replyToken: string;
  source: LineSource;
  timestamp: number;
}

type LineEvent = LineMessageEvent | LinePostbackEvent | LineFollowEvent;

interface LineWebhookBody {
  destination: string;
  events: LineEvent[];
}

interface LineTextMessageContent {
  type: 'text';
  text: string;
}

interface LineImageMessageContent {
  type: 'image';
  originalContentUrl: string;
  previewImageUrl: string;
}

type LineMessageContent = LineTextMessageContent | LineImageMessageContent;

interface LineQuickReplyItem {
  type: 'action';
  action: {
    type: 'postback' | 'uri';
    label: string;
    data?: string;
    uri?: string;
  };
}

interface LineQuickReply {
  items: LineQuickReplyItem[];
}

interface LineReplyMessage {
  replyToken: string;
  messages: LineMessageContent[];
}

interface LinePushMessage {
  to: string;
  messages: LineMessageContent[];
}

interface LineProfile {
  displayName: string;
  userId: string;
  pictureUrl?: string;
  statusMessage?: string;
}

/**
 * Check if Line is configured
 */
export function isLineConfigured(): boolean {
  const config = getMessagingConfig();
  return config.line.enabled;
}

/**
 * Get Line channel access token
 */
function getChannelAccessToken(): string {
  const config = getMessagingConfig();
  if (!config.line.channelAccessToken) {
    throw new Error('LINE_CHANNEL_ACCESS_TOKEN is not configured');
  }
  return config.line.channelAccessToken;
}

/**
 * Get Line channel secret
 */
function getChannelSecret(): string {
  const config = getMessagingConfig();
  if (!config.line.channelSecret) {
    throw new Error('LINE_CHANNEL_SECRET is not configured');
  }
  return config.line.channelSecret;
}

/**
 * Verify Line webhook signature
 */
export function verifyLineSignature(body: string, signature: string): boolean {
  try {
    const channelSecret = getChannelSecret();
    const hash = createHmac('sha256', channelSecret)
      .update(body)
      .digest('base64');
    return hash === signature;
  } catch (error) {
    const err = error as Error;
    console.error('[LineAdapter] Signature verification failed:', err.message);
    return false;
  }
}

/**
 * Make a Line Messaging API call
 */
async function callLineApi<T>(
  endpoint: string,
  method: 'GET' | 'POST' = 'POST',
  body?: object
): Promise<T> {
  const token = getChannelAccessToken();
  const url = `${LINE_API_BASE}${endpoint}`;

  const options: RequestInit = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Line API error: ${response.status} - ${errorText}`);
  }

  // Some endpoints return empty responses
  const text = await response.text();
  if (!text) {
    return {} as T;
  }

  return JSON.parse(text) as T;
}

/**
 * Get the chat ID from a Line source
 */
function getChatIdFromSource(source: LineSource): string {
  if (source.type === 'group' && source.groupId) {
    return source.groupId;
  }
  if (source.type === 'room' && source.roomId) {
    return source.roomId;
  }
  return source.userId || '';
}

/**
 * Get user profile from Line
 */
async function getUserProfile(userId: string): Promise<LineProfile | null> {
  try {
    return await callLineApi<LineProfile>(`/profile/${userId}`, 'GET');
  } catch (error) {
    const err = error as Error;
    console.error('[LineAdapter] Failed to get user profile:', err.message);
    return null;
  }
}

/**
 * Parse a Line webhook event into a normalized IncomingMessage
 */
export async function parseLineEvent(event: LineEvent): Promise<IncomingMessage | null> {
  // Only handle message events with text
  if (event.type !== 'message' || !('message' in event) || event.message.type !== 'text') {
    return null;
  }

  const messageEvent = event as LineMessageEvent;
  const chatId = getChatIdFromSource(messageEvent.source);
  const userId = messageEvent.source.userId || '';

  // Try to get user display name
  let userName: string | undefined;
  if (userId) {
    const profile = await getUserProfile(userId);
    if (profile) {
      userName = profile.displayName;
    }
  }

  return {
    platform: 'line',
    chatId,
    userId,
    userName,
    text: messageEvent.message.text,
    messageId: messageEvent.message.id,
    timestamp: new Date(messageEvent.timestamp).toISOString(),
  };
}

/**
 * Convert markdown-style formatting to plain text for Line
 * Line doesn't support markdown in regular text messages
 */
function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*/g, '') // Remove bold markers
    .replace(/\*/g, '')   // Remove italic markers
    .replace(/_/g, '')    // Remove underscore formatting
    .replace(/`/g, '');   // Remove code markers
}

/**
 * Convert OutgoingMessage to Line message format
 * Handles both text and image messages
 */
function toLineMessages(message: OutgoingMessage): LineMessageContent[] {
  const messages: LineMessageContent[] = [];

  // Handle media attachment (image)
  if (message.media && message.media.type === 'photo') {
    const imageMessage = toLineImageMessage(message.media);
    if (imageMessage) {
      messages.push(imageMessage);
    }
  }

  // Add text message (as caption or main content)
  if (message.text) {
    const text = message.parseMode === 'markdown' || message.parseMode === 'html'
      ? stripMarkdown(message.text)
      : message.text;
    messages.push({ type: 'text', text });
  }

  return messages;
}

/**
 * Convert MediaAttachment to LINE image message format
 * LINE only supports HTTPS URLs for images
 */
function toLineImageMessage(media: MediaAttachment): LineImageMessageContent | null {
  if (media.source !== 'url') {
    console.error('[LineAdapter] LINE only supports URL source for images. File/buffer not supported.');
    return null;
  }

  // Validate it's an HTTPS URL
  if (!media.data.startsWith('https://')) {
    console.error('[LineAdapter] LINE requires HTTPS URLs for images.');
    return null;
  }

  return {
    type: 'image',
    originalContentUrl: media.data,
    previewImageUrl: media.data, // Use same URL for preview
  };
}

/**
 * Send an image via LINE Messaging API
 * Only supports HTTPS URLs (LINE requirement)
 */
export async function sendLineImage(
  chatId: string,
  media: MediaAttachment
): Promise<SendMessageResult> {
  // Validate source type
  if (media.source !== 'url') {
    return {
      success: false,
      error: 'LINE only supports URL source for images. File and buffer uploads are not supported. Images must be hosted on a public HTTPS URL.',
    };
  }

  // Validate HTTPS
  if (!media.data.startsWith('https://')) {
    return {
      success: false,
      error: 'LINE requires images to be hosted on HTTPS URLs.',
    };
  }

  try {
    const messages: LineMessageContent[] = [{
      type: 'image',
      originalContentUrl: media.data,
      previewImageUrl: media.data,
    }];

    // Add caption as separate text message if provided
    if (media.caption) {
      messages.push({
        type: 'text',
        text: media.caption,
      });
    }

    const payload: LinePushMessage = {
      to: chatId,
      messages,
    };

    await callLineApi('/message/push', 'POST', payload);

    return { success: true };
  } catch (error) {
    const err = error as Error;
    console.error('[LineAdapter] Failed to send image:', err.message);
    return {
      success: false,
      error: err.message,
    };
  }
}

/**
 * Convert buttons to Line quick reply format
 */
function toLineQuickReply(message: OutgoingMessage): LineQuickReply | undefined {
  if (!message.buttons || message.buttons.length === 0) {
    return undefined;
  }

  const items: LineQuickReplyItem[] = message.buttons.map((button) => ({
    type: 'action',
    action: button.type === 'url'
      ? { type: 'uri', label: button.label, uri: button.data }
      : { type: 'postback', label: button.label, data: button.data },
  }));

  return { items };
}

/**
 * Reply to a Line message using the reply token
 */
export async function replyToLineMessage(
  replyToken: string,
  message: OutgoingMessage
): Promise<SendMessageResult> {
  try {
    const messages = toLineMessages(message);
    const payload: LineReplyMessage & { quickReply?: LineQuickReply } = {
      replyToken,
      messages,
    };

    const quickReply = toLineQuickReply(message);
    if (quickReply) {
      payload.quickReply = quickReply;
    }

    await callLineApi('/message/reply', 'POST', payload);

    return { success: true };
  } catch (error) {
    const err = error as Error;
    console.error('[LineAdapter] Failed to reply:', err.message);
    return {
      success: false,
      error: err.message,
    };
  }
}

/**
 * Send typing/loading indicator to a chat
 * Line doesn't have a true typing indicator, but we can use loading animation
 */
export async function sendTypingIndicator(chatId: string): Promise<void> {
  try {
    // Line uses a "loading" animation that shows for 5-60 seconds
    // We'll use the minimum 5 seconds and refresh as needed
    await callLineApi('/chat/loading/start', 'POST', {
      chatId,
      loadingSeconds: 5,
    });
  } catch (error) {
    const err = error as Error;
    // Loading indicator may not be supported in all contexts, ignore errors
    console.log('[LineAdapter] Loading indicator not available:', err.message);
  }
}

/**
 * Push a message to a Line user/group (for notifications)
 */
export async function pushLineMessage(
  to: string,
  message: OutgoingMessage
): Promise<SendMessageResult> {
  try {
    const messages = toLineMessages(message);
    const payload: LinePushMessage = {
      to,
      messages,
    };

    await callLineApi('/message/push', 'POST', payload);

    return { success: true };
  } catch (error) {
    const err = error as Error;
    console.error('[LineAdapter] Failed to push message:', err.message);
    return {
      success: false,
      error: err.message,
    };
  }
}

/**
 * Handle a Line follow event (user added the bot)
 */
async function handleFollowEvent(event: LineFollowEvent): Promise<SendMessageResult> {
  const chatId = getChatIdFromSource(event.source);
  const userId = event.source.userId || '';

  // Simulate a /start command
  const incomingMessage: IncomingMessage = {
    platform: 'line',
    chatId,
    userId,
    text: '/start',
    messageId: '',
    timestamp: new Date(event.timestamp).toISOString(),
  };

  const response = await handleIncomingMessage(incomingMessage);
  return replyToLineMessage(event.replyToken, response);
}

/**
 * Handle a Line postback event (quick reply/button press)
 */
async function handlePostbackEvent(event: LinePostbackEvent): Promise<SendMessageResult> {
  const chatId = getChatIdFromSource(event.source);
  const userId = event.source.userId || '';

  const response = await handleCallback('line', chatId, userId, event.postback.data);

  if (response) {
    return replyToLineMessage(event.replyToken, response);
  }

  return { success: true };
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
 * Handle a Line message event
 */
async function handleMessageEvent(event: LineMessageEvent): Promise<SendMessageResult> {
  const incomingMessage = await parseLineEvent(event);

  if (!incomingMessage) {
    return { success: true };
  }

  console.log(`[LineAdapter] Received message from ${incomingMessage.userName || incomingMessage.userId}: ${incomingMessage.text}`);

  // Check if AI processing is needed
  const useAI = await willUseAIProcessing(incomingMessage);

  if (useAI) {
    // Send typing indicator while processing
    await sendTypingIndicator(incomingMessage.chatId);
  }

  const response = await handleIncomingMessage(incomingMessage);
  return replyToLineMessage(event.replyToken, response);
}

/**
 * Handle a Line webhook request
 */
export async function handleLineWebhook(body: LineWebhookBody): Promise<SendMessageResult[]> {
  const results: SendMessageResult[] = [];

  for (const event of body.events) {
    let result: SendMessageResult;

    switch (event.type) {
      case 'follow':
        result = await handleFollowEvent(event as LineFollowEvent);
        break;
      case 'postback':
        result = await handlePostbackEvent(event as LinePostbackEvent);
        break;
      case 'message':
        result = await handleMessageEvent(event as LineMessageEvent);
        break;
      default:
        result = { success: true };
    }

    results.push(result);
  }

  return results;
}

/**
 * Send a notification to a specific Line chat
 */
export async function sendLineNotification(
  chatId: string,
  message: OutgoingMessage
): Promise<SendMessageResult> {
  return pushLineMessage(chatId, {
    ...message,
    chatId,
  });
}

/**
 * Get bot info (not directly available in Line, but we can verify the token works)
 */
export async function verifyLineBotToken(): Promise<boolean> {
  try {
    // The /bot/info endpoint doesn't exist, but we can try getting quota
    await callLineApi('/message/quota', 'GET');
    return true;
  } catch (error) {
    const err = error as Error;
    console.error('[LineAdapter] Token verification failed:', err.message);
    return false;
  }
}

/**
 * Handle a Line webhook asynchronously
 * Designed to return 200 OK immediately for webhooks that need quick response
 * Note: Line requires reply within a few seconds, so we still use replyToken
 * For long AI operations, this sends an initial "processing" message and then
 * pushes the final response
 */
export async function handleLineWebhookAsync(
  body: LineWebhookBody
): Promise<{
  immediate: Promise<SendMessageResult[]>;
  backgrounds: Array<Promise<SendMessageResult> | null>;
}> {
  const immediateResults: SendMessageResult[] = [];
  const backgrounds: Array<Promise<SendMessageResult> | null> = [];

  for (const event of body.events) {
    if (event.type === 'message') {
      const messageEvent = event as LineMessageEvent;
      const incomingMessage = await parseLineEvent(messageEvent);

      if (incomingMessage) {
        const useAI = await willUseAIProcessing(incomingMessage);

        if (useAI) {
          // For AI messages, send a "processing" response immediately
          // Then push the real response later
          const processingResponse = await replyToLineMessage(messageEvent.replyToken, {
            chatId: incomingMessage.chatId,
            text: '🤔 Processing with AI...',
            parseMode: 'plain',
          });
          immediateResults.push(processingResponse);

          // Process AI in background and push response
          backgrounds.push(
            (async () => {
              try {
                const response = await handleIncomingMessage(incomingMessage);
                return pushLineMessage(incomingMessage.chatId, response);
              } catch (error) {
                const err = error as Error;
                return pushLineMessage(incomingMessage.chatId, {
                  chatId: incomingMessage.chatId,
                  text: `❌ Error: ${err.message}`,
                  parseMode: 'plain',
                });
              }
            })()
          );
        } else {
          // Fast path - handle normally
          const result = await handleMessageEvent(messageEvent);
          immediateResults.push(result);
          backgrounds.push(null);
        }
      } else {
        immediateResults.push({ success: true });
        backgrounds.push(null);
      }
    } else if (event.type === 'follow') {
      const result = await handleFollowEvent(event as LineFollowEvent);
      immediateResults.push(result);
      backgrounds.push(null);
    } else if (event.type === 'postback') {
      const result = await handlePostbackEvent(event as LinePostbackEvent);
      immediateResults.push(result);
      backgrounds.push(null);
    } else {
      immediateResults.push({ success: true });
      backgrounds.push(null);
    }
  }

  return {
    immediate: Promise.resolve(immediateResults),
    backgrounds,
  };
}
