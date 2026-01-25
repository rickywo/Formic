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
