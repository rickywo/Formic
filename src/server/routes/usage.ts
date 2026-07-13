import type { FastifyInstance } from 'fastify';
import { summarizeUsage, taskUsageBreakdown, taskUsageTotals } from '../services/usageStore.js';

const VALID_PERIODS = new Set(['today', 'month', 'all']);
const VALID_GROUPS = new Set(['model', 'task', 'session']);

export async function usageRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/api/usage/summary', async (request, reply) => {
    try {
      const query = request.query as { period?: string; groupBy?: string };
      const period = query.period ?? 'all';
      const groupBy = query.groupBy ?? 'model';
      if (!VALID_PERIODS.has(period) || !VALID_GROUPS.has(groupBy)) {
        return reply.status(400).send({ error: 'period must be today, month, or all; groupBy must be model, task, or session' });
      }
      return reply.send(await summarizeUsage({ period: period as 'today' | 'month' | 'all', groupBy: groupBy as 'model' | 'task' | 'session' }));
    } catch (err) {
      console.error(`[Usage] Route error: ${err instanceof Error ? err.message : 'Unknown error'}`);
      return reply.status(500).send({ error: 'Failed to fetch usage summary' });
    }
  });

  fastify.get('/api/usage/tasks', async (_request, reply) => {
    try {
      return reply.send({ tasks: await taskUsageTotals() });
    } catch (err) {
      console.error(`[Usage] Route error: ${err instanceof Error ? err.message : 'Unknown error'}`);
      return reply.status(500).send({ error: 'Failed to fetch task usage totals' });
    }
  });

  fastify.get('/api/usage/task/:id', async (request, reply) => {
    try {
      const params = request.params as { id: string };
      return reply.send(await taskUsageBreakdown(params.id));
    } catch (err) {
      console.error(`[Usage] Route error: ${err instanceof Error ? err.message : 'Unknown error'}`);
      return reply.status(500).send({ error: 'Failed to fetch task usage' });
    }
  });
}
