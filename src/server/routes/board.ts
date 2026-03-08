import type { FastifyInstance } from 'fastify';
import { getBoardWithBootstrap, getQueuedTasks, getAllTasks } from '../services/store.js';
import { getQueueAnalysis } from '../services/prioritizer.js';

export async function boardRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /api/board - Get full board state with bootstrap status
  fastify.get('/api/board', async (_request, reply) => {
    const board = await getBoardWithBootstrap();
    return reply.send(board);
  });

  // GET /api/queue/analysis - Return per-task scoring breakdown for the current queue
  fastify.get('/api/queue/analysis', async (_request, reply) => {
    try {
      const [queuedTasks, allTasks] = await Promise.all([getQueuedTasks(), getAllTasks()]);
      const analysis = getQueueAnalysis(queuedTasks, allTasks);
      return reply.send(analysis);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.status(500).send({ error: message });
    }
  });
}
