import type {
  MessagingPlatform,
  MessagingCommand,
  IncomingMessage,
  OutgoingMessage,
  SendMessageResult,
  MessagingConfig,
  Task,
  MediaAttachment,
} from '../../types/index.js';
import { loadBoard, createTask, getTask, queueTask } from './store.js';
import {
  getSession,
  upsertSession,
  touchSession,
  getSessionAI,
  setAIModeEnabled,
  clearConversationHistory,
} from './messagingStore.js';
import { getWorkspacePath } from '../utils/paths.js';
import { broadcastBoardUpdate } from './boardNotifier.js';
import {
  processAIMessage,
  isClaudeCLIAvailable,
  resetConversationState,
} from './messagingAI.js';
import { getAgentDisplayName } from './agentAdapter.js';
import {
  takeScreenshotWithMCP as captureScreenshot,
  isPlaywrightAvailable,
} from './mcpScreenshot.js';

/**
 * Messaging Adapter Service
 *
 * Provides platform-agnostic message handling, command parsing, and response generation.
 * Platform-specific adapters (Telegram, Line) use these functions for consistent behavior.
 */

/**
 * Get messaging configuration from environment variables
 */
export function getMessagingConfig(): MessagingConfig {
  return {
    telegram: {
      enabled: !!process.env.TELEGRAM_BOT_TOKEN,
      botToken: process.env.TELEGRAM_BOT_TOKEN,
    },
    line: {
      enabled: !!(process.env.LINE_CHANNEL_ACCESS_TOKEN && process.env.LINE_CHANNEL_SECRET),
      channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
      channelSecret: process.env.LINE_CHANNEL_SECRET,
    },
  };
}

/**
 * Parse a message text into a command (if it starts with /)
 */
export function parseCommand(text: string): MessagingCommand | null {
  const trimmed = text.trim();

  // Check if it starts with a command
  if (!trimmed.startsWith('/')) {
    return null;
  }

  // Parse command and arguments
  const parts = trimmed.slice(1).split(/\s+/);
  const name = parts[0].toLowerCase();
  const args = parts.slice(1);

  return {
    name,
    args,
    rawText: trimmed,
  };
}

/**
 * Format a task for display in messaging apps
 */
function formatTaskForMessage(task: Task, includeContext: boolean = false): string {
  const priorityEmoji = task.priority === 'high' ? '🔴' : task.priority === 'medium' ? '🟡' : '🟢';
  const statusEmoji = getStatusEmoji(task.status);

  let message = `${statusEmoji} *[${task.id}]* ${task.title}\n`;
  message += `   Priority: ${priorityEmoji} ${task.priority}\n`;
  message += `   Status: ${task.status}`;

  if (task.workflowStep && task.workflowStep !== 'pending') {
    message += ` (${task.workflowStep})`;
  }

  if (includeContext && task.context) {
    const truncatedContext = task.context.length > 200
      ? task.context.slice(0, 200) + '...'
      : task.context;
    message += `\n\n${truncatedContext}`;
  }

  return message;
}

/**
 * Get emoji for task status
 */
function getStatusEmoji(status: Task['status']): string {
  const emojis: Record<Task['status'], string> = {
    todo: '📋',
    queued: '⏳',
    briefing: '📝',
    planning: '🗺️',
    declaring: '📂',
    running: '🚀',
    architecting: '🏗️',
    review: '👀',
    done: '✅',
  };
  return emojis[status] || '📋';
}

/**
 * Handle the /start command - Welcome and link chat to workspace
 */
export async function handleStartCommand(
  message: IncomingMessage
): Promise<OutgoingMessage> {
  const workspacePath = getWorkspacePath();

  // Create or update session
  await upsertSession(
    message.platform,
    message.chatId,
    message.userId,
    workspacePath,
    message.userName
  );

  const board = await loadBoard();
  const projectName = board.meta.projectName;

  const welcomeText = `🚀 *Welcome to Formic Task Manager!*

This chat is now linked to:
📁 *Project:* ${projectName}
📂 *Workspace:* ${workspacePath}

*Available Commands:*
/board - View all tasks
/status [task-id] - View task details
/run [task-id] - Queue task for execution
/help - Show this help message

*Quick Create:*
Send any message without a command to create a new task!

Example: "Add dark mode to settings page"`;

  return {
    chatId: message.chatId,
    text: welcomeText,
    parseMode: 'markdown',
  };
}

/**
 * Handle the /help command
 */
export async function handleHelpCommand(
  message: IncomingMessage
): Promise<OutgoingMessage> {
  const helpText = `📚 *Formic Bot Commands*

*Task Management:*
/board - View all tasks organized by status
/status [task-id] - Get detailed task information
/run [task-id] - Queue a task for execution

*AI Assistant:*
/ai on - Enable AI-powered conversations
/ai off - Disable AI mode (simple task creation)
/ai clear - Clear conversation history

*Screenshot:*
/screenshot [url] - Capture a screenshot of a web page

*Quick Actions:*
/start - Link this chat to current workspace

*Task Creation:*
• With AI off: Messages become tasks directly
• With AI on: Chat with AI to brainstorm and create refined tasks

Example: "Fix login button alignment"

*Notifications:*
You'll receive notifications when:
✅ Tasks complete successfully
❌ Tasks fail
👀 Tasks are ready for review`;

  return {
    chatId: message.chatId,
    text: helpText,
    parseMode: 'markdown',
  };
}

/**
 * Handle the /ai command - Toggle AI mode on/off or clear history
 */
export async function handleAIToggleCommand(
  message: IncomingMessage,
  args: string[]
): Promise<OutgoingMessage> {
  await touchSession(message.platform, message.chatId);

  const session = await getSession(message.platform, message.chatId);
  if (!session) {
    return {
      chatId: message.chatId,
      text: '👋 Please use /start first to link this chat to a workspace.',
      parseMode: 'markdown',
    };
  }

  const action = args[0]?.toLowerCase();

  if (action === 'on') {
    // Check if Claude CLI is available
    const cliAvailable = await isClaudeCLIAvailable();
    if (!cliAvailable) {
      const agentName = getAgentDisplayName();
      return {
        chatId: message.chatId,
        text: `❌ ${agentName} is not available.\n\nPlease ensure the CLI is installed and accessible.`,
        parseMode: 'markdown',
      };
    }

    await setAIModeEnabled(message.platform, message.chatId, true);
    const agentName = getAgentDisplayName();

    return {
      chatId: message.chatId,
      text: `🤖 *AI Mode Enabled!*

I'm now powered by ${agentName}. You can:
• Ask questions about features and requirements
• Brainstorm ideas for implementation
• Get AI-assisted task creation

Send any message to start a conversation.
Use /ai off to switch back to simple task creation.`,
      parseMode: 'markdown',
    };
  }

  if (action === 'off') {
    await setAIModeEnabled(message.platform, message.chatId, false);

    return {
      chatId: message.chatId,
      text: `📝 *AI Mode Disabled*

Switched to simple task creation mode.
Your messages will now be directly converted to tasks.

Use /ai on to re-enable AI conversations.`,
      parseMode: 'markdown',
    };
  }

  if (action === 'clear') {
    await clearConversationHistory(message.platform, message.chatId);
    resetConversationState(message.platform, message.chatId);

    return {
      chatId: message.chatId,
      text: `🗑️ *Conversation Cleared*

AI conversation history has been cleared.
Start fresh with a new topic!`,
      parseMode: 'markdown',
    };
  }

  // Show current status if no argument
  const sessionAI = await getSessionAI(message.platform, message.chatId);
  const aiEnabled = sessionAI?.aiEnabled ?? false;
  const status = aiEnabled ? '🟢 Enabled' : '⚪ Disabled';

  return {
    chatId: message.chatId,
    text: `🤖 *AI Mode Status:* ${status}

*Commands:*
/ai on - Enable AI-powered conversations
/ai off - Disable AI mode
/ai clear - Clear conversation history`,
    parseMode: 'markdown',
  };
}

/**
 * Handle the /board command - Show all tasks
 */
export async function handleBoardCommand(
  message: IncomingMessage
): Promise<OutgoingMessage> {
  await touchSession(message.platform, message.chatId);

  const board = await loadBoard();
  const projectName = board.meta.projectName;

  if (board.tasks.length === 0) {
    return {
      chatId: message.chatId,
      text: `📋 *${projectName} Board*\n\nNo tasks yet! Send a message to create one.`,
      parseMode: 'markdown',
    };
  }

  // Group tasks by status
  const statusOrder: Task['status'][] = ['running', 'briefing', 'planning', 'queued', 'todo', 'review', 'done'];
  const groupedTasks: Record<string, Task[]> = {};

  for (const status of statusOrder) {
    const tasks = board.tasks.filter((t) => t.status === status);
    if (tasks.length > 0) {
      groupedTasks[status] = tasks;
    }
  }

  let response = `📋 *${projectName} Board*\n\n`;

  for (const [status, tasks] of Object.entries(groupedTasks)) {
    const emoji = getStatusEmoji(status as Task['status']);
    response += `*${emoji} ${status.toUpperCase()}* (${tasks.length})\n`;

    for (const task of tasks.slice(0, 5)) { // Limit to 5 per section
      const priorityEmoji = task.priority === 'high' ? '🔴' : task.priority === 'medium' ? '🟡' : '🟢';
      response += `  ${priorityEmoji} [${task.id}] ${task.title}\n`;
    }

    if (tasks.length > 5) {
      response += `  _...and ${tasks.length - 5} more_\n`;
    }

    response += '\n';
  }

  response += `_Use /status [task-id] for details_`;

  return {
    chatId: message.chatId,
    text: response,
    parseMode: 'markdown',
  };
}

/**
 * Handle the /status command - Show task details
 */
export async function handleStatusCommand(
  message: IncomingMessage,
  args: string[]
): Promise<OutgoingMessage> {
  await touchSession(message.platform, message.chatId);

  if (args.length === 0) {
    return {
      chatId: message.chatId,
      text: '❌ Please provide a task ID.\n\nUsage: `/status t-15`',
      parseMode: 'markdown',
    };
  }

  const taskId = args[0].toLowerCase();
  const task = await getTask(taskId);

  if (!task) {
    return {
      chatId: message.chatId,
      text: `❌ Task *${taskId}* not found.\n\nUse /board to see all tasks.`,
      parseMode: 'markdown',
    };
  }

  const taskDetails = formatTaskForMessage(task, true);

  // Add action buttons based on status
  const buttons = [];
  if (task.status === 'todo') {
    buttons.push({ label: '▶️ Run', data: `run:${task.id}`, type: 'callback' as const });
  }

  return {
    chatId: message.chatId,
    text: taskDetails,
    parseMode: 'markdown',
    buttons: buttons.length > 0 ? buttons : undefined,
  };
}

/**
 * Handle the /run command - Queue a task for execution
 */
export async function handleRunCommand(
  message: IncomingMessage,
  args: string[]
): Promise<OutgoingMessage> {
  await touchSession(message.platform, message.chatId);

  if (args.length === 0) {
    return {
      chatId: message.chatId,
      text: '❌ Please provide a task ID.\n\nUsage: `/run t-15`',
      parseMode: 'markdown',
    };
  }

  const taskId = args[0].toLowerCase();
  const task = await getTask(taskId);

  if (!task) {
    return {
      chatId: message.chatId,
      text: `❌ Task *${taskId}* not found.\n\nUse /board to see all tasks.`,
      parseMode: 'markdown',
    };
  }

  if (task.status !== 'todo') {
    return {
      chatId: message.chatId,
      text: `❌ Task *${taskId}* is currently *${task.status}*.\n\nOnly tasks in 'todo' status can be queued.`,
      parseMode: 'markdown',
    };
  }

  const queuedTask = await queueTask(taskId);

  if (!queuedTask) {
    return {
      chatId: message.chatId,
      text: `❌ Failed to queue task *${taskId}*.`,
      parseMode: 'markdown',
    };
  }

  // Broadcast board update
  broadcastBoardUpdate();

  return {
    chatId: message.chatId,
    text: `✅ Task *${taskId}* queued for execution!\n\n*${task.title}*\n\nI'll notify you when it completes.`,
    parseMode: 'markdown',
  };
}

/**
 * Check if Playwright is available for screenshot capture
 * This checks if Playwright is installed and can be used
 */
async function isPlaywrightMCPAvailable(): Promise<boolean> {
  return isPlaywrightAvailable();
}

/**
 * Take a screenshot using Playwright
 * Returns the screenshot as a base64-encoded buffer
 */
async function takeScreenshotWithMCP(url: string): Promise<{ success: boolean; data?: string; source?: 'url' | 'buffer'; error?: string }> {
  console.log(`[MessagingAdapter] Initiating screenshot capture for: ${url}`);
  const result = await captureScreenshot(url);

  if (result.success) {
    return {
      success: true,
      data: result.data,
      source: result.source,
    };
  }

  return {
    success: false,
    error: result.error || 'Screenshot capture failed',
  };
}

/**
 * Handle the /screenshot command - Take a screenshot of a URL
 * Usage: /screenshot <url>
 */
export async function handleScreenshotCommand(
  message: IncomingMessage,
  args: string[]
): Promise<OutgoingMessage> {
  await touchSession(message.platform, message.chatId);

  // Validate URL argument
  if (args.length === 0) {
    return {
      chatId: message.chatId,
      text: `📸 *Screenshot Command*

Usage: \`/screenshot <url>\`

Example: \`/screenshot https://example.com\`

This command captures a screenshot of the specified web page and sends it to you.

*Note:* Requires Playwright to be installed on the server. LINE users will receive a message instead of the image (LINE requires HTTPS URLs for images).`,
      parseMode: 'markdown',
    };
  }

  let targetUrl = args[0];

  // Basic URL validation
  if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
    targetUrl = 'https://' + targetUrl;
  }

  try {
    new URL(targetUrl);
  } catch {
    return {
      chatId: message.chatId,
      text: `❌ Invalid URL: ${args[0]}\n\nPlease provide a valid URL starting with http:// or https://`,
      parseMode: 'markdown',
    };
  }

  // Check Playwright availability
  const playwrightAvailable = await isPlaywrightMCPAvailable();
  if (!playwrightAvailable) {
    return {
      chatId: message.chatId,
      text: `❌ *Screenshot Not Available*

Playwright is not installed on the server.

*To enable screenshots:*
1. Install Playwright: \`npm install playwright\`
2. Install browser: \`npx playwright install chromium\`

*Alternative:*
Enable AI mode with \`/ai on\` and ask the AI to take a screenshot.`,
      parseMode: 'markdown',
    };
  }

  // Attempt to take screenshot
  const result = await takeScreenshotWithMCP(targetUrl);

  if (!result.success) {
    return {
      chatId: message.chatId,
      text: `❌ *Screenshot Failed*

${result.error || 'Unknown error occurred'}

*Troubleshooting:*
• Ensure the URL is accessible
• Check that Playwright browsers are installed: \`npx playwright install chromium\``,
      parseMode: 'markdown',
    };
  }

  // Construct response with screenshot
  const media: MediaAttachment = {
    type: 'photo',
    source: result.source || 'buffer',
    data: result.data || '',
    caption: `Screenshot of ${targetUrl}`,
  };

  // For LINE, if source is buffer, we can't send it directly
  if (message.platform === 'line' && media.source !== 'url') {
    return {
      chatId: message.chatId,
      text: `⚠️ *Screenshot Captured*

LINE requires images to be hosted on public HTTPS URLs.
The screenshot was captured but cannot be sent directly.

*Tip:* Enable AI mode with \`/ai on\` and ask the AI to take a screenshot - it may have access to image hosting.`,
      parseMode: 'markdown',
    };
  }

  return {
    chatId: message.chatId,
    text: `📸 Screenshot of ${targetUrl}`,
    parseMode: 'markdown',
    media,
  };
}

/**
 * Handle natural language task creation (messages without commands)
 */
export async function handleTaskCreation(
  message: IncomingMessage
): Promise<OutgoingMessage> {
  const session = await getSession(message.platform, message.chatId);

  if (!session) {
    return {
      chatId: message.chatId,
      text: '👋 Please use /start first to link this chat to a workspace.',
      parseMode: 'markdown',
    };
  }

  await touchSession(message.platform, message.chatId);

  const text = message.text.trim();

  // Validate message length
  if (text.length < 5) {
    return {
      chatId: message.chatId,
      text: '❌ Task description too short. Please provide more details.',
      parseMode: 'markdown',
    };
  }

  if (text.length > 500) {
    return {
      chatId: message.chatId,
      text: '❌ Task description too long. Please keep it under 500 characters.',
      parseMode: 'markdown',
    };
  }

  // Create task with message as both title and context
  // Truncate title if too long
  const title = text.length > 100 ? text.slice(0, 97) + '...' : text;
  const context = text;

  try {
    const task = await createTask({
      title,
      context,
      priority: 'medium',
    });

    // Broadcast board update
    broadcastBoardUpdate();

    return {
      chatId: message.chatId,
      text: `✅ *Task Created!*\n\n*[${task.id}]* ${task.title}\n\nUse /run ${task.id} to queue it for execution.`,
      parseMode: 'markdown',
      buttons: [
        { label: '▶️ Run Now', data: `run:${task.id}`, type: 'callback' },
        { label: '📋 View Board', data: 'board', type: 'callback' },
      ],
    };
  } catch (error) {
    const err = error as Error;
    console.error('[MessagingAdapter] Failed to create task:', err.message);
    return {
      chatId: message.chatId,
      text: '❌ Failed to create task. Please try again.',
      parseMode: 'markdown',
    };
  }
}

/**
 * Handle callback query (button press)
 */
export async function handleCallback(
  platform: MessagingPlatform,
  chatId: string,
  userId: string,
  data: string
): Promise<OutgoingMessage | null> {
  // Parse callback data
  if (data === 'board') {
    return handleBoardCommand({
      platform,
      chatId,
      userId,
      text: '/board',
      messageId: '',
      timestamp: new Date().toISOString(),
    });
  }

  if (data.startsWith('run:')) {
    const taskId = data.slice(4);
    return handleRunCommand(
      {
        platform,
        chatId,
        userId,
        text: `/run ${taskId}`,
        messageId: '',
        timestamp: new Date().toISOString(),
      },
      [taskId]
    );
  }

  if (data.startsWith('status:')) {
    const taskId = data.slice(7);
    return handleStatusCommand(
      {
        platform,
        chatId,
        userId,
        text: `/status ${taskId}`,
        messageId: '',
        timestamp: new Date().toISOString(),
      },
      [taskId]
    );
  }

  return null;
}

/**
 * Route an incoming message to the appropriate handler
 */
export async function handleIncomingMessage(
  message: IncomingMessage
): Promise<OutgoingMessage> {
  const command = parseCommand(message.text);

  if (command) {
    switch (command.name) {
      case 'start':
        return handleStartCommand(message);
      case 'help':
        return handleHelpCommand(message);
      case 'board':
        return handleBoardCommand(message);
      case 'status':
        return handleStatusCommand(message, command.args);
      case 'run':
        return handleRunCommand(message, command.args);
      case 'ai':
        return handleAIToggleCommand(message, command.args);
      case 'screenshot':
        return handleScreenshotCommand(message, command.args);
      default:
        return {
          chatId: message.chatId,
          text: `❓ Unknown command: /${command.name}\n\nUse /help to see available commands.`,
          parseMode: 'markdown',
        };
    }
  }

  // No command - check if AI mode is enabled
  const sessionAI = await getSessionAI(message.platform, message.chatId);
  if (sessionAI?.aiEnabled) {
    // Route to AI processing
    return processAIMessage(message);
  }

  // AI mode disabled - treat as simple task creation
  return handleTaskCreation(message);
}

/**
 * Handle message with AI processing (for async webhook handling)
 * Returns null if AI mode is not enabled, otherwise processes through AI
 */
export async function handleMessageWithAI(
  message: IncomingMessage
): Promise<OutgoingMessage | null> {
  const sessionAI = await getSessionAI(message.platform, message.chatId);
  if (!sessionAI?.aiEnabled) {
    return null;
  }
  return processAIMessage(message);
}

/**
 * Format a notification message for task status change
 */
export function formatTaskNotification(
  task: Task,
  event: 'completed' | 'failed' | 'review'
): OutgoingMessage {
  const chatId = ''; // Will be filled by the notifier

  let emoji: string;
  let title: string;
  let details: string;

  switch (event) {
    case 'completed':
      emoji = '✅';
      title = 'Task Completed';
      details = 'The task has been successfully completed!';
      break;
    case 'failed':
      emoji = '❌';
      title = 'Task Failed';
      details = 'The task encountered an error and was moved to review.';
      break;
    case 'review':
      emoji = '👀';
      title = 'Ready for Review';
      details = 'The task is ready for your review.';
      break;
  }

  const text = `${emoji} *${title}*\n\n*[${task.id}]* ${task.title}\n\n${details}`;

  return {
    chatId,
    text,
    parseMode: 'markdown',
    buttons: [
      { label: '📋 View Details', data: `status:${task.id}`, type: 'callback' },
    ],
  };
}
