import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebSocket from '@fastify/websocket';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardRoutes } from './routes/board.js';
import { taskRoutes } from './routes/tasks.js';
import { logsWebSocket } from './ws/logs.js';
import { getAgentType, getAgentCommand, getAgentDisplayName, validateAgentEnv } from './services/agentAdapter.js';
import { startQueueProcessor, stopQueueProcessor, getQueueConfig } from './services/queueProcessor.js';
import { ensureFormicIgnored } from './services/git.js';

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

    // Ensure .formic/ is protected from git (auto-adds to .gitignore, removes from index if tracked)
    const formicProtection = ensureFormicIgnored();
    if (formicProtection.modified) {
      console.log(`Git: Protected .formic/ directory - ${formicProtection.actions.join(', ')}`);
    }

    // Start the queue processor (Phase 11: Auto-Queue System)
    const queueConfig = getQueueConfig();
    console.log(`Queue: Starting processor (poll interval: ${queueConfig.pollIntervalMs}ms, max concurrent: ${queueConfig.maxConcurrentTasks})`);
    startQueueProcessor();

    // Handle graceful shutdown
    const shutdown = async () => {
      console.log('Shutting down server...');
      stopQueueProcessor();
      await fastify.close();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

main();
