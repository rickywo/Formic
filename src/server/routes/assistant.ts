import type { FastifyInstance } from 'fastify';
import {
  startAssistant,
  stopAssistant,
  restartAssistant,
  getAssistantSession,
  getMessageHistory,
  sendUserMessage,
} from '../services/assistantManager.js';

export async function assistantRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /api/assistant/start - Start Claude Code session
  fastify.post('/api/assistant/start', async (_request, reply) => {
    try {
      const session = await startAssistant();
      return reply.send(session);
    } catch (error) {
      const err = error as Error;
      return reply.status(500).send({ error: err.message });
    }
  });

  // POST /api/assistant/stop - Stop Claude Code session
  fastify.post('/api/assistant/stop', async (_request, reply) => {
    try {
      const session = await stopAssistant();
      return reply.send(session);
    } catch (error) {
      const err = error as Error;
      return reply.status(500).send({ error: err.message });
    }
  });

  // POST /api/assistant/restart - Restart Claude Code session
  fastify.post('/api/assistant/restart', async (_request, reply) => {
    try {
      const session = await restartAssistant();
      return reply.send(session);
    } catch (error) {
      const err = error as Error;
      return reply.status(500).send({ error: err.message });
    }
  });

  // GET /api/assistant/status - Get current session status
  fastify.get('/api/assistant/status', async (_request, reply) => {
    const session = getAssistantSession();
    return reply.send(session);
  });

  // GET /api/assistant/history - Get message history
  fastify.get('/api/assistant/history', async (_request, reply) => {
    const history = getMessageHistory();
    return reply.send({ messages: history });
  });

  // POST /api/assistant/message - Send a message to the assistant
  fastify.post<{ Body: { content: string } }>('/api/assistant/message', async (request, reply) => {
    const { content } = request.body;

    if (!content || typeof content !== 'string') {
      return reply.status(400).send({ error: 'Message content is required' });
    }

    const sent = sendUserMessage(content);
    if (!sent) {
      return reply.status(400).send({ error: 'Assistant is not running. Start a session first.' });
    }

    return reply.send({ success: true });
  });
}
