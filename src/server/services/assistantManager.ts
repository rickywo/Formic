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

// Track if a message is currently being processed
let isProcessing = false;

// WebSocket connections for the assistant
const assistantConnections = new Set<WebSocket>();

// Message history (kept in memory for session duration)
const messageHistory: AssistantMessage[] = [];
const MAX_HISTORY = 100;

// Flag to track if this is the first message (don't use --continue)
let isFirstMessage = true;

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
 * Broadcast streaming content delta to all connected clients
 */
function broadcastStreamDelta(delta: string): void {
  const data = JSON.stringify({ type: 'stream_delta', delta });
  for (const ws of assistantConnections) {
    if (ws.readyState === 1) {
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
 * Send a user message - spawns a Claude process for this message
 */
export function sendUserMessage(content: string): boolean {
  if (session.status !== 'running') {
    console.log('[AssistantManager] Cannot send message: assistant not running');
    return false;
  }

  if (isProcessing) {
    console.log('[AssistantManager] Cannot send message: already processing');
    return false;
  }

  // Add user message to history
  const userMessage: AssistantMessage = {
    type: 'user',
    content,
    timestamp: new Date().toISOString(),
  };
  broadcastMessage(userMessage);

  // Spawn Claude process for this message
  processMessage(content);
  return true;
}

/**
 * Process a message by spawning Claude
 */
function processMessage(content: string): void {
  isProcessing = true;

  const workspacePath = getWorkspacePath();

  // Build command args
  const args = [
    '--print',                          // Non-interactive print mode
    '--output-format', 'stream-json',   // Stream JSON output
    '--verbose',                        // Required for stream-json
    '--dangerously-skip-permissions',   // Required for non-interactive mode
  ];

  // Use --continue for subsequent messages to maintain conversation context
  if (!isFirstMessage) {
    args.push('--continue');
  }

  // Add the prompt
  args.push(content);

  console.log('[AssistantManager] Processing message in:', workspacePath);
  console.log('[AssistantManager] Args:', args.join(' ').substring(0, 100));

  console.log('[AssistantManager] Spawning claude with cwd:', workspacePath);

  const child = spawn('claude', args, {
    cwd: workspacePath,
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Close stdin immediately - Claude waits for stdin to close before processing
  child.stdin?.end();

  console.log('[AssistantManager] Spawned with PID:', child.pid);

  // Track streaming content
  let streamingContent = '';

  // Handle spawn error
  child.on('error', (err: NodeJS.ErrnoException) => {
    console.error('[AssistantManager] Spawn error:', err.message);
    isProcessing = false;

    const errorMessage: AssistantMessage = {
      type: 'error',
      content: err.code === 'ENOENT'
        ? 'Claude Code CLI not found. Please install it.'
        : err.message,
      timestamp: new Date().toISOString(),
    };
    broadcastMessage(errorMessage);
  });

  // Handle stdout - parse stream-json events
  let outputBuffer = '';
  child.stdout?.on('data', (data: Buffer) => {
    const chunk = data.toString();
    console.log('[AssistantManager] STDOUT chunk received, length:', chunk.length);
    outputBuffer += chunk;

    // Split by newlines and process complete lines
    const lines = outputBuffer.split('\n');
    outputBuffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const event = JSON.parse(line);
        const eventType = event.type as string;

        if (eventType === 'assistant') {
          // Extract text from assistant message
          const msg = event.message as {
            content?: Array<{ type: string; text?: string }>;
          } | undefined;

          if (msg?.content) {
            for (const block of msg.content) {
              if (block.type === 'text' && block.text) {
                streamingContent += block.text;
                broadcastStreamDelta(block.text);
              }
            }
          }
        } else if (eventType === 'result') {
          // Final result
          const result = event.result as string | undefined;
          const finalContent = streamingContent.trim() || result || '';

          if (finalContent) {
            const message: AssistantMessage = {
              type: 'assistant',
              content: finalContent,
              timestamp: new Date().toISOString(),
            };
            broadcastMessage(message);
            console.log('[AssistantManager] Response:', finalContent.substring(0, 100));
          }
        } else if (eventType === 'system') {
          // Session init event
          console.log('[AssistantManager] System event:', event.subtype);
        }
      } catch {
        // Non-JSON output
        console.log('[AssistantManager] Non-JSON:', line.substring(0, 100));
      }
    }
  });

  // Handle stderr
  child.stderr?.on('data', (data: Buffer) => {
    const text = data.toString().trim();
    if (text && !text.includes('⠋') && !text.includes('⠙') && !text.includes('⠹')) {
      console.log('[AssistantManager] stderr:', text);
    }
  });

  // Handle process exit
  child.on('close', (code) => {
    console.log('[AssistantManager] Process exited with code:', code);
    isProcessing = false;
    isFirstMessage = false;  // Next message should use --continue

    // Flush any remaining content
    if (outputBuffer.trim()) {
      try {
        const event = JSON.parse(outputBuffer);
        if (event.type === 'result' && event.result) {
          const content = streamingContent.trim() || event.result;
          if (content && !messageHistory.some(m => m.content === content && m.type === 'assistant')) {
            const message: AssistantMessage = {
              type: 'assistant',
              content,
              timestamp: new Date().toISOString(),
            };
            broadcastMessage(message);
          }
        }
      } catch {
        // Ignore
      }
    }

    if (code !== 0 && code !== null) {
      const errorMessage: AssistantMessage = {
        type: 'system',
        content: `Process exited with code ${code}`,
        timestamp: new Date().toISOString(),
      };
      broadcastMessage(errorMessage);
    }
  });
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
    // Generate context file
    await generateContextFile();

    // Set session as running (we spawn processes per message)
    session = {
      status: 'running',
      pid: null,  // No persistent process
      startedAt: new Date().toISOString(),
      lastError: null,
    };

    isFirstMessage = true;  // Reset for new session
    isProcessing = false;

    broadcastStatus();

    // Send welcome message
    const welcomeMessage: AssistantMessage = {
      type: 'system',
      content: 'Claude Code assistant ready. Type your message below.',
      timestamp: new Date().toISOString(),
    };
    broadcastMessage(welcomeMessage);

    console.log('[AssistantManager] Session started');
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
  if (session.status !== 'running') {
    console.log('[AssistantManager] No active session to stop');
    return session;
  }

  console.log('[AssistantManager] Stopping assistant...');

  session = {
    status: 'idle',
    pid: null,
    startedAt: null,
    lastError: null,
  };

  isProcessing = false;
  broadcastStatus();

  const message: AssistantMessage = {
    type: 'system',
    content: 'Session ended',
    timestamp: new Date().toISOString(),
  };
  broadcastMessage(message);

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
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  // Clear message history on restart
  messageHistory.length = 0;
  isFirstMessage = true;
  isProcessing = false;

  // Start fresh
  return startAssistant();
}
