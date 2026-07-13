import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { UsageEvent } from '../../types/index.js';
import { getAgentType } from './agentAdapter.js';
import { internalEvents, USAGE_UPDATED } from './internalEvents.js';
import { readOpenCodeUsage } from './opencodeUsage.js';
import { openCodeRecordToUsageEvent, OpenCodeUsageStreamCollector, type OpenCodeUsageAttribution, type OpenCodeUsageRecord } from './opencodeJsonUsage.js';
import { claudeProjectDir, extractTaskMarker, extractUsageRecords } from './transcriptUsage.js';
import { appendUsageEvent } from './usageStore.js';
import { getWorkspacePath } from '../utils/paths.js';

interface ActiveRun {
  invocationId: string;
  taskId: string;
  step: string;
  startedAt: number;
}

interface TranscriptSession {
  offset: number;
  taskId: string | null;
  markerChecked: boolean;
  seen: Set<string>;
}

const DEFAULT_SCAN_INTERVAL_MS = 15_000;
const SESSION_MTIME_GRACE_MS = 5_000;

const activeRuns = new Map<string, ActiveRun>();
const sessions = new Map<string, TranscriptSession>();
const openCodeSeen = new Map<string, Set<string>>();
const openCodeSeenMessageIds = new Set<string>();
let intervalHandle: ReturnType<typeof setInterval> | null = null;
let scanChain: Promise<void> = Promise.resolve();
let projectDirResolver: () => string = () => claudeProjectDir(getWorkspacePath());

function getScanInterval(): number {
  const rawValue = process.env.USAGE_SCAN_INTERVAL_MS ?? '';
  if (!/^\d+$/.test(rawValue)) return DEFAULT_SCAN_INTERVAL_MS;
  const configured = Number(rawValue);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_SCAN_INTERVAL_MS;
}

function isMissingPathError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function earliestRunStart(): number | null {
  let earliest: number | null = null;
  for (const run of activeRuns.values()) {
    earliest = earliest === null ? run.startedAt : Math.min(earliest, run.startedAt);
  }
  return earliest;
}

function activeRunForTask(taskId: string): ActiveRun | undefined {
  let newest: ActiveRun | undefined;
  for (const run of activeRuns.values()) {
    if (run.taskId === taskId && (newest === undefined || run.startedAt > newest.startedAt)) {
      newest = run;
    }
  }
  return newest;
}

function findTaskMarker(chunk: string): string | null {
  for (const line of chunk.split(/\r?\n/)) {
    const marker = extractTaskMarker(line);
    if (marker !== null) return marker;
  }
  return null;
}

async function readNewContent(filePath: string, session: TranscriptSession): Promise<string> {
  const fileStat = await stat(filePath);
  if (fileStat.size < session.offset) session.offset = 0;
  const bytesToRead = fileStat.size - session.offset;
  if (bytesToRead === 0) return '';

  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, session.offset);
    session.offset += bytesRead;
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

async function scanSession(sessionId: string, filePath: string, affectedTaskIds: Set<string>): Promise<void> {
  const session = sessions.get(sessionId) ?? {
    offset: 0,
    taskId: null,
    markerChecked: false,
    seen: new Set<string>(),
  };
  sessions.set(sessionId, session);

  const chunk = await readNewContent(filePath, session);
  if (!session.markerChecked) {
    session.markerChecked = true;
    const marker = findTaskMarker(chunk);
    session.taskId = marker !== null && activeRunForTask(marker) !== undefined ? marker : null;
  }

  if (session.taskId === null || chunk.length === 0) return;
  const run = activeRunForTask(session.taskId);
  if (!run) return;

  for (const record of extractUsageRecords(chunk, sessionId, session.seen)) {
    const event: UsageEvent = {
      id: `${sessionId}:${record.messageId}`,
      timestamp: record.timestamp || new Date().toISOString(),
      scope: 'task',
      taskId: session.taskId,
      step: run.step,
      agentType: getAgentType(),
      source: 'transcript',
      sessionId,
      model: record.model || 'unknown',
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      cacheCreationTokens: record.cacheCreationTokens,
      cacheReadTokens: record.cacheReadTokens,
    };
    await appendUsageEvent(event);
    affectedTaskIds.add(session.taskId);
  }
}

function markerFromOpenCodeText(markerText: string | null): string | null {
  if (markerText === null) return null;
  // Reuse the same JSONL marker parser without allowing arbitrary Claude
  // transcript lines to become task markers.
  return extractTaskMarker(JSON.stringify({ type: 'user', message: { content: markerText } }));
}

async function scanOpenCodeUsage(affectedTaskIds: Set<string>): Promise<void> {
  const openCodeSessions = await readOpenCodeUsage({ cwd: getWorkspacePath() });
  for (const openCodeSession of openCodeSessions) {
    const taskId = markerFromOpenCodeText(openCodeSession.markerText);
    if (taskId === null || activeRunForTask(taskId) === undefined) continue;
    const run = activeRunForTask(taskId);
    if (run === undefined) continue;
    const seen = openCodeSeen.get(openCodeSession.sessionId) ?? new Set<string>();
    openCodeSeen.set(openCodeSession.sessionId, seen);

    for (const record of openCodeSession.records) {
      const recordKey = record.messageId ?? record.requestId;
      const messageKey = recordKey === null ? null : `${openCodeSession.sessionId}:${recordKey}`;
      if (recordKey === null || messageKey === null || seen.has(recordKey) || openCodeSeenMessageIds.has(messageKey)) continue;
      seen.add(recordKey);
      openCodeSeenMessageIds.add(messageKey);
      const event: UsageEvent = {
        id: `${openCodeSession.sessionId}:${recordKey}`,
        timestamp: record.timestamp || new Date().toISOString(),
        scope: 'task',
        taskId,
        step: run.step,
        agentType: 'opencode',
        source: 'transcript',
        sessionId: openCodeSession.sessionId,
        model: record.model || 'unknown',
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        cacheCreationTokens: record.cacheCreationTokens,
        cacheReadTokens: record.cacheReadTokens,
      };
      await appendUsageEvent(event);
      affectedTaskIds.add(taskId);
    }
  }
}

/**
 * Persist OpenCode events observed directly on a spawned process's stdout.
 * The shared message index also suppresses a later SQLite fallback observation
 * for the same OpenCode assistant message.
 */
export async function ingestOpenCodeUsageRecords(attribution: OpenCodeUsageAttribution, records: OpenCodeUsageRecord[]): Promise<void> {
  const affectedTaskIds = new Set<string>();
  let persistedCount = 0;
  for (const record of records) {
    const seen = openCodeSeen.get(record.sessionId) ?? new Set<string>();
    openCodeSeen.set(record.sessionId, seen);
    if (seen.has(record.id)) continue;
    seen.add(record.id);
    openCodeSeenMessageIds.add(`${record.sessionId}:${record.messageId}`);
    const persisted = await appendUsageEvent(openCodeRecordToUsageEvent(record, attribution));
    if (persisted) persistedCount += 1;
    if (attribution.scope === 'task') affectedTaskIds.add(attribution.taskId);
  }
  if (persistedCount > 0) {
    internalEvents.emit(USAGE_UPDATED, { taskIds: [...affectedTaskIds] });
  }
}

/**
 * One task-scoped agent invocation. OpenCode stdout persistence is serialized
 * with finalization so a close/error/signal cannot race trailing JSONL writes.
 */
export class TaskUsageInvocation {
  readonly id: string;
  private readonly openCodeCollector = getAgentType() === 'opencode' ? new OpenCodeUsageStreamCollector() : null;
  private pending: Promise<void> = Promise.resolve();
  private finalized = false;

  constructor(readonly taskId: string, readonly step: string, private readonly selectedModel?: string) {
    this.id = `${taskId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    activeRuns.set(this.id, { invocationId: this.id, taskId, step, startedAt: Date.now() });
    ensureScanInterval();
  }

  ingestOpenCodeStdout(chunk: string): void {
    if (this.openCodeCollector === null || this.finalized) return;
    const records = this.openCodeCollector.push(chunk);
    this.enqueueRecords(records);
  }

  private enqueueRecords(records: OpenCodeUsageRecord[]): void {
    if (records.length === 0) return;
    const selectedModel = this.selectedModel;
    const attributedRecords = selectedModel === undefined
      ? records
      : records.map(record => record.model === 'unknown' ? { ...record, model: selectedModel } : record);
    this.pending = this.pending
      .catch(() => undefined)
      .then(() => ingestOpenCodeUsageRecords({ scope: 'task', taskId: this.taskId, step: this.step }, attributedRecords))
      .catch((error: unknown) => {
        console.warn(`[UsageCollector] Failed to persist OpenCode usage for ${this.taskId}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      });
  }

  async finalize(): Promise<void> {
    if (this.finalized) {
      await this.pending;
      return;
    }
    this.finalized = true;
    if (this.openCodeCollector !== null) this.enqueueRecords(this.openCodeCollector.flush());
    await this.pending;
    try {
      await queueScan();
    } catch (error) {
      console.warn(`[UsageCollector] Final scan failed for ${this.taskId}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      activeRuns.delete(this.id);
      stopScanIntervalWhenIdle();
    }
  }
}

/**
 * One non-task OpenCode subprocess invocation. It shares the task collector
 * parser and process-wide record index, but persists the real assistant or
 * messaging identity instead of fabricating a task ID.
 */
export class OpenCodeUsageInvocation {
  private readonly collector = new OpenCodeUsageStreamCollector();
  private pending: Promise<void> = Promise.resolve();
  private finalized = false;

  constructor(private readonly attribution: Extract<OpenCodeUsageAttribution, { scope: 'assistant' | 'messaging' }>, private readonly selectedModel?: string) {}

  ingestOpenCodeStdout(chunk: string): void {
    if (this.finalized) return;
    this.enqueueRecords(this.collector.push(chunk));
  }

  private enqueueRecords(records: OpenCodeUsageRecord[]): void {
    if (records.length === 0) return;
    const selectedModel = this.selectedModel;
    const attributedRecords = selectedModel === undefined
      ? records
      : records.map(record => record.model === 'unknown' ? { ...record, model: selectedModel } : record);
    this.pending = this.pending
      .catch(() => undefined)
      .then(() => ingestOpenCodeUsageRecords(this.attribution, attributedRecords))
      .catch((error: unknown) => {
        console.warn(`[UsageCollector] Failed to persist OpenCode ${this.attribution.scope} usage: ${error instanceof Error ? error.message : 'Unknown error'}`);
      });
  }

  async finalize(): Promise<void> {
    if (this.finalized) return this.pending;
    this.finalized = true;
    this.enqueueRecords(this.collector.flush());
    await this.pending;
  }
}

export function beginOpenCodeUsageInvocation(
  attribution: Extract<OpenCodeUsageAttribution, { scope: 'assistant' | 'messaging' }>,
  selectedModel?: string,
): OpenCodeUsageInvocation {
  return new OpenCodeUsageInvocation(attribution, selectedModel);
}

async function scanClaudeUsage(earliestStart: number, affectedTaskIds: Set<string>): Promise<void> {
  let fileNames: string[];
  try {
    fileNames = await readdir(projectDirResolver());
  } catch (error) {
    if (!isMissingPathError(error)) {
      console.warn(`[UsageCollector] Failed to read transcript directory: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
    return;
  }

  for (const fileName of fileNames) {
    if (!fileName.endsWith('.jsonl')) continue;
    const filePath = path.join(projectDirResolver(), fileName);
    try {
      const fileStat = await stat(filePath);
      if (fileStat.mtimeMs < earliestStart - SESSION_MTIME_GRACE_MS) continue;
      await scanSession(fileName.slice(0, -'.jsonl'.length), filePath, affectedTaskIds);
    } catch (error) {
      if (!isMissingPathError(error)) {
        console.warn(`[UsageCollector] Failed to scan transcript ${fileName}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }
  }

}

async function scanUsage(): Promise<void> {
  const earliestStart = earliestRunStart();
  if (earliestStart === null) return;

  const affectedTaskIds = new Set<string>();
  if (getAgentType() === 'opencode') {
    await scanOpenCodeUsage(affectedTaskIds);
  } else {
    await scanClaudeUsage(earliestStart, affectedTaskIds);
  }

  if (affectedTaskIds.size > 0) {
    internalEvents.emit(USAGE_UPDATED, { taskIds: [...affectedTaskIds] });
  }
}

function queueScan(): Promise<void> {
  scanChain = scanChain.catch(() => undefined).then(scanUsage).catch((error: unknown) => {
    console.warn(`[UsageCollector] Scan failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  });
  return scanChain;
}

function ensureScanInterval(): void {
  if (intervalHandle === null) {
    intervalHandle = setInterval(() => {
      void queueScan();
    }, getScanInterval());
  }
}

function stopScanIntervalWhenIdle(): void {
  if (activeRuns.size === 0 && intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

export function beginTaskRun(taskId: string, step: string, selectedModel?: string): TaskUsageInvocation {
  return new TaskUsageInvocation(taskId, step, selectedModel);
}

/** @deprecated Pass the invocation returned by beginTaskRun to avoid ambiguity. */
export async function endTaskRun(invocation: TaskUsageInvocation | string): Promise<void> {
  if (invocation instanceof TaskUsageInvocation) {
    await invocation.finalize();
    return;
  }
  const activeRun = activeRunForTask(invocation);
  if (activeRun === undefined) return;
  // Legacy callers do not retain their invocation. Finalize the most recent
  // matching run without removing overlapping runs for the same task.
  const legacyInvocation = new LegacyTaskUsageInvocation(activeRun);
  await legacyInvocation.finalize();
}

class LegacyTaskUsageInvocation {
  constructor(private readonly activeRun: ActiveRun) {}

  async finalize(): Promise<void> {
    try {
      await queueScan();
    } finally {
      activeRuns.delete(this.activeRun.invocationId);
      stopScanIntervalWhenIdle();
    }
  }
}

export function stopUsageCollector(): void {
  if (intervalHandle !== null) clearInterval(intervalHandle);
  intervalHandle = null;
  activeRuns.clear();
  sessions.clear();
  openCodeSeen.clear();
  openCodeSeenMessageIds.clear();
  scanChain = Promise.resolve();
}

/** Test-only seam for isolated transcript fixtures. */
export function setUsageCollectorProjectDirResolverForTests(resolver: (() => string) | null): void {
  projectDirResolver = resolver ?? (() => claudeProjectDir(getWorkspacePath()));
}

/** Test-only hook that runs one serialized collector scan immediately. */
export async function scanUsageCollectorForTests(): Promise<void> {
  await queueScan();
}
