import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Board, Task, CreateTaskInput, UpdateTaskInput } from '../../types/index.js';
import { getWorkspacePath, getFormicDir, getBoardPath } from '../utils/paths.js';
import { createTaskDocsFolder, deleteTaskDocsFolder } from './taskDocs.js';
import {
  checkBootstrapRequired,
  createBootstrapTask,
  BOOTSTRAP_TASK_ID,
  BOOTSTRAP_TASK_SLUG,
} from './bootstrap.js';
import { copySkillsToWorkspace } from './skills.js';
import { calculateTaskProgress, loadSubtasks, getCompletionStats } from './subtasks.js';
import { releaseLeases } from './leaseManager.js';
import { broadcastDependencyResolved, broadcastToTask } from './boardNotifier.js';

/**
 * Get project name from workspace folder name
 */
function getProjectNameFromWorkspace(): string {
  const workspacePath = getWorkspacePath();
  return path.basename(workspacePath) || 'My Project';
}

/**
 * Create a default board structure
 */
function createDefaultBoard(): Board {
  return {
    meta: {
      projectName: getProjectNameFromWorkspace(),
      repoPath: getWorkspacePath(),
      createdAt: new Date().toISOString(),
    },
    tasks: [],
  };
}

/**
 * Ensure the .formic directory exists in workspace
 */
async function ensureFormicDir(): Promise<void> {
  const formicDir = getFormicDir();
  if (!existsSync(formicDir)) {
    await mkdir(formicDir, { recursive: true });
  }
}

/**
 * Load the board from workspace/.formic/board.json
 */
export async function loadBoard(): Promise<Board> {
  await ensureFormicDir();

  const boardPath = getBoardPath();

  if (!existsSync(boardPath)) {
    const defaultBoard = createDefaultBoard();
    await saveBoard(defaultBoard);
    return defaultBoard;
  }

  const data = await readFile(boardPath, 'utf-8');
  return JSON.parse(data) as Board;
}

/**
 * Get the board with bootstrap status and auto-create bootstrap task if needed
 * Also copies bundled skills to workspace on first access
 */
export async function getBoardWithBootstrap(): Promise<Board> {
  const board = await loadBoard();

  // Step 1: Copy skills to workspace (if not already present)
  // This happens BEFORE bootstrap check so skills are available for all tasks
  await copySkillsToWorkspace();

  // Step 2: Check bootstrap status
  const bootstrapStatus = checkBootstrapRequired();

  // Check if bootstrap task already exists
  const hasBootstrapTask = board.tasks.some(t => t.id === BOOTSTRAP_TASK_ID);

  // If bootstrap is required and no bootstrap task exists, create one
  if (bootstrapStatus.required && !hasBootstrapTask) {
    const bootstrapTask = await createBootstrapTask();

    // Create the documentation folder for bootstrap task
    await createTaskDocsFolder(BOOTSTRAP_TASK_ID, bootstrapTask.title, bootstrapTask.context);

    board.tasks.unshift(bootstrapTask); // Add to beginning of tasks
    await saveBoard(board);
  }

  // Step 3: Enrich tasks with calculated progress and manual subtask info
  const tasksWithProgress = await Promise.all(
    board.tasks.map(async (task) => {
      const enriched: typeof task & { hasManualSubtasks?: boolean } = {
        ...task,
        progress: await calculateTaskProgress(task),
        // Normalize self-healing fields for backward compatibility with tasks stored before these fields existed
        safePointCommit: task.safePointCommit ?? null,
        retryCount: task.retryCount ?? null,
        fixForTaskId: task.fixForTaskId ?? null,
      };

      // Check if task has subtasks requiring manual action (pending or skipped)
      const subtasks = await loadSubtasks(task.docsPath);
      if (subtasks) {
        const stats = getCompletionStats(subtasks);
        if (stats.pending > 0 || stats.skipped > 0) {
          enriched.hasManualSubtasks = true;
        }
      }

      return enriched;
    })
  );

  // Return board with bootstrap status and enriched tasks
  return {
    ...board,
    tasks: tasksWithProgress,
    bootstrapRequired: bootstrapStatus.required,
    guidelinesPath: bootstrapStatus.guidelinesPath,
  };
}

/**
 * Save the board to workspace/.formic/board.json
 */
export async function saveBoard(board: Board): Promise<void> {
  await ensureFormicDir();
  const boardPath = getBoardPath();
  await writeFile(boardPath, JSON.stringify(board, null, 2), 'utf-8');
}

/**
 * Get a single task by ID
 */
export async function getTask(taskId: string): Promise<Task | undefined> {
  const board = await loadBoard();
  return board.tasks.find(t => t.id === taskId);
}

/**
 * Create a new task with documentation folder
 */
export async function createTask(input: CreateTaskInput): Promise<Task> {
  const board = await loadBoard();

  // Generate next task ID
  const maxId = board.tasks.reduce((max, task) => {
    const num = parseInt(task.id.replace('t-', ''), 10);
    return num > max ? num : max;
  }, 0);

  const taskId = `t-${maxId + 1}`;

  // Create documentation folder and get the relative path
  const docsPath = await createTaskDocsFolder(taskId, input.title, input.context);

  const task: Task = {
    id: taskId,
    title: input.title,
    context: input.context,
    priority: input.priority || 'medium',
    status: 'todo',
    docsPath,
    agentLogs: [],
    pid: null,
    // Task type: 'standard' (full workflow) or 'quick' (direct execution)
    type: input.type || 'standard',
    // Initialize workflow fields
    workflowStep: 'pending',
    workflowLogs: {},
    // Timestamp for queue ordering
    createdAt: new Date().toISOString(),
    // Self-healing fields — always present, null when not set
    safePointCommit: null,
    retryCount: null,
    fixForTaskId: input.fixForTaskId ?? null,
    // Goal linkage — present when task is a child of a goal task
    ...(input.parentGoalId ? { parentGoalId: input.parentGoalId } : {}),
  };

  board.tasks.push(task);
  await saveBoard(board);
  return task;
}

/**
 * Update a task (docsPath cannot be changed)
 */
export async function updateTask(taskId: string, input: UpdateTaskInput): Promise<Task | null> {
  const board = await loadBoard();
  const taskIndex = board.tasks.findIndex(t => t.id === taskId);

  if (taskIndex === -1) {
    return null;
  }

  const task = board.tasks[taskIndex];
  const previousStatus = task.status;

  // Merge input but preserve docsPath
  board.tasks[taskIndex] = {
    ...task,
    ...input,
    docsPath: task.docsPath, // Ensure docsPath cannot be changed
  };

  await saveBoard(board);

  // Post-completion hook: unblock sibling tasks when status transitions to 'done' via user approval.
  // This mirrors the same hook in updateTaskStatus and covers the user-approval path
  // (PUT /api/tasks/:id with { status: 'done' }) which does not go through updateTaskStatus.
  if (input.status === 'done' && previousStatus !== 'done' && task.parentGoalId) {
    try {
      await unblockSiblingTasks(taskId, task.parentGoalId);
    } catch (err) {
      console.warn('[Store] Failed to unblock sibling tasks:', err instanceof Error ? err.message : 'Unknown error');
    }
  }

  return board.tasks[taskIndex];
}

/**
 * Delete a task and optionally its documentation folder
 */
export async function deleteTask(taskId: string, preserveHistory: boolean = false): Promise<boolean> {
  const board = await loadBoard();
  const taskIndex = board.tasks.findIndex(t => t.id === taskId);

  if (taskIndex === -1) {
    return false;
  }

  const task = board.tasks[taskIndex];

  // Release any leases held by this task (defensive - task may be in declaring or queued-after-yield state)
  try {
    releaseLeases(taskId);
  } catch (err) {
    console.warn('[Store] Failed to release leases during task deletion:', err instanceof Error ? err.message : 'Unknown error');
  }

  // Delete documentation folder if not preserving history
  await deleteTaskDocsFolder(task.docsPath, preserveHistory);

  board.tasks.splice(taskIndex, 1);
  await saveBoard(board);
  return true;
}

/**
 * Check all blocked siblings of a completed task and automatically queue those
 * whose entire `dependsOnResolved` dependency list has reached `done`.
 * This is an internal helper — not exported.
 */
async function unblockSiblingTasks(completedTaskId: string, parentGoalId: string): Promise<void> {
  const siblings = await getChildTasks(parentGoalId);
  const blockedSiblings = siblings.filter(
    s => s.id !== completedTaskId && s.status === 'blocked' && s.dependsOnResolved && s.dependsOnResolved.length > 0
  );

  if (blockedSiblings.length === 0) return;

  // Load current board once for dependency status checks
  const board = await loadBoard();
  const taskById = new Map(board.tasks.map(t => [t.id, t]));

  for (const sibling of blockedSiblings) {
    const allDepsResolved = sibling.dependsOnResolved!.every(depId => {
      const dep = taskById.get(depId);
      return dep !== undefined && dep.status === 'done';
    });

    if (allDepsResolved) {
      await queueTask(sibling.id);
      console.log(`[Store] Unblocked task ${sibling.id} — all dependencies resolved`);
      broadcastDependencyResolved(sibling.id, parentGoalId);
    }
  }
}

/**
 * Update task status and optionally PID
 */
export async function updateTaskStatus(taskId: string, status: Task['status'], pid?: number | null, caller?: string): Promise<Task | null> {
  const board = await loadBoard();
  const taskIndex = board.tasks.findIndex(t => t.id === taskId);

  if (taskIndex === -1) {
    return null;
  }

  const previousStatus = board.tasks[taskIndex].status;

  board.tasks[taskIndex].status = status;
  if (pid !== undefined) {
    board.tasks[taskIndex].pid = pid;
  }

  // Duration tracking: set startedAt on first active transition
  const activeStatuses: Task['status'][] = ['briefing', 'planning', 'declaring', 'running', 'architecting', 'verifying'];
  if (activeStatuses.includes(status) && !board.tasks[taskIndex].startedAt) {
    board.tasks[taskIndex].startedAt = new Date().toISOString();
  }

  // Duration tracking: set completedAt on completion
  // NOTE: 'blocked' is intentionally excluded here — blocked tasks are not yet complete.
  if (status === 'review' || status === 'done') {
    board.tasks[taskIndex].completedAt = new Date().toISOString();
  }

  // Duration tracking: clear timestamps on reset to todo
  // NOTE: 'blocked' does not trigger this reset — queuedAt and startedAt are preserved.
  if (status === 'todo') {
    board.tasks[taskIndex].startedAt = undefined;
    board.tasks[taskIndex].completedAt = undefined;
  }

  await saveBoard(board);

  // Structured status transition log
  const timestamp = new Date().toISOString();
  const resolvedCaller = caller ?? 'unknown';
  const logLine = `[StatusTransition] taskId=${taskId} ${previousStatus} → ${status} | caller=${resolvedCaller} | ${timestamp}`;
  console.log(logLine);

  try {
    await appendTaskLogs(taskId, [logLine]);
  } catch (err) {
    console.warn('[Store] Failed to append status transition log:', err instanceof Error ? err.message : 'Unknown error');
  }

  try {
    broadcastToTask(taskId, { type: 'stdout', data: logLine, timestamp });
  } catch (err) {
    console.warn('[Store] Failed to broadcast status transition:', err instanceof Error ? err.message : 'Unknown error');
  }

  // Post-completion hook: unblock sibling tasks whose dependencies are now all done
  if (status === 'done' && board.tasks[taskIndex].parentGoalId) {
    try {
      await unblockSiblingTasks(taskId, board.tasks[taskIndex].parentGoalId!);
    } catch (err) {
      console.warn('[Store] Failed to unblock sibling tasks:', err instanceof Error ? err.message : 'Unknown error');
    }
  }

  return board.tasks[taskIndex];
}

/**
 * Append logs to a task (max 50 lines)
 */
export async function appendTaskLogs(taskId: string, logs: string[]): Promise<void> {
  const board = await loadBoard();
  const task = board.tasks.find(t => t.id === taskId);

  if (!task) return;

  task.agentLogs.push(...logs);
  // Keep only last 50 lines
  if (task.agentLogs.length > 50) {
    task.agentLogs = task.agentLogs.slice(-50);
  }

  await saveBoard(board);
}

/**
 * Queue a task - transition from todo to queued and set queuedAt timestamp
 */
export async function queueTask(taskId: string): Promise<Task | null> {
  const board = await loadBoard();
  const taskIndex = board.tasks.findIndex(t => t.id === taskId);

  if (taskIndex === -1) {
    return null;
  }

  const task = board.tasks[taskIndex];

  // Only allow queuing from 'todo' or 'blocked' status
  if (task.status !== 'todo' && task.status !== 'blocked') {
    return null;
  }

  board.tasks[taskIndex] = {
    ...task,
    status: 'queued',
    queuedAt: new Date().toISOString(),
  };

  await saveBoard(board);
  return board.tasks[taskIndex];
}

/**
 * Get all queued tasks sorted by a 3-tier comparator:
 * 1. Fix tasks (fixForTaskId set) always go first — enables fast self-healing retry loops
 * 2. Priority (high > medium > low)
 * 3. FIFO — queuedAt, falling back to createdAt
 */
export async function getQueuedTasks(): Promise<Task[]> {
  const board = await loadBoard();
  const priorityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };

  // NOTE: Only 'queued' tasks are returned — 'blocked' tasks are naturally excluded.
  return board.tasks
    .filter(t => t.status === 'queued')
    .sort((a, b) => {
      // Tier 1: fix tasks (fixForTaskId set) always go first
      const aIsFix = a.fixForTaskId ? 0 : 1;
      const bIsFix = b.fixForTaskId ? 0 : 1;
      if (aIsFix !== bIsFix) return aIsFix - bIsFix;

      // Tier 2: priority (high=0, medium=1, low=2)
      const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
      if (priorityDiff !== 0) return priorityDiff;

      // Tier 3: FIFO - fall back to createdAt if queuedAt is missing
      const aTime = a.queuedAt || a.createdAt || '';
      const bTime = b.queuedAt || b.createdAt || '';
      return new Date(aTime).getTime() - new Date(bTime).getTime();
    });
}

/**
 * Get the count of currently running tasks (briefing, planning, running)
 */
export async function getRunningTasksCount(): Promise<number> {
  const board = await loadBoard();
  // NOTE: 'blocked' is intentionally excluded from active statuses — blocked tasks consume no runner slot.
  return board.tasks.filter(t =>
    t.status === 'briefing' || t.status === 'planning' || t.status === 'declaring' || t.status === 'running' || t.status === 'architecting' || t.status === 'verifying'
  ).length;
}

/**
 * Get all tasks regardless of status — used by the queue prioritizer for dependency graph analysis
 */
export async function getAllTasks(): Promise<Task[]> {
  const board = await loadBoard();
  return board.tasks;
}

/**
 * Get all child tasks for a given parent goal task
 */
export async function getChildTasks(parentGoalId: string): Promise<Task[]> {
  const board = await loadBoard();
  return board.tasks.filter(t => t.parentGoalId === parentGoalId);
}

/**
 * Recover interrupted tasks on server startup.
 * Tasks can get stuck in active execution states (briefing, planning, declaring, running,
 * architecting, verifying) when the server restarts mid-execution. This function re-queues
 * them so the queue processor picks them up automatically on restart.
 *
 * Tasks already in 'queued' status are left untouched — they were simply waiting in line
 * and do not need recovery.
 *
 * Note: In-memory leases (leaseStore) are naturally cleared on server restart,
 * so no explicit releaseLeases() call is needed here. This assumption holds
 * because leases are stored in a Map that is re-initialized on process start.
 *
 * @returns The number of tasks that were recovered
 */
export async function recoverStuckTasks(): Promise<number> {
  const board = await loadBoard();
  const interruptedStatuses: Task['status'][] = ['briefing', 'planning', 'declaring', 'running', 'architecting', 'verifying'];

  let recoveredCount = 0;

  for (const task of board.tasks) {
    if (interruptedStatuses.includes(task.status)) {
      console.log(`[Recovery] Re-queuing interrupted task ${task.id} (was '${task.status}')`);
      task.status = 'queued';
      task.pid = null;
      task.startedAt = undefined;
      task.completedAt = undefined;
      // Keep workflowStep as is - this preserves the last completed step
      // so the user can see where the task was and manually restart from there
      recoveredCount++;
    }
  }

  if (recoveredCount > 0) {
    await saveBoard(board);
    console.log(`[Recovery] Re-queued ${recoveredCount} interrupted task(s)`);
  }

  return recoveredCount;
}
