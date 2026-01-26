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
import { calculateTaskProgress } from './subtasks.js';

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

  // Step 3: Enrich tasks with calculated progress
  const tasksWithProgress = await Promise.all(
    board.tasks.map(async (task) => ({
      ...task,
      progress: await calculateTaskProgress(task),
    }))
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
    // Initialize workflow fields
    workflowStep: 'pending',
    workflowLogs: {},
    // Timestamp for queue ordering
    createdAt: new Date().toISOString(),
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

  // Merge input but preserve docsPath
  board.tasks[taskIndex] = {
    ...task,
    ...input,
    docsPath: task.docsPath, // Ensure docsPath cannot be changed
  };

  await saveBoard(board);
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

  // Delete documentation folder if not preserving history
  await deleteTaskDocsFolder(task.docsPath, preserveHistory);

  board.tasks.splice(taskIndex, 1);
  await saveBoard(board);
  return true;
}

/**
 * Update task status and optionally PID
 */
export async function updateTaskStatus(taskId: string, status: Task['status'], pid?: number | null): Promise<Task | null> {
  const board = await loadBoard();
  const taskIndex = board.tasks.findIndex(t => t.id === taskId);

  if (taskIndex === -1) {
    return null;
  }

  board.tasks[taskIndex].status = status;
  if (pid !== undefined) {
    board.tasks[taskIndex].pid = pid;
  }

  await saveBoard(board);
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

  // Only allow queuing from 'todo' status
  if (task.status !== 'todo') {
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
 * Get all queued tasks sorted by priority (high > medium > low) then by queuedAt (FIFO)
 */
export async function getQueuedTasks(): Promise<Task[]> {
  const board = await loadBoard();
  const priorityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };

  return board.tasks
    .filter(t => t.status === 'queued')
    .sort((a, b) => {
      // Sort by priority first
      const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
      if (priorityDiff !== 0) return priorityDiff;

      // Then by queuedAt (FIFO) - fall back to createdAt if queuedAt is missing
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
  return board.tasks.filter(t =>
    t.status === 'briefing' || t.status === 'planning' || t.status === 'running'
  ).length;
}

/**
 * Recover stuck tasks on server startup.
 * Tasks can get stuck in active states (briefing, planning, running, queued) when the server
 * restarts while they are being processed. This function resets them to 'todo' so they can
 * be restarted.
 *
 * @returns The number of tasks that were recovered
 */
export async function recoverStuckTasks(): Promise<number> {
  const board = await loadBoard();
  const activeStatuses: Task['status'][] = ['briefing', 'planning', 'running', 'queued'];

  let recoveredCount = 0;

  for (const task of board.tasks) {
    if (activeStatuses.includes(task.status)) {
      console.log(`[Recovery] Resetting stuck task ${task.id} from '${task.status}' to 'todo'`);
      task.status = 'todo';
      task.pid = null;
      // Keep workflowStep as is - this preserves the last completed step
      // so the user can see where the task was and manually restart from there
      recoveredCount++;
    }
  }

  if (recoveredCount > 0) {
    await saveBoard(board);
    console.log(`[Recovery] Reset ${recoveredCount} stuck task(s) to 'todo' status`);
  }

  return recoveredCount;
}
