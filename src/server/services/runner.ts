import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { WebSocket } from 'ws';
import { updateTaskStatus, appendTaskLogs, getTask } from './store.js';
import { getAgentCommand, buildAgentArgs, getAgentDisplayName } from './agentAdapter.js';
import { getWorkspacePath } from '../utils/paths.js';
import { releaseLeases } from './leaseManager.js';
import { createSafePoint } from '../utils/gitUtils.js';
import type { LogMessage, Task } from '../../types/index.js';
import path from 'node:path';
import { getRelevantMemories } from './memory.js';
import { listTools } from './tools.js';
import { engineConfig, refreshEngineConfig } from './engineConfig.js';

const GUIDELINE_FILENAME = 'kanban-development-guideline.md';

/**
 * Load the project development guidelines if they exist
 */
async function loadProjectGuidelines(): Promise<string> {
  const guidelinePath = path.join(getWorkspacePath(), GUIDELINE_FILENAME);

  if (!existsSync(guidelinePath)) {
    return '';
  }

  try {
    const content = await readFile(guidelinePath, 'utf-8');
    return `
## Project Development Guidelines
The following guidelines MUST be followed for all code changes in this project:

${content}

---
END OF GUIDELINES

`;
  } catch (error) {
    console.warn('[Runner] Failed to load project guidelines:', error);
    return '';
  }
}

// Store active processes
const activeProcesses = new Map<string, ChildProcess>();

// The actual port the server is listening on, set once at startup via setBoundPort().
let boundPort = 8000;

/**
 * Called by the server entry point after the HTTP server binds to register
 * the live port so agents always POST tool registrations to the correct address.
 */
export function setBoundPort(port: number): void {
  boundPort = port;
}

// Store WebSocket connections per task
const taskConnections = new Map<string, Set<WebSocket>>();

export function isAgentRunning(): boolean {
  return activeProcesses.size > 0;
}

export function getRunningTaskId(): string | null {
  const entries = Array.from(activeProcesses.entries());
  return entries.length > 0 ? entries[0][0] : null;
}

export function registerConnection(taskId: string, ws: WebSocket): void {
  if (!taskConnections.has(taskId)) {
    taskConnections.set(taskId, new Set());
  }
  taskConnections.get(taskId)!.add(ws);
}

export function unregisterConnection(taskId: string, ws: WebSocket): void {
  const connections = taskConnections.get(taskId);
  if (connections) {
    connections.delete(ws);
    if (connections.size === 0) {
      taskConnections.delete(taskId);
    }
  }
}

function broadcastToTask(taskId: string, message: LogMessage): void {
  const connections = taskConnections.get(taskId);
  if (!connections) return;

  const data = JSON.stringify(message);
  for (const ws of connections) {
    if (ws.readyState === 1) { // WebSocket.OPEN
      ws.send(data);
    }
  }
}

export async function runAgent(taskId: string, title: string, context: string, docsPath: string): Promise<{ pid: number }> {
  await refreshEngineConfig();
  // Check concurrency - allow multiple agents based on maxConcurrentTasks
  if (activeProcesses.size >= engineConfig.maxConcurrentTasks) {
    throw new Error(`Maximum concurrent agents reached (${engineConfig.maxConcurrentTasks}). Please wait for one to complete.`);
  }

  // Load project guidelines (injected into prompt)
  const guidelines = await loadProjectGuidelines();

  // Retrieve relevant memories for this task
  let pastExperienceSection = '';
  try {
    const task = await getTask(taskId);
    if (task !== undefined) {
      const memories = await getRelevantMemories(task);
      if (memories.length > 0) {
        console.log(`[Runner] Injecting ${memories.length} memories into agent context for task ${taskId}`);
        const entries = memories
          .map((m, i) => `${i + 1}. [${m.type.toUpperCase()}] ${m.content}`)
          .join('\n');
        pastExperienceSection = `\n\n## Past Experience\nThe following memories from previous tasks may be relevant:\n${entries}`;
      }
    }
  } catch (error) {
    console.warn('[Runner] Memory retrieval failed, proceeding without memories:', error);
  }

  // Retrieve registered tools for context injection
  let availableToolsSection = '';
  try {
    const tools = await listTools();
    if (tools.length > 0) {
      console.log(`[Runner] ${tools.length} tools available in agent context for task ${taskId}`);
      availableToolsSection = `\n## Available Tools (${tools.length} registered)\n${tools.map(t => `- **${t.manifest.name}**: ${t.manifest.description}\n  Command: \`${t.manifest.command}\``).join('\n')}\nUse these tools when they match the task requirements to avoid re-implementing existing functionality.\n`;
    }
  } catch (error) {
    console.warn('[Runner] Failed to load tools for agent context:', error);
  }

  // Build tool forging instructions with the live server port
  const toolForgingSection = `
## Tool Forging
If during this task you identify a shell command that would be reusable across future tasks (e.g. a test runner, linter, build script, or deploy command), register it as a tool by running:
  curl -s -X POST http://localhost:${boundPort}/api/tools \\
    -H 'Content-Type: application/json' \\
    -d '{"name":"slug-name","description":"What it does","command":"the shell command","created_by":"${title}"}'
Rules:
- Tool names must be lowercase alphanumeric with hyphens only (e.g. run-tests, lint-fix, build-dist).
- Only forge a tool if the command is generic and reusable — not task-specific.
- Skip forging if a similar tool already exists in the Available Tools section above.
`;

  // Build prompt - simple format for --print mode
  // Note: In --print mode, tools are limited. For complex tasks, the agent should read context from the prompt directly.
  const prompt = `${guidelines}Task: ${title}

Context: ${context}
${pastExperienceSection}${availableToolsSection}${toolForgingSection}
Task documentation is available at: ${docsPath}/

All code changes MUST comply with the project development guidelines provided above.`;

  // Spawn agent CLI process using the configured agent adapter
  // stdin is set to 'ignore' since non-interactive mode doesn't need input
  const agentCommand = getAgentCommand();
  const agentArgs = buildAgentArgs(prompt);

  // Create a git safe-point commit before spawning the agent for rollback support
  await createSafePoint(taskId);

  const child = spawn(agentCommand, agentArgs, {
    cwd: getWorkspacePath(),
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logBuffer: string[] = [];

  // --- Spawn confirmation phase ---
  // On Unix, spawn() can return successfully but then emit an 'error' event
  // asynchronously (e.g., ENOENT when the command is not found). We await
  // explicit confirmation that the child process is alive before registering
  // it in activeProcesses, so a spawn failure never leaks a phantom running task.
  // We use a ref object so TypeScript can track the mutation through the closure.
  const spawnErrorRef: { err: NodeJS.ErrnoException | null } = { err: null };
  const onSpawnError = (err: NodeJS.ErrnoException): void => {
    spawnErrorRef.err = err;
  };
  child.once('error', onSpawnError);

  // Yield to the event loop so any queued spawn error can surface.
  await new Promise<void>(resolve => setImmediate(resolve));

  const spawnError = spawnErrorRef.err;
  if (spawnError) {
    // Spawn failed — clean up without ever adding to activeProcesses.
    // No activeProcesses entry means no leaked concurrency slot.
    releaseLeases(taskId);
    console.log(`[Runner] Released leases for task ${taskId} (spawn error)`);

    const agentName = getAgentDisplayName();
    let errorMessage = spawnError.message;
    if (spawnError.code === 'ENOENT') {
      errorMessage = `Command '${agentCommand}' not found. Please ensure ${agentName} is installed and available in PATH.`;
    } else if (spawnError.code === 'EACCES') {
      errorMessage = `Permission denied when trying to execute '${agentCommand}'.`;
    }

    await updateTaskStatus(taskId, 'todo', null, 'runner.spawn_error');

    broadcastToTask(taskId, {
      type: 'error',
      data: errorMessage,
      timestamp: new Date().toISOString(),
    });

    throw new Error(errorMessage);
  }

  // Spawn confirmed — remove the one-shot spawn-error listener and replace
  // it with the permanent error handler for post-spawn (runtime) failures.
  child.removeListener('error', onSpawnError);

  // Set up the permanent error handler for post-spawn failures (e.g., process
  // crash, runtime errors after the child was successfully spawned).
  child.on('error', async (err: NodeJS.ErrnoException) => {
    activeProcesses.delete(taskId);
    releaseLeases(taskId);
    console.log(`[Runner] Released leases for task ${taskId} (error handler)`);

    // Provide helpful error messages for common issues
    const agentName = getAgentDisplayName();
    let errorMessage = err.message;
    if (err.code === 'ENOENT') {
      errorMessage = `Command '${agentCommand}' not found. Please ensure ${agentName} is installed and available in PATH.`;
    } else if (err.code === 'EACCES') {
      errorMessage = `Permission denied when trying to execute '${agentCommand}'.`;
    }

    await updateTaskStatus(taskId, 'todo', null, 'runner.spawn_error');

    broadcastToTask(taskId, {
      type: 'error',
      data: errorMessage,
      timestamp: new Date().toISOString(),
    });
  });

  activeProcesses.set(taskId, child);

  // Update task status
  await updateTaskStatus(taskId, 'running', child.pid, 'runner.process_spawned');

  // Handle stdout
  child.stdout?.on('data', (data: Buffer) => {
    const text = data.toString();
    const lines = text.split('\n').filter(line => line.length > 0);
    logBuffer.push(...lines);

    broadcastToTask(taskId, {
      type: 'stdout',
      data: text,
      timestamp: new Date().toISOString(),
    });
  });

  // Handle stderr
  child.stderr?.on('data', (data: Buffer) => {
    const text = data.toString();
    const lines = text.split('\n').filter(line => line.length > 0);
    logBuffer.push(...lines);

    broadcastToTask(taskId, {
      type: 'stderr',
      data: text,
      timestamp: new Date().toISOString(),
    });
  });

  // Handle process exit
  child.on('close', async (code) => {
    activeProcesses.delete(taskId);
    releaseLeases(taskId);
    console.log(`[Runner] Released leases for task ${taskId} (close handler)`);

    // Save logs to task
    await appendTaskLogs(taskId, logBuffer);

    // Update status based on exit code
    const newStatus = code === 0 ? 'review' : 'todo';
    const closeCallerTag = code === 0 ? 'runner.close_event.success' : 'runner.close_event.failed';
    await updateTaskStatus(taskId, newStatus, null, closeCallerTag);

    broadcastToTask(taskId, {
      type: 'exit',
      data: `Process exited with code ${code}`,
      timestamp: new Date().toISOString(),
    });
  });

  // child.pid is guaranteed defined here because spawn was confirmed above
  return { pid: child.pid! };
}

export async function stopAgent(taskId: string): Promise<boolean> {
  const process = activeProcesses.get(taskId);

  if (!process) {
    return false;
  }

  process.kill('SIGTERM');

  // Eagerly reset to todo so the UI updates immediately
  await updateTaskStatus(taskId, 'todo', null, 'runner.stopAgent');

  // Give it a moment, then force kill if needed
  setTimeout(() => {
    if (activeProcesses.has(taskId)) {
      process.kill('SIGKILL');
    }
  }, 3000);

  return true;
}
