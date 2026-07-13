import type { NonTaskUsageEvent, UsageEvent } from '../../types/index.js';
import { normalizeOpenCodeModel, recordValue } from './opencodeModel.js';

type JsonRecord = Record<string, unknown>;

export interface OpenCodeUsageRecord {
  id: string;
  sessionId: string;
  messageId: string;
  timestamp: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function tokenValue(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function timestampValue(value: unknown): string {
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value < 100_000_000_000 ? value * 1000 : value).toISOString();
  }
  return new Date().toISOString();
}

/**
 * Normalizes one OpenCode `step_finish` JSONL event. OpenCode reports reasoning
 * tokens separately. `tokens.total` is deliberately informational and never
 * counted because it overlaps the additive categories below.
 */
export function parseOpenCodeUsageLine(line: string): OpenCodeUsageRecord | null {
  try {
    const event: unknown = JSON.parse(line);
    if (!isRecord(event) || event.type !== 'step_finish' || !isRecord(event.part)) return null;

    const part = event.part;
    const tokens = isRecord(part.tokens) ? part.tokens : null;
    const sessionId = stringValue(part.sessionID) ?? stringValue(event.sessionID);
    const messageId = stringValue(part.messageID);
    const partId = stringValue(part.id);
    if (tokens === null || sessionId === null || messageId === null || partId === null) return null;

    const cache = isRecord(tokens.cache) ? tokens.cache : {};
    const inputTokens = tokenValue(tokens.input);
    const outputTokens = tokenValue(tokens.output);
    const reasoningTokens = tokenValue(tokens.reasoning);
    const cacheCreationTokens = tokenValue(cache.write);
    const cacheReadTokens = tokenValue(cache.read);
    if (inputTokens === 0 && outputTokens === 0 && reasoningTokens === 0 && cacheCreationTokens === 0 && cacheReadTokens === 0) return null;

    return {
      id: `${sessionId}:${messageId}:${partId}`,
      sessionId,
      messageId,
      timestamp: timestampValue(event.timestamp),
      model: normalizeOpenCodeModel({
        providerId: recordValue(part, 'providerID', 'providerId', 'provider_id') ?? recordValue(event, 'providerID', 'providerId', 'provider_id'),
        modelId: recordValue(part, 'modelID', 'modelId', 'model_id'),
        model: part.model ?? event.model,
      }),
      inputTokens,
      outputTokens,
      reasoningTokens,
      cacheCreationTokens,
      cacheReadTokens,
    };
  } catch {
    return null;
  }
}

/** Buffers arbitrary stdout chunks and yields normalized records per complete line. */
export class OpenCodeUsageStreamCollector {
  private partialLine = '';

  push(chunk: string): OpenCodeUsageRecord[] {
    const lines = `${this.partialLine}${chunk}`.split('\n');
    this.partialLine = lines.pop() ?? '';
    return lines.flatMap(line => {
      const record = parseOpenCodeUsageLine(line.replace(/\r$/, ''));
      return record === null ? [] : [record];
    });
  }

  flush(): OpenCodeUsageRecord[] {
    if (this.partialLine.length === 0) return [];
    const line = this.partialLine;
    this.partialLine = '';
    const record = parseOpenCodeUsageLine(line.replace(/\r$/, ''));
    return record === null ? [] : [record];
  }
}

export type OpenCodeUsageAttribution =
  | { scope: 'task'; taskId: string; step: string }
  | { scope: 'assistant' | 'messaging'; scopeId: string; step?: string };

export function openCodeRecordToUsageEvent(record: OpenCodeUsageRecord, attribution: OpenCodeUsageAttribution): UsageEvent {
  const base = {
    id: record.id,
    timestamp: record.timestamp,
    step: attribution.scope === 'task' ? attribution.step : attribution.step ?? 'assistant',
    agentType: 'opencode' as const,
    source: 'transcript' as const,
    sessionId: record.sessionId,
    model: record.model,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    reasoningTokens: record.reasoningTokens,
    cacheCreationTokens: record.cacheCreationTokens,
    cacheReadTokens: record.cacheReadTokens,
  };
  if (attribution.scope === 'task') {
    return { ...base, scope: 'task', taskId: attribution.taskId };
  }
  return { ...base, scope: attribution.scope, scopeId: attribution.scopeId } satisfies NonTaskUsageEvent;
}
