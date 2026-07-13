import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  isAvailable,
  readOpenCodeUsage,
  setOpenCodeUsageDatabasePathForTests,
} from '../../src/server/services/opencodeUsage.js';

interface SqliteStatement {
  run(...parameters: unknown[]): void;
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (location: string) => SqliteDatabase;
}

let temporaryDirectory: string | null = null;

function sqliteModule(): Promise<SqliteModule> {
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>;
  return dynamicImport('node:sqlite') as Promise<SqliteModule>;
}

afterEach(async () => {
  setOpenCodeUsageDatabasePathForTests(null);
  if (temporaryDirectory !== null) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = null;
  }
});

describe('opencodeUsage', () => {
  it('returns no records without node:sqlite or a database', async () => {
    if (!isAvailable()) {
      assert.deepStrictEqual(await readOpenCodeUsage({ cwd: '/workspace' }), []);
      return;
    }

    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'formic-opencode-usage-test-'));
    setOpenCodeUsageDatabasePathForTests(path.join(temporaryDirectory, 'missing.db'));
    assert.deepStrictEqual(await readOpenCodeUsage({ cwd: '/workspace' }), []);
  });

  it('normalizes session messages from a read-only OpenCode fixture', async () => {
    if (!isAvailable()) return;

    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'formic-opencode-usage-test-'));
    const databasePath = path.join(temporaryDirectory, 'opencode.db');
    const { DatabaseSync } = await sqliteModule();
    const database = new DatabaseSync(databasePath);
    try {
      database.exec(`
        CREATE TABLE session (id TEXT PRIMARY KEY, cwd TEXT);
        CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, data TEXT);
      `);
      database.prepare('INSERT INTO session (id, cwd) VALUES (?, ?)').run('ses-1', '/workspace');
      database.prepare('INSERT INTO message (id, session_id, role, data) VALUES (?, ?, ?, ?)').run(
        'msg-user',
        'ses-1',
        'user',
        JSON.stringify({ role: 'user', parts: [{ type: 'text', text: 'Implement .formic/tasks/t-130_add-opencode-usage.' }] }),
      );
      database.prepare('INSERT INTO message (id, session_id, role, data) VALUES (?, ?, ?, ?)').run(
        'msg-assistant',
        'ses-1',
        'assistant',
        JSON.stringify({
          role: 'assistant',
          metadata: {
            time: { created: 1_784_000_000_000 },
            assistant: {
              providerID: 'anthropic',
              modelID: 'claude-sonnet-test',
              tokens: { input: 11, output: 7, cache: { read: 5, write: 3 } },
            },
          },
        }),
      );
    } finally {
      database.close();
    }

    setOpenCodeUsageDatabasePathForTests(databasePath);
    const sessions = await readOpenCodeUsage({ cwd: '/workspace' });

    assert.strictEqual(sessions.length, 1);
    assert.strictEqual(sessions[0].markerText, 'Implement .formic/tasks/t-130_add-opencode-usage.');
    assert.deepStrictEqual(sessions[0].records, [{
      sessionId: 'ses-1',
      messageId: 'msg-assistant',
      requestId: null,
      model: 'anthropic/claude-sonnet-test',
      timestamp: '2026-07-14T03:33:20.000Z',
      inputTokens: 11,
      outputTokens: 7,
      cacheCreationTokens: 3,
      cacheReadTokens: 5,
    }]);
  });
});
