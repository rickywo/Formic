import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { SocketStream } from '@fastify/websocket';
import { registerConnection, unregisterConnection } from '../services/runner.js';
import { registerWorkflowConnection, unregisterWorkflowConnection } from '../services/workflow.js';
import { getTask } from '../services/store.js';

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

    // Register this connection for both runner and workflow
    registerConnection(taskId, socket);
    registerWorkflowConnection(taskId, socket);

    // Send existing logs if task has any
    if (task.agentLogs.length > 0) {
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
    });

    socket.on('error', () => {
      unregisterConnection(taskId, socket);
      unregisterWorkflowConnection(taskId, socket);
    });
  });
}
