import { spawn, type ChildProcess } from 'node:child_process';
import type { WebSocket } from 'ws';
import { updateTaskStatus, getTask, loadBoard, saveBoard } from './store.js';
import { getWorkspaceSkillsPath, skillExists } from './skills.js';
import { getWorkspacePath, getAgentRunnerDir } from '../utils/paths.js';
import type { LogMessage, Task, WorkflowStep } from '../../types/index.js';
import path from 'node:path';

const WORKSPACE_PATH = process.env.WORKSPACE_PATH || './workspace';
const MAX_LOG_LINES = 50;
const AGENT_COMMAND = process.env.AGENT_COMMAND || 'claude';

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
 * Build the prompt for the brief step
 */
function buildBriefPrompt(task: Task): string {
  const docsPath = path.join(WORKSPACE_PATH, task.docsPath);

  return `You are generating a feature specification for a task.

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
 * Build the prompt for the plan step
 */
function buildPlanPrompt(task: Task): string {
  const docsPath = path.join(WORKSPACE_PATH, task.docsPath);

  return `You are generating implementation planning documents for a task.

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

Make the tasks specific and actionable based on the README.md specification.`;
}

/**
 * Build the prompt for the execute step
 */
function buildExecutePrompt(task: Task): string {
  const docsPath = path.join(WORKSPACE_PATH, task.docsPath);

  return `Task: ${task.title}

IMPORTANT: Before implementing, read the task documentation at ${docsPath}/:
- README.md: Feature specification
- PLAN.md: Implementation steps
- CHECKLIST.md: Quality gates

Context: ${task.context}

Follow the PLAN.md step by step. Update CHECKLIST.md as you complete items.`;
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
  const child = spawn(AGENT_COMMAND, [
    '--print',
    '--dangerously-skip-permissions',
    prompt
  ], {
    cwd: WORKSPACE_PATH,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logBuffer: string[] = [];

  child.on('error', async (err: NodeJS.ErrnoException) => {
    activeWorkflows.delete(taskId);

    let errorMessage = err.message;
    if (err.code === 'ENOENT') {
      errorMessage = `Command '${AGENT_COMMAND}' not found.`;
    }

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

    broadcastToTask(taskId, {
      type: 'stdout',
      data: `[${step.toUpperCase()}] ${text}`,
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

    broadcastToTask(taskId, {
      type: 'stderr',
      data: `[${step.toUpperCase()}] ${text}`,
      timestamp: new Date().toISOString(),
    });
  });

  child.on('close', async (code) => {
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

  // Build prompt based on step
  let prompt: string;
  let status: 'briefing' | 'planning' | 'running';

  switch (step) {
    case 'brief':
      prompt = buildBriefPrompt(task);
      status = 'briefing';
      break;
    case 'plan':
      prompt = buildPlanPrompt(task);
      status = 'planning';
      break;
    case 'execute':
      prompt = buildExecutePrompt(task);
      status = 'running';
      break;
  }

  // Update task status
  await updateTaskStatus(taskId, status, null);
  await updateWorkflowStep(taskId, step);

  return new Promise((resolve) => {
    const child = runWorkflowStep(taskId, step, prompt, async (success) => {
      activeWorkflows.delete(taskId);

      if (success) {
        // Update workflow step to next or complete
        const nextStep: WorkflowStep = step === 'brief' ? 'plan' : step === 'plan' ? 'execute' : 'complete';
        await updateWorkflowStep(taskId, step === 'execute' ? 'complete' : nextStep);

        // Return to todo for manual steps (except execute which goes to review)
        const newStatus = step === 'execute' ? 'review' : 'todo';
        await updateTaskStatus(taskId, newStatus, null);
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

    switch (step) {
      case 'brief':
        prompt = buildBriefPrompt(currentTask);
        status = 'briefing';
        break;
      case 'plan':
        prompt = buildPlanPrompt(currentTask);
        status = 'planning';
        break;
      case 'execute':
        prompt = buildExecutePrompt(currentTask);
        status = 'running';
        break;
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

    // Step 3: Execute
    const executeSuccess = await runStep('execute');
    activeWorkflows.delete(taskId);

    if (executeSuccess) {
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
