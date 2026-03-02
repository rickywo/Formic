import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { WebSocket } from 'ws';
import { updateTaskStatus, getTask, loadBoard, saveBoard, createTask, queueTask } from './store.js';
import { getWorkspaceSkillsPath, skillExists } from './skills.js';
import { loadSkillPrompt } from './skillReader.js';
import { getAgentCommand, buildAgentArgs, getAgentDisplayName } from './agentAdapter.js';
import { acquireLeases, releaseLeases, renewLeases, recordFileHashes, detectCollisions } from './leaseManager.js';
import {
  loadSubtasks,
  isAllComplete,
  getCompletionStats,
  formatIncompleteSubtasksForPrompt,
  subtasksExist,
} from './subtasks.js';
import { getWorkspacePath, getFormicDir } from '../utils/paths.js';
import type { LogMessage, Task, WorkflowStep } from '../../types/index.js';
import path from 'node:path';
import { broadcastBoardUpdate } from './boardNotifier.js';

const MAX_LOG_LINES = 50;
const GUIDELINE_FILENAME = 'kanban-development-guideline.md';
const MAX_EXECUTE_ITERATIONS = parseInt(process.env.MAX_EXECUTE_ITERATIONS || '5', 10);
const STEP_TIMEOUT_MS = parseInt(process.env.STEP_TIMEOUT_MS || '600000', 10); // 10 minutes default

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
  const board = await loadBoard();
  const task = board.tasks.find(t => t.id === taskId);
  if (task) {
    task.workflowStep = step;
    await saveBoard(board);
  }
}

/**
 * Append logs to workflow logs for a specific step
 */
async function appendWorkflowLogs(taskId: string, step: 'brief' | 'plan' | 'execute' | 'architect', logs: string[]): Promise<void> {
  const board = await loadBoard();
  const task = board.tasks.find(t => t.id === taskId);
  if (task) {
    if (!task.workflowLogs) {
      task.workflowLogs = {};
    }
    if (!task.workflowLogs[step]) {
      task.workflowLogs[step] = [];
    }
    task.workflowLogs[step]!.push(...logs);
    // Keep only last 50 lines per step
    if (task.workflowLogs[step]!.length > MAX_LOG_LINES) {
      task.workflowLogs[step] = task.workflowLogs[step]!.slice(-MAX_LOG_LINES);
    }
    await saveBoard(board);
  }
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
  await updateTaskStatus(taskId, 'declaring', null);
  await updateWorkflowStep(taskId, 'declare');

  broadcastToTask(taskId, {
    type: 'stdout',
    data: `\n========== Starting DECLARE step ==========\n`,
    timestamp: new Date().toISOString(),
  });

  const declareSuccess = await new Promise<boolean>((resolve) => {
    const skillResult = loadSkillPrompt('declare', task);
    skillResult.then(result => {
      if (!result.success) {
        console.log('[Workflow] Declare skill not found, skipping declaration');
        resolve(true); // Skip if no declare skill - backwards compatible
        return;
      }

      const child = runWorkflowStep(taskId, 'execute', result.content, (success) => {
        resolve(success);
      });

      if (child.pid) {
        activeWorkflows.set(taskId, { process: child, currentStep: 'declare' });
      }
    }).catch(() => {
      resolve(true); // Skip on error
    });
  });

  activeWorkflows.delete(taskId);

  if (!declareSuccess) {
    console.log(`[Workflow] Declare step failed for task ${taskId}`);
    return false;
  }

  // Parse declared-files.json
  const declaredFiles = await loadDeclaredFiles(task.docsPath);
  if (declaredFiles) {
    // Store declared files on the task
    const board = await loadBoard();
    const boardTask = board.tasks.find(t => t.id === taskId);
    if (boardTask) {
      boardTask.declaredFiles = declaredFiles;
      await saveBoard(board);
    }

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
      console.log(`[Workflow] Lease acquisition failed for task ${taskId}, yielding`);
      broadcastToTask(taskId, {
        type: 'stdout',
        data: `\n[YIELD] Cannot acquire file leases - conflicts on: ${leaseResult.conflictingFiles.join(', ')}\n`,
        timestamp: new Date().toISOString(),
      });
      return false;
    }

    broadcastToTask(taskId, {
      type: 'stdout',
      data: `\n[LEASES] Acquired ${leaseResult.leases.length} file lease(s)\n`,
      timestamp: new Date().toISOString(),
    });
  } else {
    console.log(`[Workflow] No declared-files.json found for task ${taskId}, proceeding without leases`);
  }

  return true;
}

/**
 * Run a single workflow step
 */
function runWorkflowStep(
  taskId: string,
  step: 'brief' | 'plan' | 'execute',
  prompt: string,
  onComplete: (success: boolean) => void
): ChildProcess {
  console.log(`[Workflow] Starting ${step} step for task ${taskId}`);

  // Use agent adapter for CLI invocation
  const agentCommand = getAgentCommand();
  const agentArgs = buildAgentArgs(prompt);

  const child = spawn(agentCommand, agentArgs, {
    cwd: getWorkspacePath(),
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logBuffer: string[] = [];
  let hasCompleted = false;

  // Set up timeout to kill hanging processes
  const timeout = setTimeout(() => {
    if (!hasCompleted) {
      console.log(`[Workflow] ${step} step timed out after ${STEP_TIMEOUT_MS}ms, killing process`);
      broadcastToTask(taskId, {
        type: 'error',
        data: `[${step.toUpperCase()}] Step timed out after ${STEP_TIMEOUT_MS / 1000}s`,
        timestamp: new Date().toISOString(),
      });
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!hasCompleted) {
          child.kill('SIGKILL');
        }
      }, 5000);
    }
  }, STEP_TIMEOUT_MS);

  child.on('error', async (err: NodeJS.ErrnoException) => {
    hasCompleted = true;
    clearTimeout(timeout);
    activeWorkflows.delete(taskId);

    const agentName = getAgentDisplayName();
    let errorMessage = err.message;
    if (err.code === 'ENOENT') {
      errorMessage = `Command '${agentCommand}' not found. Please ensure ${agentName} is installed.`;
    }

    console.log(`[Workflow] ${step} step error: ${errorMessage}`);
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

    while (logBuffer.length > MAX_LOG_LINES) {
      logBuffer.shift();
    }

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

    while (logBuffer.length > MAX_LOG_LINES) {
      logBuffer.shift();
    }

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

    console.log(`[Workflow] ${step} step completed with code ${code}`);
    await appendWorkflowLogs(taskId, step, logBuffer);

    broadcastToTask(taskId, {
      type: 'exit',
      data: `[${step.toUpperCase()}] Step completed with code ${code}`,
      timestamp: new Date().toISOString(),
    });

    onComplete(code === 0);
  });

  return child;
}

/**
 * Run a single iteration of the execute step and return success status
 */
function runExecuteIteration(
  taskId: string,
  prompt: string
): Promise<boolean> {
  return new Promise((resolve) => {
    const child = runWorkflowStep(taskId, 'execute', prompt, (success) => {
      resolve(success);
    });

    if (child.pid) {
      activeWorkflows.set(taskId, { process: child, currentStep: 'execute' });
    }
  });
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
  console.log(`[Workflow] Starting iterative execution for task ${taskId}`);
  const guidelines = await loadProjectGuidelines();
  let iteration = 1;
  let allComplete = false;
  let previousCompletedCount = 0;
  let stalledIterations = 0;
  const STALL_THRESHOLD = 2; // Stop after 2 iterations with no progress

  // Broadcast start of iterative execution
  broadcastToTask(taskId, {
    type: 'stdout',
    data: `\n========== Starting EXECUTE step (iterative mode, max ${MAX_EXECUTE_ITERATIONS} iterations) ==========\n`,
    timestamp: new Date().toISOString(),
  });

  while (iteration <= MAX_EXECUTE_ITERATIONS && !allComplete) {
    console.log(`[Workflow] Execute iteration ${iteration}/${MAX_EXECUTE_ITERATIONS} for task ${taskId}`);

    // Renew leases at the start of each iteration to prevent watchdog timeout
    renewLeases(taskId);

    // Broadcast iteration start
    broadcastToTask(taskId, {
      type: 'stdout',
      data: `\n----- Execute Iteration ${iteration}/${MAX_EXECUTE_ITERATIONS} -----\n`,
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
      console.log(`[Workflow] Execute iteration ${iteration} failed`);
      return { success: false, iterations: iteration, allComplete: false };
    }

    // Small delay to ensure file system has flushed
    await new Promise(resolve => setTimeout(resolve, 500));

    // Check subtasks completion after this iteration
    console.log(`[Workflow] Checking subtasks for task ${taskId}, docsPath: ${task.docsPath}`);
    const subtasks = await loadSubtasks(task.docsPath);
    if (subtasks) {
      const stats = getCompletionStats(subtasks);
      allComplete = isAllComplete(subtasks);

      // Log detailed status for debugging
      const statusCounts = subtasks.subtasks.reduce((acc, s) => {
        acc[s.status] = (acc[s.status] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);
      console.log(`[Workflow] Subtask statuses: ${JSON.stringify(statusCounts)}`);

      // Broadcast completion status
      broadcastToTask(taskId, {
        type: 'stdout',
        data: `\n[Subtasks] Completion: ${stats.completed}/${stats.total} (${stats.percentage}%)\n`,
        timestamp: new Date().toISOString(),
      });

      console.log(`[Workflow] Subtask completion after iteration ${iteration}: ${stats.completed}/${stats.total} (${stats.percentage}%), allComplete=${allComplete}`);

      // Stall detection: check if progress was made this iteration
      if (stats.completed === previousCompletedCount && iteration > 1) {
        stalledIterations++;
        console.log(`[Workflow] No progress made in iteration ${iteration}. Stalled iterations: ${stalledIterations}/${STALL_THRESHOLD}`);

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
          console.log(`[Workflow] Stall detected - stopping execution loop. Remaining subtasks need manual verification.`);
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
      console.log(`[Workflow] No subtasks.json found for task ${taskId}, treating as complete`);
      allComplete = true;
    }

    iteration++;
  }

  if (!allComplete && stalledIterations >= STALL_THRESHOLD) {
    // Stalled - this is expected for manual testing subtasks
    console.log(`[Workflow] Execution stalled after ${iteration - 1} iterations, moving to review for manual verification`);
  } else if (!allComplete && iteration > MAX_EXECUTE_ITERATIONS) {
    broadcastToTask(taskId, {
      type: 'stdout',
      data: `\n[WARNING] Max iterations (${MAX_EXECUTE_ITERATIONS}) reached. Some subtasks may be incomplete.\n`,
      timestamp: new Date().toISOString(),
    });
    console.log(`[Workflow] Max iterations reached, some subtasks incomplete`);
  }

  console.log(`[Workflow] Iterative execution completed for task ${taskId}: iterations=${iteration - 1}, allComplete=${allComplete}, stalled=${stalledIterations >= STALL_THRESHOLD}`);
  return { success: true, iterations: iteration - 1, allComplete };
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

  // Check if a workflow is already running
  if (activeWorkflows.has(taskId)) {
    throw new Error('A workflow is already running for this task');
  }

  console.log(`[Workflow] Starting quick task execution for ${taskId}`);

  // Load project guidelines
  const guidelines = await loadProjectGuidelines();

  // Build the quick execute prompt
  const prompt = buildQuickExecutePrompt(task, guidelines);

  // Update task status to running
  await updateTaskStatus(taskId, 'running', null);
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
    const success = await new Promise<boolean>((resolve) => {
      const child = runWorkflowStep(taskId, 'execute', prompt, (success) => {
        resolve(success);
      });

      if (child.pid) {
        activeWorkflows.set(taskId, { process: child, currentStep: 'execute' });
      }
    });

    activeWorkflows.delete(taskId);

    // Release any leases held by this task
    releaseLeases(taskId);

    if (success) {
      await updateWorkflowStep(taskId, 'complete');
      await updateTaskStatus(taskId, 'review', null);
      broadcastToTask(taskId, {
        type: 'stdout',
        data: `\n[SUCCESS] Quick task completed. Ready for review.\n`,
        timestamp: new Date().toISOString(),
      });
    } else {
      await updateTaskStatus(taskId, 'todo', null);
      broadcastToTask(taskId, {
        type: 'error',
        data: `\n[FAILED] Quick task execution failed.\n`,
        timestamp: new Date().toISOString(),
      });
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

  // Build prompt based on step - try skill file first, fallback to hardcoded
  let prompt: string;
  let status: 'briefing' | 'planning' | 'running';

  switch (step) {
    case 'brief': {
      // Try loading from skill file first
      const skillResult = await loadSkillPrompt('brief', task);
      if (skillResult.success) {
        prompt = skillResult.content;
        console.log('[Workflow] Using skill file for brief step');
      } else {
        // Fallback to hardcoded prompt
        const guidelines = await loadProjectGuidelines();
        prompt = buildBriefPromptFallback(task, guidelines);
        console.log('[Workflow] Using fallback prompt for brief step');
      }
      status = 'briefing';
      break;
    }
    case 'plan': {
      // Try loading from skill file first
      const skillResult = await loadSkillPrompt('plan', task);
      if (skillResult.success) {
        prompt = skillResult.content;
        console.log('[Workflow] Using skill file for plan step');
      } else {
        // Fallback to hardcoded prompt
        const guidelines = await loadProjectGuidelines();
        prompt = buildPlanPromptFallback(task, guidelines);
        console.log('[Workflow] Using fallback prompt for plan step');
      }
      status = 'planning';
      break;
    }
    case 'execute': {
      // Execute step uses iterative loop with subtask completion checking
      console.log(`[Workflow] Starting execute step for task ${taskId}`);
      await updateTaskStatus(taskId, 'running', null);
      await updateWorkflowStep(taskId, 'execute');

      let result: { success: boolean; allComplete: boolean; iterations: number };
      try {
        result = await executeWithIterativeLoop(taskId, task);
        console.log(`[Workflow] Execute step finished for task ${taskId}: success=${result.success}, allComplete=${result.allComplete}, iterations=${result.iterations}`);

        if (result.success && result.allComplete) {
          // All subtasks complete - move to review
          console.log(`[Workflow] All subtasks complete, transitioning task ${taskId} to review`);
          await updateWorkflowStep(taskId, 'complete');
          await updateTaskStatus(taskId, 'review', null);
        } else if (result.success && !result.allComplete) {
          // Max iterations reached but not all complete - still move to review with warning
          console.log(`[Workflow] Max iterations reached, transitioning task ${taskId} to review with incomplete subtasks`);
          await updateWorkflowStep(taskId, 'complete');
          await updateTaskStatus(taskId, 'review', null);
        } else {
          // Execution failed
          console.log(`[Workflow] Execute step failed for task ${taskId}, reverting to todo`);
          await updateTaskStatus(taskId, 'todo', null);
        }
      } finally {
        releaseLeases(taskId);
        console.log(`[Workflow] Released leases for task ${taskId} (executeSingleStep)`);
      }

      return { success: result.success, pid: process.pid };
    }
  }

  // Update task status (for brief and plan steps)
  await updateTaskStatus(taskId, status!, null);
  await updateWorkflowStep(taskId, step);

  return new Promise((resolve) => {
    const child = runWorkflowStep(taskId, step, prompt!, async (success) => {
      activeWorkflows.delete(taskId);

      if (success) {
        // Update workflow step to next
        const nextStep: WorkflowStep = step === 'brief' ? 'plan' : 'execute';
        await updateWorkflowStep(taskId, nextStep);

        // Return to todo for manual steps
        await updateTaskStatus(taskId, 'todo', null);
      } else {
        // On failure, return to todo
        await updateTaskStatus(taskId, 'todo', null);
      }

      resolve({ success, pid: child.pid || 0 });
    });

    if (child.pid) {
      activeWorkflows.set(taskId, { process: child, currentStep: step });
    }
  });
}

/**
 * Execute the full workflow: brief → plan → execute
 */
export async function executeFullWorkflow(taskId: string): Promise<{ pid: number }> {
  const task = await getTask(taskId);
  if (!task) {
    throw new Error(`Task ${taskId} not found`);
  }

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
          console.log('[Workflow] Full workflow: Using skill file for brief step');
        } else {
          const guidelines = await loadProjectGuidelines();
          prompt = buildBriefPromptFallback(currentTask, guidelines);
          console.log('[Workflow] Full workflow: Using fallback for brief step');
        }
        status = 'briefing';
        break;
      }
      case 'plan': {
        const skillResult = await loadSkillPrompt('plan', currentTask);
        if (skillResult.success) {
          prompt = skillResult.content;
          console.log('[Workflow] Full workflow: Using skill file for plan step');
        } else {
          const guidelines = await loadProjectGuidelines();
          prompt = buildPlanPromptFallback(currentTask, guidelines);
          console.log('[Workflow] Full workflow: Using fallback for plan step');
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

    await updateTaskStatus(taskId, status, null);
    await updateWorkflowStep(taskId, step);

    broadcastToTask(taskId, {
      type: 'stdout',
      data: `\n========== Starting ${step.toUpperCase()} step ==========\n`,
      timestamp: new Date().toISOString(),
    });

    return new Promise((resolve) => {
      const child = runWorkflowStep(taskId, step, prompt, (success) => {
        resolve(success);
      });

      if (child.pid) {
        activeWorkflows.set(taskId, { process: child, currentStep: step });
      }
    });
  };

  // Start the workflow
  const startPid = process.pid; // Return server PID as reference

  // Run steps sequentially
  (async () => {
    // Step 1: Brief
    const briefSuccess = await runStep('brief');
    if (!briefSuccess) {
      activeWorkflows.delete(taskId);
      await updateTaskStatus(taskId, 'todo', null);
      return;
    }

    // Step 2: Plan
    const planSuccess = await runStep('plan');
    if (!planSuccess) {
      activeWorkflows.delete(taskId);
      await updateTaskStatus(taskId, 'todo', null);
      return;
    }

    // Step 2.5: Declare + Acquire Leases
    const currentTaskForDeclare = await getTask(taskId);
    if (!currentTaskForDeclare) {
      activeWorkflows.delete(taskId);
      await updateTaskStatus(taskId, 'todo', null);
      return;
    }

    const leasesAcquired = await executeDeclareAndAcquireLeases(taskId, currentTaskForDeclare);
    if (!leasesAcquired) {
      // Task needs to yield - return to queued for retry
      activeWorkflows.delete(taskId);
      const board = await loadBoard();
      const yieldTask = board.tasks.find(t => t.id === taskId);
      if (yieldTask) {
        yieldTask.yieldCount = (yieldTask.yieldCount || 0) + 1;
        await saveBoard(board);
      }
      await updateTaskStatus(taskId, 'queued', null);
      return;
    }

    // Step 3: Execute (with iterative completion checking)
    const currentTask = await getTask(taskId);
    if (!currentTask) {
      activeWorkflows.delete(taskId);
      releaseLeases(taskId);
      await updateTaskStatus(taskId, 'todo', null);
      return;
    }

    // Wrap post-lease-acquisition code in try/finally to guarantee lease release
    // even if an unexpected exception occurs during execution or collision detection
    try {
      await updateTaskStatus(taskId, 'running', null);
      await updateWorkflowStep(taskId, 'execute');

      const executeResult = await executeWithIterativeLoop(taskId, currentTask);
      activeWorkflows.delete(taskId);

      // Detect collisions on shared files BEFORE releasing leases
      // (releaseLeases deletes fileHashStore entries needed by detectCollisions)
      if (currentTask.declaredFiles?.shared && currentTask.declaredFiles.shared.length > 0) {
        const conflicts = await detectCollisions(taskId, getWorkspacePath());
        if (conflicts.length > 0) {
          const board = await loadBoard();
          const conflictTask = board.tasks.find(t => t.id === taskId);
          if (conflictTask) {
            conflictTask.fileConflicts = conflicts;
            await saveBoard(board);
          }
          console.log(`[Workflow] File conflicts detected for task ${taskId}: ${conflicts.map(c => c.filePath).join(', ')}`);
        }
      }

      if (executeResult.success) {
        // Guard against stale status updates: check if watchdog has already re-queued the task
        const latestTask = await getTask(taskId);
        if (latestTask && latestTask.status === 'running') {
          await updateWorkflowStep(taskId, 'complete');
          await updateTaskStatus(taskId, 'review', null);
        } else {
          console.warn(`[Workflow] Skipping status update for task ${taskId}: expected 'running' but found '${latestTask?.status ?? 'deleted'}'`);
        }
      } else {
        const latestTask = await getTask(taskId);
        if (latestTask && latestTask.status === 'running') {
          await updateTaskStatus(taskId, 'todo', null);
        } else {
          console.warn(`[Workflow] Skipping status update for task ${taskId}: expected 'running' but found '${latestTask?.status ?? 'deleted'}'`);
        }
      }
    } finally {
      // Ensure leases are always released, even on unexpected exceptions.
      // Safe to call even if leases were already released (no-op in that case).
      releaseLeases(taskId);
    }
  })();

  return { pid: startPid };
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

/**
 * Execute a goal task workflow (architect step → create child tasks)
 */
export async function executeGoalWorkflow(taskId: string): Promise<{ pid: number }> {
  const task = await getTask(taskId);
  if (!task) {
    throw new Error(`Task ${taskId} not found`);
  }

  if (activeWorkflows.has(taskId)) {
    throw new Error('A workflow is already running for this task');
  }

  console.log(`[Workflow] Starting goal workflow for ${taskId}`);

  // Update status to architecting
  await updateTaskStatus(taskId, 'architecting', null);
  await updateWorkflowStep(taskId, 'architect');

  // Load skill prompt with fallback
  let prompt: string;
  const skillResult = await loadSkillPrompt('architect', task);
  if (skillResult.success) {
    prompt = skillResult.content;
    console.log('[Workflow] Using skill file for architect step');
  } else {
    const guidelines = await loadProjectGuidelines();
    prompt = buildArchitectPromptFallback(task, guidelines);
    console.log('[Workflow] Using fallback prompt for architect step');
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
    const success = await new Promise<boolean>((resolve) => {
      const child = runWorkflowStep(taskId, 'execute', prompt, (stepSuccess) => {
        resolve(stepSuccess);
      });

      if (child.pid) {
        activeWorkflows.set(taskId, { process: child, currentStep: 'architect' });
      }
    });

    activeWorkflows.delete(taskId);

    if (!success) {
      await updateTaskStatus(taskId, 'todo', null);
      broadcastToTask(taskId, {
        type: 'error',
        data: `\n[FAILED] Architect step failed.\n`,
        timestamp: new Date().toISOString(),
      });
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
        await updateTaskStatus(taskId, 'review', null);
        broadcastBoardUpdate();
        return;
      }

      const outputContent = await readFile(outputPath, 'utf-8');
      const childTaskDefs = JSON.parse(outputContent) as Array<{
        title: string;
        context: string;
        priority?: 'high' | 'medium' | 'low';
      }>;

      if (!Array.isArray(childTaskDefs) || childTaskDefs.length === 0) {
        throw new Error('architect-output.json must be a non-empty array');
      }

      console.log(`[Workflow] Parsed ${childTaskDefs.length} child tasks from architect output`);

      broadcastToTask(taskId, {
        type: 'stdout',
        data: `\n[ARCHITECT] Creating ${childTaskDefs.length} child tasks...\n`,
        timestamp: new Date().toISOString(),
      });

      const childTaskIds: string[] = [];

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
        const board = await loadBoard();
        const childInBoard = board.tasks.find(t => t.id === childTask.id);
        if (childInBoard) {
          childInBoard.parentGoalId = taskId;
          await saveBoard(board);
        }

        childTaskIds.push(childTask.id);

        broadcastToTask(taskId, {
          type: 'stdout',
          data: `  → Created: ${childTask.id} - ${childTask.title}\n`,
          timestamp: new Date().toISOString(),
        });
      }

      // Update goal task with child task IDs
      const goalBoard = await loadBoard();
      const goalTask = goalBoard.tasks.find(t => t.id === taskId);
      if (goalTask) {
        goalTask.childTaskIds = childTaskIds;
        await saveBoard(goalBoard);
      }

      // Auto-queue each child task
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
      await updateTaskStatus(taskId, 'review', null);

      broadcastToTask(taskId, {
        type: 'stdout',
        data: `\n[SUCCESS] Goal decomposed into ${childTaskIds.length} tasks. Ready for review.\n`,
        timestamp: new Date().toISOString(),
      });

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
      await updateTaskStatus(taskId, 'review', null);
      broadcastBoardUpdate();
    }
  })();

  return { pid: startPid };
}

/**
 * Stop an active workflow
 */
export async function stopWorkflow(taskId: string): Promise<boolean> {
  const workflow = activeWorkflows.get(taskId);
  if (!workflow) {
    return false;
  }

  workflow.process.kill('SIGTERM');

  setTimeout(() => {
    if (activeWorkflows.has(taskId)) {
      workflow.process.kill('SIGKILL');
    }
  }, 5000);

  // Immediately release any leases held by this task to unblock sibling tasks,
  // rather than waiting for the async IIFE to complete after process exit.
  activeWorkflows.delete(taskId);
  releaseLeases(taskId);

  return true;
}
