import type { FastifyInstance } from 'fastify';
import { getActivePipeline } from '../services/pipelineRegistry.js';

export async function pipelineRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /api/pipeline/stages - Return active pipeline stages with source attribution
  fastify.get('/api/pipeline/stages', async (request, reply) => {
    const query = request.query as { taskType?: string };
    const taskType = query.taskType || 'standard';
    const stages = getActivePipeline(taskType);
    return reply.send({ stages });
  });
}
