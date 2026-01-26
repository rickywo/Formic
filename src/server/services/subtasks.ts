import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { SubtasksFile, Subtask, SubtaskStatus, Task, TaskStatus, WorkflowStep } from '../../types/index.js';
import { getWorkspacePath } from '../utils/paths.js';

const SUBTASKS_FILENAME = 'subtasks.json';

/**
 * Get the path to the subtasks.json file for a task
 */
export function getSubtasksPath(docsPath: string): string {
  return path.join(getWorkspacePath(), docsPath, SUBTASKS_FILENAME);
}

/**
 * Check if subtasks.json exists for a task
 */
export function subtasksExist(docsPath: string): boolean {
  return existsSync(getSubtasksPath(docsPath));
}

/**
 * Load and parse subtasks.json for a task
 * Returns null if file doesn't exist or is invalid
 */
export async function loadSubtasks(docsPath: string): Promise<SubtasksFile | null> {
  const subtasksPath = getSubtasksPath(docsPath);
  console.log(`[Subtasks] Loading subtasks from: ${subtasksPath}`);

  if (!existsSync(subtasksPath)) {
    console.log(`[Subtasks] File does not exist: ${subtasksPath}`);
    return null;
  }

  try {
    const content = await readFile(subtasksPath, 'utf-8');
    const data = JSON.parse(content) as SubtasksFile;

    // Basic validation
    if (!data.version || !data.subtasks || !Array.isArray(data.subtasks)) {
      console.warn('[Subtasks] Invalid subtasks.json structure');
      return null;
    }

    console.log(`[Subtasks] Loaded ${data.subtasks.length} subtasks`);
    return data;
  } catch (error) {
    console.error('[Subtasks] Failed to load subtasks.json:', error);
    return null;
  }
}

/**
 * Save subtasks.json for a task
 */
export async function saveSubtasks(docsPath: string, subtasks: SubtasksFile): Promise<boolean> {
  const subtasksPath = getSubtasksPath(docsPath);

  try {
    // Update the updatedAt timestamp
    subtasks.updatedAt = new Date().toISOString();

    await writeFile(subtasksPath, JSON.stringify(subtasks, null, 2), 'utf-8');
    return true;
  } catch (error) {
    console.error('[Subtasks] Failed to save subtasks.json:', error);
    return false;
  }
}

/**
 * Update the status of a single subtask
 */
export async function updateSubtaskStatus(
  docsPath: string,
  subtaskId: string,
  status: SubtaskStatus
): Promise<{ success: boolean; subtask?: Subtask }> {
  const subtasks = await loadSubtasks(docsPath);

  if (!subtasks) {
    return { success: false };
  }

  const subtask = subtasks.subtasks.find(s => s.id === subtaskId);
  if (!subtask) {
    return { success: false };
  }

  subtask.status = status;

  // Set completedAt timestamp when marking as completed
  if (status === 'completed') {
    subtask.completedAt = new Date().toISOString();
  } else {
    delete subtask.completedAt;
  }

  const saved = await saveSubtasks(docsPath, subtasks);
  return { success: saved, subtask };
}

/**
 * Get completion statistics for subtasks
 */
export function getCompletionStats(subtasks: SubtasksFile): {
  total: number;
  completed: number;
  skipped: number;
  inProgress: number;
  pending: number;
  percentage: number;
} {
  const total = subtasks.subtasks.length;
  const completed = subtasks.subtasks.filter(s => s.status === 'completed').length;
  const skipped = subtasks.subtasks.filter(s => s.status === 'skipped').length;
  const inProgress = subtasks.subtasks.filter(s => s.status === 'in_progress').length;
  const pending = subtasks.subtasks.filter(s => s.status === 'pending').length;
  // Both completed and skipped count toward progress
  const doneCount = completed + skipped;
  const percentage = total > 0 ? Math.round((doneCount / total) * 100) : 0;

  return { total, completed, skipped, inProgress, pending, percentage };
}

/**
 * Check if all subtasks are completed or skipped
 * Skipped subtasks are those that require manual verification and cannot be automated
 */
export function isAllComplete(subtasks: SubtasksFile): boolean {
  if (subtasks.subtasks.length === 0) {
    return true; // No subtasks means complete
  }
  // Both 'completed' and 'skipped' count as done for workflow purposes
  return subtasks.subtasks.every(s => s.status === 'completed' || s.status === 'skipped');
}

/**
 * Get all incomplete subtasks (pending or in_progress, not skipped)
 */
export function getIncompleteSubtasks(subtasks: SubtasksFile): Subtask[] {
  return subtasks.subtasks.filter(s => s.status !== 'completed' && s.status !== 'skipped');
}

/**
 * Format incomplete subtasks as a string for agent feedback
 */
export function formatIncompleteSubtasksForPrompt(subtasks: SubtasksFile): string {
  const incomplete = getIncompleteSubtasks(subtasks);

  if (incomplete.length === 0) {
    return 'All subtasks are complete.';
  }

  const lines = incomplete.map(s => {
    const statusLabel = s.status === 'in_progress' ? '[IN PROGRESS]' : '[PENDING]';
    return `- ${statusLabel} ${s.id}: ${s.content}`;
  });

  return `The following subtasks are NOT yet complete:\n${lines.join('\n')}`;
}

/**
 * Calculate task progress percentage (0-100) based on workflow stage and subtask completion.
 *
 * Progress model:
 * - Stage progress (0-25%): pending/todo=0%, briefing=5%, planning=18%, running=25%, review/done=100%
 * - Subtask progress (25-100%): During 'execute' stage, remaining 75% divided among subtasks
 *
 * @param task - The task to calculate progress for
 * @returns Progress percentage (0-100)
 */
export async function calculateTaskProgress(task: Task): Promise<number> {
  const { status, workflowStep, docsPath, id } = task;

  // Bootstrap task: 0% when pending/todo, 100% when done
  if (id === 't-bootstrap') {
    if (status === 'done' || status === 'review') {
      return 100;
    }
    if (status === 'todo') {
      return 0;
    }
    // If running, estimate based on status
    if (status === 'briefing') return 10;
    if (status === 'planning') return 30;
    if (status === 'running') return 60;
    return 0;
  }

  // Completed tasks
  if (status === 'done') {
    return 100;
  }

  // Review tasks (workflow complete, awaiting human review)
  if (status === 'review') {
    return 100;
  }

  // Todo tasks (not started)
  if (status === 'todo') {
    return 0;
  }

  // Stage-based progress for active workflow
  // briefing = 5%, planning = 18%, running = 25% (base for execute)
  const stageProgress: Record<TaskStatus, number> = {
    'todo': 0,
    'queued': 0,
    'briefing': 5,
    'planning': 18,
    'running': 25,
    'review': 100,
    'done': 100,
  };

  let progress = stageProgress[status] ?? 0;

  // Add subtask progress during execution phase
  if (status === 'running' && (workflowStep === 'execute' || workflowStep === 'complete')) {
    const subtasks = await loadSubtasks(docsPath);

    if (subtasks && subtasks.subtasks.length > 0) {
      const stats = getCompletionStats(subtasks);
      // Subtasks contribute 75% of total progress (25% to 100%)
      // Both completed and skipped count toward progress
      const doneCount = stats.completed + stats.skipped;
      const subtaskProgress = (doneCount / stats.total) * 75;
      progress = 25 + subtaskProgress;
    }
    // If no subtasks.json yet during execute, stay at 25%
  }

  return Math.min(100, Math.round(progress));
}
