/**
 * Git Service - Branch management for task isolation
 *
 * Provides git operations for creating, checking out, and tracking
 * branches for queued task execution.
 */

import { execSync, exec } from 'node:child_process';
import { promisify } from 'node:util';
import { getWorkspacePath } from '../utils/paths.js';
import type { BranchStatus } from '../../types/index.js';

const execAsync = promisify(exec);

/**
 * Execute a git command in the workspace directory
 */
function gitExec(command: string): string {
  const cwd = getWorkspacePath();
  try {
    return execSync(`git ${command}`, { cwd, encoding: 'utf-8' }).trim();
  } catch (error) {
    const err = error as Error & { stderr?: string };
    throw new Error(`Git command failed: git ${command}\n${err.stderr || err.message}`);
  }
}

/**
 * Execute a git command asynchronously
 */
async function gitExecAsync(command: string): Promise<string> {
  const cwd = getWorkspacePath();
  try {
    const { stdout } = await execAsync(`git ${command}`, { cwd });
    return stdout.trim();
  } catch (error) {
    const err = error as Error & { stderr?: string };
    throw new Error(`Git command failed: git ${command}\n${err.stderr || err.message}`);
  }
}

/**
 * Get the current branch name
 */
export function getCurrentBranch(): string {
  return gitExec('rev-parse --abbrev-ref HEAD');
}

/**
 * Check if a branch exists
 */
export function branchExists(branchName: string): boolean {
  try {
    gitExec(`rev-parse --verify ${branchName}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a new branch from a base branch
 * @param branchName - Name of the new branch
 * @param baseBranch - Branch to create from (default: 'main')
 */
export async function createBranch(branchName: string, baseBranch: string = 'main'): Promise<void> {
  // First, ensure we have the latest base branch
  try {
    await gitExecAsync(`fetch origin ${baseBranch}`);
  } catch {
    // Fetch may fail if no remote, continue anyway
  }

  // Create the branch from base
  if (branchExists(branchName)) {
    throw new Error(`Branch '${branchName}' already exists`);
  }

  // Create and checkout the new branch
  await gitExecAsync(`checkout -b ${branchName} ${baseBranch}`);
}

/**
 * Checkout an existing branch
 */
export async function checkoutBranch(branchName: string): Promise<void> {
  if (!branchExists(branchName)) {
    throw new Error(`Branch '${branchName}' does not exist`);
  }
  await gitExecAsync(`checkout ${branchName}`);
}

/**
 * Check if there are uncommitted changes in the workspace
 * Excludes .formic/ directory since that's internal state that shouldn't block queue
 */
export function hasUncommittedChanges(): boolean {
  try {
    const status = gitExec('status --porcelain');
    if (status.length === 0) return false;

    // Filter out .formic/ changes - these are internal and shouldn't block queue
    const lines = status.split('\n').filter(line => line.trim().length > 0);
    const nonFormicChanges = lines.filter(line => {
      // Status format: XY filename or XY "filename with spaces"
      const file = line.slice(3).replace(/^"(.*)"$/, '$1');
      return !file.startsWith('.formic/') && !file.startsWith('.formic\\');
    });

    return nonFormicChanges.length > 0;
  } catch {
    return false;
  }
}

/**
 * Get the status of a branch relative to main
 * @returns BranchStatus - 'created' | 'ahead' | 'behind' | 'conflicts' | 'merged'
 */
export async function getBranchStatus(branchName: string, baseBranch: string = 'main'): Promise<BranchStatus> {
  if (!branchExists(branchName)) {
    return 'created';
  }

  try {
    // Fetch latest from remote (ignore errors if no remote)
    try {
      await gitExecAsync(`fetch origin ${baseBranch}`);
    } catch {
      // Continue without fetch
    }

    // Check if branch is merged into base
    const mergedBranches = gitExec(`branch --merged ${baseBranch}`);
    if (mergedBranches.includes(branchName)) {
      return 'merged';
    }

    // Get ahead/behind counts
    const revList = gitExec(`rev-list --left-right --count ${baseBranch}...${branchName}`);
    const [behind, ahead] = revList.split('\t').map(Number);

    // Check for merge conflicts by attempting a dry-run merge
    if (behind > 0) {
      try {
        // Try to merge base into branch (dry run)
        const currentBranch = getCurrentBranch();
        if (currentBranch !== branchName) {
          await gitExecAsync(`checkout ${branchName}`);
        }

        // Check if merge would have conflicts
        try {
          gitExec(`merge --no-commit --no-ff ${baseBranch}`);
          // No conflicts, abort the merge
          gitExec('merge --abort');
        } catch {
          // Merge failed, likely conflicts
          try {
            gitExec('merge --abort');
          } catch {
            // Abort may fail if no merge in progress
          }
          return 'conflicts';
        }

        // Switch back if we changed branches
        if (currentBranch !== branchName) {
          await gitExecAsync(`checkout ${currentBranch}`);
        }
      } catch {
        // If anything fails, assume conflicts
        return 'conflicts';
      }
    }

    // Determine status based on ahead/behind
    if (ahead > 0 && behind > 0) {
      return 'behind'; // Diverged, but no conflicts detected
    } else if (behind > 0) {
      return 'behind';
    } else if (ahead > 0) {
      return 'ahead';
    }

    return 'created';
  } catch {
    return 'created';
  }
}

/**
 * Generate a branch name for a task
 * @param taskId - Task ID (e.g., 't-1')
 * @param slug - Task slug (e.g., 'add-dark-mode')
 */
export function generateBranchName(taskId: string, slug: string): string {
  return `formic/${taskId}_${slug}`;
}

/**
 * Get the default base branch (checks for main or master)
 */
export function getDefaultBaseBranch(): string {
  try {
    // Check if 'main' exists
    if (branchExists('main')) {
      return 'main';
    }
    // Fall back to 'master'
    if (branchExists('master')) {
      return 'master';
    }
    // Default to 'main'
    return 'main';
  } catch {
    return 'main';
  }
}

/**
 * Safely switch back to a branch, handling errors gracefully
 */
export async function safeSwitchBranch(branchName: string): Promise<boolean> {
  try {
    await checkoutBranch(branchName);
    return true;
  } catch {
    return false;
  }
}
