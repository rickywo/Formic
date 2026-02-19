import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  handleTelegramWebhook,
  isTelegramConfigured,
  getTelegramBotInfo,
  setTelegramWebhook,
} from '../services/telegramAdapter.js';
import {
  handleLineWebhook,
  verifyLineSignature,
  isLineConfigured,
} from '../services/lineAdapter.js';
import { getMessagingConfig } from '../services/messagingAdapter.js';
import { getAllSessions } from '../services/messagingStore.js';

/**
 * Webhook Routes
 *
 * Provides HTTP endpoints for messaging platform webhooks.
 * - POST /api/webhooks/telegram - Telegram bot updates
 * - POST /api/webhooks/line - Line messaging events
 * - GET /api/messaging/status - Check messaging configuration status
 * - POST /api/messaging/telegram/set-webhook - Set Telegram webhook URL
 */

export async function webhookRoutes(fastify: FastifyInstance): Promise<void> {
  // ==================== Telegram Webhook ====================

  /**
   * POST /api/webhooks/telegram
   * Receives updates from Telegram Bot API
   */
  fastify.post('/api/webhooks/telegram', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isTelegramConfigured()) {
      return reply.status(503).send({
        error: 'Telegram integration not configured',
        hint: 'Set TELEGRAM_BOT_TOKEN environment variable',
      });
    }

    try {
      const update = request.body;

      // Telegram doesn't use signatures, but we validate the update structure
      if (!update || typeof update !== 'object') {
        return reply.status(400).send({ error: 'Invalid update format' });
      }

      // Process the webhook asynchronously
      // We respond quickly to Telegram and process in background
      handleTelegramWebhook(update as unknown as Parameters<typeof handleTelegramWebhook>[0])
        .catch((err) => {
          console.error('[Webhooks] Telegram webhook error:', (err as Error).message);
        });

      // Telegram expects a 200 OK response quickly
      return reply.status(200).send({ ok: true });
    } catch (error) {
      const err = error as Error;
      console.error('[Webhooks] Telegram webhook error:', err.message);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // ==================== Line Webhook ====================

  /**
   * POST /api/webhooks/line
   * Receives events from Line Messaging API
   */
  fastify.post('/api/webhooks/line', {
    config: {
      // Disable body parsing so we can access raw body for signature verification
      rawBody: true,
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isLineConfigured()) {
      return reply.status(503).send({
        error: 'Line integration not configured',
        hint: 'Set LINE_CHANNEL_ACCESS_TOKEN and LINE_CHANNEL_SECRET environment variables',
      });
    }

    try {
      // Get signature from header
      const signature = request.headers['x-line-signature'] as string;

      if (!signature) {
        console.warn('[Webhooks] Line webhook missing signature');
        return reply.status(401).send({ error: 'Missing signature' });
      }

      // Get raw body for signature verification
      // Fastify may have already parsed it, so we need to stringify it back
      const rawBody = typeof request.body === 'string'
        ? request.body
        : JSON.stringify(request.body);

      // Verify signature
      if (!verifyLineSignature(rawBody, signature)) {
        console.warn('[Webhooks] Line webhook signature verification failed');
        return reply.status(401).send({ error: 'Invalid signature' });
      }

      const body = typeof request.body === 'string'
        ? JSON.parse(request.body) as Parameters<typeof handleLineWebhook>[0]
        : request.body as Parameters<typeof handleLineWebhook>[0];

      // Process the webhook
      handleLineWebhook(body)
        .catch((err) => {
          console.error('[Webhooks] Line webhook error:', (err as Error).message);
        });

      // Line expects a 200 OK response
      return reply.status(200).send({ ok: true });
    } catch (error) {
      const err = error as Error;
      console.error('[Webhooks] Line webhook error:', err.message);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // ==================== Messaging Status & Management ====================

  /**
   * GET /api/messaging/status
   * Get messaging integration status and configuration
   */
  fastify.get('/api/messaging/status', async (request: FastifyRequest, reply: FastifyReply) => {
    const config = getMessagingConfig();
    const sessions = await getAllSessions();

    const status = {
      telegram: {
        configured: config.telegram.enabled,
        botInfo: null as { id: number; username: string; first_name: string } | null,
      },
      line: {
        configured: config.line.enabled,
      },
      sessions: {
        total: sessions.length,
        byPlatform: {
          telegram: sessions.filter((s) => s.platform === 'telegram').length,
          line: sessions.filter((s) => s.platform === 'line').length,
        },
      },
    };

    // Get Telegram bot info if configured
    if (config.telegram.enabled) {
      status.telegram.botInfo = await getTelegramBotInfo();
    }

    return reply.send(status);
  });

  /**
   * POST /api/messaging/telegram/set-webhook
   * Set the Telegram webhook URL
   */
  fastify.post<{
    Body: { webhookUrl: string };
  }>('/api/messaging/telegram/set-webhook', async (request, reply) => {
    if (!isTelegramConfigured()) {
      return reply.status(503).send({
        error: 'Telegram integration not configured',
      });
    }

    const { webhookUrl } = request.body;

    if (!webhookUrl) {
      return reply.status(400).send({ error: 'webhookUrl is required' });
    }

    // Validate URL format
    try {
      const url = new URL(webhookUrl);
      if (url.protocol !== 'https:') {
        return reply.status(400).send({ error: 'Webhook URL must use HTTPS' });
      }
    } catch {
      return reply.status(400).send({ error: 'Invalid URL format' });
    }

    const success = await setTelegramWebhook(webhookUrl);

    if (success) {
      return reply.send({
        success: true,
        webhookUrl,
        message: 'Webhook URL set successfully',
      });
    } else {
      return reply.status(500).send({ error: 'Failed to set webhook URL' });
    }
  });

  /**
   * GET /api/messaging/sessions
   * List all messaging sessions (for debugging/admin)
   */
  fastify.get('/api/messaging/sessions', async (request: FastifyRequest, reply: FastifyReply) => {
    const sessions = await getAllSessions();

    return reply.send({
      sessions: sessions.map((s) => ({
        id: s.id,
        platform: s.platform,
        chatId: s.chatId,
        userName: s.userName,
        workspacePath: s.workspacePath,
        notifications: s.notifications,
        createdAt: s.createdAt,
        lastActiveAt: s.lastActiveAt,
      })),
    });
  });
}
