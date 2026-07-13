import { readFile, writeFile, mkdir, rename, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Board, Task, TaskStatus, TaskPriority, CreateTaskInput, UpdateTaskInput, WorkflowStep } from '../../types/index.js';
import { getWorkspacePath, getFormicDir, getBoardPath } from '../utils/paths.js';
import { createTaskDocsFolder, deleteTaskDocsFolder } from './taskDocs.js';
import {
  checkBootstrapRequired,
  createBootstrapTask,
  BOOTSTRAP_TASK_ID,
  BOOTSTRAP_TASK_SLUG,
} from './bootstrap.js';
import { copySkillsToWorkspace, copyOpenCodeExecutorProfile, copyOpenCodeReadOnlyProfile } from './skills.js';
import { calculateTaskProgress, loadSubtasks, getCompletionStats } from './subtasks.js';
import { releaseLeases, clearWait } from './leaseManager.js';
import { broadcastDependencyResolved, broadcastToTask } from './boardNotifier.js';

/** Async write mutex — serializes all saveBoard() calls to prevent concurrent write corruption */
let saveLock: Promise<void> = Promise.resolve();

/**
 * Promise-chained mutex that serializes entire board read-modify-write cycles.
 *
 * Every board mutator MUST use this instead of manually calling loadBoard() →
 * mutate → saveBoard(). The existing saveLock only serializes the final write;
 * without this whole-cycle lock, concurrent mutators can both load the same
 * stale snapshot and the later save silently erases the earlier change
 * (lost-update race).
 *
 * Usage:
 *   const result = await withBoard((board) => {
 *     const task = board.tasks.find(t => t.id === id);
 *     task.status = 'done';
 *     return task;
 *   });
 *
 * IMPORTANT: The mutator callback MUST NOT call any other function that itself
 * calls withBoard() (e.g. queueTask, appendTaskLogs, updateTask). Doing so
 * would deadlock on this mutex. Side effects that mutate the board must be
 * deferred until AFTER withBoard resolves.
 */
let boardMutex: Promise<void> = Promise.resolve();

export async function withBoard<T>(mutator: (board: Board) => T | Promise<T>): Promise<T> {
  const resultPromise = boardMutex.then(async () => {
    const board = await loadBoard();
    const result = await mutator(board);
    await saveBoard(board);
    return result;
  });

  // Keep the chain alive regardless of success/failure so future
  // withBoard calls aren't permanently blocked by a failed cycle.
  boardMutex = resultPromise.then(() => undefined, () => undefined);

  return resultPromise;
}

/**
 * Statuses representing an actively-running workflow step for a task.
 * Single source of truth used both for duration tracking (startedAt) and for
 * deciding when a task's file leases must be released immediately on exit
 * from one of these states (see updateTask() and updateTaskStatus()).
 */
export const ACTIVE_STATUSES: ReadonlySet<Task['status']> = new Set([
  'briefing',
  'planning',
  'declaring',
  'running',
  'architecting',
]);

/**
 * Release file leases and clear wait-queue state for a task that has just
 * transitioned out of an active workflow status. Safe to call even if the
 * task holds no leases (releaseLeases/clearWait are no-ops in that case).
 */
function releaseLeasesOnExitFromActive(taskId: string, previousStatus: Task['status'], nextStatus: Task['status']): void {
  if (!ACTIVE_STATUSES.has(previousStatus) || ACTIVE_STATUSES.has(nextStatus)) {
    return;
  }

  try {
    releaseLeases(taskId);
    clearWait(taskId);
  } catch (err) {
    console.warn('[Store] Failed to release leases on status transition:', err instanceof Error ? err.message : 'Unknown error');
  }
}

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

/** All valid TaskStatus values for runtime validation (mirrors the TaskStatus union type) */
export const VALID_TASK_STATUSES: string[] = [
  'todo', 'queued', 'briefing', 'planning', 'declaring', 'running',
  'architecting', 'review', 'done', 'blocked',
];

/** All valid TaskPriority values for runtime validation (mirrors the TaskPriority union type) */
export const VALID_TASK_PRIORITIES: string[] = ['low', 'medium', 'high'];

/**
 * Runtime type guard that validates the structural integrity of a parsed Board object.
 * Follows the validateToolManifest() pattern from tools.ts.
 */
export function validateBoard(board: unknown): board is Board {
  if (typeof board !== 'object' || board === null) return false;
  const b = board as Record<string, unknown>;

  // Validate meta
  if (typeof b.meta !== 'object' || b.meta === null) return false;
  const meta = b.meta as Record<string, unknown>;
  if (typeof meta.projectName !== 'string') return false;
  if (typeof meta.repoPath !== 'string') return false;
  if (typeof meta.createdAt !== 'string') return false;
  if (meta.nextTaskId !== undefined && typeof meta.nextTaskId !== 'number') return false;

  // Validate tasks array
  if (!Array.isArray(b.tasks)) return false;

  // Validate each task entry
  for (const task of b.tasks) {
    if (typeof task !== 'object' || task === null) return false;
    const t = task as Record<string, unknown>;
    if (typeof t.id !== 'string' || t.id.length === 0) return false;
    if (typeof t.title !== 'string' || t.title.length === 0) return false;
    if (typeof t.status !== 'string' || !VALID_TASK_STATUSES.includes(t.status)) return false;
    if (typeof t.priority !== 'string' || !VALID_TASK_PRIORITIES.includes(t.priority)) return false;
    if (typeof t.context !== 'string') return false;
    if (typeof t.docsPath !== 'string') return false;
    if (!Array.isArray(t.agentLogs)) return false;
  }

  return true;
}

/**
 * Load the board from workspace/.formic/board.json
 *
 * If board.json is corrupted or fails validation:
 * 1. Archives the corrupted file to .formic/board.json.corrupted.{timestamp}
 * 2. Attempts restoration from .formic/board.json.backup
 * 3. Falls back to a fresh default board if no valid backup exists
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

  try {
    const parsed: unknown = JSON.parse(data);

    if (!validateBoard(parsed)) {
      throw new Error('Board validation failed — structural integrity check did not pass');
    }

    return parsed;
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'Unknown error';
    const timestamp = new Date().toISOString().replace(/:/g, '-');
    const archivePath = path.join(getFormicDir(), `board.json.corrupted.${timestamp}`);

    // Archive the corrupted file for debugging
    try {
      await copyFile(boardPath, archivePath);
    } catch (archiveErr) {
      console.error(`[Store] Failed to archive corrupted board.json: ${archiveErr instanceof Error ? archiveErr.message : 'Unknown error'}`);
    }

    console.error(`[Store] board.json is corrupted (${errMsg}), archived to ${path.basename(archivePath)}`);

    // Attempt backup restoration
    const backupPath = path.join(getFormicDir(), 'board.json.backup');
    if (existsSync(backupPath)) {
      try {
        const backupData = await readFile(backupPath, 'utf-8');
        const backupParsed: unknown = JSON.parse(backupData);

        if (validateBoard(backupParsed)) {
          console.warn('[Store] board.json corrupted — restored from backup');
          await saveBoard(backupParsed);
          return backupParsed;
        }

        console.warn('[Store] board.json.backup exists but failed validation');
      } catch (backupErr) {
        console.warn(`[Store] board.json.backup is also corrupted: ${backupErr instanceof Error ? backupErr.message : 'Unknown error'}`);
      }
    }

    // Last resort: create fresh default board
    console.warn(`[Store] board.json corrupted — archived to board.json.corrupted.${timestamp}, created fresh board`);
    const defaultBoard = createDefaultBoard();
    await saveBoard(defaultBoard);
    return defaultBoard;
  }
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

  // Step 1b: Materialize opencode executor agent profile
  // This ensures the write-capable executor profile is available for opencode
  // workflow runs, overriding the read-only Task Manager persona in AGENTS.md/CLAUDE.md
  await copyOpenCodeExecutorProfile();

  // Step 1c: Materialize opencode read-only agent profile
  // This ensures the restricted read-only profile is available for opencode
  // assistant and messaging sessions, enforcing deny rules for write tools
  await copyOpenCodeReadOnlyProfile();

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
        recoveryCount: task.recoveryCount ?? null,
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
 * Uses atomic temp-file+rename, rolling backup, and async mutex.
 *
 * IMPORTANT: Direct loadBoard() → mutate → saveBoard() sequences outside of
 * withBoard() are FORBIDDEN for any operation that mutates the board. Always
 * use withBoard() for read-modify-write cycles to prevent lost-update races
 * under concurrency. This method's own saveLock is defense-in-depth — it
 * serializes the final write but cannot prevent two callers from loading the
 * same stale snapshot before either saves.
 */
export async function saveBoard(board: Board): Promise<void> {
  // Validate before any disk I/O
  if (!validateBoard(board)) {
    console.error('[Store] Rejected invalid board write');
    throw new Error('[Store] Rejected invalid board write');
  }

  // Chain onto the mutex to serialize concurrent calls
  const resultPromise = saveLock.then(
    () => saveBoardInternal(board),
    () => saveBoardInternal(board)  // proceed even if previous save failed
  );
  // Keep chain alive regardless of success/failure so future saves aren't blocked
  saveLock = resultPromise.catch(() => {});

  return resultPromise;
}

async function saveBoardInternal(board: Board): Promise<void> {
  await ensureFormicDir();
  const boardPath = getBoardPath();
  const tmpPath = boardPath + '.tmp';
  const backupPath = boardPath + '.backup';

  // Rolling backup: copy current board.json → board.json.backup
  try {
    await copyFile(boardPath, backupPath);
  } catch (err) {
    console.warn('[Store] Could not create backup (may not exist yet):', err instanceof Error ? err.message : 'Unknown error');
  }

  // Atomic write: write to .tmp then rename
  try {
    await writeFile(tmpPath, JSON.stringify(board, null, 2), 'utf-8');
    await rename(tmpPath, boardPath);
  } catch (error) {
    const err = error as Error;
    console.error('[Store] Failed to save board:', err.message);
    throw new Error(`[Store] Failed to save board: ${err.message}`);
  }
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
  return withBoard(async (board) => {
    // Generate next task ID from a persistent monotonic counter so deleting the
    // highest-numbered task never causes ID reuse. Reconcile it with the board's
    // existing IDs as a defensive measure against a stale restored board.
    // BOOTSTRAP_TASK_ID ('t-bootstrap') is excluded naturally since
    // parseInt('bootstrap', 10) is not finite.
    const maxExisting = board.tasks.reduce((max, task) => {
      const num = parseInt(task.id.replace('t-', ''), 10);
      return Number.isFinite(num) && num > max ? num : max;
    }, 0);

    const persistedCounter = board.meta.nextTaskId ?? 0;
    // A missing counter is expected for legacy boards and is safely seeded from
    // the existing IDs below. Warn only when an actually persisted value is
    // unsafe, so brand-new and legacy boards do not produce false alarms.
    if (board.meta.nextTaskId !== undefined && persistedCounter <= maxExisting) {
      console.warn(
        `[Store] Task ID counter regression detected: nextTaskId ${persistedCounter} is behind existing task ID t-${maxExisting}; reconciling counter`,
      );
    }

    const seeded = Math.max(persistedCounter, maxExisting + 1);

    const taskId = `t-${seeded}`;
    board.meta.nextTaskId = seeded + 1;

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
      recoveryCount: null,
      fixForTaskId: input.fixForTaskId ?? null,
      // Goal linkage — present when task is a child of a goal task
      ...(input.parentGoalId ? { parentGoalId: input.parentGoalId } : {}),
    };

    board.tasks.push(task);
    return task;
  });
}

/**
 * Update a task (docsPath cannot be changed)
 */
export async function updateTask(taskId: string, input: UpdateTaskInput): Promise<Task | null> {
  // Capture values inside the serialized withBoard closure for use in post-save
  // hooks, which must run OUTSIDE withBoard to avoid deadlocking on nested
  // withBoard calls (unblockSiblingTasks → queueTask → withBoard).
  let previousStatus: Task['status'] | undefined;
  let parentGoalId: string | undefined;

  const result = await withBoard((board) => {
    const taskIndex = board.tasks.findIndex(t => t.id === taskId);

    if (taskIndex === -1) {
      return null;
    }

    const task = board.tasks[taskIndex];
    previousStatus = task.status;
    parentGoalId = task.parentGoalId;

    // Merge input but preserve docsPath
    board.tasks[taskIndex] = {
      ...task,
      ...input,
      docsPath: task.docsPath, // Ensure docsPath cannot be changed
    };

    return board.tasks[taskIndex];
  });

  if (result === null) return null;

  // Post-transition hook: release file leases and clear wait state the moment a task
  // leaves an active workflow status via any PUT /api/tasks/:id status change (e.g. a
  // manual board-drag), not just workflow-internal exit paths.
  if (input.status !== undefined && previousStatus !== undefined) {
    releaseLeasesOnExitFromActive(taskId, previousStatus, input.status);
  }

  // Post-transition hook: unblock sibling tasks when status transitions to 'review' or 'done'.
  // This mirrors the same hook in updateTaskStatus and covers the user-approval path
  // (PUT /api/tasks/:id with { status: 'done' or 'review' }) which does not go through updateTaskStatus.
  if ((input.status === 'done' || input.status === 'review') && input.status !== previousStatus && parentGoalId) {
    try {
      await unblockSiblingTasks(taskId, parentGoalId);
    } catch (err) {
      console.warn('[Store] Failed to unblock sibling tasks:', err instanceof Error ? err.message : 'Unknown error');
    }
  }

  return result;
}

/**
 * Delete a task and optionally its documentation folder
 */
export async function deleteTask(taskId: string, preserveHistory: boolean = false): Promise<boolean> {
  return withBoard(async (board) => {
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
    return true;
  });
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
      return dep !== undefined && (dep.status === 'done' || dep.status === 'review');
    });

    if (allDepsResolved) {
      await queueTask(sibling.id);
      console.warn(`[Store] Unblocked task ${sibling.id} — all dependencies resolved`);
      broadcastDependencyResolved(sibling.id, parentGoalId);
    }
  }
}

/**
 * Update task status and optionally PID
 */
export async function updateTaskStatus(taskId: string, status: Task['status'], pid?: number | null, caller?: string): Promise<Task | null> {
  // Capture values inside the serialized withBoard closure for use in post-save
  // hooks, which must run OUTSIDE withBoard to avoid deadlocking on nested
  // withBoard calls (appendTaskLogs → withBoard, unblockSiblingTasks → queueTask → withBoard).
  let previousStatus: Task['status'] | undefined;
  let parentGoalId: string | undefined;

  const result = await withBoard((board) => {
    const taskIndex = board.tasks.findIndex(t => t.id === taskId);

    if (taskIndex === -1) {
      return null;
    }

    previousStatus = board.tasks[taskIndex].status;
    parentGoalId = board.tasks[taskIndex].parentGoalId;

    board.tasks[taskIndex].status = status;
    if (pid !== undefined) {
      board.tasks[taskIndex].pid = pid;
    }

    // Duration tracking: set startedAt on first active transition
    if (ACTIVE_STATUSES.has(status) && !board.tasks[taskIndex].startedAt) {
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

      // Workflow resumption: if brief+plan are already done (workflowStep is 'declare'
      // or 'execute'), mark the task to resume from declare on re-queue so it
      // skips brief and plan instead of starting over from scratch.
      const stepsPastPlan: WorkflowStep[] = ['declare', 'execute'];
      const currentStep = board.tasks[taskIndex].workflowStep;
      if (currentStep && stepsPastPlan.includes(currentStep) && !board.tasks[taskIndex].resumeFromStep) {
        board.tasks[taskIndex].resumeFromStep = 'declare';
      }
    }

    return board.tasks[taskIndex];
  });

  if (result === null) return null;

  // Post-transition hook: release file leases and clear wait state the moment a task
  // leaves an active workflow status, regardless of which caller triggered the change.
  releaseLeasesOnExitFromActive(taskId, previousStatus!, status);

  // Structured status transition log
  const timestamp = new Date().toISOString();
  const resolvedCaller = caller ?? 'unknown';
  const logLine = `[StatusTransition] taskId=${taskId} ${previousStatus} → ${status} | caller=${resolvedCaller} | ${timestamp}`;
  console.warn(logLine);

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

  // Post-transition hook: unblock sibling tasks whose dependencies are now all resolved (review or done)
  if ((status === 'done' || status === 'review') && parentGoalId) {
    try {
      await unblockSiblingTasks(taskId, parentGoalId);
    } catch (err) {
      console.warn('[Store] Failed to unblock sibling tasks:', err instanceof Error ? err.message : 'Unknown error');
    }
  }

  return result;
}

/**
 * Append logs to a task (max 50 lines)
 */
export async function appendTaskLogs(taskId: string, logs: string[]): Promise<void> {
  await withBoard((board) => {
    const task = board.tasks.find(t => t.id === taskId);
    if (!task) return;
    task.agentLogs.push(...logs);
    // Keep only last 50 lines
    if (task.agentLogs.length > 50) {
      task.agentLogs = task.agentLogs.slice(-50);
    }
  });
}

/**
 * Queue a task - transition from todo to queued and set queuedAt timestamp
 */
export async function queueTask(taskId: string): Promise<Task | null> {
  return withBoard((board) => {
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
      // Reset counters on manual re-queue so a human retry starts fresh
      retryCount: null,
      recoveryCount: null,
      yieldCount: 0,
      yieldReason: undefined,
    };

    return board.tasks[taskIndex];
  });
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
    t.status === 'briefing' || t.status === 'planning' || t.status === 'declaring' || t.status === 'running' || t.status === 'architecting'
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
 * architecting) when the server restarts mid-execution. This function re-queues
 * them so the queue processor picks them up automatically on restart.
 *
 * Each re-queue goes through updateTaskStatus() so a [StatusTransition] log entry and
 * broadcast are emitted (unlike the prior direct field writes). recoveryCount is
 * incremented per recovery so the queue processor can cap the loop.
 *
 * Before re-queuing, we attempt a best-effort process.kill() on the task's recorded pid
 * to clean up orphaned agent processes that survived the server restart. PID reuse is a
 * theoretical hazard (the kernel may have recycled the pid for an unrelated process), but
 * this is acceptable for a local dev tool — the worst case is a spurious signal to an
 * unrelated process owned by the same user on the same machine.
 *
 * Tasks already in 'queued' status are left untouched — they were simply waiting in line
 * and do not need recovery.
 *
 * Note: restoreLeases() (called before recoverStuckTasks() in the startup
 * sequence) loads non-expired leases from disk into memory. Recovery must
 * explicitly release those leases for re-queued tasks — otherwise stale
 * leases from a prior session can block dispatch after restart.
 *
 * @returns The number of tasks that were recovered
 */
export async function recoverStuckTasks(): Promise<number> {
  const interruptedStatuses: Task['status'][] = ['briefing', 'planning', 'declaring', 'running', 'architecting'];

  // Phase 1: collect interrupted task info inside withBoard WITHOUT mutating the board.
  // This respects the withBoard nesting rule — updateTaskStatus / updateTask called
  // below each acquire withBoard themselves, and we must not nest.
  const toRecover: Array<{ id: string; pid: number | null; recoveryCount: number }> = await withBoard((board) => {
    const items: Array<{ id: string; pid: number | null; recoveryCount: number }> = [];
    for (const task of board.tasks) {
      if (interruptedStatuses.includes(task.status)) {
        items.push({
          id: task.id,
          pid: task.pid,
          recoveryCount: task.recoveryCount ?? 0,
        });
      }
    }
    return items;
  });

  // Phase 2: for each interrupted task, clean up orphans and transition through
  // the proper status-update path (outside withBoard so we don't nest mutators).
  let recoveredCount = 0;

  for (const item of toRecover) {
    // Best-effort orphan cleanup: if the task recorded a pid, try to terminate it.
    // PID reuse caveat: the kernel may have recycled the pid since the server restart,
    // but this is acceptable for a local dev tool.
    if (item.pid !== null) {
      try {
        process.kill(item.pid, 'SIGTERM');
        console.warn(`[Recovery] Sent SIGTERM to orphan pid ${item.pid} for task ${item.id}`);
      } catch (_err) {
        // ESRCH - process already gone
      }
    }

    console.warn(`[Recovery] Re-queuing interrupted task ${item.id} (was stuck in active status, recovery #${item.recoveryCount + 1})`);

    try {
      // Transition to queued with proper StatusTransition logging and broadcast
      await updateTaskStatus(item.id, 'queued', null, 'recovery.startup');

      // Increment recoveryCount and clear stale timestamps
      await updateTask(item.id, {
        recoveryCount: item.recoveryCount + 1,
        startedAt: undefined,
        completedAt: undefined,
      });

      recoveredCount++;

      // Release any non-expired leases that restoreLeases() loaded from disk
      // for this task — stale leases from a prior session can otherwise block
      // dispatch after restart.
      releaseLeases(item.id);
    } catch (err) {
      console.warn(`[Recovery] Failed to recover task ${item.id}:`, err instanceof Error ? err.message : 'Unknown error');
    }
  }

  if (recoveredCount > 0) {
    console.warn(`[Recovery] Re-queued ${recoveredCount} interrupted task(s)`);
  }

  return recoveredCount;
}
