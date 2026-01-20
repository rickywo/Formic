import path from 'node:path';

/**
 * Get the workspace path from environment variable
 */
export function getWorkspacePath(): string {
  return process.env.WORKSPACE_PATH || './workspace';
}

/**
 * Get the .agentrunner directory path inside workspace
 */
export function getAgentRunnerDir(): string {
  return path.join(getWorkspacePath(), '.agentrunner');
}

/**
 * Get the board.json file path
 */
export function getBoardPath(): string {
  return path.join(getAgentRunnerDir(), 'board.json');
}

/**
 * Get the tasks directory path
 */
export function getTasksDir(): string {
  return path.join(getAgentRunnerDir(), 'tasks');
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
  return `.agentrunner/tasks/${id}_${slug}`;
}
