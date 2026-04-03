/**
 * Output Parser - Agent-agnostic CLI output parsing
 *
 * Handles different output formats from supported AI coding agents:
 * - Claude Code CLI: stream-json format with line-delimited JSON events
 * - GitHub Copilot CLI: Plain text output
 */

import type { OutputParseResult, OutputEventType } from '../../types/index.js';
import { getAgentType, type AgentType } from './agentAdapter.js';

/**
 * Format a tool_use content block into a human-readable status label.
 * Truncates long file paths to the last 2 segments for readability.
 */
function formatToolStatus(name: string, input?: Record<string, unknown>): string {
  switch (name) {
    case 'Read': {
      const filePath = input?.file_path as string | undefined;
      if (filePath) {
        const segments = filePath.split('/');
        const short = segments.length > 2 ? segments.slice(-2).join('/') : filePath;
        return `Reading ${short}`;
      }
      return 'Reading file…';
    }
    case 'Grep': {
      const pattern = input?.pattern as string | undefined;
      return pattern ? `Searching for ${pattern}` : 'Searching…';
    }
    case 'Glob': {
      const pattern = input?.pattern as string | undefined;
      return pattern ? `Finding files ${pattern}` : 'Finding files…';
    }
    case 'WebSearch':
      return 'Searching web…';
    case 'WebFetch': {
      const url = input?.url as string | undefined;
      return url ? `Fetching ${url}` : 'Fetching URL…';
    }
    case 'Bash':
      return 'Running command…';
    case 'Agent':
      return 'Launching agent…';
    case 'Edit':
      return 'Editing file…';
    case 'Write':
      return 'Writing file…';
    default:
      // MCP tools have names like mcp__server__toolName
      if (name.startsWith('mcp__')) {
        const parts = name.split('__');
        const toolLabel = parts.length >= 3 ? parts.slice(2).join('__') : name;
        return `Using ${toolLabel}…`;
      }
      return `Using ${name}…`;
  }
}

/**
 * Parse Claude Code CLI stream-json output line
 * Format: Line-delimited JSON with event types: 'assistant', 'result', 'system'
 *
 * Claude Code CLI emits these high-level events (NOT raw Anthropic SSE events):
 *   type=system   (subtypes: hook_started, hook_response, init)
 *   type=assistant (content blocks: text, tool_use)
 *   type=user     (tool results)
 *   type=result   (final response)
 */
export function parseClaudeStreamJson(line: string): OutputParseResult {
  if (!line.trim()) {
    return { type: 'unknown' };
  }

  try {
    const event = JSON.parse(line) as {
      type?: string;
      subtype?: string;
      message?: {
        content?: Array<{
          type: string;
          text?: string;
          name?: string;
          input?: Record<string, unknown>;
        }>;
      };
      result?: string;
    };

    const eventType = event.type;

    if (eventType === 'assistant') {
      // An assistant event can contain both text AND tool_use blocks.
      // We extract text for streaming display and tool_use for status indicators.
      const textContent: string[] = [];
      let lastToolStatus: string | null = null;

      if (event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === 'text' && block.text) {
            textContent.push(block.text);
          } else if (block.type === 'tool_use' && block.name) {
            lastToolStatus = formatToolStatus(block.name, block.input);
          }
        }
      }

      // If we have text content, return it (text takes priority for display)
      if (textContent.length > 0) {
        return {
          type: 'text',
          content: textContent.join(''),
          raw: event,
        };
      }

      // Otherwise, if we found tool_use blocks, return a status update
      if (lastToolStatus) {
        return {
          type: 'status',
          content: lastToolStatus,
          raw: event,
        };
      }

      return { type: 'unknown', raw: event };
    }

    if (eventType === 'result') {
      return {
        type: 'result',
        content: event.result || '',
        isFinal: true,
        raw: event,
      };
    }

    if (eventType === 'system') {
      // The 'init' subtype fires when the CLI boots — use it as the first
      // status indicator so users see 'Thinking…' before any tool calls.
      if (event.subtype === 'init') {
        return {
          type: 'status',
          content: 'Thinking…',
          raw: event,
        };
      }
      return {
        type: 'system',
        content: event.subtype || 'system',
        raw: event,
      };
    }

    return { type: 'unknown', raw: event };
  } catch {
    // Not valid JSON - could be plain text or error output
    return {
      type: 'unknown',
      content: line,
    };
  }
}

/**
 * Parse GitHub Copilot CLI output line
 * Copilot outputs plain text, so we treat each line as text content
 * Preserves newlines by appending \n to each line for proper formatting
 */
export function parseCopilotOutput(line: string): OutputParseResult {
  if (!line.trim()) {
    return { type: 'unknown' };
  }

  // Copilot typically outputs plain text responses
  // Append newline to preserve formatting (line breaks between paragraphs, lists, etc.)
  return {
    type: 'text',
    content: line + '\n',
  };
}

/**
 * Clean up agent output by removing function call XML blocks
 * This is useful for Copilot which may include raw XML in its text output
 */
export function cleanAgentOutput(content: string): string {
  // List of known tool call XML tag patterns to remove
  const toolCallPatterns = [
    // Generic function calls
    /<function_calls>[\s\S]*?<\/function_calls>/g,
    /<function_calls>[\s\S]*?<\/antml:function_calls>/g,
    /<tool_call>[\s\S]*?<\/tool_call>/g,
    // Invoke patterns
    /<invoke[^>]*>[\s\S]*?<\/invoke>/g,
    /<invoke[^>]*>[\s\S]*?<\/antml:invoke>/g,
    // Copilot-specific tool patterns
    /<read_file>[\s\S]*?<\/read_file>/g,
    /<write_file>[\s\S]*?<\/write_file>/g,
    /<root_command_execution>[\s\S]*?<\/root_command_execution>/g,
    /<command_execution>[\s\S]*?<\/command_execution>/g,
    /<search_files>[\s\S]*?<\/search_files>/g,
    /<list_directory>[\s\S]*?<\/list_directory>/g,
    // Generic XML blocks with path/command children
    /<[a-z_]+><path>[^<]*<\/path><\/[a-z_]+>/g,
    /<[a-z_]+><command>[^<]*<\/command>[\s\S]*?<\/[a-z_]+>/g,
    // Parameter blocks
    /<parameter[^>]*>[\s\S]*?<\/parameter>/g,
  ];

  let cleaned = content;
  for (const pattern of toolCallPatterns) {
    cleaned = cleaned.replace(pattern, '');
  }

  // Clean up any resulting multiple spaces or newlines
  return cleaned
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * Parse agent output line based on agent type
 * Delegates to agent-specific parsers
 */
export function parseAgentOutput(line: string, agentType?: AgentType): OutputParseResult {
  const type = agentType ?? getAgentType();

  switch (type) {
    case 'claude':
      return parseClaudeStreamJson(line);
    case 'copilot':
      return parseCopilotOutput(line);
    default:
      // Fallback to treating as plain text
      return {
        type: 'text',
        content: line,
      };
  }
}

/**
 * Check if the output format uses JSON (for streaming parsers)
 */
export function usesJsonOutput(agentType?: AgentType): boolean {
  const type = agentType ?? getAgentType();
  return type === 'claude';
}
