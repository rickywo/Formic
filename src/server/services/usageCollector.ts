import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { UsageEvent } from '../../types/index.js';
import { getAgentType } from './agentAdapter.js';
import { internalEvents, USAGE_UPDATED } from './internalEvents.js';
import { readOpenCodeUsage } from './opencodeUsage.js';
import { claudeProjectDir, extractTaskMarker, extractUsageRecords } from './transcriptUsage.js';
import { appendUsageEvent } from './usageStore.js';
import { getWorkspacePath } from '../utils/paths.js';

interface ActiveRun {
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
    session.taskId = marker !== null && activeRuns.has(marker) ? marker : null;
  }

  if (session.taskId === null || chunk.length === 0) return;
  const run = activeRuns.get(session.taskId);
  if (!run) return;

  for (const record of extractUsageRecords(chunk, sessionId, session.seen)) {
    const event: UsageEvent = {
      id: `${sessionId}:${record.messageId}`,
      timestamp: record.timestamp || new Date().toISOString(),
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
    if (taskId === null || !activeRuns.has(taskId)) continue;
    const run = activeRuns.get(taskId);
    if (run === undefined) continue;
    const seen = openCodeSeen.get(openCodeSession.sessionId) ?? new Set<string>();
    openCodeSeen.set(openCodeSession.sessionId, seen);

    for (const record of openCodeSession.records) {
      const recordKey = record.messageId ?? record.requestId;
      if (recordKey === null || seen.has(recordKey)) continue;
      seen.add(recordKey);
      const event: UsageEvent = {
        id: `${openCodeSession.sessionId}:${recordKey}`,
        timestamp: record.timestamp || new Date().toISOString(),
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

export function beginTaskRun(taskId: string, step: string): void {
  activeRuns.set(taskId, { step, startedAt: Date.now() });
  if (intervalHandle === null) {
    intervalHandle = setInterval(() => {
      void queueScan();
    }, getScanInterval());
  }
}

export async function endTaskRun(taskId: string): Promise<void> {
  try {
    await queueScan();
  } catch (error) {
    console.warn(`[UsageCollector] Final scan failed for ${taskId}: ${error instanceof Error ? error.message : 'Unknown error'}`);
  } finally {
    activeRuns.delete(taskId);
    if (activeRuns.size === 0 && intervalHandle !== null) {
      clearInterval(intervalHandle);
      intervalHandle = null;
    }
  }
}

export function stopUsageCollector(): void {
  if (intervalHandle !== null) clearInterval(intervalHandle);
  intervalHandle = null;
  activeRuns.clear();
  sessions.clear();
  openCodeSeen.clear();
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
