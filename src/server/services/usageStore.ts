import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { UsageEvent } from '../../types/index.js';
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

function isUsageEvent(value: unknown): value is UsageEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return isNonEmptyString(event.id)
    && isNonEmptyString(event.timestamp)
    && isNonEmptyString(event.taskId)
    && isNonEmptyString(event.step)
    && isNonEmptyString(event.agentType)
    && event.source === 'transcript'
    && isNonEmptyString(event.sessionId)
    && isNonEmptyString(event.model)
    && isFiniteNonNegativeNumber(event.inputTokens)
    && isFiniteNonNegativeNumber(event.outputTokens)
    && isFiniteNonNegativeNumber(event.cacheCreationTokens)
    && isFiniteNonNegativeNumber(event.cacheReadTokens);
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
    let malformedLogged = false;
    for (const line of contents.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!isUsageEvent(parsed)) throw new Error('record does not match the UsageEvent schema');
        if (matchesFilter(parsed, filter)) events.push(parsed);
      } catch (err) {
        if (!malformedLogged) {
          malformedLogged = true;
          console.warn(`[UsageStore] Skipping malformed usage event: ${err instanceof Error ? err.message : 'Unknown error'}`);
        }
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
