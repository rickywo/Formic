import type { FastifyInstance } from 'fastify';
import { getBoardWithBootstrap } from '../services/store.js';

export async function boardRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /api/board - Get full board state with bootstrap status
  fastify.get('/api/board', async (_request, reply) => {
    const board = await getBoardWithBootstrap();
    return reply.send(board);
  });
}
