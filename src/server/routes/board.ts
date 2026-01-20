import type { FastifyInstance } from 'fastify';
import { loadBoard } from '../services/store.js';

export async function boardRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /api/board - Get full board state
  fastify.get('/api/board', async (_request, reply) => {
    const board = await loadBoard();
    return reply.send(board);
  });
}
