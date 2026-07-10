import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, mkdir, appendFile, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { WebSocket } from 'ws';
import { updateTaskStatus, getTask, loadBoard, saveBoard, createTask, queueTask, updateTask, withBoard } from './store.js';
import { getWorkspaceSkillsPath, skillExists } from './skills.js';
import { loadSkillPrompt } from './skillReader.js';
import { getAgentCommand, buildAgentArgs, getAgentDisplayName } from './agentAdapter.js';
import { acquireLeases, releaseLeases, renewLeases, recordFileHashes, detectCollisions, recordWait, clearWait, preemptLease, getExclusiveLeaseHolder } from './leaseManager.js';
import {
  loadSubtasks,
  isAllComplete,
  getCompletionStats,
  formatIncompleteSubtasksForPrompt,
  subtasksExist,
} from './subtasks.js';
import { getWorkspacePath, getFormicDir, getTaskLogsDir } from '../utils/paths.js';
import { createSafePoint } from '../utils/gitUtils.js';
import { checkoutFilesFromCommit } from '../utils/safeGit.js';
import type { LogMessage, Task, WorkflowStep } from '../../types/index.js';
import path from 'node:path';
import { broadcastBoardUpdate, broadcastKillSwitch, broadcastTaskCompleted } from './boardNotifier.js';
import { stopQueueProcessor, removeInFlightTask } from './queueProcessor.js';
import { broadcastToWorkspace } from './messagingNotifier.js';
import { addMemory } from './memory.js';
import { addTool } from './tools.js';
import { internalEvents, TASK_COMPLETED } from './internalEvents.js';

const GUIDELINE_FILENAME = 'kanban-development-guideline.md';
import { engineConfig, refreshEngineConfig } from './engineConfig.js';

/**
 * Load the project development guidelines if they exist
 */
async function loadProjectGuidelines(): Promise<string> {
  const guidelinePath = path.join(getWorkspacePath(), GUIDELINE_FILENAME);

  if (!existsSync(guidelinePath)) {
    return '';
  }

  try {
    const content = await readFile(guidelinePath, 'utf-8');
    return `
## Project Development Guidelines
The following guidelines MUST be followed for all code changes in this project:

${content}

---
END OF GUIDELINES
`;
  } catch (error) {
    console.warn('[Workflow] Failed to load project guidelines:', error);
    return '';
  }
}

// Store active workflow processes
const activeWorkflows = new Map<string, {
  process: ChildProcess;
  currentStep: WorkflowStep;
}>();

// Tracks tasks that have been requested to stop, so workflow IIFEs can abort at step boundaries
const stoppedWorkflows = new Set<string>();

/**
 * Increment the retryCount on a task after an execution failure.
 * Returns the new retryCount value so callers can decide whether to engage the kill switch.
 */
async function incrementRetryCount(taskId: string, caller: string): Promise<number> {
  try {
    const task = await getTask(taskId);
    if (!task) return 0;
    const newCount = (task.retryCount ?? 0) + 1;
    await updateTask(taskId, { retryCount: newCount });
    console.warn(`[Workflow] Incremented retryCount for ${taskId} to ${newCount} (caller: ${caller})`);
    return newCount;
  } catch (err) {
    console.warn(`[Workflow] Failed to increment retryCount for ${taskId}:`, err instanceof Error ? err.message : 'Unknown error');
    return 0;
  }
}

// Store WebSocket connections per task (shared with runner)
const taskConnections = new Map<string, Set<WebSocket>>();

export function isWorkflowRunning(taskId: string): boolean {
  return activeWorkflows.has(taskId);
}

export function getActiveWorkflowStep(taskId: string): WorkflowStep | null {
  const workflow = activeWorkflows.get(taskId);
  return workflow ? workflow.currentStep : null;
}

export function registerWorkflowConnection(taskId: string, ws: WebSocket): void {
  if (!taskConnections.has(taskId)) {
    taskConnections.set(taskId, new Set());
  }
  taskConnections.get(taskId)!.add(ws);
}

export function unregisterWorkflowConnection(taskId: string, ws: WebSocket): void {
  const connections = taskConnections.get(taskId);
  if (connections) {
    connections.delete(ws);
    if (connections.size === 0) {
      taskConnections.delete(taskId);
    }
  }
}

async function artifactExists(docsDir: string, filename: string): Promise<boolean> {
  try {
    await access(path.join(docsDir, filename));
    return true;
  } catch {
    return false;
  }
}

function broadcastToTask(taskId: string, message: LogMessage): void {
  const connections = taskConnections.get(taskId);
  if (!connections) return;

  const data = JSON.stringify(message);
  for (const ws of connections) {
    if (ws.readyState === 1) { // WebSocket.OPEN
      ws.send(data);
    }
  }
}

/**
 * Update the workflow step for a task
 */
async function updateWorkflowStep(taskId: string, step: WorkflowStep): Promise<void> {
  await withBoard((board) => {
    const task = board.tasks.find(t => t.id === taskId);
    if (task) {
      task.workflowStep = step;
    }
  });
}

/**
 * Append logs to a per-task, per-step log file on disk.
 * Stores only the file path reference in board.json (not the log content).
 */
async function appendWorkflowLogs(taskId: string, step: 'brief' | 'plan' | 'execute' | 'architect' | 'verify', logs: string[]): Promise<void> {
  if (logs.length === 0) return;

  // Ensure the .formic/logs/{taskId}/ directory exists and append log lines.
  // File I/O is done OUTSIDE withBoard to avoid holding the mutex during disk writes.
  const taskLogsDir = getTaskLogsDir(taskId);
  await mkdir(taskLogsDir, { recursive: true });

  const logFilePath = path.join(taskLogsDir, `${step}.log`);
  const content = logs.join('\n') + '\n';
  await appendFile(logFilePath, content, 'utf-8');

  // Store the relative log file path in board.json (not the log content)
  await withBoard((board) => {
    const task = board.tasks.find(t => t.id === taskId);
    if (task) {
      if (!task.workflowLogs) {
        task.workflowLogs = {};
      }
      // Store relative path so it's portable across machines
      task.workflowLogs[step] = `.formic/logs/${taskId}/${step}.log`;
    }
  });
}

/**
 * Build the prompt for the brief step (FALLBACK)
 * Used when skill file is not available or fails to load
 */
function buildBriefPromptFallback(task: Task, guidelines: string): string {
  const docsPath = path.join(getWorkspacePath(), task.docsPath);

  return `${guidelines}
You are generating a feature specification for a task.

TASK_TITLE: ${task.title}
TASK_CONTEXT: ${task.context}
TASK_DOCS_PATH: ${docsPath}

Your task is to generate a README.md file with the following structure:

# ${task.title}

## Overview
[A brief 2-3 sentence introduction to what this task accomplishes]

## Goals
- [Primary objective 1]
- [Primary objective 2]

## Key Capabilities
- [Main functionality 1]
- [Main functionality 2]

## Non-Goals
- [What is explicitly out of scope]

## Requirements
- [Technical requirement 1]
- [Technical requirement 2]

Focus on the 'what' and 'why', NOT the 'how'.
Write the README.md to: ${docsPath}/README.md`;
}

/**
 * Build the prompt for the plan step (FALLBACK)
 * Used when skill file is not available or fails to load
 */
function buildPlanPromptFallback(task: Task, guidelines: string): string {
  const docsPath = path.join(getWorkspacePath(), task.docsPath);

  return `${guidelines}
You are generating implementation planning documents for a task.

TASK_TITLE: ${task.title}
TASK_DOCS_PATH: ${docsPath}

First, read the README.md at ${docsPath}/README.md to understand the feature specification.

Then generate TWO files:

1. PLAN.md at ${docsPath}/PLAN.md with:
   - Status section
   - Implementation phases with checkboxes
   - Testing strategy
   - Success criteria

2. CHECKLIST.md at ${docsPath}/CHECKLIST.md with:
   - Pre-implementation checklist
   - Implementation checklist
   - Quality gates
   - Post-implementation checklist

Make the tasks specific and actionable based on the README.md specification.
Ensure all implementation steps follow the project development guidelines above.`;
}

/**
 * Build the prompt for the execute step (initial iteration)
 */
function buildExecutePrompt(task: Task, guidelines: string): string {
  const docsPath = path.join(getWorkspacePath(), task.docsPath);

  return `${guidelines}
Task: ${task.title}

IMPORTANT: Before implementing, read the task documentation at ${docsPath}/:
- README.md: Feature specification
- PLAN.md: Implementation steps
- subtasks.json: Structured subtask list (update status as you complete items)

Context: ${task.context}

Follow the PLAN.md step by step. As you complete each subtask, update its status in subtasks.json to "completed".

IMPORTANT: For subtasks that require manual verification, interactive testing, or cannot be automated (e.g., "Test with different environment variables", "Verify manually", "Test in browser"), mark their status as "skipped" instead of leaving them pending. This indicates the subtask needs human verification during review.

All code changes MUST comply with the project development guidelines provided above.`;
}

/**
 * Build the prompt for iterative execute step (subsequent iterations)
 * Provides feedback about incomplete subtasks
 */
function buildIterativeExecutePrompt(
  task: Task,
  guidelines: string,
  iteration: number,
  incompleteSubtasksInfo: string
): string {
  const docsPath = path.join(getWorkspacePath(), task.docsPath);

  return `${guidelines}
Task: ${task.title}

ITERATION ${iteration} - Continuing work on incomplete subtasks.

${incompleteSubtasksInfo}

Task documentation is at ${docsPath}/:
- README.md: Feature specification
- PLAN.md: Implementation steps
- subtasks.json: Structured subtask list

Context: ${task.context}

Please continue working on the incomplete subtasks listed above. As you complete each one, update its status in subtasks.json to "completed".

IMPORTANT: If a subtask requires manual verification, interactive testing, or cannot be automated (e.g., requires different environment variables, needs a running server, requires human verification), mark its status as "skipped" in subtasks.json. Do not leave them pending if you cannot complete them.

All code changes MUST comply with the project development guidelines provided above.`;
}

/**
 * Build the prompt for quick task execution (skips brief/plan stages)
 * Uses task.context directly as the execution prompt with project guidelines
 */
function buildQuickExecutePrompt(task: Task, guidelines: string): string {
  return `${guidelines}
Task: ${task.title}

Context: ${task.context}

This is a QUICK TASK - execute directly without generating documentation files.
Complete the task as specified in the context above.

All code changes MUST comply with the project development guidelines provided above.`;
}

/**
 * Load declared files from the task's declared-files.json
 */
async function loadDeclaredFiles(docsPath: string): Promise<{ exclusive: string[]; shared: string[] } | null> {
  const filePath = path.join(getWorkspacePath(), docsPath, 'declared-files.json');
  try {
    if (!existsSync(filePath)) {
      return null;
    }
    const content = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(content) as { exclusive?: string[]; shared?: string[] };
    return {
      exclusive: parsed.exclusive || [],
      shared: parsed.shared || [],
    };
  } catch (error) {
    console.warn('[Workflow] Failed to load declared-files.json:', error);
    return null;
  }
}

/**
 * Execute the declare step: run declare skill, parse output, acquire leases
 * Returns true if leases were acquired successfully, false if task should yield
 */
async function executeDeclareAndAcquireLeases(taskId: string, task: Task): Promise<boolean> {
  // Run the declare skill
  await updateTaskStatus(taskId, 'declaring', undefined, 'workflow.executeDeclareAndAcquireLeases');
  await updateWorkflowStep(taskId, 'declare');

  broadcastToTask(taskId, {
    type: 'stdout',
    data: `\n========== Starting DECLARE step ==========\n`,
    timestamp: new Date().toISOString(),
  });

  let declareSuccess: boolean;
  try {
    const skillResult = await loadSkillPrompt('declare', task);
    if (!skillResult.success) {
      console.warn('[Workflow] Declare skill not found, skipping declaration');
      declareSuccess = true;
    } else {
      let pidPromise: Promise<void> | undefined;
      const resultPromise = new Promise<boolean>((resolve) => {
        const { child, pidPersisted } = runWorkflowStep(taskId, 'execute', skillResult.content, (success) => {
          resolve(success);
        });
        pidPromise = pidPersisted;

        if (child.pid) {
          activeWorkflows.set(taskId, { process: child, currentStep: 'declare' });
        }
      });
      // Await PID persistence so board.json has the correct PID while the process runs
      if (pidPromise) await pidPromise;
      declareSuccess = await resultPromise;
    }
  } catch {
    declareSuccess = true; // Skip on error — backwards compatible
  }

  activeWorkflows.delete(taskId);

  if (!declareSuccess) {
    console.warn(`[Workflow] Declare step failed for task ${taskId}`);
    return false;
  }

  // Parse declared-files.json
  const declaredFiles = await loadDeclaredFiles(task.docsPath);
  if (declaredFiles) {
    // Store declared files on the task (serialized via withBoard)
    await withBoard((board) => {
      const boardTask = board.tasks.find(t => t.id === taskId);
      if (boardTask) {
        boardTask.declaredFiles = declaredFiles;
      }
    });

    // Record file hashes for shared files (optimistic concurrency)
    if (declaredFiles.shared.length > 0) {
      await recordFileHashes(taskId, declaredFiles.shared, getWorkspacePath());
    }

    // Attempt to acquire leases
    const leaseResult = acquireLeases({
      taskId,
      exclusiveFiles: declaredFiles.exclusive,
      sharedFiles: declaredFiles.shared,
    });

    if (!leaseResult.granted) {
      console.warn(`[Workflow] Lease acquisition failed for task ${taskId}, yielding`);
      broadcastToTask(taskId, {
        type: 'stdout',
        data: `\n[YIELD] Cannot acquire file leases - conflicts on: ${leaseResult.conflictingFiles.join(', ')}\n`,
        timestamp: new Date().toISOString(),
      });
      if (leaseResult.conflictingFiles.length > 0) {
        const blockedOnFile = leaseResult.conflictingFiles[0];
        recordWait(taskId, blockedOnFile);
        await preemptLease(taskId, blockedOnFile);
      }
      return false;
    }

    clearWait(taskId);
    broadcastToTask(taskId, {
      type: 'stdout',
      data: `\n[LEASES] Acquired ${leaseResult.leases.length} file lease(s)\n`,
      timestamp: new Date().toISOString(),
    });
  } else {
    console.warn(`[Workflow] No declared-files.json found for task ${taskId}, proceeding without leases`);
  }

  return true;
}

/**
 * Run a single workflow step.
 *
 * Returns the child process and a `pidPersisted` promise that resolves once the
 * child's PID has been written to board.json via `updateTaskStatus`.  Callers
 * should `await pidPersisted` before proceeding so the PID is visible in the
 * API and cannot be lost to a concurrent board write.
 */
function runWorkflowStep(
  taskId: string,
  step: 'brief' | 'plan' | 'execute',
  prompt: string,
  onComplete: (success: boolean) => void
): { child: ChildProcess; pidPersisted: Promise<void> } {
  console.warn(`[Workflow] Starting ${step} step for task ${taskId}`);

  // Use agent adapter for CLI invocation
  const agentCommand = getAgentCommand();
  const agentArgs = buildAgentArgs(prompt);

  const child = spawn(agentCommand, agentArgs, {
    cwd: getWorkspacePath(),
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Persist child.pid to board.json so the OS process is identifiable for running tasks.
  // We read the task's current status and re-write it together with the PID in a single
  // updateTaskStatus call so the PID is set atomically with the status field.
  // Callers must `await pidPersisted` before proceeding to ensure the PID write completes
  // before any competing board writes.
  const pidPersisted: Promise<void> = (async () => {
    if (!child.pid) return;
    try {
      const currentTask = await getTask(taskId);
      if (currentTask) {
        await updateTaskStatus(taskId, currentTask.status, child.pid, 'workflow.process_spawned');
      }
    } catch (err) {
      console.warn(`[Workflow] Failed to persist PID ${child.pid} for task ${taskId}:`, err);
    }
  })();

  const logBuffer: string[] = [];
  let hasCompleted = false;

  // Set up timeout to kill hanging processes
  const timeout = setTimeout(() => {
    if (!hasCompleted) {
      console.warn(`[Workflow] ${step} step timed out after ${engineConfig.stepTimeoutMs}ms, killing process`);
      broadcastToTask(taskId, {
        type: 'error',
        data: `[${step.toUpperCase()}] Step timed out after ${engineConfig.stepTimeoutMs / 1000}s`,
        timestamp: new Date().toISOString(),
      });
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!hasCompleted) {
          child.kill('SIGKILL');
        }
      }, 5000);
    }
  }, engineConfig.stepTimeoutMs);

  child.on('error', async (err: NodeJS.ErrnoException) => {
    hasCompleted = true;
    clearTimeout(timeout);
    activeWorkflows.delete(taskId);

    const agentName = getAgentDisplayName();
    let errorMessage = err.message;
    if (err.code === 'ENOENT') {
      errorMessage = `Command '${agentCommand}' not found. Please ensure ${agentName} is installed.`;
    }

    console.warn(`[Workflow] ${step} step error: ${errorMessage}`);
    await appendWorkflowLogs(taskId, step, [`Error: ${errorMessage}`]);

    broadcastToTask(taskId, {
      type: 'error',
      data: `[${step.toUpperCase()}] ${errorMessage}`,
      timestamp: new Date().toISOString(),
    });

    onComplete(false);
  });

  child.stdout?.on('data', (data: Buffer) => {
    const text = data.toString();
    const lines = text.split('\n').filter(line => line.length > 0);
    logBuffer.push(...lines);

    // Send raw text without per-chunk prefix - the step context is shown in the UI header
    broadcastToTask(taskId, {
      type: 'stdout',
      data: text,
      timestamp: new Date().toISOString(),
    });
  });

  child.stderr?.on('data', (data: Buffer) => {
    const text = data.toString();
    const lines = text.split('\n').filter(line => line.length > 0);
    logBuffer.push(...lines);

    // Send raw text without per-chunk prefix - the step context is shown in the UI header
    broadcastToTask(taskId, {
      type: 'stderr',
      data: text,
      timestamp: new Date().toISOString(),
    });
  });

  child.on('close', async (code) => {
    hasCompleted = true;
    clearTimeout(timeout);

    console.warn(`[Workflow] ${step} step completed with code ${code}`);
    await appendWorkflowLogs(taskId, step, logBuffer);

    broadcastToTask(taskId, {
      type: 'exit',
      data: `[${step.toUpperCase()}] Step completed with code ${code}`,
      timestamp: new Date().toISOString(),
    });

    onComplete(code === 0);
  });

  return { child, pidPersisted };
}

/**
 * Run a single iteration of the execute step and return success status
 */
async function runExecuteIteration(
  taskId: string,
  prompt: string
): Promise<boolean> {
  let pidPromise: Promise<void> | undefined;
  const resultPromise = new Promise<boolean>((resolve) => {
    const { child, pidPersisted } = runWorkflowStep(taskId, 'execute', prompt, (success) => {
      resolve(success);
    });
    pidPromise = pidPersisted;

    if (child.pid) {
      activeWorkflows.set(taskId, { process: child, currentStep: 'execute' });
    }
  });

  // Await PID persistence so board.json has the correct PID before the process completes
  if (pidPromise) {
    await pidPromise;
  }

  return resultPromise;
}

/**
 * Execute with iterative completion checking (Ralph Wiggum style)
 * Continues running until all subtasks are complete, max iterations reached,
 * or progress has stalled (no new subtasks completed for consecutive iterations)
 */
async function executeWithIterativeLoop(
  taskId: string,
  task: Task
): Promise<{ success: boolean; iterations: number; allComplete: boolean }> {
  console.warn(`[Workflow] Starting iterative execution for task ${taskId}`);
  const guidelines = await loadProjectGuidelines();
  let iteration = 1;
  let allComplete = false;
  let previousCompletedCount = 0;
  let stalledIterations = 0;
  const STALL_THRESHOLD = 2; // Stop after 2 iterations with no progress

  // Periodic lease renewal timer — renews every 2 minutes to prevent
  // watchdog from expiring leases during long-running execute iterations
  const LEASE_RENEWAL_INTERVAL_MS = 2 * 60 * 1000;
  const leaseRenewalTimer = setInterval(() => {
    renewLeases(taskId);
    console.warn(`[Workflow] Periodic lease renewal for task ${taskId}`);
  }, LEASE_RENEWAL_INTERVAL_MS);

  // Broadcast start of iterative execution
  broadcastToTask(taskId, {
    type: 'stdout',
    data: `\n========== Starting EXECUTE step (iterative mode, max ${engineConfig.maxExecuteIterations} iterations) ==========\n`,
    timestamp: new Date().toISOString(),
  });

  try {

  while (iteration <= engineConfig.maxExecuteIterations && !allComplete) {
    console.warn(`[Workflow] Execute iteration ${iteration}/${engineConfig.maxExecuteIterations} for task ${taskId}`);

    // Renew leases at the start of each iteration to prevent watchdog timeout
    renewLeases(taskId);

    // Broadcast iteration start
    broadcastToTask(taskId, {
      type: 'stdout',
      data: `\n----- Execute Iteration ${iteration}/${engineConfig.maxExecuteIterations} -----\n`,
      timestamp: new Date().toISOString(),
    });

    // Build prompt based on iteration
    let prompt: string;
    if (iteration === 1) {
      // First iteration uses standard execute prompt
      prompt = buildExecutePrompt(task, guidelines);
    } else {
      // Subsequent iterations include feedback about incomplete subtasks
      const subtasks = await loadSubtasks(task.docsPath);
      const incompleteInfo = subtasks
        ? formatIncompleteSubtasksForPrompt(subtasks)
        : 'Unable to load subtasks.json - please check the file exists and is valid JSON.';
      prompt = buildIterativeExecutePrompt(task, guidelines, iteration, incompleteInfo);
    }

    // Run this iteration
    const success = await runExecuteIteration(taskId, prompt);
    activeWorkflows.delete(taskId);

    if (!success) {
      // Iteration failed - stop the loop
      console.warn(`[Workflow] Execute iteration ${iteration} failed`);
      return { success: false, iterations: iteration, allComplete: false };
    }

    // Small delay to ensure file system has flushed
    await new Promise(resolve => setTimeout(resolve, 500));

    // Check subtasks completion after this iteration
    console.warn(`[Workflow] Checking subtasks for task ${taskId}, docsPath: ${task.docsPath}`);
    const subtasks = await loadSubtasks(task.docsPath);
    if (subtasks) {
      const stats = getCompletionStats(subtasks);
      allComplete = isAllComplete(subtasks);

      // Log detailed status for debugging
      const statusCounts = subtasks.subtasks.reduce((acc, s) => {
        acc[s.status] = (acc[s.status] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);
      console.warn(`[Workflow] Subtask statuses: ${JSON.stringify(statusCounts)}`);

      // Broadcast completion status
      broadcastToTask(taskId, {
        type: 'stdout',
        data: `\n[Subtasks] Completion: ${stats.completed}/${stats.total} (${stats.percentage}%)\n`,
        timestamp: new Date().toISOString(),
      });

      console.warn(`[Workflow] Subtask completion after iteration ${iteration}: ${stats.completed}/${stats.total} (${stats.percentage}%), allComplete=${allComplete}`);

      // Stall detection: check if progress was made this iteration
      if (stats.completed === previousCompletedCount && iteration > 1) {
        stalledIterations++;
        console.warn(`[Workflow] No progress made in iteration ${iteration}. Stalled iterations: ${stalledIterations}/${STALL_THRESHOLD}`);

        if (stalledIterations >= STALL_THRESHOLD) {
          // Progress has stalled - likely manual testing subtasks remaining
          broadcastToTask(taskId, {
            type: 'stdout',
            data: `\n[INFO] No progress for ${STALL_THRESHOLD} iterations. Remaining subtasks likely require manual verification.\n`,
            timestamp: new Date().toISOString(),
          });
          broadcastToTask(taskId, {
            type: 'stdout',
            data: `[INFO] Moving to review. Please verify remaining subtasks manually.\n`,
            timestamp: new Date().toISOString(),
          });
          console.warn(`[Workflow] Stall detected - stopping execution loop. Remaining subtasks need manual verification.`);
          break;
        }
      } else {
        // Progress was made, reset stall counter
        stalledIterations = 0;
      }
      previousCompletedCount = stats.completed;

      if (allComplete) {
        broadcastToTask(taskId, {
          type: 'stdout',
          data: `\n[SUCCESS] All subtasks complete! Task ready for review.\n`,
          timestamp: new Date().toISOString(),
        });
      }
    } else {
      // No subtasks.json found - treat as complete (backwards compatibility)
      console.warn(`[Workflow] No subtasks.json found for task ${taskId}, treating as complete`);
      allComplete = true;
    }

    iteration++;
  }

  if (!allComplete && stalledIterations >= STALL_THRESHOLD) {
    // Stalled - this is expected for manual testing subtasks
    console.warn(`[Workflow] Execution stalled after ${iteration - 1} iterations, moving to review for manual verification`);
  } else if (!allComplete && iteration > engineConfig.maxExecuteIterations) {
    broadcastToTask(taskId, {
      type: 'stdout',
      data: `\n[WARNING] Max iterations (${engineConfig.maxExecuteIterations}) reached. Some subtasks may be incomplete.\n`,
      timestamp: new Date().toISOString(),
    });
    console.warn(`[Workflow] Max iterations reached, some subtasks incomplete`);
  }

  console.warn(`[Workflow] Iterative execution completed for task ${taskId}: iterations=${iteration - 1}, allComplete=${allComplete}, stalled=${stalledIterations >= STALL_THRESHOLD}`);
  return { success: true, iterations: iteration - 1, allComplete };

  } finally {
    clearInterval(leaseRenewalTimer);
  }
}

/**
 * Run the verification command against the workspace.
 * Always refreshes engineConfig first to pick up any changes made during execution.
 * Returns { success: true } immediately when skipVerify is true or verifyCommand is unset.
 */
async function executeVerifyStep(taskId: string): Promise<{ success: boolean; stderrLines: string[] }> {
  await refreshEngineConfig();

  if (engineConfig.skipVerify) {
    console.warn('[Verifier] Skipping verification — toggle is OFF');
    return { success: true, stderrLines: [] };
  }

  if (!engineConfig.verifyCommand) {
    console.warn('[Verifier] Skipping verification — toggle is ON but verifyCommand is not configured. Set a verify command in Settings.');
    return { success: true, stderrLines: [] };
  }

  await updateTaskStatus(taskId, 'verifying', undefined, 'workflow.executeVerifyStep');
  await updateWorkflowStep(taskId, 'verify');

  broadcastToTask(taskId, {
    type: 'stdout',
    data: '\n========== Starting VERIFY step ==========\n',
    timestamp: new Date().toISOString(),
  });

  const parts = engineConfig.verifyCommand.split(' ');
  const cmd = parts[0];
  const args = parts.slice(1);
  const logBuffer: string[] = [];
  const stderrLines: string[] = [];

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(cmd, args, {
      cwd: getWorkspacePath(),
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.warn(`[Verifier] Failed to spawn verification command: ${message}`);
    return { success: false, stderrLines: [message] };
  }

  // Persist verifier PID to board.json using updateTaskStatus for atomic status+PID writes.
  if (child.pid) {
    const currentTask = await getTask(taskId);
    if (currentTask) {
      await updateTaskStatus(taskId, currentTask.status, child.pid, 'workflow.executeVerifyStep.process_spawned').catch((err) => {
        console.warn(`[Verifier] Failed to persist PID ${child.pid} for task ${taskId}:`, err);
      });
    }
  }

  return new Promise((resolve) => {
    child.on('error', (err: NodeJS.ErrnoException) => {
      const message = err.message;
      console.warn(`[Verifier] Failed to spawn verification command: ${message}`);
      resolve({ success: false, stderrLines: [message] });
    });

    child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      logBuffer.push(...text.split('\n').filter(l => l.length > 0));
      broadcastToTask(taskId, { type: 'stdout', data: text, timestamp: new Date().toISOString() });
    });

    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      const lines = text.split('\n').filter(l => l.length > 0);
      logBuffer.push(...lines);
      stderrLines.push(...lines);
      broadcastToTask(taskId, { type: 'stderr', data: text, timestamp: new Date().toISOString() });
    });

    child.on('close', async (code) => {
      await appendWorkflowLogs(taskId, 'verify', logBuffer);

      broadcastToTask(taskId, {
        type: 'exit',
        data: `[VERIFY] Step completed with code ${code}`,
        timestamp: new Date().toISOString(),
      });

      if (code === 0) {
        console.warn('[Verifier] Verification PASSED');
        resolve({ success: true, stderrLines: [] });
      } else {
        console.warn(`[Verifier] Verification FAILED (exit code ${code})`);
        resolve({ success: false, stderrLines });
      }
    });
  });
}

/**
 * On verify failure: increment retryCount; create a Fix task or engage kill switch after 3 failures.
 */
async function executeCriticAndRetry(taskId: string, stderrLines: string[]): Promise<void> {
  // Capture retryCount and fields needed for kill-switch logic inside the
  // serialized withBoard closure so the task reference remains valid.
  const captured = await withBoard((board): {
    newRetryCount: number;
    safePointCommit: string | null | undefined;
    declaredExclusiveFiles: string[];
    title: string;
    context: string;
  } | null => {
    const task = board.tasks.find(t => t.id === taskId);
    if (!task) return null;

    const newRetryCount = (task.retryCount ?? 0) + 1;
    task.retryCount = newRetryCount;

    return {
      newRetryCount,
      safePointCommit: task.safePointCommit,
      declaredExclusiveFiles: task.declaredFiles?.exclusive ?? [],
      title: task.title,
      context: task.context,
    };
  });

  if (!captured) return;

  const { newRetryCount, safePointCommit, declaredExclusiveFiles, title, context } = captured;
  console.warn(`[Critic] Task ${taskId} retry count: ${newRetryCount}`);

  if (newRetryCount >= 3) {
    console.warn(`[Critic] Kill switch activated for task ${taskId} after ${newRetryCount} failed verifications`);

    let revertMessage: string;
    if (safePointCommit) {
      if (declaredExclusiveFiles.length > 0) {
        try {
          await checkoutFilesFromCommit(safePointCommit, declaredExclusiveFiles, getWorkspacePath());
          console.warn(`[Critic] Reverted ${declaredExclusiveFiles.length} declared file(s) for task ${taskId} to safe point ${safePointCommit}`);
          revertMessage = `Declared files reverted to safe point \`${safePointCommit}\`. HEAD was not moved.`;
        } catch (err) {
          console.warn('[Critic] Failed to revert declared files to safe point:', err instanceof Error ? err.message : 'Unknown error');
          revertMessage = `Attempted revert failed. Safe point: \`${safePointCommit}\`. Manual review recommended.`;
        }
      } else {
        console.warn(`[Critic] Task ${taskId} has no declaredFiles, skipping auto-revert. Safe point: ${safePointCommit}`);
        revertMessage = `Workspace NOT auto-reverted (no declared files). Safe point: \`${safePointCommit}\``;
      }
    } else {
      console.warn(`[Critic] No safePointCommit on task ${taskId}, skipping revert`);
      revertMessage = 'No safe point recorded; workspace was not reverted.';
    }

    stopQueueProcessor();
    console.warn('[Critic] Queue processor stopped by kill switch');

    broadcastKillSwitch(taskId);

    try {
      await broadcastToWorkspace(getWorkspacePath(), {
        chatId: '',
        text: `🚨 *Kill Switch Activated*\n\nTask \`${taskId}\` has failed verification 3 times.\nQueue paused. ${revertMessage}`,
        parseMode: 'markdown',
      });
    } catch (err) {
      console.warn('[Critic] Failed to send kill switch messaging notification:', err instanceof Error ? err.message : 'Unknown error');
    }

    await updateTaskStatus(taskId, 'todo', null, 'workflow.executeCriticAndRetry.kill_switch');
    return;
  }

  const errorSnippet = stderrLines.slice(-100).join('\n');
  const fixContext = `Auto-fix for task ${taskId}: ${title}\n\nVerification failed with the following error:\n\`\`\`\n${errorSnippet}\n\`\`\`\n\nPlease fix the code so that the verification command passes.\n\nOriginal task context:\n${context}`;

  const fixTask = await createTask({
    title: `Fix: ${title}`,
    context: fixContext,
    priority: 'high',
    type: 'quick',
    fixForTaskId: taskId,
  });
  await queueTask(fixTask.id);
  await updateTaskStatus(taskId, 'todo', null, 'workflow.executeCriticAndRetry.retry');
  broadcastBoardUpdate();
  console.warn(`[Critic] Created fix task ${fixTask.id} for task ${taskId} (retry ${newRetryCount}/3)`);
}

// ==================== Reflection Step ====================

interface ReflectionEntry {
  type: 'pattern' | 'pitfall' | 'preference';
  content: string;
  relevance_tags: string[];
}

function isReflectionEntry(val: unknown): val is ReflectionEntry {
  if (typeof val !== 'object' || val === null) return false;
  const obj = val as Record<string, unknown>;
  return (
    (obj['type'] === 'pattern' || obj['type'] === 'pitfall' || obj['type'] === 'preference') &&
    typeof obj['content'] === 'string' &&
    Array.isArray(obj['relevance_tags']) &&
    (obj['relevance_tags'] as unknown[]).every((t) => typeof t === 'string')
  );
}

function parseReflectionOutput(output: string): ReflectionEntry[] {
  const match = output.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isReflectionEntry);
  } catch {
    return [];
  }
}

/** Spawn the agent with a one-shot prompt and collect all output as a string. */
function runAgentForOutput(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const agentCommand = getAgentCommand();
    const agentArgs = buildAgentArgs(prompt);

    const child = spawn(agentCommand, agentArgs, {
      cwd: getWorkspacePath(),
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const chunks: string[] = [];

    child.stdout?.on('data', (data: Buffer) => {
      chunks.push(data.toString());
    });

    child.stderr?.on('data', (data: Buffer) => {
      chunks.push(data.toString());
    });

    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
    }, 3 * 60 * 1000); // 3-minute timeout for reflection

    child.on('error', () => {
      clearTimeout(timeout);
      resolve(chunks.join(''));
    });

    child.on('close', () => {
      clearTimeout(timeout);
      resolve(chunks.join(''));
    });
  });
}

/**
 * Fire-and-forget reflection step: runs after a task transitions to 'review'.
 * Prompts the agent to extract learnings and pitfalls, saves them as memory entries,
 * and links the generated IDs back to the task via reflectionMemories.
 * All errors are swallowed so this never blocks task completion.
 */
async function runReflectionStep(taskId: string): Promise<void> {
  try {
    const task = await getTask(taskId);
    if (!task) return;

    const prompt = `You have just completed task "${task.title}".

Reflect on what was done and produce a JSON array of memory entries for future reference.
Each entry must have: type ('pattern'|'pitfall'|'preference'), content (string), relevance_tags (string array of file paths or keywords).

Output ONLY a valid JSON array, no markdown fences.
Example:
[
  { "type": "pattern", "content": "Always use writeFile with { recursive: true } when creating nested dirs", "relevance_tags": ["node:fs", "file-system"] },
  { "type": "pitfall", "content": "ESM imports require .js extension even for .ts source files", "relevance_tags": ["typescript", "esm", "imports"] }
]`;

    const output = await runAgentForOutput(prompt);
    const entries = parseReflectionOutput(output);

    const memoryIds: string[] = [];
    for (const entry of entries) {
      const memEntry = await addMemory({
        type: entry.type,
        content: entry.content,
        source_task: taskId,
        relevance_tags: entry.relevance_tags,
      });
      memoryIds.push(memEntry.id);
    }

    if (memoryIds.length > 0) {
      await updateTask(taskId, { reflectionMemories: memoryIds });
      broadcastBoardUpdate();
      console.warn(`[Workflow] Reflection step saved ${memoryIds.length} memory entries for task ${taskId}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.warn(`[Workflow] Reflection step failed for task ${taskId}:`, message);
  }
}

/**
 * Fire-and-forget tool forge step: runs after a task transitions to 'review'.
 * Prompts the agent to identify reusable shell commands and registers them via addTool().
 * All errors are swallowed so this never blocks task completion.
 */
async function triggerToolForge(taskId: string): Promise<void> {
  try {
    const task = await getTask(taskId);
    if (!task) return;

    const prompt = `You have just completed task "${task.title}".

Review the work done and identify any shell commands that would be generically reusable across future tasks (e.g. test runners, linters, build scripts, deploy commands).

Output ONLY a valid JSON array of tool objects, no markdown fences. Each object must have: name (lowercase alphanumeric + hyphens only), description (string), command (string), created_by (string — use the task title).

If no reusable commands were identified, output an empty array: []

Example:
[
  { "name": "run-tests", "description": "Run the full test suite", "command": "npm test", "created_by": "${task.title}" }
]`;

    const output = await runAgentForOutput(prompt);
    const rawEntries = parseToolForgeOutput(output);
    const entries = rawEntries.filter((item): item is ToolForgeEntry => {
      if (isToolForgeEntry(item)) return true;
      console.warn('[Workflow] Skipped tool forge entry:', JSON.stringify(item));
      return false;
    });

    let forged = 0;
    for (const entry of entries) {
      try {
        await addTool(entry);
        forged++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        console.warn(`[Workflow] Skipping tool '${entry.name}' for task ${taskId}: ${msg}`);
      }
    }

    if (forged > 0) {
      console.warn(`[Workflow] Tool forge step registered ${forged} tool(s) for task ${taskId}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.warn(`[Workflow] Tool forge step failed for task ${taskId}:`, message);
  }
}

interface ToolForgeEntry {
  name: string;
  description: string;
  command: string;
  created_by: string;
}

function isToolForgeEntry(obj: unknown): obj is ToolForgeEntry {
  if (typeof obj !== 'object' || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return (
    typeof o['name'] === 'string' &&
    typeof o['description'] === 'string' &&
    typeof o['command'] === 'string' &&
    typeof o['created_by'] === 'string'
  );
}

/**
 * Scan `text` for all top-level JSON arrays, correctly handling nested arrays
 * and string literals so bracket counting is not confused by their contents.
 */
function extractJsonArrays(text: string): string[] {
  const arrays: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === '[') {
      let depth = 0;
      let j = i;
      let inString = false;
      let escape = false;
      while (j < text.length) {
        const ch = text[j];
        if (escape) {
          escape = false;
        } else if (inString) {
          if (ch === '\\') escape = true;
          else if (ch === '"') inString = false;
        } else {
          if (ch === '"') inString = true;
          else if (ch === '[') depth++;
          else if (ch === ']') {
            depth--;
            if (depth === 0) {
              arrays.push(text.slice(i, j + 1));
              i = j + 1;
              break;
            }
          }
        }
        j++;
      }
      if (depth !== 0) {
        // Unbalanced bracket — skip past this opening bracket
        i++;
      }
    } else {
      i++;
    }
  }
  return arrays;
}

function parseToolForgeOutput(output: string): unknown[] {
  const candidates = extractJsonArrays(output);
  const results: unknown[] = [];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (!Array.isArray(parsed)) {
        console.warn('[Workflow] Failed to parse tool forge array: not an array');
        continue;
      }
      results.push(...parsed);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      console.warn(`[Workflow] Failed to parse tool forge array: ${msg}`);
    }
  }
  return results;
}

/**
 * Execute a quick task (skips brief/plan stages, runs execute directly)
 * Quick tasks use task.context directly as the execution prompt
 */
export async function executeQuickTask(taskId: string): Promise<{ pid: number }> {
  const task = await getTask(taskId);
  if (!task) {
    throw new Error(`Task ${taskId} not found`);
  }
  await refreshEngineConfig();

  // Check if a workflow is already running
  if (activeWorkflows.has(taskId)) {
    throw new Error('A workflow is already running for this task');
  }

  console.warn(`[Workflow] Starting quick task execution for ${taskId}`);

  // Create a git safe-point commit before execution for rollback support
  await createSafePoint(taskId);

  // Load project guidelines
  const guidelines = await loadProjectGuidelines();

  // Build the quick execute prompt
  const prompt = buildQuickExecutePrompt(task, guidelines);

  // Update task status to running
  await updateTaskStatus(taskId, 'running', undefined, 'workflow.executeQuickTask.start');
  await updateWorkflowStep(taskId, 'execute');

  // Broadcast start
  broadcastToTask(taskId, {
    type: 'stdout',
    data: `\n========== Starting QUICK TASK execution (no brief/plan) ==========\n`,
    timestamp: new Date().toISOString(),
  });

  const startPid = process.pid;

  // Run the execute step
  (async () => {
    try {
      // Abort if stop was requested before execute begins
      if (stoppedWorkflows.has(taskId)) {
        stoppedWorkflows.delete(taskId);
        return;
      }

      let pidPromise: Promise<void> | undefined;
      const resultPromise = new Promise<boolean>((resolve) => {
        const { child, pidPersisted } = runWorkflowStep(taskId, 'execute', prompt, (success) => {
          resolve(success);
        });
        pidPromise = pidPersisted;

        if (child.pid) {
          activeWorkflows.set(taskId, { process: child, currentStep: 'execute' });
        }
      });

      // Await PID persistence before proceeding
      if (pidPromise) await pidPromise;

      const success = await resultPromise;

      activeWorkflows.delete(taskId);

      // Release any leases held by this task
      releaseLeases(taskId);

      // Abort if stop was requested while the execute step was finishing
      if (stoppedWorkflows.has(taskId)) {
        stoppedWorkflows.delete(taskId);
        return;
      }

      if (success) {
        const verifyResult = await executeVerifyStep(taskId);
        if (!verifyResult.success) {
          await executeCriticAndRetry(taskId, verifyResult.stderrLines);
          return;
        }
        await updateWorkflowStep(taskId, 'complete');
        await updateTaskStatus(taskId, 'review', null, 'workflow.executeQuickTask.success');
        broadcastTaskCompleted(taskId);
        internalEvents.emit(TASK_COMPLETED, taskId);
        void runReflectionStep(taskId);
        void triggerToolForge(taskId);
        broadcastToTask(taskId, {
          type: 'stdout',
          data: `\n[SUCCESS] Quick task completed. Ready for review.\n`,
          timestamp: new Date().toISOString(),
        });
      } else {
        await incrementRetryCount(taskId, 'workflow.executeQuickTask.failed');
        await updateTaskStatus(taskId, 'todo', null, 'workflow.executeQuickTask.failed');
        broadcastToTask(taskId, {
          type: 'error',
          data: `\n[FAILED] Quick task execution failed.\n`,
          timestamp: new Date().toISOString(),
        });
      }
    } finally {
      removeInFlightTask(taskId);
    }
  })();

  return { pid: startPid };
}

/**
 * Execute a single workflow step (for manual step execution)
 */
export async function executeSingleStep(
  taskId: string,
  step: 'brief' | 'plan' | 'execute'
): Promise<{ success: boolean; pid: number }> {
  const task = await getTask(taskId);
  if (!task) {
    throw new Error(`Task ${taskId} not found`);
  }

  // Check if a workflow is already running
  if (activeWorkflows.has(taskId)) {
    throw new Error('A workflow step is already running for this task');
  }

  // Abort if stop was requested before this step begins
  if (stoppedWorkflows.has(taskId)) {
    stoppedWorkflows.delete(taskId);
    return { success: false, pid: 0 };
  }

  // Build prompt based on step - try skill file first, fallback to hardcoded
  let prompt: string;
  let status: 'briefing' | 'planning' | 'running';

  switch (step) {
    case 'brief': {
      // Try loading from skill file first
      const skillResult = await loadSkillPrompt('brief', task);
      if (skillResult.success) {
        prompt = skillResult.content;
        console.warn('[Workflow] Using skill file for brief step');
      } else {
        // Fallback to hardcoded prompt
        const guidelines = await loadProjectGuidelines();
        prompt = buildBriefPromptFallback(task, guidelines);
        console.warn('[Workflow] Using fallback prompt for brief step');
      }
      status = 'briefing';
      break;
    }
    case 'plan': {
      // Try loading from skill file first
      const skillResult = await loadSkillPrompt('plan', task);
      if (skillResult.success) {
        prompt = skillResult.content;
        console.warn('[Workflow] Using skill file for plan step');
      } else {
        // Fallback to hardcoded prompt
        const guidelines = await loadProjectGuidelines();
        prompt = buildPlanPromptFallback(task, guidelines);
        console.warn('[Workflow] Using fallback prompt for plan step');
      }
      status = 'planning';
      break;
    }
    case 'execute': {
      // Execute step uses iterative loop with subtask completion checking
      console.warn(`[Workflow] Starting execute step for task ${taskId}`);
      await updateTaskStatus(taskId, 'running', undefined, 'workflow.executeSingleStep.execute_start');
      await updateWorkflowStep(taskId, 'execute');

      // Abort if stop was requested before execute begins
      if (stoppedWorkflows.has(taskId)) {
        stoppedWorkflows.delete(taskId);
        return { success: false, pid: 0 };
      }

      let result: { success: boolean; allComplete: boolean; iterations: number };
      try {
        result = await executeWithIterativeLoop(taskId, task);
        console.warn(`[Workflow] Execute step finished for task ${taskId}: success=${result.success}, allComplete=${result.allComplete}, iterations=${result.iterations}`);

        if (result.success && result.allComplete) {
          // All subtasks complete - move to review
          console.warn(`[Workflow] All subtasks complete, transitioning task ${taskId} to review`);
          await updateWorkflowStep(taskId, 'complete');
          await updateTaskStatus(taskId, 'review', null, 'workflow.executeSingleStep.all_complete');
          broadcastTaskCompleted(taskId);
          internalEvents.emit(TASK_COMPLETED, taskId);
          void runReflectionStep(taskId);
          void triggerToolForge(taskId);
        } else if (result.success && !result.allComplete) {
          // Max iterations reached but not all complete - still move to review with warning
          console.warn(`[Workflow] Max iterations reached, transitioning task ${taskId} to review with incomplete subtasks`);
          await updateWorkflowStep(taskId, 'complete');
          await updateTaskStatus(taskId, 'review', null, 'workflow.executeSingleStep.max_iterations');
          broadcastTaskCompleted(taskId);
          internalEvents.emit(TASK_COMPLETED, taskId);
          void runReflectionStep(taskId);
          void triggerToolForge(taskId);
        } else {
          // Execution failed
          console.warn(`[Workflow] Execute step failed for task ${taskId}, reverting to todo`);
          await incrementRetryCount(taskId, 'workflow.executeSingleStep.execute_failed');
          await updateTaskStatus(taskId, 'todo', null, 'workflow.executeSingleStep.execute_failed');
        }
      } finally {
        releaseLeases(taskId);
        console.warn(`[Workflow] Released leases for task ${taskId} (executeSingleStep)`);
      }

      return { success: result.success, pid: process.pid };
    }
  }

  // Update task status (for brief and plan steps)
  await updateTaskStatus(taskId, status!, undefined, 'workflow.executeSingleStep.step_start');
  await updateWorkflowStep(taskId, step);

  let pidPromise: Promise<void> | undefined;
  const resultPromise = new Promise<{ success: boolean; pid: number }>((resolve) => {
    const { child, pidPersisted } = runWorkflowStep(taskId, step, prompt!, async (success) => {
      activeWorkflows.delete(taskId);

      if (success) {
        // Update workflow step to next
        const nextStep: WorkflowStep = step === 'brief' ? 'plan' : 'execute';
        await updateWorkflowStep(taskId, nextStep);

        // Return to todo for manual steps
        await updateTaskStatus(taskId, 'todo', null, 'workflow.executeSingleStep.step_success');
      } else {
        // On failure, return to todo
        await incrementRetryCount(taskId, 'workflow.executeSingleStep.step_failed');
        await updateTaskStatus(taskId, 'todo', null, 'workflow.executeSingleStep.step_failed');
      }

      resolve({ success, pid: child.pid || 0 });
    });
    pidPromise = pidPersisted;

    if (child.pid) {
      activeWorkflows.set(taskId, { process: child, currentStep: step });
    }
  });

  // Await PID persistence so board.json has the correct PID before the process completes
  if (pidPromise) await pidPromise;

  return resultPromise;
}

/**
 * Execute the full workflow: brief → plan → execute
 */
export async function executeFullWorkflow(taskId: string): Promise<{ pid: number }> {
  const task = await getTask(taskId);
  if (!task) {
    throw new Error(`Task ${taskId} not found`);
  }
  await refreshEngineConfig();

  // Check if a workflow is already running
  if (activeWorkflows.has(taskId)) {
    throw new Error('A workflow is already running for this task');
  }

  // Helper to run steps sequentially
  const runStep = async (step: 'brief' | 'plan' | 'execute'): Promise<boolean> => {
    const currentTask = await getTask(taskId);
    if (!currentTask) return false;

    let prompt: string;
    let status: 'briefing' | 'planning' | 'running';

    // Build prompt - try skill file first, fallback to hardcoded
    switch (step) {
      case 'brief': {
        const skillResult = await loadSkillPrompt('brief', currentTask);
        if (skillResult.success) {
          prompt = skillResult.content;
          console.warn('[Workflow] Full workflow: Using skill file for brief step');
        } else {
          const guidelines = await loadProjectGuidelines();
          prompt = buildBriefPromptFallback(currentTask, guidelines);
          console.warn('[Workflow] Full workflow: Using fallback for brief step');
        }
        status = 'briefing';
        break;
      }
      case 'plan': {
        const skillResult = await loadSkillPrompt('plan', currentTask);
        if (skillResult.success) {
          prompt = skillResult.content;
          console.warn('[Workflow] Full workflow: Using skill file for plan step');
        } else {
          const guidelines = await loadProjectGuidelines();
          prompt = buildPlanPromptFallback(currentTask, guidelines);
          console.warn('[Workflow] Full workflow: Using fallback for plan step');
        }
        status = 'planning';
        break;
      }
      case 'execute': {
        const guidelines = await loadProjectGuidelines();
        prompt = buildExecutePrompt(currentTask, guidelines);
        status = 'running';
        break;
      }
    }

    await updateTaskStatus(taskId, status, undefined, 'workflow.executeFullWorkflow.step_start');
    await updateWorkflowStep(taskId, step);

    broadcastToTask(taskId, {
      type: 'stdout',
      data: `\n========== Starting ${step.toUpperCase()} step ==========\n`,
      timestamp: new Date().toISOString(),
    });

    let pidPromise: Promise<void> | undefined;
    const resultPromise = new Promise<boolean>((resolve) => {
      const { child, pidPersisted } = runWorkflowStep(taskId, step, prompt, (success) => {
        resolve(success);
      });
      pidPromise = pidPersisted;

      if (child.pid) {
        activeWorkflows.set(taskId, { process: child, currentStep: step });
      }
    });

    // Await PID persistence so board.json has the correct PID before the process completes
    if (pidPromise) await pidPromise;

    return resultPromise;
  };

  // Start the workflow
  const startPid = process.pid; // Return server PID as reference

  // Set status to 'briefing' immediately to prevent queue processor re-dispatch
  // during the async setup window (createSafePoint + skill loading).
  await updateTaskStatus(taskId, 'briefing', undefined, 'workflow.executeFullWorkflow.init');

  // Run steps sequentially
  (async () => {
    try {
      // Create a git safe-point commit before execution for rollback support.
      // Guard against duplicate commits on re-entry (e.g. if resumeFromStep was
      // not persisted and the task re-enters executeFullWorkflow on a retry).
      // Capture safePointCommit BEFORE creating a new safe-point.
      // A null value means this is a fresh run (e.g. re-run from review) — never skip stages.
      const taskBeforeSafePoint = await getTask(taskId);
      const isReEntry = !!taskBeforeSafePoint?.safePointCommit;
      if (!taskBeforeSafePoint?.safePointCommit) {
        await createSafePoint(taskId);
      }

      // Resolve task docs directory for artifact checks
      const docsDir = path.join(getWorkspacePath(), task.docsPath);

    // Abort if stop was requested before brief starts
    if (stoppedWorkflows.has(taskId)) {
      stoppedWorkflows.delete(taskId);
      return;
    }

    // Step 1: Brief — skip if README.md already exists on re-entry
    const skipBrief = isReEntry && await artifactExists(docsDir, 'README.md');
    if (skipBrief) {
      console.warn('[Workflow] Skipping brief step — README.md already exists');
      broadcastToTask(taskId, {
        type: 'stdout',
        data: '\n========== Skipping BRIEF step (README.md exists) ==========\n',
        timestamp: new Date().toISOString(),
      });
      // Transition through briefing→planning so the board UI shows progress
      await updateTaskStatus(taskId, 'planning', undefined, 'workflow.executeFullWorkflow.brief_skipped');
    } else {
      const briefSuccess = await runStep('brief');
      if (!briefSuccess) {
        activeWorkflows.delete(taskId);
        await incrementRetryCount(taskId, 'workflow.executeFullWorkflow.brief_failed');
        await updateTaskStatus(taskId, 'todo', null, 'workflow.executeFullWorkflow.brief_failed');
        return;
      }
    }

    // Abort if stop was requested between brief and plan
    if (stoppedWorkflows.has(taskId)) {
      stoppedWorkflows.delete(taskId);
      return;
    }

    // Step 2: Plan — skip if PLAN.md and subtasks.json already exist on re-entry
    const skipPlan = isReEntry
      && await artifactExists(docsDir, 'PLAN.md')
      && await artifactExists(docsDir, 'subtasks.json');
    if (skipPlan) {
      console.warn('[Workflow] Skipping plan step — PLAN.md + subtasks.json already exist');
      broadcastToTask(taskId, {
        type: 'stdout',
        data: '\n========== Skipping PLAN step (PLAN.md + subtasks.json exist) ==========\n',
        timestamp: new Date().toISOString(),
      });
      // Transition to declaring so the board UI shows progress
      await updateTaskStatus(taskId, 'declaring', undefined, 'workflow.executeFullWorkflow.plan_skipped');
    } else {
      const planSuccess = await runStep('plan');
      if (!planSuccess) {
        activeWorkflows.delete(taskId);
        await incrementRetryCount(taskId, 'workflow.executeFullWorkflow.plan_failed');
        await updateTaskStatus(taskId, 'todo', null, 'workflow.executeFullWorkflow.plan_failed');
        return;
      }
    }

    // Abort if stop was requested between plan and declare
    if (stoppedWorkflows.has(taskId)) {
      stoppedWorkflows.delete(taskId);
      return;
    }

    // Step 2.5: Declare + Acquire Leases
    const currentTaskForDeclare = await getTask(taskId);
    if (!currentTaskForDeclare) {
      activeWorkflows.delete(taskId);
      await updateTaskStatus(taskId, 'todo', null, 'workflow.executeFullWorkflow.task_not_found');
      return;
    }

    const leasesAcquired = await executeDeclareAndAcquireLeases(taskId, currentTaskForDeclare);
    if (!leasesAcquired) {
      // Task needs to yield - mark resumeFromStep so retry skips brief+plan
      activeWorkflows.delete(taskId);
      await withBoard((board) => {
        const yieldTask = board.tasks.find(t => t.id === taskId);
        if (yieldTask) {
          yieldTask.yieldCount = (yieldTask.yieldCount || 0) + 1;
          yieldTask.resumeFromStep = 'declare';
        }
      });
      const verifyTask = await getTask(taskId);
      console.warn(`[Workflow] Task ${taskId} yielded at declare — resumeFromStep persisted: ${verifyTask?.resumeFromStep}`);
      await updateTaskStatus(taskId, 'queued', null, 'workflow.executeFullWorkflow.declare_yield');
      return;
    }

    // Abort if stop was requested between declare and execute
    if (stoppedWorkflows.has(taskId)) {
      stoppedWorkflows.delete(taskId);
      releaseLeases(taskId);
      return;
    }

    // Step 3: Execute (with iterative completion checking)
    const currentTask = await getTask(taskId);
    if (!currentTask) {
      activeWorkflows.delete(taskId);
      releaseLeases(taskId);
      await updateTaskStatus(taskId, 'todo', null, 'workflow.executeFullWorkflow.task_not_found_post_declare');
      return;
    }

    // Wrap post-lease-acquisition code in try/finally to guarantee lease release
    // even if an unexpected exception occurs during execution or collision detection
    try {
      await updateTaskStatus(taskId, 'running', undefined, 'workflow.executeFullWorkflow.execute_start');
      await updateWorkflowStep(taskId, 'execute');

      const executeResult = await executeWithIterativeLoop(taskId, currentTask);
      activeWorkflows.delete(taskId);

      // Detect collisions on shared files BEFORE releasing leases
      // (releaseLeases deletes fileHashStore entries needed by detectCollisions)
      if (currentTask.declaredFiles?.shared && currentTask.declaredFiles.shared.length > 0) {
        const conflicts = await detectCollisions(taskId, getWorkspacePath());
        if (conflicts.length > 0) {
          await withBoard((board) => {
            const conflictTask = board.tasks.find(t => t.id === taskId);
            if (conflictTask) {
              conflictTask.fileConflicts = conflicts;
            }
          });
          console.warn(`[Workflow] File conflicts detected for task ${taskId}: ${conflicts.map(c => c.filePath).join(', ')}`);
        }
      }

      if (executeResult.success) {
        // Guard against stale status updates: check if watchdog has already re-queued the task
        const latestTask = await getTask(taskId);
        if (latestTask && latestTask.status === 'running') {
          const verifyResult = await executeVerifyStep(taskId);
          if (!verifyResult.success) {
            await executeCriticAndRetry(taskId, verifyResult.stderrLines);
          } else {
            await updateWorkflowStep(taskId, 'complete');
            await updateTaskStatus(taskId, 'review', null, 'workflow.executeFullWorkflow.verified');
            broadcastTaskCompleted(taskId);
            internalEvents.emit(TASK_COMPLETED, taskId);
            void runReflectionStep(taskId);
            void triggerToolForge(taskId);
          }
        } else {
          console.warn(`[Workflow] Skipping status update for task ${taskId}: expected 'running' but found '${latestTask?.status ?? 'deleted'}'`);
        }
      } else {
        const latestTask = await getTask(taskId);
        if (latestTask && latestTask.status === 'running') {
          await incrementRetryCount(taskId, 'workflow.executeFullWorkflow.execute_failed');
          await updateTaskStatus(taskId, 'todo', null, 'workflow.executeFullWorkflow.execute_failed');
        } else {
          console.warn(`[Workflow] Skipping status update for task ${taskId}: expected 'running' but found '${latestTask?.status ?? 'deleted'}'`);
        }
      }
    } finally {
      // Ensure leases are always released, even on unexpected exceptions.
      // Safe to call even if leases were already released (no-op in that case).
      releaseLeases(taskId);
    }
    } finally {
      removeInFlightTask(taskId);
    }
  })();

  return { pid: startPid };
}

/**
 * Resume a task that previously yielded at the declare step due to a lease conflict.
 * Skips brief and plan steps, jumping directly to declare + acquire leases and then execute.
 */
export async function executeFromDeclare(taskId: string): Promise<void> {
  // Change status to 'declaring' immediately so the queue processor cannot re-dispatch this task
  // before the async IIFE begins (mirrors the 'briefing' guard in executeFullWorkflow).
  await updateTaskStatus(taskId, 'declaring', undefined, 'workflow.executeFromDeclare.init');

  (async () => {
    try {
      const currentTask = await getTask(taskId);
      if (!currentTask) {
        activeWorkflows.delete(taskId);
        await updateTaskStatus(taskId, 'todo', null, 'workflow.executeFromDeclare.task_not_found');
        return;
      }

      const leasesAcquired = await executeDeclareAndAcquireLeases(taskId, currentTask);
      if (!leasesAcquired) {
        // Still conflicted — re-queue with resumeFromStep preserved for the next retry
        activeWorkflows.delete(taskId);
        await withBoard(async (board) => {
          const yieldTask = board.tasks.find(t => t.id === taskId);
          if (yieldTask) {
            const newYieldCount = (yieldTask.yieldCount || 0) + 1;
            yieldTask.yieldCount = newYieldCount;
            yieldTask.resumeFromStep = 'declare';

            // Zombie lease detection: if we've retried enough times, check whether
            // the blocking task is still active. If not, force-release its leases.
            const ZOMBIE_YIELD_THRESHOLD = Math.max(3, Math.floor(engineConfig.maxYieldCount / 2));
            if (newYieldCount >= ZOMBIE_YIELD_THRESHOLD) {
              const exclusiveFiles = currentTask.declaredFiles?.exclusive ?? [];
              const zombieHolders = new Set<string>();
              for (const filePath of exclusiveFiles) {
                const holder = getExclusiveLeaseHolder(filePath);
                if (holder && holder !== taskId) {
                  zombieHolders.add(holder);
                }
              }
              for (const holderId of zombieHolders) {
                const holderTask = await getTask(holderId);
                const holderStatus = holderTask?.status ?? 'unknown';
                if (holderStatus !== 'running' && holderStatus !== 'declaring') {
                  console.warn(`[Workflow] Force-releasing zombie leases held by task ${holderId} (status: ${holderStatus}) to unblock task ${taskId}`);
                  releaseLeases(holderId);
                }
              }
            }
          }
        });
        const verifyRetryTask = await getTask(taskId);
        console.warn(`[Workflow] Task ${taskId} re-queued from declare retry — resumeFromStep persisted: ${verifyRetryTask?.resumeFromStep}, yieldCount: ${verifyRetryTask?.yieldCount}`);
        await updateTaskStatus(taskId, 'queued', null, 'workflow.executeFromDeclare.declare_yield');
        return;
      }

      // Leases acquired — clear the resume marker so future retries (if any) start fresh
      await withBoard((board) => {
        const boardTask = board.tasks.find(t => t.id === taskId);
        if (boardTask) {
          boardTask.resumeFromStep = undefined;
        }
      });

      // Abort if stop was requested between declare and execute
      if (stoppedWorkflows.has(taskId)) {
        stoppedWorkflows.delete(taskId);
        releaseLeases(taskId);
        return;
      }

      const taskForExecution = await getTask(taskId);
      if (!taskForExecution) {
        activeWorkflows.delete(taskId);
        releaseLeases(taskId);
        await updateTaskStatus(taskId, 'todo', null, 'workflow.executeFromDeclare.task_not_found_post_declare');
        return;
      }

      try {
        await updateTaskStatus(taskId, 'running', undefined, 'workflow.executeFromDeclare.execute_start');
        await updateWorkflowStep(taskId, 'execute');

        const executeResult = await executeWithIterativeLoop(taskId, taskForExecution);
        activeWorkflows.delete(taskId);

        if (taskForExecution.declaredFiles?.shared && taskForExecution.declaredFiles.shared.length > 0) {
          const conflicts = await detectCollisions(taskId, getWorkspacePath());
          if (conflicts.length > 0) {
            await withBoard((board) => {
              const conflictTask = board.tasks.find(t => t.id === taskId);
              if (conflictTask) {
                conflictTask.fileConflicts = conflicts;
              }
            });
            console.warn(`[Workflow] File conflicts detected for task ${taskId}: ${conflicts.map(c => c.filePath).join(', ')}`);
          }
        }

        if (executeResult.success) {
          const latestTask = await getTask(taskId);
          if (latestTask && latestTask.status === 'running') {
            const verifyResult = await executeVerifyStep(taskId);
            if (!verifyResult.success) {
              await executeCriticAndRetry(taskId, verifyResult.stderrLines);
            } else {
              await updateWorkflowStep(taskId, 'complete');
              await updateTaskStatus(taskId, 'review', null, 'workflow.executeFromDeclare.verified');
              broadcastTaskCompleted(taskId);
              internalEvents.emit(TASK_COMPLETED, taskId);
              void runReflectionStep(taskId);
              void triggerToolForge(taskId);
            }
          } else {
            console.warn(`[Workflow] Skipping status update for task ${taskId}: expected 'running' but found '${latestTask?.status ?? 'deleted'}'`);
          }
        } else {
          const latestTask = await getTask(taskId);
          if (latestTask && latestTask.status === 'running') {
            await incrementRetryCount(taskId, 'workflow.executeFromDeclare.execute_failed');
            await updateTaskStatus(taskId, 'todo', null, 'workflow.executeFromDeclare.execute_failed');
          } else {
            console.warn(`[Workflow] Skipping status update for task ${taskId}: expected 'running' but found '${latestTask?.status ?? 'deleted'}'`);
          }
        }
      } finally {
        releaseLeases(taskId);
      }
    } finally {
      removeInFlightTask(taskId);
    }
  })();
}

/**
 * Build the prompt for the architect step (FALLBACK)
 * Used when skill file is not available or fails to load
 */
function buildArchitectPromptFallback(task: Task, guidelines: string): string {
  const docsPath = path.join(getWorkspacePath(), task.docsPath);

  return `${guidelines}
You are a senior Software Architect. Your task is to analyze a high-level goal and decompose it into multiple independent, actionable child tasks.

TASK_TITLE: ${task.title}
TASK_CONTEXT: ${task.context}
TASK_DOCS_PATH: ${docsPath}

IMPORTANT: You must NOT write any implementation code. Your only job is to analyze and decompose.

Instructions:
1. Explore the project codebase to understand the structure, tech stack, and patterns.
2. Decompose the goal into 3-8 independent tasks.
3. Write a JSON file to ${docsPath}/architect-output.json with this format:

[
  {
    "title": "Short verb-based title",
    "context": "Detailed self-contained description with requirements and acceptance criteria",
    "priority": "high|medium|low"
  }
]

Each task must be self-contained and not reference other child tasks.
Include a final task for integration testing/verification when appropriate.`;
}

/** Shape of a single task definition in architect-output.json */
interface ArchitectTaskDef {
  title: string;
  context: string;
  priority?: 'high' | 'medium' | 'low';
  /** Architect-assigned symbolic ID for dependency references (optional, DAG mode only) */
  task_id?: string;
  /** Symbolic IDs of tasks this task depends on (optional, DAG mode only) */
  depends_on?: string[];
}

/**
 * Detect cycles in the architect-output DAG using Kahn's BFS topological sort.
 * Returns true if a cycle is detected, false if the graph is acyclic.
 */
function detectDAGCycle(defs: ArchitectTaskDef[]): boolean {
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const def of defs) {
    if (typeof def.task_id !== 'string' || def.task_id.length === 0) continue;
    if (!inDegree.has(def.task_id)) inDegree.set(def.task_id, 0);
    if (!adjacency.has(def.task_id)) adjacency.set(def.task_id, []);
  }

  for (const def of defs) {
    if (typeof def.task_id !== 'string' || def.task_id.length === 0) continue;
    if (!Array.isArray(def.depends_on)) continue;

    for (const dep of def.depends_on) {
      if (!inDegree.has(dep)) continue; // unknown reference — skip
      inDegree.set(def.task_id, (inDegree.get(def.task_id) ?? 0) + 1);
      const neighbors = adjacency.get(dep) ?? [];
      neighbors.push(def.task_id);
      adjacency.set(dep, neighbors);
    }
  }

  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id);
  }

  let processed = 0;
  while (queue.length > 0) {
    const node = queue.shift()!;
    processed++;
    for (const neighbor of (adjacency.get(node) ?? [])) {
      const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) queue.push(neighbor);
    }
  }

  return processed < inDegree.size;
}

/**
 * Execute a goal task workflow (architect step → create child tasks)
 */
export async function executeGoalWorkflow(taskId: string): Promise<{ pid: number }> {
  const task = await getTask(taskId);
  if (!task) {
    throw new Error(`Task ${taskId} not found`);
  }
  await refreshEngineConfig();

  if (activeWorkflows.has(taskId)) {
    throw new Error('A workflow is already running for this task');
  }

  console.warn(`[Workflow] Starting goal workflow for ${taskId}`);

  // Create a git safe-point commit before execution for rollback support
  await createSafePoint(taskId);

  // Update status to architecting
  await updateTaskStatus(taskId, 'architecting', undefined, 'workflow.runArchitectStep.start');
  await updateWorkflowStep(taskId, 'architect');

  // Load skill prompt with fallback
  let prompt: string;
  const skillResult = await loadSkillPrompt('architect', task);
  if (skillResult.success) {
    prompt = skillResult.content;
    console.warn('[Workflow] Using skill file for architect step');
  } else {
    const guidelines = await loadProjectGuidelines();
    prompt = buildArchitectPromptFallback(task, guidelines);
    console.warn('[Workflow] Using fallback prompt for architect step');
  }

  // Broadcast start
  broadcastToTask(taskId, {
    type: 'stdout',
    data: `\n========== Starting ARCHITECT step (goal decomposition) ==========\n`,
    timestamp: new Date().toISOString(),
  });

  const startPid = process.pid;

  // Run the architect step asynchronously
  (async () => {
    try {
      // Abort if stop was requested before architect begins
      if (stoppedWorkflows.has(taskId)) {
        stoppedWorkflows.delete(taskId);
        return;
      }

      let pidPromise: Promise<void> | undefined;
      const resultPromise = new Promise<boolean>((resolve) => {
        const { child, pidPersisted } = runWorkflowStep(taskId, 'execute', prompt, (stepSuccess) => {
          resolve(stepSuccess);
        });
        pidPromise = pidPersisted;

        if (child.pid) {
          activeWorkflows.set(taskId, { process: child, currentStep: 'architect' });
        }
      });

      // Await PID persistence so board.json has the correct PID before the process completes
      if (pidPromise) await pidPromise;

      const success = await resultPromise;

      activeWorkflows.delete(taskId);

      if (!success) {
        await incrementRetryCount(taskId, 'workflow.runArchitectStep.failed');
        await updateTaskStatus(taskId, 'todo', null, 'workflow.runArchitectStep.failed');
        broadcastToTask(taskId, {
          type: 'error',
          data: `\n[FAILED] Architect step failed.\n`,
          timestamp: new Date().toISOString(),
        });
        return;
      }

    // Abort if stop was requested between architect and child task creation
    if (stoppedWorkflows.has(taskId)) {
      stoppedWorkflows.delete(taskId);
      return;
    }

    // Parse architect-output.json and create child tasks
    const outputPath = path.join(getWorkspacePath(), task.docsPath, 'architect-output.json');

    try {
      if (!existsSync(outputPath)) {
        console.warn(`[Workflow] architect-output.json not found at ${outputPath}`);
        broadcastToTask(taskId, {
          type: 'error',
          data: `\n[WARNING] architect-output.json not found. Goal moved to review.\n`,
          timestamp: new Date().toISOString(),
        });
        await updateWorkflowStep(taskId, 'complete');
        await updateTaskStatus(taskId, 'review', null, 'workflow.runArchitectStep.no_output');
        broadcastTaskCompleted(taskId);
        internalEvents.emit(TASK_COMPLETED, taskId);
        void runReflectionStep(taskId);
        void triggerToolForge(taskId);
        broadcastBoardUpdate();
        return;
      }

      const outputContent = await readFile(outputPath, 'utf-8');
      const childTaskDefs = JSON.parse(outputContent) as Array<ArchitectTaskDef>;

      if (!Array.isArray(childTaskDefs) || childTaskDefs.length === 0) {
        throw new Error('architect-output.json must be a non-empty array');
      }

      console.warn(`[Workflow] Parsed ${childTaskDefs.length} child tasks from architect output`);

      // Determine if DAG mode is active: at least one def has a task_id and no cycle exists
      const hasDagFields = childTaskDefs.some(d => typeof d.task_id === 'string' && d.task_id.length > 0);
      let dagMode = false;
      if (hasDagFields) {
        if (detectDAGCycle(childTaskDefs)) {
          console.warn('[Workflow] Cycle detected in architect DAG — falling back to flat queue mode');
          broadcastToTask(taskId, {
            type: 'stdout',
            data: `\n[WARNING] Cycle detected in dependency graph. Falling back to flat queue mode.\n`,
            timestamp: new Date().toISOString(),
          });
        } else {
          dagMode = true;
        }
      }

      broadcastToTask(taskId, {
        type: 'stdout',
        data: `\n[ARCHITECT] Creating ${childTaskDefs.length} child tasks...\n`,
        timestamp: new Date().toISOString(),
      });

      const childTaskIds: string[] = [];
      // Maps architect task_id → Formic task ID (populated in creation loop)
      const symbolicToFormicId = new Map<string, string>();

      for (const def of childTaskDefs) {
        if (!def.title || !def.context) {
          console.warn('[Workflow] Skipping invalid child task definition (missing title or context)');
          continue;
        }

        const childTask = await createTask({
          title: def.title,
          context: def.context,
          priority: def.priority || 'medium',
          type: 'standard',
        });

        // Set parentGoalId on the child task
        await withBoard((board) => {
          const childInBoard = board.tasks.find(t => t.id === childTask.id);
          if (childInBoard) {
            childInBoard.parentGoalId = taskId;
          }
        });

        if (dagMode && typeof def.task_id === 'string' && def.task_id.length > 0) {
          symbolicToFormicId.set(def.task_id, childTask.id);
        }

        childTaskIds.push(childTask.id);

        broadcastToTask(taskId, {
          type: 'stdout',
          data: `  → Created: ${childTask.id} - ${childTask.title}\n`,
          timestamp: new Date().toISOString(),
        });
      }

      // Update goal task with child task IDs
      await withBoard((board) => {
        const goalTask = board.tasks.find(t => t.id === taskId);
        if (goalTask) {
          goalTask.childTaskIds = childTaskIds;
        }
      });

      // In DAG mode: persist dependsOn / dependsOnResolved, then queue or block each child
      if (dagMode) {
        await withBoard((board) => {
          for (let i = 0; i < childTaskDefs.length; i++) {
            const def = childTaskDefs[i];
            const childId = childTaskIds[i];
            if (!childId) continue;

            const childInBoard = board.tasks.find(t => t.id === childId);
            if (childInBoard && Array.isArray(def.depends_on) && def.depends_on.length > 0) {
              childInBoard.dependsOn = def.depends_on;
              childInBoard.dependsOnResolved = def.depends_on
                .map(sym => symbolicToFormicId.get(sym))
                .filter((id): id is string => typeof id === 'string');
            }
          }
        });

        let queuedCount = 0;
        let blockedCount = 0;

        for (let i = 0; i < childTaskDefs.length; i++) {
          const def = childTaskDefs[i];
          const childId = childTaskIds[i];
          if (!childId) continue;

          const hasDeps = Array.isArray(def.depends_on) && def.depends_on.length > 0;
          if (hasDeps) {
            await updateTaskStatus(childId, 'blocked', null, 'workflow.runArchitectStep.child_blocked');
            blockedCount++;
            broadcastToTask(taskId, {
              type: 'stdout',
              data: `  ⏸ Blocked (awaiting dependencies): ${childId}\n`,
              timestamp: new Date().toISOString(),
            });
          } else {
            await queueTask(childId);
            queuedCount++;
            broadcastToTask(taskId, {
              type: 'stdout',
              data: `  ✓ Queued: ${childId}\n`,
              timestamp: new Date().toISOString(),
            });
          }
        }

        // Move goal to review
        await updateWorkflowStep(taskId, 'complete');
        await updateTaskStatus(taskId, 'review', null, 'workflow.runArchitectStep.dag_complete');
        broadcastTaskCompleted(taskId);
        internalEvents.emit(TASK_COMPLETED, taskId);
        void runReflectionStep(taskId);
        void triggerToolForge(taskId);

        broadcastToTask(taskId, {
          type: 'stdout',
          data: `\n[SUCCESS] Goal decomposed into ${childTaskIds.length} tasks (${queuedCount} queued, ${blockedCount} blocked). Ready for review.\n`,
          timestamp: new Date().toISOString(),
        });
      } else {
        // Flat mode: queue all children unconditionally
        for (const childId of childTaskIds) {
          await queueTask(childId);
          broadcastToTask(taskId, {
            type: 'stdout',
            data: `  ✓ Queued: ${childId}\n`,
            timestamp: new Date().toISOString(),
          });
        }

        // Move goal to review
        await updateWorkflowStep(taskId, 'complete');
        await updateTaskStatus(taskId, 'review', null, 'workflow.runArchitectStep.flat_complete');
        broadcastTaskCompleted(taskId);
        internalEvents.emit(TASK_COMPLETED, taskId);
        void runReflectionStep(taskId);
        void triggerToolForge(taskId);

        broadcastToTask(taskId, {
          type: 'stdout',
          data: `\n[SUCCESS] Goal decomposed into ${childTaskIds.length} tasks. Ready for review.\n`,
          timestamp: new Date().toISOString(),
        });
      }

      broadcastBoardUpdate();

    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.warn('[Workflow] Failed to parse architect output:', message);

      broadcastToTask(taskId, {
        type: 'error',
        data: `\n[WARNING] Failed to parse architect-output.json: ${message}\nGoal moved to review for manual inspection.\n`,
        timestamp: new Date().toISOString(),
      });

      await updateWorkflowStep(taskId, 'complete');
      await updateTaskStatus(taskId, 'review', null, 'workflow.runArchitectStep.parse_error');
      broadcastTaskCompleted(taskId);
      internalEvents.emit(TASK_COMPLETED, taskId);
      void runReflectionStep(taskId);
      void triggerToolForge(taskId);
      broadcastBoardUpdate();
    }
    } finally {
      removeInFlightTask(taskId);
    }
  })();

  return { pid: startPid };
}

/**
 * Stop an active workflow
 */
export async function stopWorkflow(taskId: string): Promise<boolean> {
  const workflow = activeWorkflows.get(taskId);

  // Mark as stopped so workflow IIFEs abort at the next step boundary
  stoppedWorkflows.add(taskId);

  // Eagerly reset to todo so the UI updates immediately via WebSocket broadcast
  await updateTaskStatus(taskId, 'todo', null, 'workflow.stopWorkflow');

  // Remove from inFlightTasks so the task can be re-queued cleanly if needed.
  // Safe to call here even though the workflow IIFE's outer finally block also calls
  // removeInFlightTask — Set.delete is idempotent so double-calls are harmless.
  removeInFlightTask(taskId);

  // Immediately release any leases held by this task to unblock sibling tasks
  releaseLeases(taskId);
  activeWorkflows.delete(taskId);

  if (workflow) {
    workflow.process.kill('SIGTERM');
    setTimeout(() => {
      if (!workflow.process.killed) workflow.process.kill('SIGKILL');
      stoppedWorkflows.delete(taskId);
    }, 3000);
  } else {
    // No active process — clean up the abort flag after a brief delay to allow
    // any in-flight IIFE to observe it before it is removed
    setTimeout(() => stoppedWorkflows.delete(taskId), 3000);
  }

  return true;
}
