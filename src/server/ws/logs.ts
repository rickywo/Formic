import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { SocketStream } from '@fastify/websocket';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { registerConnection, unregisterConnection } from '../services/runner.js';
import { registerWorkflowConnection, unregisterWorkflowConnection } from '../services/workflow.js';
import { registerTaskConnection, unregisterTaskConnection } from '../services/boardNotifier.js';
import { getTask } from '../services/store.js';
import { getTaskLogsDir, getTaskLogPath } from '../utils/paths.js';

const CANONICAL_STEP_ORDER = ['brief', 'plan', 'declare', 'execute', 'verify', 'architect'];

async function loadDiskLogs(taskId: string): Promise<string | null> {
  // Prefer unified task.log when it exists
  try {
    const content = await readFile(getTaskLogPath(taskId), 'utf-8');
    if (content.trim().length > 0) {
      return content;
    }
  } catch (err: unknown) {
    if (!(err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT')) {
      throw err;
    }
  }

  // Fallback: per-step directory scan for tasks created before this change
  const logsDir = getTaskLogsDir(taskId);

  let files: string[];
  try {
    files = await readdir(logsDir);
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw err;
  }

  const logFileSet = new Set(files);
  const parts: string[] = [];

  for (const step of CANONICAL_STEP_ORDER) {
    const filename = `${step}.log`;
    if (!logFileSet.has(filename)) continue;

    try {
      const content = await readFile(path.join(logsDir, filename), 'utf-8');
      if (content.trim().length > 0) {
        parts.push(`\n========== ${step.toUpperCase()} STEP ==========\n`);
        parts.push(content);
      }
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        continue;
      }
      throw err;
    }
  }

  return parts.length > 0 ? parts.join('') : null;
}

export async function logsWebSocket(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Params: { taskId: string } }>('/ws/logs/:taskId', { websocket: true }, async (connection: SocketStream, request: FastifyRequest<{ Params: { taskId: string } }>) => {
    const { taskId } = request.params;
    const socket = connection.socket;

    // Verify task exists
    const task = await getTask(taskId);
    if (!task) {
      socket.send(JSON.stringify({ type: 'error', data: 'Task not found' }));
      socket.close();
      return;
    }

    // Register this connection for runner, workflow, and board notifier
    registerConnection(taskId, socket);
    registerWorkflowConnection(taskId, socket);
    registerTaskConnection(taskId, socket);

    // Send disk logs if available, fall back to in-memory agentLogs
    const diskLogs = await loadDiskLogs(taskId);
    if (diskLogs) {
      socket.send(JSON.stringify({
        type: 'history',
        data: diskLogs,
        timestamp: new Date().toISOString(),
      }));
    } else if (task.agentLogs.length > 0) {
      socket.send(JSON.stringify({
        type: 'history',
        data: task.agentLogs.join('\n'),
        timestamp: new Date().toISOString(),
      }));
    }

    // Handle client messages (for future use)
    socket.on('message', (_message: Buffer) => {
      // Could handle client commands here
    });

    // Handle disconnection
    socket.on('close', () => {
      unregisterConnection(taskId, socket);
      unregisterWorkflowConnection(taskId, socket);
      unregisterTaskConnection(taskId, socket);
    });

    socket.on('error', () => {
      unregisterConnection(taskId, socket);
      unregisterWorkflowConnection(taskId, socket);
      unregisterTaskConnection(taskId, socket);
    });
  });
}
