import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebSocket from '@fastify/websocket';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardRoutes } from './routes/board.js';
import { taskRoutes } from './routes/tasks.js';
import { assistantRoutes } from './routes/assistant.js';
import { workspaceRoutes } from './routes/workspace.js';
import { webhookRoutes } from './routes/webhooks.js';
import { configRoutes } from './routes/config.js';
import { toolRoutes } from './routes/tools.js';
import { logsWebSocket } from './ws/logs.js';
import { assistantWebSocket } from './ws/assistant.js';
import { readFile } from 'node:fs/promises';
import { getAgentType, getAgentCommand, getAgentDisplayName, validateAgentEnv } from './services/agentAdapter.js';
import { startQueueProcessor, getQueueProcessorConfig } from './services/queueProcessor.js';
import { printStartupBanner } from './utils/banner.js';
import type { StartupInfo } from './utils/banner.js';
import { startWatchdog, stopWatchdog } from './services/watchdog.js';
import { setWorkspacePath } from './utils/paths.js';
import { loadConfig, getActiveWorkspace as getActiveConfigWorkspace } from './services/configStore.js';
import { recoverStuckTasks, loadBoard } from './services/store.js';
import { getMessagingConfig } from './services/messagingAdapter.js';
import { initializeStatusCache } from './services/messagingNotifier.js';
import type { ServerOptions } from '../types/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the client path for static file serving.
 * Handles both development (src/) and production (dist/) scenarios,
 * as well as global npm installs where package location differs from CWD.
 */
function resolveClientPath(): string {
  // In both dev and production, client files are in src/client relative to project root
  // __dirname is either src/server or dist/server
  const projectRoot = path.resolve(__dirname, '..', '..');
  return path.join(projectRoot, 'src', 'client');
}

const DEFAULT_PORT = 8000;
const DEFAULT_HOST = '0.0.0.0';

/**
 * Start the Formic server with the given options.
 * This function can be called from the CLI or directly.
 */
export async function startServer(options: ServerOptions = {}): Promise<void> {
  const port = options.port ?? parseInt(process.env.PORT || String(DEFAULT_PORT), 10);
  const host = options.host ?? process.env.HOST ?? DEFAULT_HOST;

  // Resolve workspace path with priority:
  // 1. Explicit option / WORKSPACE_PATH env var
  // 2. Active workspace from ~/.formic/config.json
  // 3. process.cwd() fallback
  const explicitWorkspace = options.workspacePath ?? process.env.WORKSPACE_PATH;
  let workspacePath: string;
  let workspaceSource: string;

  if (explicitWorkspace) {
    workspacePath = explicitWorkspace;
    workspaceSource = 'explicit (env/option)';
  } else {
    // Try to load active workspace from global config
    try {
      const activeWorkspace = await getActiveConfigWorkspace();
      if (activeWorkspace) {
        workspacePath = activeWorkspace.path;
        workspaceSource = `config.json (${activeWorkspace.name})`;
      } else {
        workspacePath = process.cwd();
        workspaceSource = 'cwd (fallback)';
      }
    } catch {
      workspacePath = process.cwd();
      workspaceSource = 'cwd (config load failed)';
    }
  }

  // workspaceSource is used in the banner; suppress the inline log
  void workspaceSource;

  // Set the workspace path for all services
  setWorkspacePath(workspacePath);

  const clientPath = resolveClientPath();

  const fastify = Fastify({
    logger: false,
  });

  // Register WebSocket support
  await fastify.register(fastifyWebSocket);

  // Serve static files from client directory
  await fastify.register(fastifyStatic, {
    root: clientPath,
    prefix: '/',
  });

  // Register API routes
  await fastify.register(boardRoutes);
  await fastify.register(taskRoutes);
  await fastify.register(assistantRoutes);
  await fastify.register(workspaceRoutes);
  await fastify.register(webhookRoutes);
  await fastify.register(configRoutes);
  await fastify.register(toolRoutes);

  // Register WebSocket routes
  await fastify.register(logsWebSocket);
  await fastify.register(assistantWebSocket);

  // Health check endpoint
  fastify.get('/health', async () => ({ status: 'ok' }));

  try {
    // Ensure ~/.formic/config.json exists on first startup
    await loadConfig();

    await fastify.listen({ port, host });

    // Log agent configuration
    const agentType = getAgentType();
    const agentCommand = getAgentCommand();
    const agentDisplayName = getAgentDisplayName();

    // Warn about missing environment variables (still useful for CI/piped output)
    const missingEnvVars = validateAgentEnv();
    if (missingEnvVars.length > 0) {
      console.warn(`Warning: Missing environment variables for ${agentDisplayName}: ${missingEnvVars.join(', ')}`);
    }

    // Recover any stuck tasks from previous server session
    // This must run BEFORE the queue processor starts
    await recoverStuckTasks();

    // Start the queue processor
    startQueueProcessor();
    const queueConfig = getQueueProcessorConfig();

    // Start the lease watchdog
    startWatchdog();

    // Initialize messaging notifications
    const messagingConfig = getMessagingConfig();
    const messagingEnabled = messagingConfig.telegram.enabled || messagingConfig.line.enabled;
    const messagingPlatforms: string[] = [];
    if (messagingEnabled) {
      // Initialize status cache to prevent false notifications on startup
      const board = await loadBoard();
      initializeStatusCache(board.tasks);

      if (messagingConfig.telegram.enabled) messagingPlatforms.push('Telegram');
      if (messagingConfig.line.enabled) messagingPlatforms.push('LINE');
    }

    // Read version from package.json
    let version = '0.0.0';
    try {
      const pkgPath = new URL('../../package.json', import.meta.url);
      const pkg = JSON.parse(await readFile(pkgPath, 'utf-8')) as { version?: string };
      version = pkg.version ?? '0.0.0';
    } catch { /* ignore */ }

    const bannerInfo: StartupInfo = {
      port,
      host,
      workspacePath,
      agentType,
      agentDisplayName,
      queueEnabled: queueConfig.enabled,
      maxConcurrent: queueConfig.maxConcurrent,
      version,
      messagingPlatforms,
    };

    await printStartupBanner(bannerInfo);

    // Suppress unused variable warning for agentCommand (retained for potential future use)
    void agentCommand;
  } catch (err) {
    const error = err as NodeJS.ErrnoException;

    // Provide helpful error messages for common issues
    if (error.code === 'EADDRINUSE') {
      console.error(`Error: Port ${port} is already in use.`);
      console.error(`Try running: formic start --port ${port + 1}`);
      process.exit(1);
    }

    fastify.log.error(err);
    process.exit(1);
  }
}

// Run server directly if this is the main module (for npm run dev/start)
// Check if this file was run directly vs imported
const isMainModule = process.argv[1] && (
  process.argv[1].endsWith('/server/index.js') ||
  process.argv[1].endsWith('/server/index.ts') ||
  process.argv[1].includes('dist/server/index')
);

if (isMainModule) {
  startServer();
}
