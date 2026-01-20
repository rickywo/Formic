import type { FastifyInstance } from 'fastify';
import { createTask, updateTask, deleteTask, getTask } from '../services/store.js';
import { runAgent, stopAgent, isAgentRunning, getRunningTaskId } from '../services/runner.js';
import {
  executeFullWorkflow,
  executeSingleStep,
  stopWorkflow,
  isWorkflowRunning,
  getActiveWorkflowStep,
} from '../services/workflow.js';
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

    // Check if task is running or workflow is active
    if (getRunningTaskId() === id || isWorkflowRunning(id)) {
      return reply.status(400).send({ error: 'Cannot delete a running task' });
    }

    const deleted = await deleteTask(id, preserveHistory);

    if (!deleted) {
      return reply.status(404).send({ error: 'Task not found' });
    }

    return reply.status(204).send();
  });

  // POST /api/tasks/:id/run - Start full workflow execution (brief → plan → execute)
  fastify.post<{ Params: { id: string }; Querystring: { useWorkflow?: string } }>('/api/tasks/:id/run', async (request, reply) => {
    const { id } = request.params;
    const useWorkflow = request.query.useWorkflow !== 'false'; // Default to using workflow

    // Check if an agent is already running
    if (isAgentRunning() || isWorkflowRunning(id)) {
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
      if (useWorkflow) {
        // Use full workflow: brief → plan → execute
        const result = await executeFullWorkflow(id);
        return reply.send({
          status: 'briefing',
          workflowStep: 'brief',
          message: 'Starting workflow: brief → plan → execute',
          pid: result.pid,
        });
      } else {
        // Legacy: direct execution without workflow
        const result = await runAgent(id, task.title, task.context, task.docsPath);
        return reply.send({ status: 'running', pid: result.pid });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.status(500).send({ error: message });
    }
  });

  // POST /api/tasks/:id/stop - Stop agent/workflow execution
  fastify.post<{ Params: { id: string } }>('/api/tasks/:id/stop', async (request, reply) => {
    const { id } = request.params;

    // Try stopping workflow first, then legacy agent
    const workflowStopped = await stopWorkflow(id);
    if (workflowStopped) {
      return reply.send({ status: 'stopping', type: 'workflow' });
    }

    const agentStopped = await stopAgent(id);
    if (agentStopped) {
      return reply.send({ status: 'stopping', type: 'agent' });
    }

    return reply.status(404).send({ error: 'No running agent found for this task' });
  });

  // POST /api/tasks/:id/workflow/brief - Run only the brief step
  fastify.post<{ Params: { id: string } }>('/api/tasks/:id/workflow/brief', async (request, reply) => {
    const { id } = request.params;

    if (isAgentRunning() || isWorkflowRunning(id)) {
      return reply.status(409).send({ error: 'An agent is already running' });
    }

    const task = await getTask(id);
    if (!task) {
      return reply.status(404).send({ error: 'Task not found' });
    }

    try {
      const result = await executeSingleStep(id, 'brief');
      return reply.send({
        status: 'briefing',
        workflowStep: 'brief',
        success: result.success,
        pid: result.pid,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.status(500).send({ error: message });
    }
  });

  // POST /api/tasks/:id/workflow/plan - Run only the plan step
  fastify.post<{ Params: { id: string } }>('/api/tasks/:id/workflow/plan', async (request, reply) => {
    const { id } = request.params;

    if (isAgentRunning() || isWorkflowRunning(id)) {
      return reply.status(409).send({ error: 'An agent is already running' });
    }

    const task = await getTask(id);
    if (!task) {
      return reply.status(404).send({ error: 'Task not found' });
    }

    try {
      const result = await executeSingleStep(id, 'plan');
      return reply.send({
        status: 'planning',
        workflowStep: 'plan',
        success: result.success,
        pid: result.pid,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.status(500).send({ error: message });
    }
  });

  // POST /api/tasks/:id/workflow/execute - Run only the execute step
  fastify.post<{ Params: { id: string } }>('/api/tasks/:id/workflow/execute', async (request, reply) => {
    const { id } = request.params;

    if (isAgentRunning() || isWorkflowRunning(id)) {
      return reply.status(409).send({ error: 'An agent is already running' });
    }

    const task = await getTask(id);
    if (!task) {
      return reply.status(404).send({ error: 'Task not found' });
    }

    try {
      const result = await executeSingleStep(id, 'execute');
      return reply.send({
        status: 'running',
        workflowStep: 'execute',
        success: result.success,
        pid: result.pid,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.status(500).send({ error: message });
    }
  });

  // GET /api/tasks/:id/workflow - Get workflow status
  fastify.get<{ Params: { id: string } }>('/api/tasks/:id/workflow', async (request, reply) => {
    const { id } = request.params;

    const task = await getTask(id);
    if (!task) {
      return reply.status(404).send({ error: 'Task not found' });
    }

    return reply.send({
      taskId: id,
      status: task.status,
      workflowStep: task.workflowStep || 'pending',
      workflowLogs: task.workflowLogs || {},
      isRunning: isWorkflowRunning(id),
      activeStep: getActiveWorkflowStep(id),
    });
  });
}
