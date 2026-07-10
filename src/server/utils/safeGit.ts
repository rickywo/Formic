import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Convert a user- or agent-provided path to a workspace-relative Git path.
 * Paths outside the workspace are rejected before invoking Git.
 */
export function getSafeWorkspaceRelativePath(filePath: string, workspacePath: string): string | null {
  if (filePath.length === 0 || filePath.includes('\0')) return null;

  const workspaceRoot = path.resolve(workspacePath);
  const resolvedPath = path.resolve(workspaceRoot, filePath);
  const relativePath = path.relative(workspaceRoot, resolvedPath);

  if (
    relativePath.length === 0 ||
    relativePath === '..' ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    return null;
  }

  return relativePath;
}

/** Hash one workspace-contained file without passing its path through a shell. */
export async function hashWorkspaceFile(filePath: string, workspacePath: string): Promise<string> {
  const relativePath = getSafeWorkspaceRelativePath(filePath, workspacePath);
  if (!relativePath) {
    throw new Error(`Path is outside the workspace: ${filePath}`);
  }

  const { stdout } = await execFileAsync('git', ['hash-object', '--', relativePath], {
    cwd: workspacePath,
  });
  return stdout.trim();
}

/** Revert workspace-contained files without passing any path through a shell. */
export async function checkoutWorkspaceFiles(filePaths: string[], workspacePath: string): Promise<void> {
  const relativePaths = filePaths.map(filePath => {
    const relativePath = getSafeWorkspaceRelativePath(filePath, workspacePath);
    if (!relativePath) {
      throw new Error(`Path is outside the workspace: ${filePath}`);
    }
    return relativePath;
  });

  if (relativePaths.length === 0) return;

  await execFileAsync('git', ['checkout', '--', ...relativePaths], {
    cwd: workspacePath,
  });
}

const COMMIT_HASH_PATTERN = /^[0-9a-f]{7,40}$/i;

/**
 * Restore workspace files to their content at a given commit, without moving HEAD.
 * Files are checked out individually so a single file missing at that commit
 * (e.g. created after the commit) does not abort the rest; such failures are
 * caught, logged with a `[SafeGit]` prefix, and skipped rather than force-deleted.
 */
export async function checkoutFilesFromCommit(
  commit: string,
  filePaths: string[],
  workspacePath: string
): Promise<void> {
  if (!COMMIT_HASH_PATTERN.test(commit)) {
    throw new Error(`Invalid commit hash: ${commit}`);
  }

  const relativePaths = filePaths.map(filePath => {
    const relativePath = getSafeWorkspaceRelativePath(filePath, workspacePath);
    if (!relativePath) {
      throw new Error(`Path is outside the workspace: ${filePath}`);
    }
    return relativePath;
  });

  if (relativePaths.length === 0) return;

  for (const relativePath of relativePaths) {
    try {
      await execFileAsync('git', ['checkout', commit, '--', relativePath], {
        cwd: workspacePath,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.warn(`[SafeGit] Failed to checkout '${relativePath}' from commit ${commit} (likely did not exist at safe point): ${message}`);
    }
  }
}
