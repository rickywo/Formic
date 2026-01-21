import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { getTaskDocsPath, getRelativeDocsPath, getTasksDir } from '../utils/paths.js';
import { generateSlug } from '../utils/slug.js';
import { generateTaskReadme, generateTaskPlan, generateTaskChecklist } from '../templates/index.js';

/**
 * Ensure the tasks directory exists
 */
async function ensureTasksDir(): Promise<void> {
  const tasksDir = getTasksDir();
  if (!existsSync(tasksDir)) {
    await mkdir(tasksDir, { recursive: true });
  }
}

/**
 * Create a task documentation folder with template files
 * Returns the relative docsPath for storing in board.json
 */
export async function createTaskDocsFolder(
  taskId: string,
  title: string,
  context: string
): Promise<string> {
  await ensureTasksDir();

  const slug = generateSlug(title);
  const fullPath = getTaskDocsPath(taskId, slug);
  const relativePath = getRelativeDocsPath(taskId, slug);

  // Create the task folder
  await mkdir(fullPath, { recursive: true });

  // Create the output subdirectory
  await mkdir(path.join(fullPath, 'output'), { recursive: true });

  // Write template files
  await writeFile(
    path.join(fullPath, 'README.md'),
    generateTaskReadme(title, context),
    'utf-8'
  );

  await writeFile(
    path.join(fullPath, 'PLAN.md'),
    generateTaskPlan(title, context),
    'utf-8'
  );

  await writeFile(
    path.join(fullPath, 'CHECKLIST.md'),
    generateTaskChecklist(title, context),
    'utf-8'
  );

  return relativePath;
}

/**
 * Delete a task documentation folder
 * @param docsPath - The relative docs path (e.g., .formic/tasks/t-1_my-task)
 * @param preserveHistory - If true, don't delete the folder
 */
export async function deleteTaskDocsFolder(
  docsPath: string,
  preserveHistory: boolean = false
): Promise<void> {
  if (preserveHistory) {
    return;
  }

  const workspacePath = process.env.WORKSPACE_PATH || './workspace';
  const fullPath = path.join(workspacePath, docsPath);

  if (existsSync(fullPath)) {
    await rm(fullPath, { recursive: true, force: true });
  }
}

/**
 * Check if a task documentation folder exists
 */
export function taskDocsFolderExists(docsPath: string): boolean {
  const workspacePath = process.env.WORKSPACE_PATH || './workspace';
  const fullPath = path.join(workspacePath, docsPath);
  return existsSync(fullPath);
}
