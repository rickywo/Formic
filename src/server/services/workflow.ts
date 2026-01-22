import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { WebSocket } from 'ws';
import { updateTaskStatus, getTask, loadBoard, saveBoard, updateTask } from './store.js';
import { getWorkspaceSkillsPath, skillExists } from './skills.js';
import { loadSkillPrompt } from './skillReader.js';
import { getAgentCommand, buildAgentArgs, getAgentDisplayName } from './agentAdapter.js';
import {
  loadSubtasks,
  isAllComplete,
  getCompletionStats,
  formatIncompleteSubtasksForPrompt,
  subtasksExist,
} from './subtasks.js';
import { getWorkspacePath, getFormicDir } from '../utils/paths.js';
import { getBranchStatus } from './git.js';
import type { LogMessage, Task, WorkflowStep } from '../../types/index.js';
import path from 'node:path';

const WORKSPACE_PATH = process.env.WORKSPACE_PATH || './workspace';
const MAX_LOG_LINES = 50;
const GUIDELINE_FILENAME = 'kanban-development-guideline.md';
const MAX_EXECUTE_ITERATIONS = parseInt(process.env.MAX_EXECUTE_ITERATIONS || '5', 10);
const STEP_TIMEOUT_MS = parseInt(process.env.STEP_TIMEOUT_MS || '600000', 10); // 10 minutes default

/**
 * Load the project development guidelines if they exist
 */
async function loadProjectGuidelines(): Promise<string> {
  const guidelinePath = path.join(WORKSPACE_PATH, GUIDELINE_FILENAME);

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
async function appendWorkflowLogs(taskId: string, step: 'brief' | 'plan' | 'execute', logs: string[]): Promise<void> {
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
  const docsPath = path.join(WORKSPACE_PATH, task.docsPath);

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
  const docsPath = path.join(WORKSPACE_PATH, task.docsPath);

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
  const docsPath = path.join(WORKSPACE_PATH, task.docsPath);

  return `${guidelines}
Task: ${task.title}

IMPORTANT: Before implementing, read the task documentation at ${docsPath}/:
- README.md: Feature specification
- PLAN.md: Implementation steps
- subtasks.json: Structured subtask list (update status as you complete items)

Context: ${task.context}

Follow the PLAN.md step by step. As you complete each subtask, update its status in subtasks.json to "completed".
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
  const docsPath = path.join(WORKSPACE_PATH, task.docsPath);

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
All code changes MUST comply with the project development guidelines provided above.`;
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
    cwd: WORKSPACE_PATH,
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
 * Continues running until all subtasks are complete or max iterations reached
 */
async function executeWithIterativeLoop(
  taskId: string,
  task: Task
): Promise<{ success: boolean; iterations: number; allComplete: boolean }> {
  console.log(`[Workflow] Starting iterative execution for task ${taskId}`);
  const guidelines = await loadProjectGuidelines();
  let iteration = 1;
  let allComplete = false;

  // Broadcast start of iterative execution
  broadcastToTask(taskId, {
    type: 'stdout',
    data: `\n========== Starting EXECUTE step (iterative mode, max ${MAX_EXECUTE_ITERATIONS} iterations) ==========\n`,
    timestamp: new Date().toISOString(),
  });

  while (iteration <= MAX_EXECUTE_ITERATIONS && !allComplete) {
    console.log(`[Workflow] Execute iteration ${iteration}/${MAX_EXECUTE_ITERATIONS} for task ${taskId}`);

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

  if (!allComplete && iteration > MAX_EXECUTE_ITERATIONS) {
    broadcastToTask(taskId, {
      type: 'stdout',
      data: `\n[WARNING] Max iterations (${MAX_EXECUTE_ITERATIONS}) reached. Some subtasks may be incomplete.\n`,
      timestamp: new Date().toISOString(),
    });
    console.log(`[Workflow] Max iterations reached, some subtasks incomplete`);
  }

  console.log(`[Workflow] Iterative execution completed for task ${taskId}: iterations=${iteration - 1}, allComplete=${allComplete}`);
  return { success: true, iterations: iteration - 1, allComplete };
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

      const result = await executeWithIterativeLoop(taskId, task);
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

    // Step 3: Execute (with iterative completion checking)
    const currentTask = await getTask(taskId);
    if (!currentTask) {
      activeWorkflows.delete(taskId);
      await updateTaskStatus(taskId, 'todo', null);
      return;
    }

    await updateTaskStatus(taskId, 'running', null);
    await updateWorkflowStep(taskId, 'execute');

    const executeResult = await executeWithIterativeLoop(taskId, currentTask);
    activeWorkflows.delete(taskId);

    if (executeResult.success) {
      await updateWorkflowStep(taskId, 'complete');
      await updateTaskStatus(taskId, 'review', null);
    } else {
      await updateTaskStatus(taskId, 'todo', null);
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

  return true;
}

/**
 * Run workflow for a task (used by queue processor)
 * This wraps executeFullWorkflow and handles branch status updates after completion
 */
export async function runWorkflow(taskId: string): Promise<void> {
  const task = await getTask(taskId);
  if (!task) {
    throw new Error(`Task ${taskId} not found`);
  }

  try {
    // Execute the full workflow
    await executeFullWorkflow(taskId);

    // Note: Branch status will be updated by the queue processor
    // or can be updated here after workflow completes
  } catch (error) {
    console.error(`[Workflow] runWorkflow failed for task ${taskId}:`, error);
    throw error;
  }
}

/**
 * Update branch status for a task after workflow completion
 */
export async function updateTaskBranchStatus(taskId: string): Promise<void> {
  const task = await getTask(taskId);
  if (!task || !task.branch) {
    return;
  }

  try {
    const baseBranch = task.baseBranch || 'main';
    const branchStatus = await getBranchStatus(task.branch, baseBranch);
    await updateTask(taskId, { branchStatus });
    console.log(`[Workflow] Updated branch status for task ${taskId}: ${branchStatus}`);
  } catch (error) {
    console.error(`[Workflow] Failed to update branch status for task ${taskId}:`, error);
  }
}
