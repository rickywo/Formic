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
 * Parse Claude Code CLI stream-json output line
 * Format: Line-delimited JSON with event types: 'assistant', 'result', 'system'
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
        content?: Array<{ type: string; text?: string }>;
      };
      result?: string;
    };

    const eventType = event.type;

    if (eventType === 'assistant') {
      // Extract text from assistant message content blocks
      const textContent: string[] = [];
      if (event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === 'text' && block.text) {
            textContent.push(block.text);
          }
        }
      }

      if (textContent.length > 0) {
        return {
          type: 'text',
          content: textContent.join(''),
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
 */
export function parseCopilotOutput(line: string): OutputParseResult {
  if (!line.trim()) {
    return { type: 'unknown' };
  }

  // Copilot typically outputs plain text responses
  // We'll treat each non-empty line as text content
  return {
    type: 'text',
    content: line,
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
