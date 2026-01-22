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
import {
  loadSubtasks,
  updateSubtaskStatus,
  getCompletionStats,
  subtasksExist,
} from '../services/subtasks.js';
import type { CreateTaskInput, UpdateTaskInput, SubtaskStatus } from '../../types/index.js';
import { getCurrentBranch, getBranchStatus } from '../services/git.js';

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

  // ==================== Subtask Management Endpoints (Phase 9) ====================

  // GET /api/tasks/:id/subtasks - Get all subtasks for a task
  fastify.get<{ Params: { id: string } }>('/api/tasks/:id/subtasks', async (request, reply) => {
    const { id } = request.params;

    const task = await getTask(id);
    if (!task) {
      return reply.status(404).send({ error: 'Task not found' });
    }

    if (!subtasksExist(task.docsPath)) {
      return reply.status(404).send({ error: 'Subtasks not found. Run the /plan step to generate subtasks.json' });
    }

    const subtasks = await loadSubtasks(task.docsPath);
    if (!subtasks) {
      return reply.status(500).send({ error: 'Failed to load subtasks.json' });
    }

    return reply.send(subtasks);
  });

  // PUT /api/tasks/:id/subtasks/:subtaskId - Update a subtask's status
  fastify.put<{
    Params: { id: string; subtaskId: string };
    Body: { status: SubtaskStatus };
  }>('/api/tasks/:id/subtasks/:subtaskId', async (request, reply) => {
    const { id, subtaskId } = request.params;
    const { status } = request.body;

    // Validate status
    if (!status || !['pending', 'in_progress', 'completed'].includes(status)) {
      return reply.status(400).send({ error: 'Invalid status. Must be: pending, in_progress, or completed' });
    }

    const task = await getTask(id);
    if (!task) {
      return reply.status(404).send({ error: 'Task not found' });
    }

    if (!subtasksExist(task.docsPath)) {
      return reply.status(404).send({ error: 'Subtasks not found' });
    }

    const result = await updateSubtaskStatus(task.docsPath, subtaskId, status);
    if (!result.success) {
      return reply.status(404).send({ error: 'Subtask not found' });
    }

    return reply.send({ success: true, subtask: result.subtask });
  });

  // GET /api/tasks/:id/subtasks/completion - Get completion statistics
  fastify.get<{ Params: { id: string } }>('/api/tasks/:id/subtasks/completion', async (request, reply) => {
    const { id } = request.params;

    const task = await getTask(id);
    if (!task) {
      return reply.status(404).send({ error: 'Task not found' });
    }

    if (!subtasksExist(task.docsPath)) {
      return reply.status(404).send({ error: 'Subtasks not found' });
    }

    const subtasks = await loadSubtasks(task.docsPath);
    if (!subtasks) {
      return reply.status(500).send({ error: 'Failed to load subtasks.json' });
    }

    const stats = getCompletionStats(subtasks);
    return reply.send({
      taskId: id,
      ...stats,
      allComplete: stats.completed === stats.total,
    });
  });

  // ==================== Branch & Conflict Management (Phase 11) ====================

  // POST /api/tasks/:id/conflict-task - Create a conflict resolution task
  fastify.post<{ Params: { id: string } }>('/api/tasks/:id/conflict-task', async (request, reply) => {
    const { id } = request.params;

    const task = await getTask(id);
    if (!task) {
      return reply.status(404).send({ error: 'Task not found' });
    }

    // Ensure the task has branch info
    if (!task.branch) {
      return reply.status(400).send({ error: 'Task does not have a branch assigned' });
    }

    // Check branch status
    const baseBranch = task.baseBranch || 'main';
    const branchStatus = await getBranchStatus(task.branch, baseBranch);

    if (branchStatus !== 'conflicts' && branchStatus !== 'behind') {
      return reply.status(400).send({
        error: 'No conflicts detected',
        branchStatus,
        message: `Branch ${task.branch} is ${branchStatus} relative to ${baseBranch}`,
      });
    }

    // Create conflict resolution task
    const conflictTitle = `Resolve conflicts: ${task.id} ↔ ${baseBranch}`;
    const conflictContext = `## Conflict Resolution Task

**Source Task:** ${task.id} - ${task.title}
**Source Branch:** ${task.branch}
**Base Branch:** ${baseBranch}
**Status:** ${branchStatus}

### Instructions
1. Checkout the branch: \`git checkout ${task.branch}\`
2. Merge the base branch: \`git merge ${baseBranch}\`
3. Resolve any conflicts in the affected files
4. Commit the resolution: \`git commit -m "Resolve merge conflicts with ${baseBranch}"\`
5. Push the changes: \`git push\`

### Context from Original Task
${task.context}`;

    const conflictTask = await createTask({
      title: conflictTitle,
      context: conflictContext,
      priority: 'high', // Conflict resolution is high priority
      baseBranch: task.branch, // Work on the conflicting branch
    });

    return reply.status(201).send({
      success: true,
      conflictTask,
      originalTask: {
        id: task.id,
        branch: task.branch,
        baseBranch,
        branchStatus,
      },
    });
  });

  // GET /api/tasks/:id/branch-status - Get branch status for a task
  fastify.get<{ Params: { id: string } }>('/api/tasks/:id/branch-status', async (request, reply) => {
    const { id } = request.params;

    const task = await getTask(id);
    if (!task) {
      return reply.status(404).send({ error: 'Task not found' });
    }

    if (!task.branch) {
      return reply.send({
        taskId: id,
        branch: null,
        branchStatus: null,
        baseBranch: task.baseBranch || 'main',
        message: 'Task does not have a branch assigned yet',
      });
    }

    const baseBranch = task.baseBranch || 'main';
    const branchStatus = await getBranchStatus(task.branch, baseBranch);

    return reply.send({
      taskId: id,
      branch: task.branch,
      branchStatus,
      baseBranch,
    });
  });
}
