import os from 'node:os';
import path from 'node:path';

export interface TranscriptUsageRecord {
  sessionId: string;
  messageId: string | null;
  requestId: string | null;
  model: string;
  timestamp: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function numericValue(value: unknown): number {
  const numberValue = typeof value === 'number' ? value : Number(value);
  return Number.isNaN(numberValue) ? 0 : numberValue;
}

function usageValue(usage: JsonRecord, keys: string[]): number {
  for (const key of keys) {
    if (key in usage) {
      return numericValue(usage[key]);
    }
  }

  return 0;
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content.map(textFromContent).join('');
  }

  if (isRecord(content)) {
    const text = textFromContent(content.text);
    return text || textFromContent(content.content);
  }

  return '';
}

/** Returns Claude Code's escaped transcript directory name for a workspace path. */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Returns the absolute Claude Code transcript directory for a workspace path. */
export function claudeProjectDir(cwd: string, home?: string): string {
  return path.join(home ?? os.homedir(), '.claude', 'projects', claudeProjectDirName(cwd));
}

/** Extracts unique assistant usage records from a JSONL transcript chunk. */
export function extractUsageRecords(
  jsonlChunk: string,
  sessionId: string,
  seen: Set<string>,
): TranscriptUsageRecord[] {
  const records: TranscriptUsageRecord[] = [];

  for (const line of jsonlChunk.split(/\r?\n/)) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      // Intentionally skip malformed or incomplete JSONL lines.
      continue;
    }

    if (!isRecord(entry) || entry.type !== 'assistant' || !isRecord(entry.message)) {
      continue;
    }

    const usage = isRecord(entry.message.usage) ? entry.message.usage : null;
    if (usage === null) {
      continue;
    }

    const messageId = stringOrNull(entry.message.id);
    const requestId = stringOrNull(entry.requestId);
    const key = `${sessionId}:${messageId ?? requestId}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    records.push({
      sessionId,
      messageId,
      requestId,
      model: stringOrNull(entry.message.model) ?? '',
      timestamp: stringOrNull(entry.timestamp) ?? '',
      inputTokens: usageValue(usage, ['input_tokens', 'inputTokens', 'input']),
      outputTokens: usageValue(usage, ['output_tokens', 'outputTokens', 'output']),
      reasoningTokens: usageValue(usage, ['reasoning_tokens', 'reasoningTokens', 'reasoning']),
      cacheCreationTokens: usageValue(usage, [
        'cache_creation_input_tokens',
        'cacheCreationInputTokens',
        'cacheCreationTokens',
      ]),
      cacheReadTokens: usageValue(usage, [
        'cache_read_input_tokens',
        'cacheReadInputTokens',
        'cacheReadTokens',
      ]),
    });
  }

  return records;
}

/** Returns a Formic task ID referenced by a user transcript entry, if present. */
export function extractTaskMarker(line: string): string | null {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    // Intentionally skip malformed or incomplete JSONL lines.
    return null;
  }

  if (!isRecord(entry) || entry.type !== 'user' || !isRecord(entry.message)) {
    return null;
  }

  return /\.formic\/tasks\/(t-\d+)/.exec(textFromContent(entry.message.content))?.[1] ?? null;
}
