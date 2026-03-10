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

const MAX_LOG_LINES = 50;
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
        pastExperienceSection = `\n## Past Experience (${memories.length} relevant memories)\n${memories.map((m, i) => `${i + 1}. [${m.type}] ${m.content}`).join('\n')}\n`;
      }
    }
  } catch (error) {
    console.warn('[Runner] Failed to load task for memory injection:', error);
  }

  // Retrieve registered tools for context injection
  let availableToolsSection = '';
  try {
    const tools = await listTools();
    if (tools.length > 0) {
      console.log(`[Runner] ${tools.length} tools available in agent context for task ${taskId}`);
      availableToolsSection = `\n## Available Tools (${tools.length} registered)\n${tools.map(t => `- **${t.name}**: ${t.description}\n  Command: \`${t.command}\``).join('\n')}\nUse these tools when they match the task requirements to avoid re-implementing existing functionality.\n`;
    }
  } catch (error) {
    console.warn('[Runner] Failed to load tools for agent context:', error);
  }

  // Build tool forging instructions with the live server port
  const toolForgingSection = `
## Tool Forging
If during this task you identify a shell command that would be reusable across future tasks (e.g. a test runner, linter, build script, or deploy command), register it as a tool by running:
  curl -s -X POST http://localhost:${port}/api/tools \\
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

  // Set up error handler FIRST to catch spawn errors (e.g., command not found)
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

    await updateTaskStatus(taskId, 'todo', null);
    await appendTaskLogs(taskId, [`Error: ${errorMessage}`]);

    broadcastToTask(taskId, {
      type: 'error',
      data: errorMessage,
      timestamp: new Date().toISOString(),
    });
  });

  // Check if spawn succeeded (pid exists)
  if (!child.pid) {
    // Don't throw - let the error event handle it
    // Return a placeholder that will be updated when error fires
    activeProcesses.set(taskId, child);
    await updateTaskStatus(taskId, 'running', 0);
    return { pid: 0 };
  }

  activeProcesses.set(taskId, child);

  // Update task status
  await updateTaskStatus(taskId, 'running', child.pid);

  // Handle stdout
  child.stdout?.on('data', (data: Buffer) => {
    const text = data.toString();
    const lines = text.split('\n').filter(line => line.length > 0);
    logBuffer.push(...lines);

    // Keep buffer limited
    while (logBuffer.length > MAX_LOG_LINES) {
      logBuffer.shift();
    }

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

    while (logBuffer.length > MAX_LOG_LINES) {
      logBuffer.shift();
    }

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
    await updateTaskStatus(taskId, newStatus, null);

    broadcastToTask(taskId, {
      type: 'exit',
      data: `Process exited with code ${code}`,
      timestamp: new Date().toISOString(),
    });
  });

  return { pid: child.pid };
}

export async function stopAgent(taskId: string): Promise<boolean> {
  const process = activeProcesses.get(taskId);

  if (!process) {
    return false;
  }

  process.kill('SIGTERM');

  // Give it a moment, then force kill if needed
  setTimeout(() => {
    if (activeProcesses.has(taskId)) {
      process.kill('SIGKILL');
    }
  }, 5000);

  return true;
}
