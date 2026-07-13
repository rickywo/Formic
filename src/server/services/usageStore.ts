import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentType, UsageEvent } from '../../types/index.js';
import { getBundledTemplatesPath, getFormicDir } from '../utils/paths.js';

export type UsagePeriod = 'today' | 'month' | 'all';
export type UsageGroupBy = 'model' | 'task' | 'session';

export interface UsageEventFilter {
  taskId?: string;
  from?: string;
  to?: string;
}

interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheWritePerMTok: number;
  cacheReadPerMTok: number;
}

export interface GroupSummary {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  requests: number;
  estCostUsd: number | null;
  costBasis: 'ESTIMATED';
}

export interface PeriodWindows {
  today: { key: string; endsAt: string };
  month: { key: string; endsAt: string };
}

let appendLock: Promise<void> = Promise.resolve();
const MAX_REPORTED_MALFORMED_LINES = 100;
const reportedMalformedLines = new Set<string>();

function getUsageDir(): string {
  return path.join(getFormicDir(), 'usage');
}

function getEventsPath(): string {
  return path.join(getUsageDir(), 'events.ndjson');
}

function getPricingPath(): string {
  return path.join(getUsageDir(), 'pricing.json');
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isAgentType(value: unknown): value is AgentType {
  return value === 'claude' || value === 'copilot' || value === 'opencode';
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function usageEventIssues(value: unknown): string[] {
  const event = recordOf(value);
  if (event === null) return ['record'];

  const issues: string[] = [];
  if (!isNonEmptyString(event.id)) issues.push('id');
  if (!isNonEmptyString(event.timestamp)) issues.push('timestamp');
  if (!isNonEmptyString(event.taskId)) issues.push('taskId');
  if (!isNonEmptyString(event.step)) issues.push('step');
  if (!isAgentType(event.agentType)) issues.push('agentType');
  if (event.source !== 'transcript') issues.push('source');
  if (!isNonEmptyString(event.sessionId)) issues.push('sessionId');
  if (!isNonEmptyString(event.model)) issues.push('model');
  if (!isFiniteNonNegativeNumber(event.inputTokens)) issues.push('inputTokens');
  if (!isFiniteNonNegativeNumber(event.outputTokens)) issues.push('outputTokens');
  if (!isFiniteNonNegativeNumber(event.cacheCreationTokens)) issues.push('cacheCreationTokens');
  if (!isFiniteNonNegativeNumber(event.cacheReadTokens)) issues.push('cacheReadTokens');
  return issues;
}

function isUsageEvent(value: unknown): value is UsageEvent {
  return usageEventIssues(value).length === 0;
}

function isValidLegacyTimestamp(value: unknown): value is string {
  return isNonEmptyString(value) && !Number.isNaN(new Date(value).getTime());
}

function legacyAgentType(provider: unknown): AgentType | null {
  // The previous proxy stored Anthropic usage without an agent type. It was
  // exclusively Claude usage, so this mapping is intentionally narrow.
  return provider === 'anthropic' ? 'claude' : null;
}

interface LegacyNormalizationResult {
  event: UsageEvent | null;
  issues: string[];
}

function isLegacyUsageRecord(value: Record<string, unknown>): boolean {
  return Object.hasOwn(value, 'agentId') || Object.hasOwn(value, 'provider') || Object.hasOwn(value, 'requestId');
}

function normalizeLegacyUsageEvent(value: Record<string, unknown>): LegacyNormalizationResult {
  const { id, timestamp, taskId, agentId, provider, requestId, model } = value;
  const { inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens } = value;
  const agentType = legacyAgentType(provider);
  const issues: string[] = [];
  if (!isNonEmptyString(id)) issues.push('id');
  if (!isValidLegacyTimestamp(timestamp)) issues.push('timestamp');
  if (!isNonEmptyString(taskId)) issues.push('taskId');
  if (!isNonEmptyString(agentId)) issues.push('agentId');
  if (agentType === null) issues.push('provider');
  if (!isNonEmptyString(requestId)) issues.push('requestId');
  if (!isNonEmptyString(model)) issues.push('model');
  if (!isFiniteNonNegativeNumber(inputTokens)) issues.push('inputTokens');
  if (!isFiniteNonNegativeNumber(outputTokens)) issues.push('outputTokens');
  if (!isFiniteNonNegativeNumber(cacheCreationTokens)) issues.push('cacheCreationTokens');
  if (!isFiniteNonNegativeNumber(cacheReadTokens)) issues.push('cacheReadTokens');
  if (issues.length > 0) return { event: null, issues };

  // The field checks above make the legacy-to-current mapping safe. Keep this
  // guard explicit so TypeScript preserves that proof at the conversion point.
  if (!isNonEmptyString(id) || !isValidLegacyTimestamp(timestamp) || !isNonEmptyString(taskId)
    || !isNonEmptyString(agentId) || agentType === null || !isNonEmptyString(requestId)
    || !isNonEmptyString(model) || !isFiniteNonNegativeNumber(inputTokens)
    || !isFiniteNonNegativeNumber(outputTokens) || !isFiniteNonNegativeNumber(cacheCreationTokens)
    || !isFiniteNonNegativeNumber(cacheReadTokens)) {
    return { event: null, issues: ['record'] };
  }

  return {
    event: {
      id,
      timestamp,
      taskId,
      step: agentId,
      agentType,
      source: 'transcript',
      sessionId: requestId,
      model,
      inputTokens,
      outputTokens,
      cacheCreationTokens,
      cacheReadTokens,
    },
    issues: [],
  };
}

function parseUsageEventRecord(value: unknown): LegacyNormalizationResult {
  if (isUsageEvent(value)) return { event: value, issues: [] };
  const record = recordOf(value);
  if (record !== null && isLegacyUsageRecord(record)) return normalizeLegacyUsageEvent(record);
  return { event: null, issues: usageEventIssues(value) };
}

function reportMalformedUsageLine(lineNumber: number, issues: string[]): void {
  const issueList = issues.length > 0 ? issues.join(', ') : 'record';
  const warningKey = `${getEventsPath()}:${lineNumber}:${issueList}`;
  if (reportedMalformedLines.has(warningKey)) return;
  if (reportedMalformedLines.size >= MAX_REPORTED_MALFORMED_LINES) return;
  reportedMalformedLines.add(warningKey);
  console.warn(`[UsageStore] Skipping malformed usage event at events.ndjson line ${lineNumber}: invalid or missing fields: ${issueList}`);
}

function isModelPricing(value: unknown): value is ModelPricing {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const pricing = value as Record<string, unknown>;
  return isFiniteNonNegativeNumber(pricing.inputPerMTok)
    && isFiniteNonNegativeNumber(pricing.outputPerMTok)
    && isFiniteNonNegativeNumber(pricing.cacheWritePerMTok)
    && isFiniteNonNegativeNumber(pricing.cacheReadPerMTok);
}

function parsePricing(contents: string): Record<string, ModelPricing> | null {
  try {
    const parsed: unknown = JSON.parse(contents);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const pricing: Record<string, ModelPricing> = {};
    for (const [model, value] of Object.entries(parsed)) {
      if (!isModelPricing(value)) return null;
      pricing[model] = value;
    }
    return pricing;
  } catch (err) {
    console.warn(`[UsageStore] Invalid pricing file: ${err instanceof Error ? err.message : 'Unknown error'}`);
    return null;
  }
}

async function loadPricing(): Promise<Record<string, ModelPricing>> {
  try {
    const workspacePricing = parsePricing(await readFile(getPricingPath(), 'utf8'));
    if (workspacePricing) return workspacePricing;
    console.warn('[UsageStore] Workspace pricing is invalid; using bundled pricing');
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code !== 'ENOENT') {
      console.warn(`[UsageStore] Failed to read workspace pricing: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }

  try {
    const bundledContents = await readFile(path.join(getBundledTemplatesPath(), 'pricing.json'), 'utf8');
    const bundledPricing = parsePricing(bundledContents);
    if (!bundledPricing) return {};
    await mkdir(getUsageDir(), { recursive: true });
    await appendFile(getPricingPath(), bundledContents, { encoding: 'utf8', flag: 'wx' }).catch((err: unknown) => {
      const error = err as NodeJS.ErrnoException;
      if (error.code !== 'EEXIST') throw err;
    });
    return bundledPricing;
  } catch (err) {
    console.warn(`[UsageStore] Failed to load bundled pricing: ${err instanceof Error ? err.message : 'Unknown error'}`);
    return {};
  }
}

function matchesFilter(event: UsageEvent, filter: UsageEventFilter): boolean {
  return (!filter.taskId || event.taskId === filter.taskId)
    && (!filter.from || event.timestamp >= filter.from)
    && (!filter.to || event.timestamp <= filter.to);
}

function emptySummary(): GroupSummary {
  return { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, requests: 0, estCostUsd: null, costBasis: 'ESTIMATED' };
}

function groupKey(event: UsageEvent, groupBy: UsageGroupBy): string {
  if (groupBy === 'model') return event.model;
  if (groupBy === 'task') return event.taskId;
  return event.sessionId;
}

function summarizeEvents(events: UsageEvent[], groupBy: UsageGroupBy, pricing: Record<string, ModelPricing>): Record<string, GroupSummary> {
  const groups: Record<string, GroupSummary> = {};
  const unpricedGroups = new Set<string>();
  for (const event of events) {
    const key = groupKey(event, groupBy);
    const summary = groups[key] ?? (groups[key] = emptySummary());
    summary.inputTokens += event.inputTokens;
    summary.outputTokens += event.outputTokens;
    summary.cacheCreationTokens += event.cacheCreationTokens;
    summary.cacheReadTokens += event.cacheReadTokens;
    summary.requests += 1;
    const modelPricing = pricing[event.model];
    if (!modelPricing) {
      unpricedGroups.add(key);
      continue;
    }
    const cost = (event.inputTokens * modelPricing.inputPerMTok
      + event.outputTokens * modelPricing.outputPerMTok
      + event.cacheCreationTokens * modelPricing.cacheWritePerMTok
      + event.cacheReadTokens * modelPricing.cacheReadPerMTok) / 1_000_000;
    summary.estCostUsd = (summary.estCostUsd ?? 0) + cost;
  }
  for (const key of unpricedGroups) groups[key].estCostUsd = null;
  return groups;
}

function eventInPeriod(event: UsageEvent, period: UsagePeriod, now: Date): boolean {
  if (period === 'all') return true;
  const timestamp = new Date(event.timestamp);
  if (Number.isNaN(timestamp.getTime())) return false;
  const start = period === 'today'
    ? new Date(now.getFullYear(), now.getMonth(), now.getDate())
    : new Date(now.getFullYear(), now.getMonth(), 1);
  const end = period === 'today'
    ? new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
    : new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return timestamp >= start && timestamp < end;
}

export function computePeriodWindows(now: Date = new Date()): PeriodWindows {
  const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return {
    today: { key: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`, endsAt: todayEnd.toISOString() },
    month: { key: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`, endsAt: monthEnd.toISOString() },
  };
}

export async function appendUsageEvent(event: UsageEvent): Promise<void> {
  if (!isUsageEvent(event)) throw new Error('Invalid usage event');
  const append = appendLock.then(async () => {
    await mkdir(getUsageDir(), { recursive: true });
    await appendFile(getEventsPath(), `${JSON.stringify(event)}\n`, 'utf8');
  });
  appendLock = append.catch(() => undefined);
  return append;
}

export async function readUsageEvents(filter: UsageEventFilter = {}): Promise<UsageEvent[]> {
  try {
    const contents = await readFile(getEventsPath(), 'utf8');
    const events: UsageEvent[] = [];
    const lines = contents.split('\n');
    for (const [index, line] of lines.entries()) {
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        const result = parseUsageEventRecord(parsed);
        if (result.event === null) {
          reportMalformedUsageLine(index + 1, result.issues);
          continue;
        }
        if (matchesFilter(result.event, filter)) events.push(result.event);
      } catch {
        reportMalformedUsageLine(index + 1, ['invalid JSON']);
      }
    }
    return events;
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === 'ENOENT') return [];
    console.warn(`[UsageStore] Failed to read usage events: ${err instanceof Error ? err.message : 'Unknown error'}`);
    throw err;
  }
}

export async function summarizeUsage(opts: { period: UsagePeriod; groupBy: UsageGroupBy }): Promise<{ periodWindows: PeriodWindows; groups: Record<string, GroupSummary> }> {
  const now = new Date();
  const [events, pricing] = await Promise.all([readUsageEvents(), loadPricing()]);
  return { periodWindows: computePeriodWindows(now), groups: summarizeEvents(events.filter((event) => eventInPeriod(event, opts.period, now)), opts.groupBy, pricing) };
}

export async function taskUsageTotals(): Promise<Record<string, GroupSummary>> {
  const [events, pricing] = await Promise.all([readUsageEvents(), loadPricing()]);
  return summarizeEvents(events, 'task', pricing);
}

export async function taskUsageBreakdown(taskId: string): Promise<{ total: GroupSummary; byModel: Record<string, GroupSummary>; bySession: Record<string, GroupSummary> }> {
  const [events, pricing] = await Promise.all([readUsageEvents({ taskId }), loadPricing()]);
  const total = summarizeEvents(events, 'task', pricing)[taskId] ?? emptySummary();
  return { total, byModel: summarizeEvents(events, 'model', pricing), bySession: summarizeEvents(events, 'session', pricing) };
}
