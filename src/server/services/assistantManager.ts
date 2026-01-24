import { spawn, type ChildProcess } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { WebSocket } from 'ws';
import type { AssistantSession, AssistantMessage } from '../../types/index.js';
import { getWorkspacePath, getFormicDir } from '../utils/paths.js';
import { loadBoard } from './store.js';

// Session state
let session: AssistantSession = {
  status: 'idle',
  pid: null,
  startedAt: null,
  lastError: null,
};

// Active process reference
let activeProcess: ChildProcess | null = null;

// WebSocket connections for the assistant
const assistantConnections = new Set<WebSocket>();

// Message history (kept in memory for session duration)
const messageHistory: AssistantMessage[] = [];
const MAX_HISTORY = 100;

/**
 * Register a WebSocket connection for assistant messages
 */
export function registerAssistantConnection(ws: WebSocket): void {
  assistantConnections.add(ws);
  console.log('[AssistantManager] Connection registered, total:', assistantConnections.size);
}

/**
 * Unregister a WebSocket connection
 */
export function unregisterAssistantConnection(ws: WebSocket): void {
  assistantConnections.delete(ws);
  console.log('[AssistantManager] Connection unregistered, total:', assistantConnections.size);
}

/**
 * Broadcast a message to all connected WebSocket clients
 */
function broadcastMessage(message: AssistantMessage): void {
  // Add to history
  messageHistory.push(message);
  while (messageHistory.length > MAX_HISTORY) {
    messageHistory.shift();
  }

  const data = JSON.stringify({ type: 'message', message });
  for (const ws of assistantConnections) {
    if (ws.readyState === 1) { // WebSocket.OPEN
      ws.send(data);
    }
  }
}

/**
 * Broadcast status update to all connected clients
 */
function broadcastStatus(): void {
  const data = JSON.stringify({ type: 'status', session });
  for (const ws of assistantConnections) {
    if (ws.readyState === 1) {
      ws.send(data);
    }
  }
}

/**
 * Get current session status
 */
export function getAssistantSession(): AssistantSession {
  return { ...session };
}

/**
 * Get message history
 */
export function getMessageHistory(): AssistantMessage[] {
  return [...messageHistory];
}

/**
 * Generate the context file (.formic/CLAUDE.md) with API docs and board state
 */
export async function generateContextFile(): Promise<string> {
  const formicDir = getFormicDir();
  const contextPath = path.join(formicDir, 'CLAUDE.md');

  // Ensure .formic directory exists
  if (!existsSync(formicDir)) {
    await mkdir(formicDir, { recursive: true });
  }

  // Load current board state
  const board = await loadBoard();

  // Build task summary
  const tasksByStatus: Record<string, string[]> = {
    todo: [],
    queued: [],
    briefing: [],
    planning: [],
    running: [],
    review: [],
    done: [],
  };

  for (const task of board.tasks) {
    const priorityLabel = task.priority === 'high' ? '!' : task.priority === 'low' ? '-' : '';
    tasksByStatus[task.status]?.push(`  - [${task.id}] ${priorityLabel}${task.title}`);
  }

  const taskSummary = Object.entries(tasksByStatus)
    .filter(([, tasks]) => tasks.length > 0)
    .map(([status, tasks]) => `### ${status.charAt(0).toUpperCase() + status.slice(1)}\n${tasks.join('\n')}`)
    .join('\n\n');

  const contextContent = `# Formic AI Assistant Context

You are an AI assistant integrated with Formic, a local-first agent orchestration platform. You can help users manage their kanban board, create tasks, and provide software development guidance.

## Current Board State

**Project:** ${board.meta.projectName}
**Repository:** ${board.meta.repoPath}

${taskSummary || 'No tasks on the board yet.'}

## Formic API Reference

All endpoints are available at \`http://localhost:8000\`.

### Board Operations

\`\`\`bash
# Get board state
curl http://localhost:8000/api/board

# Health check
curl http://localhost:8000/health
\`\`\`

### Task Operations

\`\`\`bash
# Create a new task
curl -X POST http://localhost:8000/api/tasks \\
  -H "Content-Type: application/json" \\
  -d '{"title": "Task title", "context": "Description", "priority": "medium"}'

# Queue a task (adds to automated queue)
curl -X POST http://localhost:8000/api/tasks/{taskId}/queue

# Run a task immediately (starts workflow: brief -> plan -> execute)
curl -X POST http://localhost:8000/api/tasks/{taskId}/run

# Stop a running task
curl -X POST http://localhost:8000/api/tasks/{taskId}/stop

# Update a task
curl -X PUT http://localhost:8000/api/tasks/{taskId} \\
  -H "Content-Type: application/json" \\
  -d '{"status": "done", "priority": "high"}'

# Delete a task
curl -X DELETE http://localhost:8000/api/tasks/{taskId}
\`\`\`

### Task Statuses

- **todo**: Not started
- **queued**: Waiting in priority queue for automated execution
- **briefing**: AI is generating the feature specification (README.md)
- **planning**: AI is creating the implementation plan (PLAN.md, subtasks.json)
- **running**: AI is executing the implementation
- **review**: Completed, awaiting human review
- **done**: Completed and approved

### Priority Levels

- **high**: Executed first in the queue
- **medium**: Default priority
- **low**: Executed last

## Best Practices

1. **Creating Tasks**: Provide clear, specific context describing what needs to be done
2. **Priority**: Use 'high' for urgent bugs or blockers, 'medium' for features, 'low' for nice-to-haves
3. **Task Size**: Keep tasks focused on a single feature or fix for better AI execution
4. **Review**: Always review AI-generated code before moving tasks to 'done'

## Commands You Can Help With

- Creating new tasks with appropriate priorities
- Explaining the current board state
- Suggesting how to break down large features into smaller tasks
- Answering questions about the Formic workflow
- Providing coding assistance and architecture advice
`;

  await writeFile(contextPath, contextContent, 'utf-8');
  console.log('[AssistantManager] Context file generated at:', contextPath);
  return contextPath;
}

/**
 * Send a user message to the Claude Code process
 */
export function sendUserMessage(content: string): boolean {
  if (!activeProcess || session.status !== 'running') {
    console.log('[AssistantManager] Cannot send message: assistant not running');
    return false;
  }

  // Add user message to history
  const userMessage: AssistantMessage = {
    type: 'user',
    content,
    timestamp: new Date().toISOString(),
  };
  broadcastMessage(userMessage);

  // Send to stdin
  if (activeProcess.stdin) {
    activeProcess.stdin.write(content + '\n');
    return true;
  }

  return false;
}

/**
 * Start the Claude Code assistant session
 */
export async function startAssistant(): Promise<AssistantSession> {
  if (session.status === 'running') {
    console.log('[AssistantManager] Assistant already running');
    return session;
  }

  try {
    // Generate context file first
    await generateContextFile();

    const workspacePath = getWorkspacePath();

    // Build the Claude Code command
    // Using interactive mode for back-and-forth conversation
    const command = 'claude';
    const args: string[] = [];

    console.log('[AssistantManager] Starting Claude Code in:', workspacePath);

    const child = spawn(command, args, {
      cwd: workspacePath,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
    });

    // Handle spawn error
    child.on('error', (err: NodeJS.ErrnoException) => {
      console.error('[AssistantManager] Spawn error:', err.message);
      session = {
        status: 'error',
        pid: null,
        startedAt: null,
        lastError: err.code === 'ENOENT'
          ? 'Claude Code CLI not found. Please install it with: npm install -g @anthropic-ai/claude-code'
          : err.message,
      };
      activeProcess = null;
      broadcastStatus();

      const errorMessage: AssistantMessage = {
        type: 'error',
        content: session.lastError || 'Unknown error',
        timestamp: new Date().toISOString(),
      };
      broadcastMessage(errorMessage);
    });

    if (!child.pid) {
      session = {
        status: 'error',
        pid: null,
        startedAt: null,
        lastError: 'Failed to spawn Claude Code process',
      };
      broadcastStatus();
      return session;
    }

    activeProcess = child;
    session = {
      status: 'running',
      pid: child.pid,
      startedAt: new Date().toISOString(),
      lastError: null,
    };

    // Handle stdout
    let outputBuffer = '';
    child.stdout?.on('data', (data: Buffer) => {
      outputBuffer += data.toString();

      // Split by newlines and process complete lines
      const lines = outputBuffer.split('\n');
      outputBuffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        if (line.trim()) {
          const message: AssistantMessage = {
            type: 'assistant',
            content: line,
            timestamp: new Date().toISOString(),
          };
          broadcastMessage(message);
        }
      }
    });

    // Handle stderr
    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      console.log('[AssistantManager] stderr:', text);

      // Only broadcast if it's meaningful output (not just progress indicators)
      if (text.trim() && !text.includes('⠋') && !text.includes('⠙')) {
        const message: AssistantMessage = {
          type: 'system',
          content: text,
          timestamp: new Date().toISOString(),
        };
        broadcastMessage(message);
      }
    });

    // Handle process exit
    child.on('close', (code) => {
      console.log('[AssistantManager] Process exited with code:', code);
      session = {
        status: 'idle',
        pid: null,
        startedAt: null,
        lastError: code !== 0 ? `Process exited with code ${code}` : null,
      };
      activeProcess = null;
      broadcastStatus();

      const message: AssistantMessage = {
        type: 'system',
        content: `Session ended (exit code: ${code})`,
        timestamp: new Date().toISOString(),
      };
      broadcastMessage(message);
    });

    broadcastStatus();

    // Send welcome message
    const welcomeMessage: AssistantMessage = {
      type: 'system',
      content: 'Claude Code assistant started. How can I help you?',
      timestamp: new Date().toISOString(),
    };
    broadcastMessage(welcomeMessage);

    console.log('[AssistantManager] Started with PID:', child.pid);
    return session;

  } catch (error) {
    const err = error as Error;
    console.error('[AssistantManager] Failed to start:', err.message);
    session = {
      status: 'error',
      pid: null,
      startedAt: null,
      lastError: err.message,
    };
    broadcastStatus();
    return session;
  }
}

/**
 * Stop the Claude Code assistant session
 */
export async function stopAssistant(): Promise<AssistantSession> {
  if (!activeProcess || session.status !== 'running') {
    console.log('[AssistantManager] No active session to stop');
    return session;
  }

  console.log('[AssistantManager] Stopping assistant...');

  // Try graceful termination first
  activeProcess.kill('SIGTERM');

  // Force kill after timeout
  setTimeout(() => {
    if (activeProcess) {
      console.log('[AssistantManager] Force killing process...');
      activeProcess.kill('SIGKILL');
    }
  }, 3000);

  return session;
}

/**
 * Restart the Claude Code assistant session
 */
export async function restartAssistant(): Promise<AssistantSession> {
  console.log('[AssistantManager] Restarting assistant...');

  // Stop if running
  if (session.status === 'running') {
    await stopAssistant();
    // Wait a bit for cleanup
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  // Clear message history on restart
  messageHistory.length = 0;

  // Start fresh
  return startAssistant();
}
