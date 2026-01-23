import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebSocket from '@fastify/websocket';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardRoutes } from './routes/board.js';
import { taskRoutes } from './routes/tasks.js';
import { logsWebSocket } from './ws/logs.js';
import { getAgentType, getAgentCommand, getAgentDisplayName, validateAgentEnv } from './services/agentAdapter.js';
import { startQueueProcessor, getQueueProcessorConfig } from './services/queueProcessor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve project root (works for both src/server and dist/server)
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const CLIENT_PATH = path.join(PROJECT_ROOT, 'src', 'client');

const PORT = parseInt(process.env.PORT || '8000', 10);
const HOST = process.env.HOST || '0.0.0.0';

async function main() {
  const fastify = Fastify({
    logger: true,
  });

  // Register WebSocket support
  await fastify.register(fastifyWebSocket);

  // Serve static files from client directory
  await fastify.register(fastifyStatic, {
    root: CLIENT_PATH,
    prefix: '/',
  });

  // Register API routes
  await fastify.register(boardRoutes);
  await fastify.register(taskRoutes);

  // Register WebSocket routes
  await fastify.register(logsWebSocket);

  // Health check endpoint
  fastify.get('/health', async () => ({ status: 'ok' }));

  try {
    await fastify.listen({ port: PORT, host: HOST });
    console.log(`Formic server running at http://${HOST}:${PORT}`);

    // Log agent configuration
    const agentType = getAgentType();
    const agentCommand = getAgentCommand();
    const agentDisplayName = getAgentDisplayName();
    console.log(`Agent: ${agentDisplayName} (type: ${agentType}, command: ${agentCommand})`);

    // Warn about missing environment variables
    const missingEnvVars = validateAgentEnv();
    if (missingEnvVars.length > 0) {
      console.warn(`Warning: Missing environment variables for ${agentDisplayName}: ${missingEnvVars.join(', ')}`);
    }

    // Start the queue processor
    startQueueProcessor();
    const queueConfig = getQueueProcessorConfig();
    if (queueConfig.enabled) {
      console.log(`Queue processor: enabled (poll: ${queueConfig.pollInterval}ms, max concurrent: ${queueConfig.maxConcurrent})`);
    } else {
      console.log('Queue processor: disabled');
    }
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

main();
