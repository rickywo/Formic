import { access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TranscriptUsageRecord } from './transcriptUsage.js';
import { normalizeOpenCodeModel, recordValue } from './opencodeModel.js';

interface SqliteStatement {
  all(...parameters: unknown[]): unknown[];
}

interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (location: string, options: { readOnly: boolean }) => SqliteDatabase;
}

type JsonRecord = Record<string, unknown>;

export interface OpenCodeUsageSession {
  sessionId: string;
  markerText: string | null;
  records: TranscriptUsageRecord[];
}

export interface ReadOpenCodeUsageOptions {
  cwd: string;
  sinceMs?: number;
  home?: string;
}

let sqlite: SqliteModule | null = null;
let unavailableWarningLogged = false;
let databasePathForTests: string | null = null;

// `node:sqlite` was added after this project's Node 20 type baseline. Using an
// indirect dynamic import keeps both compilation and startup compatible there.
try {
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>;
  const candidate: unknown = await dynamicImport('node:sqlite');
  if (isSqliteModule(candidate)) sqlite = candidate;
} catch {
  // Intentionally unavailable on Node versions that do not provide node:sqlite.
  sqlite = null;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSqliteModule(value: unknown): value is SqliteModule {
  return isRecord(value) && typeof value.DatabaseSync === 'function';
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function numberValue(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : 0;
}

function nestedValue(value: JsonRecord, keys: string[]): unknown {
  let current: unknown = value;
  for (const key of keys) {
    if (!isRecord(current) || !(key in current)) return undefined;
    current = current[key];
  }
  return current;
}

function jsonValue(value: unknown): JsonRecord {
  if (isRecord(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    // A malformed row is ignored by the strict normalization below.
    return {};
  }
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const string = stringValue(value);
    if (string !== null) return string;
  }
  return null;
}

function timestampValue(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return value;
    if (typeof value === 'number' && Number.isFinite(value)) {
      return new Date(value < 100_000_000_000 ? value * 1000 : value).toISOString();
    }
  }
  return '';
}

function timestampMs(timestamp: string): number {
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function textFromValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textFromValue).join('');
  if (!isRecord(value)) return '';
  if (typeof value.text === 'string') return value.text;
  if ('content' in value) return textFromValue(value.content);
  if ('parts' in value) return textFromValue(value.parts);
  return '';
}

function rowData(row: JsonRecord): JsonRecord {
  return jsonValue(row.data ?? row.message ?? row.content);
}

function rowRole(row: JsonRecord, data: JsonRecord): string | null {
  return firstString(row.role, data.role);
}

function sessionCwd(row: JsonRecord): string | null {
  const data = rowData(row);
  return firstString(
    row.cwd,
    row.directory,
    data.cwd,
    data.directory,
    nestedValue(data, ['path', 'cwd']),
  );
}

function tableName(database: SqliteDatabase, candidates: string[]): string | null {
  const rows = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
  const available = new Set(rows.filter(isRecord).map((row) => stringValue(row.name)).filter((name): name is string => name !== null));
  return candidates.find((candidate) => available.has(candidate)) ?? null;
}

function modelValue(message: JsonRecord, data: JsonRecord): string {
  const assistant = nestedValue(data, ['metadata', 'assistant']);
  const metadata = isRecord(assistant) ? assistant : {};
  return normalizeOpenCodeModel({
    providerId: recordValue(metadata, 'providerID', 'providerId', 'provider_id'),
    modelId: recordValue(metadata, 'modelID', 'modelId', 'model_id'),
    model: message.model ?? data.model,
  });
}

/** Whether this runtime can read OpenCode's SQLite store. */
export function isAvailable(): boolean {
  return sqlite !== null;
}

/** Test-only seam for a temporary OpenCode database. */
export function setOpenCodeUsageDatabasePathForTests(databasePath: string | null): void {
  databasePathForTests = databasePath;
}

function defaultDatabasePath(home?: string): string {
  return path.join(home ?? os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
}

function warnUnavailableOnce(): void {
  if (unavailableWarningLogged) return;
  unavailableWarningLogged = true;
  console.warn('[OpenCodeUsage] node:sqlite is unavailable; OpenCode usage collection is disabled');
}

function isMissingPathError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/**
 * Reads the legacy OpenCode SQLite schema used by the installed CLI: singular
 * `session` and `message` tables, with message metadata in `data` JSON
 * (`metadata.assistant.{providerID,modelID,tokens}`) and user text in the same
 * message object. Plural table names and direct columns are also accepted for
 * compatible database revisions. The database is only ever opened read-only.
 */
export async function readOpenCodeUsage(options: ReadOpenCodeUsageOptions): Promise<OpenCodeUsageSession[]> {
  if (sqlite === null) {
    warnUnavailableOnce();
    return [];
  }

  const databasePath = databasePathForTests ?? defaultDatabasePath(options.home);
  try {
    await access(databasePath);
    const database = new sqlite.DatabaseSync(databasePath, { readOnly: true });
    try {
      const sessionsTable = tableName(database, ['session', 'sessions']);
      const messagesTable = tableName(database, ['message', 'messages']);
      if (sessionsTable === null || messagesTable === null) return [];

      const sessionRows = database.prepare(`SELECT * FROM "${sessionsTable}"`).all().filter(isRecord);
      const messageRows = database.prepare(`SELECT rowid AS _rowid, * FROM "${messagesTable}"`).all().filter(isRecord);
      const results: OpenCodeUsageSession[] = [];

      for (const session of sessionRows) {
        const sessionId = firstString(session.id, session.session_id);
        if (sessionId === null || sessionCwd(session) !== options.cwd) continue;
        const messages = messageRows.filter((message) => firstString(message.session_id, message.sessionId) === sessionId);
        const firstUser = messages.find((message) => rowRole(message, rowData(message)) === 'user');
        const markerText = firstUser === undefined ? null : textFromValue(rowData(firstUser));
        const records: TranscriptUsageRecord[] = [];

        for (const message of messages) {
          const data = rowData(message);
          if (rowRole(message, data) !== 'assistant') continue;
          const tokens = isRecord(nestedValue(data, ['metadata', 'assistant', 'tokens']))
            ? nestedValue(data, ['metadata', 'assistant', 'tokens']) as JsonRecord
            : isRecord(message.tokens) ? message.tokens : {};
          const cache = isRecord(tokens.cache) ? tokens.cache : {};
          const timestamp = timestampValue(
            message.timestamp,
            message.time_created,
            message.created_at,
            nestedValue(data, ['metadata', 'time', 'created']),
          );
          if (options.sinceMs !== undefined && timestampMs(timestamp) < options.sinceMs) continue;
          const messageId = firstString(message.id, message.message_id, message._rowid);
          if (messageId === null) continue;
          records.push({
            sessionId,
            messageId,
            requestId: firstString(message.request_id, nestedValue(data, ['metadata', 'requestID'])),
            model: modelValue(message, data),
            timestamp,
            inputTokens: numberValue(tokens.input ?? message.input_tokens),
            outputTokens: numberValue(tokens.output ?? message.output_tokens),
            reasoningTokens: numberValue(tokens.reasoning ?? message.reasoning_tokens),
            cacheCreationTokens: numberValue(cache.write ?? message.cache_creation_tokens),
            cacheReadTokens: numberValue(cache.read ?? message.cache_read_tokens),
          });
        }

        results.push({ sessionId, markerText, records });
      }

      return results;
    } finally {
      database.close();
    }
  } catch (error) {
    if (!isMissingPathError(error)) {
      console.warn(`[OpenCodeUsage] Failed to read OpenCode usage: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
    return [];
  }
}
