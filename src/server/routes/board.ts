import type { FastifyInstance } from 'fastify';
import { getBoardWithBootstrap, getQueuedTasks, getAllTasks } from '../services/store.js';
import { getQueueAnalysis } from '../services/prioritizer.js';
import { isQueueProcessorRunning } from '../services/queueProcessor.js';
import type { TaskCounts } from '../../types/index.js';

export async function boardRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /api/board - Get full board state with bootstrap status
  fastify.get('/api/board', async (_request, reply) => {
    const board = await getBoardWithBootstrap();

    // Compute per-status task counts for AGI phase health metrics
    const counts: TaskCounts = {
      todo: 0, queued: 0, briefing: 0, planning: 0, declaring: 0,
      running: 0, architecting: 0, verifying: 0, review: 0, done: 0, blocked: 0,
    };
    for (const task of board.tasks) {
      if (task.status in counts) {
        (counts as unknown as Record<string, number>)[task.status]++;
      }
    }

    const enrichedBoard = {
      ...board,
      meta: {
        ...board.meta,
        queueEnabled: isQueueProcessorRunning(),
        counts,
      },
    };

    return reply.send(enrichedBoard);
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
