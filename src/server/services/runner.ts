import { spawn, type ChildProcess } from 'node:child_process';
import type { WebSocket } from 'ws';
import { updateTaskStatus, appendTaskLogs } from './store.js';
import type { LogMessage } from '../../types/index.js';

const WORKSPACE_PATH = process.env.WORKSPACE_PATH || './workspace';
const MAX_LOG_LINES = 50;

// Store active processes
const activeProcesses = new Map<string, ChildProcess>();

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
  // Check concurrency
  if (isAgentRunning()) {
    throw new Error('An agent is already running. Please wait for it to complete.');
  }

  // Build prompt that includes task context location
  const prompt = `First, read the task context from ${docsPath}/ (README.md, PLAN.md, CHECKLIST.md). Then execute: ${title}. Context: ${context}. Write any outputs to ${docsPath}/output/`;

  // Spawn Claude CLI process
  const child = spawn('claude', ['--print', prompt], {
    cwd: WORKSPACE_PATH,
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  if (!child.pid) {
    throw new Error('Failed to spawn Claude process');
  }

  activeProcesses.set(taskId, child);

  // Update task status
  await updateTaskStatus(taskId, 'running', child.pid);

  const logBuffer: string[] = [];

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

  // Handle errors
  child.on('error', async (err) => {
    activeProcesses.delete(taskId);

    await updateTaskStatus(taskId, 'todo', null);
    await appendTaskLogs(taskId, [`Error: ${err.message}`]);

    broadcastToTask(taskId, {
      type: 'error',
      data: err.message,
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
