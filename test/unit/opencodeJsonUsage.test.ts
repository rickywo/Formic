import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { OpenCodeUsageStreamCollector, openCodeRecordToUsageEvent, parseOpenCodeUsageLine } from '../../src/server/services/opencodeJsonUsage.js';

const FIXTURE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'opencode-t156-execute.jsonl');

describe('OpenCodeUsageStreamCollector', () => {
  it('normalizes the token-bearing t-156 step_finish fixture without counting total', async () => {
    const fixture = await readFile(FIXTURE_PATH, 'utf8');
    const collector = new OpenCodeUsageStreamCollector();
    const records = collector.push(fixture);

    assert.strictEqual(records.length, 2);
    assert.deepStrictEqual(records.map(record => record.id), [
      'ses_0b4bb7fa6ffet9zjs1NzqJsZKQ:msg_f4b448107001zAtt9MmhpwMiah:prt_f4b4497110017FnMTqc8CrF6d',
      'ses_0b4bb7fa6ffet9zjs1NzqJsZKQ:msg_f4b44a723001TUjLLMFE0dqYiN:prt_f4b44af40001fikoJmjQF1A9hr',
    ]);
    assert.deepStrictEqual(records.map(record => [record.inputTokens, record.outputTokens, record.cacheCreationTokens, record.cacheReadTokens]), [
      [6316, 67, 0, 0],
      [412, 17, 0, 6144],
    ]);
  });

  it('buffers arbitrarily chunked records and flushes a final unterminated line once', () => {
    const line = JSON.stringify({
      type: 'step_finish', timestamp: '2026-07-13T12:00:00.000Z', sessionID: 'session',
      part: { id: 'part', messageID: 'message', tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } } },
    });
    const collector = new OpenCodeUsageStreamCollector();
    assert.deepStrictEqual(collector.push(line.slice(0, 17)), []);
    assert.deepStrictEqual(collector.push(line.slice(17)), []);
    const [record] = collector.flush();
    assert.ok(record);
    assert.deepStrictEqual([record.inputTokens, record.outputTokens, record.cacheReadTokens, record.cacheCreationTokens], [1, 5, 4, 5]);
    assert.deepStrictEqual(collector.flush(), []);
  });

  it('ignores malformed, unrelated, and zero-token events', () => {
    const collector = new OpenCodeUsageStreamCollector();
    assert.deepStrictEqual(collector.push('not-json\n{"type":"text"}\n'), []);
    assert.strictEqual(parseOpenCodeUsageLine(JSON.stringify({
      type: 'step_finish', sessionID: 'session', part: { id: 'part', messageID: 'message', tokens: { total: 99 } },
    })), null);
  });

  it('converts records with explicit task or non-task attribution', () => {
    const record = parseOpenCodeUsageLine(JSON.stringify({
      type: 'step_finish', sessionID: 'provider-session',
      part: { id: 'part', messageID: 'message', modelID: 'provider/model', tokens: { input: 1, output: 2 } },
    }));
    assert.ok(record);
    const task = openCodeRecordToUsageEvent(record, { scope: 'task', taskId: 't-1', step: 'execute' });
    const messaging = openCodeRecordToUsageEvent(record, { scope: 'messaging', scopeId: 'telegram:42' });
    assert.deepEqual(task.scope === 'task' ? task.taskId : null, 't-1');
    assert.deepEqual(messaging, {
      id: 'provider-session:message:part', timestamp: messaging.timestamp, scope: 'messaging', scopeId: 'telegram:42', step: 'assistant',
      agentType: 'opencode', source: 'transcript', sessionId: 'provider-session', model: 'provider/model',
      inputTokens: 1, outputTokens: 2, cacheCreationTokens: 0, cacheReadTokens: 0,
    });
  });
});
