import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getWorkspacePath } from './paths.js';
import { updateTask } from '../services/store.js';

const execFileAsync = promisify(execFile);

/**
 * Create a git auto-save commit before task execution as a rollback safe point.
 * Runs `git add . && git commit --allow-empty` in the workspace and stores the
 * resulting SHA in `task.safePointCommit`. Returns the SHA on success, or null
 * if git is unavailable or the workspace is not a git repository (non-fatal).
 */
export async function createSafePoint(taskId: string): Promise<string | null> {
  const cwd = getWorkspacePath();
  try {
    await execFileAsync('git', ['add', '.'], { cwd });
    await execFileAsync('git', ['commit', '--allow-empty', '-m', `auto-save: before task ${taskId}`], { cwd });
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd });
    const sha = stdout.trim();
    await updateTask(taskId, { safePointCommit: sha });
    console.warn(`[Workflow] Safe point commit created for task ${taskId}: ${sha}`);
    return sha;
  } catch (error) {
    console.warn('[Workflow] createSafePoint failed for', taskId + ':', error instanceof Error ? error.message : 'Unknown error');
    return null;
  }
}

/**
 * List files that have changed in the workspace since a given commit.
 * Includes untracked files as well, so newly created task deliverables are
 * visible to verification before an agent stages them.
 * Returns an empty array if the diff is empty, git is unavailable, or the
 * commit doesn't exist (the caller can distinguish the "no changes" case).
 */
export async function getChangedFilesSince(commit: string): Promise<string[]> {
  const cwd = getWorkspacePath();
  try {
    const [{ stdout: diffOutput }, { stdout: untrackedOutput }] = await Promise.all([
      execFileAsync('git', ['diff', '--name-only', commit], { cwd }),
      execFileAsync('git', ['ls-files', '--others', '--exclude-standard'], { cwd }),
    ]);
    return [...new Set([...diffOutput.split('\n'), ...untrackedOutput.split('\n')].filter(Boolean))];
  } catch (error) {
    console.warn('[Workflow] getChangedFilesSince failed for commit', commit + ':', error instanceof Error ? error.message : 'Unknown error');
    return [];
  }
}
