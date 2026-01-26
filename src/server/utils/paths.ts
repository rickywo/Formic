import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Get the package root directory.
 * This resolves correctly whether running from source (src/) or compiled (dist/),
 * and whether installed globally via npm or running locally.
 */
export function getPackageRoot(): string {
  // __dirname is either src/server/utils or dist/server/utils
  // Package root is 3 levels up
  return path.resolve(__dirname, '..', '..', '..');
}

/**
 * Get the path to bundled skills directory.
 * Works for both local development and global npm installs.
 */
export function getBundledSkillsPath(): string {
  return path.join(getPackageRoot(), 'skills');
}

/**
 * Get the path to bundled templates directory.
 * Works for both local development and global npm installs.
 */
export function getBundledTemplatesPath(): string {
  return path.join(getPackageRoot(), 'templates');
}

/**
 * Module-level workspace path, initialized from environment variable.
 * Can be updated at runtime via setWorkspacePath().
 */
let currentWorkspacePath: string = process.env.WORKSPACE_PATH || './workspace';

/**
 * Get the current workspace path
 */
export function getWorkspacePath(): string {
  return currentWorkspacePath;
}

/**
 * Set the workspace path at runtime for dynamic workspace switching
 */
export function setWorkspacePath(newPath: string): void {
  currentWorkspacePath = newPath;
  console.log('[Paths] Workspace path updated to:', newPath);
}

/**
 * Get the .formic directory path inside workspace
 */
export function getFormicDir(): string {
  return path.join(getWorkspacePath(), '.formic');
}

/**
 * Get the board.json file path
 */
export function getBoardPath(): string {
  return path.join(getFormicDir(), 'board.json');
}

/**
 * Get the tasks directory path
 */
export function getTasksDir(): string {
  return path.join(getFormicDir(), 'tasks');
}

/**
 * Get the full path for a task's documentation folder
 */
export function getTaskDocsPath(id: string, slug: string): string {
  return path.join(getTasksDir(), `${id}_${slug}`);
}

/**
 * Get the relative docsPath (for storing in board.json)
 */
export function getRelativeDocsPath(id: string, slug: string): string {
  return `.formic/tasks/${id}_${slug}`;
}

/**
 * Get the .claude/skills directory path inside workspace
 * This is the standard location for project-level skills (compatible with both Claude and Copilot)
 */
export function getSkillsDir(): string {
  return path.join(getWorkspacePath(), '.claude', 'skills');
}
