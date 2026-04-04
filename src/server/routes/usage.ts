import type { FastifyInstance } from 'fastify';
import { getUsageInfo } from '../services/usage.js';

export async function usageRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/api/usage', async (_request, reply) => {
    try {
      const usage = await getUsageInfo();
      return reply.send(usage);
    } catch (err) {
      console.error(`[Usage] Route error: ${err instanceof Error ? err.message : 'Unknown error'}`);
      return reply.status(500).send({ error: 'Failed to fetch usage info' });
    }
  });
}
