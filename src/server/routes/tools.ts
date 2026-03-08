/**
 * Tool Forging API Routes
 * Exposes CRUD endpoints for the agent tool catalog stored in .formic/tools/tools.json
 */
import type { FastifyInstance } from 'fastify';
import { listTools, addTool } from '../services/tools.js';

export async function toolRoutes(fastify: FastifyInstance): Promise<void> {
  /** GET /api/tools — list all registered tools */
  fastify.get('/api/tools', async (_request, reply) => {
    try {
      const tools = await listTools();
      return reply.send({ tools });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.status(500).send({ error: message });
    }
  });

  /** POST /api/tools — register a new tool */
  fastify.post('/api/tools', async (request, reply) => {
    try {
      const body = request.body as Record<string, unknown>;
      const { name, description, command, created_by } = body;
      if (typeof name !== 'string' || typeof description !== 'string' || typeof command !== 'string' || typeof created_by !== 'string') {
        return reply.status(400).send({ error: 'name, description, command, and created_by are required strings' });
      }
      const tool = await addTool({ name, description, command, created_by });
      return reply.status(201).send(tool);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.status(400).send({ error: message });
    }
  });
}
