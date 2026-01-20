import type { FastifyInstance } from 'fastify';
import { createTask, updateTask, deleteTask, getTask } from '../services/store.js';
import { runAgent, stopAgent, isAgentRunning, getRunningTaskId } from '../services/runner.js';
import type { CreateTaskInput, UpdateTaskInput } from '../../types/index.js';

export async function taskRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /api/tasks - Create a new task
  fastify.post<{ Body: CreateTaskInput }>('/api/tasks', async (request, reply) => {
    const { title, context, priority } = request.body;

    if (!title || !context) {
      return reply.status(400).send({ error: 'Title and context are required' });
    }

    const task = await createTask({ title, context, priority });
    return reply.status(201).send(task);
  });

  // PUT /api/tasks/:id - Update a task
  fastify.put<{ Params: { id: string }; Body: UpdateTaskInput }>('/api/tasks/:id', async (request, reply) => {
    const { id } = request.params;
    const task = await updateTask(id, request.body);

    if (!task) {
      return reply.status(404).send({ error: 'Task not found' });
    }

    return reply.send(task);
  });

  // DELETE /api/tasks/:id - Delete a task
  // Query param: ?preserveHistory=true to keep the docs folder
  fastify.delete<{ Params: { id: string }; Querystring: { preserveHistory?: string } }>('/api/tasks/:id', async (request, reply) => {
    const { id } = request.params;
    const preserveHistory = request.query.preserveHistory === 'true';

    // Check if task is running
    if (getRunningTaskId() === id) {
      return reply.status(400).send({ error: 'Cannot delete a running task' });
    }

    const deleted = await deleteTask(id, preserveHistory);

    if (!deleted) {
      return reply.status(404).send({ error: 'Task not found' });
    }

    return reply.status(204).send();
  });

  // POST /api/tasks/:id/run - Start agent execution
  fastify.post<{ Params: { id: string } }>('/api/tasks/:id/run', async (request, reply) => {
    const { id } = request.params;

    // Check if an agent is already running
    if (isAgentRunning()) {
      return reply.status(409).send({
        error: 'An agent is already running',
        runningTaskId: getRunningTaskId(),
      });
    }

    const task = await getTask(id);
    if (!task) {
      return reply.status(404).send({ error: 'Task not found' });
    }

    if (task.status !== 'todo') {
      return reply.status(400).send({ error: 'Task must be in todo status to run' });
    }

    try {
      const result = await runAgent(id, task.title, task.context, task.docsPath);
      return reply.send({ status: 'running', pid: result.pid });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.status(500).send({ error: message });
    }
  });

  // POST /api/tasks/:id/stop - Stop agent execution
  fastify.post<{ Params: { id: string } }>('/api/tasks/:id/stop', async (request, reply) => {
    const { id } = request.params;

    const stopped = await stopAgent(id);

    if (!stopped) {
      return reply.status(404).send({ error: 'No running agent found for this task' });
    }

    return reply.send({ status: 'stopping' });
  });
}
