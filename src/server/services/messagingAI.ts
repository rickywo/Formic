import { spawn } from 'node:child_process';
import { readFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import type {
  MessagingPlatform,
  IncomingMessage,
  OutgoingMessage,
  AIConversationMessage,
  MediaAttachment,
} from '../../types/index.js';
import {
  getSessionAI,
  appendConversationMessage,
  getConversationHistory,
} from './messagingStore.js';
import { getWorkspacePath } from '../utils/paths.js';
import { generateContextFile } from './assistantManager.js';
import { broadcastBoardUpdate } from './boardNotifier.js';
import {
  getAgentCommand,
  getAgentType,
  getAgentDisplayName,
  buildMessagingAssistantArgs,
  supportsConversationContinue,
} from './agentAdapter.js';
import { parseAgentOutput, usesJsonOutput, cleanAgentOutput } from './outputParser.js';
import {
  takeScreenshotWithMCP,
  isPlaywrightAvailable,
} from './mcpScreenshot.js';

/**
 * Messaging AI Service
 *
 * Provides AI-powered conversations for messaging platforms (Telegram, Line).
 * Spawns Claude CLI to process messages and parse responses for task creation.
 */

// Pattern to detect task creation in AI responses (same as assistantManager.ts)
const TASK_CREATE_PATTERN = /```task-create\s*([\s\S]*?)\s*```/g;

// Pattern to detect screenshot code blocks in AI responses
// Expected format: ```screenshot\n{"url": "...", "path": "/path/to/screenshot.png"}\n```
const SCREENSHOT_BLOCK_PATTERN = /```screenshot\s*([\s\S]*?)\s*```/g;

// Fallback pattern to detect malformed markdown image syntax from AI
// Example: ![Gmail Sign-in Page](http://gmail-login-page.png/) or ![Screenshot](page-123.png)
const MARKDOWN_IMAGE_PATTERN = /!\[([^\]]*)\]\(([^)]+)\)/g;

// Pattern to detect screenshot intent in user messages
// Matches messages containing screenshot/capture/snap keywords combined with a URL
const SCREENSHOT_KEYWORD_PATTERN = /\b(screenshot|capture|snap|screencap)\b/i;
const URL_EXTRACTION_PATTERN = /(?:https?:\/\/[^\s]+|(?:www\.)[^\s]+|[a-zA-Z0-9][-a-zA-Z0-9]*\.[a-zA-Z]{2,}(?:\/[^\s]*)?)/i;

/**
 * Detect if a user message is requesting a screenshot and extract the target URL
 * Returns the URL if screenshot intent is detected, null otherwise
 */
function detectScreenshotIntent(text: string): string | null {
  const hasScreenshotKeyword = SCREENSHOT_KEYWORD_PATTERN.test(text);
  if (!hasScreenshotKeyword) {
    return null;
  }

  const urlMatch = text.match(URL_EXTRACTION_PATTERN);
  if (!urlMatch) {
    return null;
  }

  let url = urlMatch[0];
  // Normalize URL — add https:// if no protocol
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }

  console.log('[MessagingAI] Screenshot intent detected, URL:', url);
  return url;
}

// Get the server port for API calls
const getServerPort = () => parseInt(process.env.PORT || '8000', 10);

// Track if a conversation has had previous messages (for --continue flag)
const conversationStarted = new Map<string, boolean>();

/**
 * Check if Claude CLI is available in the system
 */
export async function isClaudeCLIAvailable(): Promise<boolean> {
  const agentCommand = getAgentCommand();

  return new Promise((resolve) => {
    const child = spawn(agentCommand, ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.on('error', () => {
      resolve(false);
    });

    child.on('close', (code) => {
      resolve(code === 0);
    });

    // Timeout after 5 seconds
    setTimeout(() => {
      child.kill();
      resolve(false);
    }, 5000);
  });
}

/**
 * Create a task via the Formic API
 */
async function createTaskViaAPI(taskData: {
  title: string;
  context: string;
  priority?: string;
}): Promise<{ success: boolean; taskId?: string; error?: string }> {
  try {
    const port = getServerPort();
    const response = await fetch(`http://localhost:${port}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(taskData),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[MessagingAI] Task creation failed:', errorText);
      return { success: false, error: errorText };
    }

    const result = (await response.json()) as { id: string };
    console.log('[MessagingAI] Task created:', result.id);
    return { success: true, taskId: result.id };
  } catch (error) {
    const err = error as Error;
    console.error('[MessagingAI] Task creation error:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Parse task-create blocks from AI response content
 */
export function parseTaskCreateBlocks(
  content: string
): Array<{ title: string; context: string; priority?: string }> {
  const matches = [...content.matchAll(TASK_CREATE_PATTERN)];
  const tasks: Array<{ title: string; context: string; priority?: string }> = [];

  for (const match of matches) {
    try {
      const taskData = JSON.parse(match[1]) as {
        title: string;
        context: string;
        priority?: string;
      };
      tasks.push(taskData);
    } catch (error) {
      const err = error as Error;
      console.error('[MessagingAI] Failed to parse task data:', err.message);
    }
  }

  return tasks;
}

/**
 * Screenshot block data from AI response
 */
interface ScreenshotBlock {
  url: string;
  path: string;
}

/**
 * Result from parsing screenshot blocks including any warnings
 */
interface ScreenshotParseResult {
  screenshots: ScreenshotBlock[];
  warnings: string[];
}

/**
 * Check if a path looks like a valid local file path (not a fake URL)
 */
function isValidLocalPath(pathStr: string): boolean {
  // Must not be a URL-like fake path
  if (pathStr.startsWith('http://') || pathStr.startsWith('https://')) {
    return false;
  }
  // Should have a file extension for images
  const hasImageExtension = /\.(png|jpg|jpeg|webp|gif)$/i.test(pathStr);
  return hasImageExtension;
}

/**
 * Parse screenshot code blocks from AI response content
 * Expected format: {"url": "https://example.com", "path": "/path/to/screenshot.png"}
 * Also handles fallback detection of malformed markdown image syntax
 */
export function parseScreenshotBlocks(content: string): ScreenshotParseResult {
  const screenshots: ScreenshotBlock[] = [];
  const warnings: string[] = [];

  // First, try to parse proper screenshot JSON blocks
  const jsonMatches = [...content.matchAll(SCREENSHOT_BLOCK_PATTERN)];

  for (const match of jsonMatches) {
    try {
      const screenshotData = JSON.parse(match[1]) as ScreenshotBlock;
      if (screenshotData.url && screenshotData.path) {
        // Validate the path is a real local path, not a fake URL
        if (isValidLocalPath(screenshotData.path)) {
          screenshots.push(screenshotData);
          console.log('[MessagingAI] Parsed screenshot block:', screenshotData.url, '->', screenshotData.path);
        } else {
          console.log('[MessagingAI] Screenshot block has invalid path (looks like fake URL):', screenshotData.path);
          warnings.push(`Screenshot path appears invalid: ${screenshotData.path}`);
        }
      }
    } catch (error) {
      const err = error as Error;
      console.error('[MessagingAI] Failed to parse screenshot JSON data:', err.message);
      warnings.push(`Failed to parse screenshot JSON: ${err.message}`);
    }
  }

  // If no valid screenshots found, check for malformed markdown image syntax
  if (screenshots.length === 0) {
    const markdownMatches = [...content.matchAll(MARKDOWN_IMAGE_PATTERN)];

    for (const match of markdownMatches) {
      const altText = match[1];
      const imagePath = match[2];

      // Check if this looks like it might be a screenshot attempt
      const looksLikeScreenshot = /screenshot|page-\d+|capture/i.test(imagePath) ||
                                  /screenshot|capture|page/i.test(altText);

      if (looksLikeScreenshot) {
        console.log('[MessagingAI] Detected malformed markdown image syntax:', `![${altText}](${imagePath})`);

        // Check if the path might be a valid local file
        if (isValidLocalPath(imagePath)) {
          // Try to use it as a fallback
          screenshots.push({
            url: altText || 'Unknown URL',
            path: imagePath,
          });
          console.log('[MessagingAI] Using markdown image as fallback screenshot:', imagePath);
        } else {
          // This is the common case where AI generates fake URLs
          warnings.push(`AI generated a fake screenshot URL instead of using the actual file path. Please ensure the screenshot was actually taken and try again.`);
          console.log('[MessagingAI] Markdown image has fake/invalid path:', imagePath);
        }
      }
    }
  }

  return { screenshots, warnings };
}

/**
 * Read a screenshot file and convert to base64
 */
async function readScreenshotAsBase64(filePath: string): Promise<string | null> {
  try {
    // Check if file exists and is accessible
    await access(filePath, constants.R_OK);

    // Read file and convert to base64
    const buffer = await readFile(filePath);
    const base64Data = buffer.toString('base64');

    console.log(`[MessagingAI] Screenshot file read successfully: ${filePath} (${Math.round(buffer.length / 1024)}KB)`);
    return base64Data;
  } catch (error) {
    const err = error as Error;
    console.error('[MessagingAI] Failed to read screenshot file:', err.message);
    return null;
  }
}

/**
 * Create tasks from parsed task-create blocks
 */
export async function createTasksFromBlocks(
  tasks: Array<{ title: string; context: string; priority?: string }>
): Promise<Array<{ success: boolean; title: string; taskId?: string; error?: string }>> {
  const results: Array<{
    success: boolean;
    title: string;
    taskId?: string;
    error?: string;
  }> = [];

  for (const task of tasks) {
    const result = await createTaskViaAPI(task);
    results.push({
      success: result.success,
      title: task.title,
      taskId: result.taskId,
      error: result.error,
    });
  }

  // Broadcast board update if any tasks were created
  if (results.some((r) => r.success)) {
    broadcastBoardUpdate();
  }

  return results;
}

/**
 * Build the conversation context for AI from message history
 */
function buildConversationContext(
  messages: AIConversationMessage[],
  currentMessage: string
): string {
  // Limit to last 10 messages to avoid token overflow
  const recentMessages = messages.slice(-10);

  let context = '';

  for (const msg of recentMessages) {
    const role = msg.role === 'user' ? 'User' : 'Assistant';
    context += `${role}: ${msg.content}\n\n`;
  }

  context += `User: ${currentMessage}`;

  return context;
}

/**
 * Generate messaging-specific context (calls generateContextFile from assistantManager)
 */
export async function generateMessagingContext(): Promise<string> {
  try {
    const contextPath = await generateContextFile();
    return contextPath;
  } catch (error) {
    const err = error as Error;
    console.error('[MessagingAI] Failed to generate context:', err.message);
    throw err;
  }
}

/**
 * Process a message through the AI and return the response
 * This is an async operation that may take several seconds
 */
export async function processAIMessage(
  message: IncomingMessage
): Promise<OutgoingMessage> {
  const { platform, chatId, text } = message;
  const sessionKey = `${platform}:${chatId}`;

  // Check if AI is available
  const cliAvailable = await isClaudeCLIAvailable();
  if (!cliAvailable) {
    const agentDisplayName = getAgentDisplayName();
    return {
      chatId,
      text: `❌ ${agentDisplayName} is not available. AI mode disabled.\n\nYour message will be created as a task instead.`,
      parseMode: 'markdown',
    };
  }

  // Get session and conversation history
  const session = await getSessionAI(platform, chatId);
  if (!session) {
    return {
      chatId,
      text: '❌ Session not found. Please use /start first.',
      parseMode: 'markdown',
    };
  }

  // Generate context file
  try {
    await generateMessagingContext();
  } catch (error) {
    console.error('[MessagingAI] Context generation failed:', error);
  }

  // Pre-intercept: detect screenshot intent before spawning AI subprocess
  const screenshotUrl = detectScreenshotIntent(text);
  let preInterceptMedia: MediaAttachment | undefined;
  let preInterceptMessage = '';

  if (screenshotUrl) {
    console.log('[MessagingAI] Pre-intercepting screenshot request for:', screenshotUrl);

    const playwrightAvailable = await isPlaywrightAvailable();
    if (playwrightAvailable) {
      const result = await takeScreenshotWithMCP(screenshotUrl);

      if (result.success && result.data) {
        if (platform === 'line') {
          preInterceptMessage = `\n\n📸 Screenshot captured for: ${screenshotUrl}\nNote: LINE does not support direct image uploads. Screenshot saved locally.`;
          console.log('[MessagingAI] LINE platform - screenshot captured but cannot be sent directly');
        } else {
          preInterceptMedia = {
            type: 'photo',
            source: 'buffer',
            data: result.data,
            caption: `Screenshot of ${screenshotUrl}`,
          };
          console.log('[MessagingAI] Pre-intercept screenshot captured for Telegram');
        }
      } else {
        console.log('[MessagingAI] Pre-intercept screenshot failed:', result.error);
        preInterceptMessage = `\n\n⚠️ Screenshot capture failed: ${result.error}`;
      }
    } else {
      console.log('[MessagingAI] Playwright not available for pre-intercept screenshot');
      preInterceptMessage = '\n\n⚠️ Screenshot not available: Playwright is not installed.';
    }
  }

  // Get conversation history
  const history = await getConversationHistory(platform, chatId);
  const messages = history?.messages || [];

  // Build the prompt with conversation context
  const prompt = messages.length > 0
    ? buildConversationContext(messages, text)
    : text;

  // Store user message in history
  const userMessage: AIConversationMessage = {
    role: 'user',
    content: text,
    timestamp: new Date().toISOString(),
  };
  await appendConversationMessage(platform, chatId, userMessage);

  // Spawn Claude CLI and get response
  try {
    const response = await spawnAgentAndGetResponse(prompt, sessionKey);

    // Store assistant response in history
    const assistantMessage: AIConversationMessage = {
      role: 'assistant',
      content: response,
      timestamp: new Date().toISOString(),
    };
    await appendConversationMessage(platform, chatId, assistantMessage);

    // Check for task creation blocks
    const taskBlocks = parseTaskCreateBlocks(response);
    let taskCreationMessage = '';

    if (taskBlocks.length > 0) {
      const results = await createTasksFromBlocks(taskBlocks);
      const successCount = results.filter((r) => r.success).length;

      if (successCount > 0) {
        const createdTasks = results
          .filter((r) => r.success)
          .map((r) => `[${r.taskId}] ${r.title}`)
          .join('\n');
        taskCreationMessage = `\n\n✅ *Tasks Created:*\n${createdTasks}`;
      }
    }

    // Check for screenshot blocks in AI response (post-process fallback)
    const screenshotParseResult = parseScreenshotBlocks(response);
    const screenshotBlocks = screenshotParseResult.screenshots;
    const screenshotWarnings = screenshotParseResult.warnings;
    let mediaAttachment: MediaAttachment | undefined = preInterceptMedia;
    let screenshotMessage = preInterceptMessage;

    // Log any warnings from screenshot parsing
    for (const warning of screenshotWarnings) {
      console.log('[MessagingAI] Screenshot parsing warning:', warning);
    }

    // Only attempt post-process if pre-intercept didn't already capture a screenshot
    if (!preInterceptMedia && screenshotBlocks.length > 0) {
      const screenshot = screenshotBlocks[0];
      console.log('[MessagingAI] Post-processing screenshot block for URL:', screenshot.url);

      if (platform === 'line') {
        screenshotMessage = `\n\n📸 Screenshot captured for: ${screenshot.url}\nNote: LINE does not support direct image uploads. Screenshot saved locally.`;
        console.log('[MessagingAI] LINE platform - screenshot saved but cannot be sent directly');
      } else {
        // Try to read the file from the AI's screenshot block path
        const base64Data = await readScreenshotAsBase64(screenshot.path);

        if (base64Data) {
          mediaAttachment = {
            type: 'photo',
            source: 'buffer',
            data: base64Data,
            caption: `Screenshot of ${screenshot.url}`,
          };
          console.log('[MessagingAI] Screenshot attachment created from AI output path');
        } else {
          // Fallback: file doesn't exist (MCP tools failed silently), retry via direct Playwright
          console.log('[MessagingAI] Screenshot file not found, retrying via direct Playwright:', screenshot.url);
          const fallbackResult = await takeScreenshotWithMCP(screenshot.url);

          if (fallbackResult.success && fallbackResult.data) {
            mediaAttachment = {
              type: 'photo',
              source: 'buffer',
              data: fallbackResult.data,
              caption: `Screenshot of ${screenshot.url}`,
            };
            console.log('[MessagingAI] Fallback screenshot captured successfully');
          } else {
            screenshotMessage = `\n\n⚠️ Screenshot could not be captured: ${fallbackResult.error || 'Unknown error'}`;
            console.log('[MessagingAI] Fallback screenshot also failed:', fallbackResult.error);
          }
        }
      }
    } else if (!preInterceptMedia && screenshotWarnings.length > 0) {
      // No valid screenshots found but warnings exist - the AI likely generated fake URLs
      screenshotMessage = `\n\n⚠️ Screenshot could not be attached: ${screenshotWarnings[0]}`;
      console.log('[MessagingAI] Screenshot attachment failed due to invalid AI output');
    }

    // Clean up response - remove task-create and screenshot blocks for display
    let displayResponse = response
      .replace(TASK_CREATE_PATTERN, '')
      .replace(SCREENSHOT_BLOCK_PATTERN, '')
      .trim();

    // If response is empty after removing blocks, provide a default message
    if (!displayResponse) {
      if (mediaAttachment || preInterceptMedia) {
        displayResponse = 'Screenshot captured.';
      } else if (taskBlocks.length > 0) {
        displayResponse = 'Task creation processed.';
      } else {
        displayResponse = 'Request processed.';
      }
    }

    return {
      chatId,
      text: displayResponse + taskCreationMessage + screenshotMessage,
      parseMode: 'markdown',
      media: mediaAttachment,
    };
  } catch (error) {
    const err = error as Error;
    console.error('[MessagingAI] AI processing error:', err.message);

    // Even if the AI subprocess failed, return the pre-intercepted screenshot if available
    if (preInterceptMedia) {
      return {
        chatId,
        text: `⚠️ AI response failed, but the screenshot was captured.${preInterceptMessage}`,
        parseMode: 'markdown',
        media: preInterceptMedia,
      };
    }

    return {
      chatId,
      text: `❌ AI processing failed: ${err.message}\n\nTry again or use /ai off to disable AI mode.`,
      parseMode: 'markdown',
    };
  }
}

/**
 * Spawn the agent CLI and capture its response
 */
function spawnAgentAndGetResponse(
  prompt: string,
  sessionKey: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const workspacePath = getWorkspacePath();
    const agentType = getAgentType();
    const agentCommand = getAgentCommand();

    // Determine if we should use --continue
    const hasStarted = conversationStarted.get(sessionKey) ?? false;
    const useContinue = hasStarted && supportsConversationContinue();

    // Build args for messaging assistant mode (no MCP Playwright tools)
    const args = buildMessagingAssistantArgs(prompt, { continue: useContinue });

    console.log('[MessagingAI] Spawning agent:', agentCommand);
    console.log('[MessagingAI] Working directory:', workspacePath);
    console.log('[MessagingAI] Using --continue:', useContinue);

    const child = spawn(agentCommand, args, {
      cwd: workspacePath,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Close stdin immediately
    child.stdin?.end();

    let outputBuffer = '';
    let streamingContent = '';
    const isJsonOutput = usesJsonOutput(agentType);

    // Handle stdout
    child.stdout?.on('data', (data: Buffer) => {
      const chunk = data.toString();
      outputBuffer += chunk;

      // Process complete lines
      const lines = outputBuffer.split('\n');
      outputBuffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;

        const result = parseAgentOutput(line, agentType);

        if (result.type === 'text' && result.content) {
          streamingContent += result.content;
        } else if (result.type === 'result' && result.content) {
          streamingContent = result.content;
        } else if (!isJsonOutput && result.type === 'unknown' && line.trim()) {
          streamingContent += line + '\n';
        }
      }
    });

    // Handle stderr (log but don't fail)
    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString().trim();
      if (text &&
        !text.includes('⠋') && !text.includes('⠙') && !text.includes('⠹') &&
        !text.includes('Disabled tools:') &&
        !text.includes('Unknown tool name') &&
        !text.includes('● Calling') &&
        !text.includes('● Reading')
      ) {
        console.log('[MessagingAI] stderr:', text);
      }
    });

    // Handle spawn error
    child.on('error', (err: NodeJS.ErrnoException) => {
      console.error('[MessagingAI] Spawn error:', err.message);
      reject(new Error(err.code === 'ENOENT' ? 'Agent CLI not found' : err.message));
    });

    // Handle process exit
    child.on('close', (code) => {
      console.log('[MessagingAI] Process exited with code:', code);

      // Mark conversation as started for future --continue usage
      conversationStarted.set(sessionKey, true);

      // Process remaining buffer
      if (outputBuffer.trim()) {
        if (isJsonOutput) {
          const result = parseAgentOutput(outputBuffer, agentType);
          if (result.type === 'result' && result.content) {
            streamingContent = streamingContent || result.content;
          }
        } else {
          streamingContent += outputBuffer;
        }
      }

      // For non-JSON agents, clean up the output
      if (!isJsonOutput && streamingContent) {
        streamingContent = cleanAgentOutput(streamingContent);
      }

      const finalContent = streamingContent.trim();

      if (finalContent) {
        resolve(finalContent);
      } else if (code !== 0) {
        reject(new Error(`Agent exited with code ${code}`));
      } else {
        resolve('I processed your request but have no response to display.');
      }
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      child.kill();
      reject(new Error('AI processing timed out'));
    }, 300000);
  });
}

/**
 * Check if AI mode is available for a session
 */
export async function isAIModeAvailable(
  platform: MessagingPlatform,
  chatId: string
): Promise<boolean> {
  const session = await getSessionAI(platform, chatId);
  return session?.aiEnabled ?? false;
}

/**
 * Clear the conversation started flag (useful when clearing history)
 */
export function resetConversationState(
  platform: MessagingPlatform,
  chatId: string
): void {
  const sessionKey = `${platform}:${chatId}`;
  conversationStarted.delete(sessionKey);
}
