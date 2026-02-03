import type { FastifyInstance } from 'fastify';
import { stat, access, mkdir } from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import path from 'node:path';
import { getWorkspacePath, setWorkspacePath, getFormicDir, getBoardPath } from '../utils/paths.js';
import { loadBoard } from '../services/store.js';
import { broadcastWorkspaceChanged } from '../services/boardNotifier.js';
import { loadConfig, addWorkspace, setActiveWorkspace } from '../services/configStore.js';
import type { WorkspaceInfo, WorkspaceValidation, TaskCounts, TaskStatus } from '../../types/index.js';

/**
 * Validate that a path is an absolute path to an existing, writable directory
 */
async function validateWorkspacePath(workspacePath: string): Promise<WorkspaceValidation> {
  const result: WorkspaceValidation = {
    valid: false,
    exists: false,
    isDirectory: false,
    isWritable: false,
    hasFormic: false,
  };

  // Check if path is absolute
  if (!path.isAbsolute(workspacePath)) {
    result.error = 'Path must be absolute';
    return result;
  }

  // Check if path exists
  try {
    const stats = await stat(workspacePath);
    result.exists = true;
    result.isDirectory = stats.isDirectory();
  } catch {
    result.error = 'Path does not exist';
    return result;
  }

  if (!result.isDirectory) {
    result.error = 'Path is not a directory';
    return result;
  }

  // Check if path is writable
  try {
    await access(workspacePath, constants.W_OK);
    result.isWritable = true;
  } catch {
    result.error = 'Directory is not writable';
    return result;
  }

  // Check if .formic folder exists
  const formicPath = path.join(workspacePath, '.formic');
  result.hasFormic = existsSync(formicPath);

  result.valid = true;
  return result;
}

/**
 * Calculate task counts by status from board
 */
function calculateTaskCounts(tasks: Array<{ status: TaskStatus }>): TaskCounts {
  const counts: TaskCounts = {
    todo: 0,
    queued: 0,
    briefing: 0,
    planning: 0,
    running: 0,
    review: 0,
    done: 0,
  };

  for (const task of tasks) {
    if (task.status in counts) {
      counts[task.status]++;
    }
  }

  return counts;
}

/**
 * Get the most recent activity timestamp from tasks
 */
function getLastActivity(tasks: Array<{ createdAt?: string; queuedAt?: string }>): string | null {
  let lastActivity: Date | null = null;

  for (const task of tasks) {
    const timestamps = [task.createdAt, task.queuedAt].filter(Boolean) as string[];
    for (const ts of timestamps) {
      const date = new Date(ts);
      if (!lastActivity || date > lastActivity) {
        lastActivity = date;
      }
    }
  }

  return lastActivity ? lastActivity.toISOString() : null;
}

export async function workspaceRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /api/workspace/validate - Validate a workspace path
  fastify.post<{ Body: { path: string } }>('/api/workspace/validate', async (request, reply) => {
    const { path: workspacePath } = request.body;

    if (!workspacePath) {
      return reply.status(400).send({ error: 'Path is required' });
    }

    const validation = await validateWorkspacePath(workspacePath);
    return reply.send(validation);
  });

  // GET /api/workspace/info - Get current workspace metadata
  fastify.get('/api/workspace/info', async (_request, reply) => {
    const workspacePath = getWorkspacePath();
    const formicDir = getFormicDir();
    const formicInitialized = existsSync(formicDir);

    let taskCounts: TaskCounts = {
      todo: 0,
      queued: 0,
      briefing: 0,
      planning: 0,
      running: 0,
      review: 0,
      done: 0,
    };
    let lastActivity: string | null = null;

    // Load board if .formic exists
    if (formicInitialized && existsSync(getBoardPath())) {
      try {
        const board = await loadBoard();
        taskCounts = calculateTaskCounts(board.tasks);
        lastActivity = getLastActivity(board.tasks);
      } catch (err) {
        console.error('[Workspace] Failed to load board for info:', err);
      }
    }

    const info: WorkspaceInfo = {
      path: workspacePath,
      projectName: path.basename(workspacePath) || 'Unknown',
      taskCounts,
      formicInitialized,
      lastActivity,
    };

    return reply.send(info);
  });

  // POST /api/workspace/switch - Switch to a different workspace
  fastify.post<{ Body: { path: string } }>('/api/workspace/switch', async (request, reply) => {
    const { path: workspacePath } = request.body;

    if (!workspacePath) {
      return reply.status(400).send({ error: 'Path is required' });
    }

    // Validate the new workspace path
    const validation = await validateWorkspacePath(workspacePath);
    if (!validation.valid) {
      return reply.status(400).send({
        error: validation.error || 'Invalid workspace path',
        validation,
      });
    }

    // Create .formic directory if it doesn't exist
    const formicPath = path.join(workspacePath, '.formic');
    if (!validation.hasFormic) {
      try {
        await mkdir(formicPath, { recursive: true });
        console.log('[Workspace] Created .formic directory at:', formicPath);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return reply.status(500).send({ error: `Failed to create .formic directory: ${message}` });
      }
    }

    // Update the workspace path
    setWorkspacePath(workspacePath);

    // Persist workspace change to ~/.formic/config.json
    try {
      const workspace = await addWorkspace({ path: workspacePath });
      await setActiveWorkspace(workspace.id);
    } catch (err) {
      console.error('[Workspace] Failed to persist workspace to config:', err);
    }

    // Broadcast workspace change to all connected clients
    broadcastWorkspaceChanged(workspacePath);

    // Load workspace info to return
    let taskCounts: TaskCounts = {
      todo: 0,
      queued: 0,
      briefing: 0,
      planning: 0,
      running: 0,
      review: 0,
      done: 0,
    };

    // Load board if it exists (may be newly created empty workspace)
    if (existsSync(getBoardPath())) {
      try {
        const board = await loadBoard();
        taskCounts = calculateTaskCounts(board.tasks);
      } catch (err) {
        console.error('[Workspace] Failed to load board after switch:', err);
      }
    }

    return reply.send({
      success: true,
      workspace: {
        path: workspacePath,
        name: path.basename(workspacePath),
        taskCounts,
      },
    });
  });
}
