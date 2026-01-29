import { spawn, type ChildProcess } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { WebSocket } from 'ws';
import type { AssistantSession, AssistantMessage } from '../../types/index.js';
import { getWorkspacePath, getFormicDir } from '../utils/paths.js';
import { loadBoard } from './store.js';
import { broadcastBoardUpdate } from './boardNotifier.js';
import {
  getAgentCommand,
  getAgentType,
  getAgentDisplayName,
  buildAssistantArgs,
  supportsConversationContinue,
} from './agentAdapter.js';
import { parseAgentOutput, usesJsonOutput, cleanAgentOutput } from './outputParser.js';

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

// Pattern to detect task creation in assistant responses
// Supports both formats: with newline after task-create or directly after
// Global flag allows matching multiple task-create blocks
const TASK_CREATE_PATTERN = /```task-create\s*([\s\S]*?)\s*```/g;

// Get the server port for API calls
const getServerPort = () => parseInt(process.env.PORT || '8000', 10);

/**
 * Create a task via the Formic API
 */
async function createTaskViaAPI(taskData: { title: string; context: string; priority?: string }): Promise<{ success: boolean; taskId?: string; error?: string }> {
  try {
    const port = getServerPort();
    const response = await fetch(`http://localhost:${port}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(taskData),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[AssistantManager] Task creation failed:', errorText);
      return { success: false, error: errorText };
    }

    const result = await response.json() as { id: string };
    console.log('[AssistantManager] Task created:', result.id);
    return { success: true, taskId: result.id };
  } catch (error) {
    const err = error as Error;
    console.error('[AssistantManager] Task creation error:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Process assistant response content for task creation commands
 * Supports multiple task-create blocks in a single response
 */
async function processTaskCreation(content: string): Promise<void> {
  const matches = [...content.matchAll(TASK_CREATE_PATTERN)];
  if (matches.length === 0) return;

  console.log(`[AssistantManager] Found ${matches.length} task creation request(s)`);

  const results: Array<{ success: boolean; title: string; taskId?: string; error?: string }> = [];

  for (const match of matches) {
    try {
      const taskData = JSON.parse(match[1]) as { title: string; context: string; priority?: string };
      console.log('[AssistantManager] Creating task:', taskData.title);

      const result = await createTaskViaAPI(taskData);
      results.push({
        success: result.success,
        title: taskData.title,
        taskId: result.taskId,
        error: result.error,
      });
    } catch (error) {
      const err = error as Error;
      console.error('[AssistantManager] Failed to parse task data:', err.message);
      results.push({
        success: false,
        title: 'Unknown',
        error: `Parse error: ${err.message}`,
      });
    }
  }

  // Broadcast board update if any tasks were created
  if (results.some(r => r.success)) {
    broadcastBoardUpdate();
  }

  // Broadcast summary message
  const successCount = results.filter(r => r.success).length;
  const failCount = results.filter(r => !r.success).length;

  let summaryContent: string;
  if (results.length === 1) {
    // Single task - show detailed message
    const r = results[0];
    summaryContent = r.success
      ? `Task created: "${r.title}" [${r.taskId}]`
      : `Failed to create task: ${r.error}`;
  } else {
    // Multiple tasks - show summary
    const successList = results
      .filter(r => r.success)
      .map(r => `"${r.title}" [${r.taskId}]`)
      .join(', ');
    const failList = results
      .filter(r => !r.success)
      .map(r => `"${r.title}": ${r.error}`)
      .join('; ');

    if (failCount === 0) {
      summaryContent = `Created ${successCount} tasks: ${successList}`;
    } else if (successCount === 0) {
      summaryContent = `Failed to create ${failCount} task(s): ${failList}`;
    } else {
      summaryContent = `Created ${successCount} task(s): ${successList}. Failed: ${failList}`;
    }
  }

  const confirmMessage: AssistantMessage = {
    type: 'system',
    content: summaryContent,
    timestamp: new Date().toISOString(),
  };
  broadcastMessage(confirmMessage);
}

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
 * Get the context file name based on agent type
 * Claude uses CLAUDE.md, Copilot uses AGENTS.md
 */
function getContextFileName(): string {
  const agentType = getAgentType();
  switch (agentType) {
    case 'claude':
      return 'CLAUDE.md';
    case 'copilot':
      // GitHub Copilot CLI reads custom instructions from AGENTS.md
      return 'AGENTS.md';
    default:
      return 'CLAUDE.md';
  }
}

/**
 * Generate the context file with API docs and board state
 * File name depends on the configured agent type
 */
export async function generateContextFile(): Promise<string> {
  const workspacePath = getWorkspacePath();
  const contextFileName = getContextFileName();
  // Put context file at the workspace root so CLI reads it automatically
  const contextPath = path.join(workspacePath, contextFileName);

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

  const contextContent = `# Formic Task Manager Assistant

You are the **Formic Task Manager**, an AI assistant focused on helping users:
1. **Brainstorm** ideas for features, improvements, and fixes
2. **Analyze** the codebase (read-only) to understand context
3. **Create tasks** with well-crafted prompts for the Formic workflow

## Your Capabilities

### What You CAN Do:
- Read and explore files in the codebase
- Search for code patterns and understand architecture
- Discuss ideas and help refine requirements
- Create Formic tasks with optimized descriptions
- View the current board state and task queue

### What You CANNOT Do:
- Write, edit, or delete files
- Execute commands that modify the system
- Directly implement features (that's what tasks are for)

## Creating Tasks

When the user is ready to create a task, output it in this exact format:

\`\`\`task-create
{
  "title": "Short, action-oriented title",
  "context": "Detailed description with what needs to be done, why it's needed, technical considerations, and acceptance criteria",
  "priority": "medium"
}
\`\`\`

The server will automatically detect this format and create the task via the Formic API.

### Task Prompt Best Practices:
1. **Title**: Start with a verb (Add, Implement, Fix, Update, Refactor)
2. **Context**: Be specific about requirements, constraints, and expected outcomes. Include:
   - What needs to be done (clear requirements)
   - Why it's needed (motivation/problem being solved)
   - Technical considerations (files to modify, patterns to follow)
   - Acceptance criteria (how to verify it's done)
3. **Priority**: high (urgent/blocking), medium (normal), low (nice-to-have)

## Current Board State

**Project:** ${board.meta.projectName}
**Repository:** ${board.meta.repoPath}

${taskSummary || 'No tasks on the board yet.'}

## Formic Workflow

Tasks go through these stages:
- **todo**: Not started, waiting to be queued
- **queued**: In priority queue for automated execution
- **briefing**: AI is generating the feature specification (README.md)
- **planning**: AI is creating the implementation plan (PLAN.md, subtasks.json)
- **running**: AI is executing the implementation
- **review**: Completed, awaiting human review
- **done**: Completed and approved

## How to Work with Users

1. **Listen and Understand**: Ask clarifying questions to understand requirements
2. **Explore the Codebase**: Use your read-only tools to understand existing patterns
3. **Brainstorm Solutions**: Discuss approaches, trade-offs, and considerations
4. **Craft the Task**: When ready, create a well-structured task with clear context
5. **Iterate**: Refine the task description based on user feedback before finalizing

## Taking Screenshots (MCP Playwright)

When the user asks you to take a screenshot of a webpage, use the \`mcp__playwright__browser_take_screenshot\` tool.

### ⚠️ CRITICAL: You MUST Output the Screenshot Code Block

After taking a screenshot, you **MUST** output a screenshot code block. **DO NOT** describe the screenshot visually. The user cannot see images in your response - they need the code block to receive the actual image file.

**REQUIRED OUTPUT FORMAT** (use this EXACT format):

\`\`\`screenshot
{"url": "https://example.com", "path": "page-1234567890.png"}
\`\`\`

### Rules:
1. The \`url\` field = the URL of the page you captured
2. The \`path\` field = the **EXACT filename** from the tool result (e.g., \`page-1706540123456.png\`)
3. Look at the tool result message - it will say something like "Screenshot saved to page-XXXXX.png" - use that filename

### ❌ WRONG (DO NOT DO THIS):
- Describing what you see in the screenshot ("The page shows a login form with...")
- Using markdown image syntax: \`![Screenshot](url)\`
- Making up fake URLs: \`http://screenshot.png/\`
- Skipping the screenshot block entirely

### ✅ CORRECT:
\`\`\`screenshot
{"url": "https://gmail.com", "path": "page-1706540123456.png"}
\`\`\`

The server will automatically read this code block, load the image file, and send it to the user as an actual image attachment.

### Complete Example:
1. User asks: "Take a screenshot of google.com"
2. Navigate to https://google.com
3. Call \`mcp__playwright__browser_take_screenshot\`
4. Tool returns: "Screenshot saved to page-1706540123456.png"
5. **Your response MUST include:**
\`\`\`screenshot
{"url": "https://google.com", "path": "page-1706540123456.png"}
\`\`\`

**Remember: Without the screenshot code block, the user will NOT receive the image!**
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
 * Process a message by spawning the configured agent CLI
 */
function processMessage(content: string): void {
  isProcessing = true;

  const workspacePath = getWorkspacePath();
  const agentType = getAgentType();
  const agentCommand = getAgentCommand();
  const agentDisplayName = getAgentDisplayName();

  // Determine if we should use --continue based on agent support and message history
  const useContinue = !isFirstMessage && supportsConversationContinue();

  // Build agent-specific args using the adapter
  const args = buildAssistantArgs(content, { continue: useContinue });

  console.log('[AssistantManager] Processing message in:', workspacePath);
  console.log('[AssistantManager] Agent:', agentType, '| Command:', agentCommand);
  console.log('[AssistantManager] Args:', args.join(' ').substring(0, 100));

  const child = spawn(agentCommand, args, {
    cwd: workspacePath,
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Close stdin immediately - agents may wait for stdin to close before processing
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
        ? `${agentDisplayName} not found. Please install it.`
        : err.message,
      timestamp: new Date().toISOString(),
    };
    broadcastMessage(errorMessage);
  });

  // Handle stdout - parse output using agent-specific parser
  let outputBuffer = '';
  const isJsonOutput = usesJsonOutput(agentType);

  child.stdout?.on('data', (data: Buffer) => {
    const chunk = data.toString();
    console.log('[AssistantManager] STDOUT chunk received, length:', chunk.length);
    outputBuffer += chunk;

    // Split by newlines and process complete lines
    const lines = outputBuffer.split('\n');
    outputBuffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;

      // Use the agent-agnostic output parser
      const result = parseAgentOutput(line, agentType);

      if (result.type === 'text' && result.content) {
        streamingContent += result.content;
        broadcastStreamDelta(result.content);
      } else if (result.type === 'result') {
        // Final result
        const finalContent = streamingContent.trim() || result.content || '';

        if (finalContent) {
          const message: AssistantMessage = {
            type: 'assistant',
            content: finalContent,
            timestamp: new Date().toISOString(),
          };
          broadcastMessage(message);
          console.log('[AssistantManager] Response:', finalContent.substring(0, 100));

          // Check for task creation commands in the response
          processTaskCreation(finalContent).catch(err => {
            console.error('[AssistantManager] Task creation processing error:', err);
          });
        }
      } else if (result.type === 'system') {
        console.log('[AssistantManager] System event:', result.content);
      } else if (!isJsonOutput && result.type === 'unknown' && line.trim()) {
        // For non-JSON agents, treat unknown lines as potential text content
        streamingContent += line + '\n';
        broadcastStreamDelta(line + '\n');
      }
    }
  });

  // Handle stderr
  child.stderr?.on('data', (data: Buffer) => {
    const text = data.toString().trim();
    // Filter out spinner characters
    if (text && !text.includes('⠋') && !text.includes('⠙') && !text.includes('⠹')) {
      console.log('[AssistantManager] stderr:', text);
    }
  });

  // Handle process exit
  child.on('close', (code) => {
    console.log('[AssistantManager] Process exited with code:', code);
    isProcessing = false;

    // Only set isFirstMessage to false if agent supports continuation
    if (supportsConversationContinue()) {
      isFirstMessage = false;
    }

    // Flush any remaining content
    if (outputBuffer.trim()) {
      if (isJsonOutput) {
        // Try to parse remaining JSON
        const result = parseAgentOutput(outputBuffer, agentType);
        if (result.type === 'result' && result.content) {
          const content = streamingContent.trim() || result.content;
          if (content && !messageHistory.some(m => m.content === content && m.type === 'assistant')) {
            const message: AssistantMessage = {
              type: 'assistant',
              content,
              timestamp: new Date().toISOString(),
            };
            broadcastMessage(message);

            processTaskCreation(content).catch(err => {
              console.error('[AssistantManager] Task creation processing error:', err);
            });
          }
        }
      } else {
        // For non-JSON output, treat remaining buffer as text
        streamingContent += outputBuffer;
      }
    }

    // For non-JSON agents, broadcast the final accumulated content
    if (!isJsonOutput && streamingContent.trim()) {
      // Clean up function call XML blocks that may appear in Copilot output
      const finalContent = cleanAgentOutput(streamingContent);
      if (finalContent && !messageHistory.some(m => m.content === finalContent && m.type === 'assistant')) {
        const message: AssistantMessage = {
          type: 'assistant',
          content: finalContent,
          timestamp: new Date().toISOString(),
        };
        broadcastMessage(message);

        processTaskCreation(finalContent).catch(err => {
          console.error('[AssistantManager] Task creation processing error:', err);
        });
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

    // Send welcome message with agent info
    const agentDisplayName = getAgentDisplayName();
    const welcomeMessage: AssistantMessage = {
      type: 'system',
      content: `Formic Task Manager ready (using ${agentDisplayName}). I can help you brainstorm ideas, explore the codebase, and create well-crafted tasks.`,
      timestamp: new Date().toISOString(),
    };
    broadcastMessage(welcomeMessage);

    console.log('[AssistantManager] Session started with agent:', getAgentType());
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
