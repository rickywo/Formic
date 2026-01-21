import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { SubtasksFile, Subtask, SubtaskStatus } from '../../types/index.js';

const WORKSPACE_PATH = process.env.WORKSPACE_PATH || './workspace';
const SUBTASKS_FILENAME = 'subtasks.json';

/**
 * Get the path to the subtasks.json file for a task
 */
export function getSubtasksPath(docsPath: string): string {
  return path.join(WORKSPACE_PATH, docsPath, SUBTASKS_FILENAME);
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
  inProgress: number;
  pending: number;
  percentage: number;
} {
  const total = subtasks.subtasks.length;
  const completed = subtasks.subtasks.filter(s => s.status === 'completed').length;
  const inProgress = subtasks.subtasks.filter(s => s.status === 'in_progress').length;
  const pending = subtasks.subtasks.filter(s => s.status === 'pending').length;
  const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;

  return { total, completed, inProgress, pending, percentage };
}

/**
 * Check if all subtasks are completed
 */
export function isAllComplete(subtasks: SubtasksFile): boolean {
  if (subtasks.subtasks.length === 0) {
    return true; // No subtasks means complete
  }
  return subtasks.subtasks.every(s => s.status === 'completed');
}

/**
 * Get all incomplete subtasks (pending or in_progress)
 */
export function getIncompleteSubtasks(subtasks: SubtasksFile): Subtask[] {
  return subtasks.subtasks.filter(s => s.status !== 'completed');
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
