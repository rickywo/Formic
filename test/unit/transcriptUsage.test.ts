import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  claudeProjectDir,
  claudeProjectDirName,
  extractTaskMarker,
  extractUsageRecords,
} from '../../src/server/services/transcriptUsage.js';

const fixturePath = path.join(process.cwd(), 'test', 'fixtures', 'claude-transcript-basic.jsonl');

describe('transcriptUsage', () => {
  it('escapes Claude project directory names and resolves an injected home directory', () => {
    const cwd = '/Users/rickywo/WebstormProjects/Formic-0.9';
    assert.equal(claudeProjectDirName(cwd), '-Users-rickywo-WebstormProjects-Formic-0-9');
    assert.equal(
      claudeProjectDir(cwd, '/test-home'),
      '/test-home/.claude/projects/-Users-rickywo-WebstormProjects-Formic-0-9',
    );
  });

  it('extracts fixture usage totals and deduplicates streamed message repeats', async () => {
    const fixture = await readFile(fixturePath, 'utf8');
    const records = extractUsageRecords(fixture, 'session-fixture', new Set());

    assert.equal(records.length, 3);
    assert.deepEqual(
      records.map((record) => record.messageId),
      ['message-stream', 'message-cache', null],
    );
    assert.equal(records.reduce((total, record) => total + record.inputTokens, 0), 31);
    assert.equal(records.reduce((total, record) => total + record.outputTokens, 0), 15);
    assert.equal(records.reduce((total, record) => total + record.cacheCreationTokens, 0), 4);
    assert.equal(records.reduce((total, record) => total + record.cacheReadTokens, 0), 9);
  });

  it('supports alternate usage keys and coerces invalid or missing values to zero', () => {
    const syntheticLine = JSON.stringify({
      type: 'assistant',
      requestId: 'camel-request',
      timestamp: '2026-07-12T10:00:00.000Z',
      message: {
        id: 'camel-message',
        model: 'claude-test',
        usage: {
          inputTokens: 12,
          output: 3,
          cacheCreationTokens: 4,
          cacheReadInputTokens: 'not-a-number',
        },
      },
    });
    const [record] = extractUsageRecords(syntheticLine, 'session-camel', new Set());

    assert.ok(record);
    assert.equal(record.inputTokens, 12);
    assert.equal(record.outputTokens, 3);
    assert.equal(record.cacheCreationTokens, 4);
    assert.equal(record.cacheReadTokens, 0);
  });

  it('extracts task markers only from valid user entries and ignores malformed JSONL', async () => {
    const lines = (await readFile(fixturePath, 'utf8')).split('\n');

    assert.equal(extractTaskMarker(lines[0] ?? ''), 't-42');
    assert.equal(extractTaskMarker(lines[1] ?? ''), null);
    assert.equal(extractTaskMarker(lines[5] ?? ''), null);
    assert.equal(extractTaskMarker(lines[6] ?? ''), null);
    assert.doesNotThrow(() => extractUsageRecords(lines[6] ?? '', 'session-fixture', new Set()));
  });
});
