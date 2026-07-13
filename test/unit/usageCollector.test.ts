import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  beginTaskRun,
  beginOpenCodeUsageInvocation,
  endTaskRun,
  scanUsageCollectorForTests,
  setUsageCollectorProjectDirResolverForTests,
  stopUsageCollector,
} from '../../src/server/services/usageCollector.js';
import { readUsageEvents } from '../../src/server/services/usageStore.js';
import { getWorkspacePath, setWorkspacePath } from '../../src/server/utils/paths.js';
import { engineConfig } from '../../src/server/services/engineConfig.js';
import { isAvailable, setOpenCodeUsageDatabasePathForTests } from '../../src/server/services/opencodeUsage.js';
import { OpenCodeUsageStreamCollector } from '../../src/server/services/opencodeJsonUsage.js';
import { ingestOpenCodeUsageRecords } from '../../src/server/services/usageCollector.js';
import { internalEvents, USAGE_UPDATED } from '../../src/server/services/internalEvents.js';

let savedWorkspacePath: string;
let workspacePath: string;
let transcriptDir: string;
let savedAgentType: typeof engineConfig.agentType;

function userLine(taskReference?: string): string {
  return JSON.stringify({
    type: 'user',
    message: { content: taskReference ? `Implement this task. ${taskReference}` : 'A session without a task marker.' },
  });
}

function usageLine(messageId: string, inputTokens = 10): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: '2026-07-13T12:00:00.000Z',
    message: {
      id: messageId,
      model: 'claude-test',
      usage: { input_tokens: inputTokens, output_tokens: 5 },
    },
  });
}

async function writeTranscript(sessionId: string, lines: string[]): Promise<string> {
  await mkdir(transcriptDir, { recursive: true });
  const transcriptPath = path.join(transcriptDir, `${sessionId}.jsonl`);
  await writeFile(transcriptPath, `${lines.join('\n')}\n`, 'utf8');
  return transcriptPath;
}

beforeEach(async () => {
  savedWorkspacePath = getWorkspacePath();
  workspacePath = await mkdtemp(path.join(os.tmpdir(), 'formic-usage-collector-test-'));
  transcriptDir = path.join(workspacePath, 'claude-transcripts');
  setWorkspacePath(workspacePath);
  setUsageCollectorProjectDirResolverForTests(() => transcriptDir);
  savedAgentType = engineConfig.agentType;
});

afterEach(async () => {
  stopUsageCollector();
  setUsageCollectorProjectDirResolverForTests(null);
  setOpenCodeUsageDatabasePathForTests(null);
  engineConfig.agentType = savedAgentType;
  setWorkspacePath(savedWorkspacePath);
  await rm(workspacePath, { recursive: true, force: true });
});

describe('usageCollector', () => {
  it('attributes transcript usage only when a session contains an active task marker', async () => {
    beginTaskRun('t-123', 'execute');
    await writeTranscript('session-valid', [userLine('.formic/tasks/t-123_add-usage'), usageLine('message-1')]);

    await scanUsageCollectorForTests();

    const events = await readUsageEvents({ taskId: 't-123' });
    assert.strictEqual(events.length, 1);
    assert.deepStrictEqual(events[0].taskId, 't-123');
    assert.strictEqual(events[0].step, 'execute');
    assert.strictEqual(events[0].id, 'session-valid:message-1');
  });

  it('ignores a session with no task marker', async () => {
    beginTaskRun('t-124', 'quick');
    await writeTranscript('session-no-marker', [userLine(), usageLine('message-1')]);

    await scanUsageCollectorForTests();

    assert.deepStrictEqual(await readUsageEvents(), []);
  });

  it('ignores a session whose marker does not match an active task', async () => {
    beginTaskRun('t-125', 'execute');
    await writeTranscript('session-unmatched', [userLine('.formic/tasks/t-999_other'), usageLine('message-1')]);

    await scanUsageCollectorForTests();

    assert.deepStrictEqual(await readUsageEvents(), []);
  });

  it('reads appended transcript content incrementally', async () => {
    beginTaskRun('t-126', 'execute');
    const transcriptPath = await writeTranscript('session-incremental', [userLine('.formic/tasks/t-126_incremental'), usageLine('message-1')]);
    await scanUsageCollectorForTests();

    await appendFile(transcriptPath, `${usageLine('message-2', 20)}\n`, 'utf8');
    await scanUsageCollectorForTests();

    const events = await readUsageEvents({ taskId: 't-126' });
    assert.strictEqual(events.length, 2);
    assert.deepStrictEqual(events.map((event) => event.id), ['session-incremental:message-1', 'session-incremental:message-2']);
  });

  it('does not persist a repeated message ID across scans', async () => {
    beginTaskRun('t-127', 'execute');
    const transcriptPath = await writeTranscript('session-deduped', [userLine('.formic/tasks/t-127_dedup'), usageLine('message-1')]);
    await scanUsageCollectorForTests();

    await appendFile(transcriptPath, `${usageLine('message-1')}\n`, 'utf8');
    await scanUsageCollectorForTests();

    const events = await readUsageEvents({ taskId: 't-127' });
    assert.strictEqual(events.length, 1);
  });

  it('performs a final scan before an active run ends', async () => {
    beginTaskRun('t-128', 'reflection');
    await writeTranscript('session-final', [userLine('.formic/tasks/t-128_reflection'), usageLine('message-1')]);

    await endTaskRun('t-128');

    const events = await readUsageEvents({ taskId: 't-128' });
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].step, 'reflection');
  });

  it('treats a missing transcript directory as a no-op', async () => {
    beginTaskRun('t-129', 'execute');

    await assert.doesNotReject(scanUsageCollectorForTests());
    assert.deepStrictEqual(await readUsageEvents(), []);
  });

  it('persists direct OpenCode stdout with task and step attribution without SQLite', async () => {
    const collector = new OpenCodeUsageStreamCollector();
    const line = JSON.stringify({
      type: 'step_finish', timestamp: 1783674220354, sessionID: 'direct-session',
      part: { id: 'direct-part', messageID: 'direct-message', tokens: { total: 99, input: 10, output: 2, reasoning: 3, cache: { read: 80, write: 4 } } },
    });
    const notifications: string[][] = [];
    const listener = (event: { taskIds: string[] }): void => { notifications.push(event.taskIds); };
    internalEvents.on(USAGE_UPDATED, listener);
    try {
      const firstHalf = collector.push(line.slice(0, 30));
      await ingestOpenCodeUsageRecords({ scope: 'task', taskId: 't-direct', step: 'quick' }, firstHalf);
      await ingestOpenCodeUsageRecords({ scope: 'task', taskId: 't-direct', step: 'quick' }, collector.push(`${line.slice(30)}\n`));
      await ingestOpenCodeUsageRecords({ scope: 'task', taskId: 't-direct', step: 'quick' }, collector.push(`${line}\n`));
    } finally {
      internalEvents.off(USAGE_UPDATED, listener);
    }

    const events = await readUsageEvents({ taskId: 't-direct' });
    assert.strictEqual(events.length, 1);
    assert.deepStrictEqual(events[0], {
      id: 'direct-session:direct-message:direct-part', timestamp: '2026-07-10T09:03:40.354Z', scope: 'task', taskId: 't-direct', step: 'quick',
      agentType: 'opencode', source: 'transcript', sessionId: 'direct-session', model: 'unknown',
      inputTokens: 10, outputTokens: 2, reasoningTokens: 3, cacheCreationTokens: 4, cacheReadTokens: 80,
    });
    assert.deepStrictEqual(notifications, [['t-direct']]);
  });

  it('deduplicates chunked OpenCode retries by part identity without consulting SQLite', async () => {
    // This uses only the stdout collector and usage file. It intentionally does
    // not create or configure an OpenCode database, so it remains a regression
    // test for Node versions where `node:sqlite` cannot be imported.
    const collector = new OpenCodeUsageStreamCollector();
    const line = JSON.stringify({
      type: 'step_finish', sessionID: 'stdout-only-session',
      part: { id: 'stdout-part', messageID: 'stdout-message', providerID: 'openai', modelID: 'gpt-5', tokens: { input: 12, output: 3, reasoning: 2, cache: { read: 4, write: 5 } } },
    });
    const firstAttempt = collector.push(line.slice(0, 42));
    const completedAttempt = collector.push(`${line.slice(42)}\n`);
    const retry = collector.push(`${line}\n`);
    await ingestOpenCodeUsageRecords({ scope: 'task', taskId: 't-stdout-only', step: 'execute' }, firstAttempt);
    await ingestOpenCodeUsageRecords({ scope: 'task', taskId: 't-stdout-only', step: 'execute' }, completedAttempt);
    await ingestOpenCodeUsageRecords({ scope: 'task', taskId: 't-stdout-only', step: 'execute' }, retry);

    const events = await readUsageEvents({ taskId: 't-stdout-only' });
    assert.equal(events.length, 1);
    assert.deepEqual(events, [{
      id: 'stdout-only-session:stdout-message:stdout-part', timestamp: events[0].timestamp,
      scope: 'task', taskId: 't-stdout-only', step: 'execute', agentType: 'opencode', source: 'transcript', sessionId: 'stdout-only-session', model: 'openai/gpt-5',
      inputTokens: 12, outputTokens: 3, reasoningTokens: 2, cacheCreationTokens: 5, cacheReadTokens: 4,
    }]);
  });

  it('keeps overlapping same-task OpenCode invocations isolated by semantic step', async () => {
    engineConfig.agentType = 'opencode';
    const declareRun = beginTaskRun('t-overlap', 'declare');
    const executeRun = beginTaskRun('t-overlap', 'execute');
    const declareLine = JSON.stringify({
      type: 'step_finish', sessionID: 'declare-session',
      part: { id: 'declare-part', messageID: 'declare-message', modelID: 'provider/declare', tokens: { input: 3, output: 2 } },
    });
    const executeLine = JSON.stringify({
      type: 'step_finish', sessionID: 'execute-session',
      part: { id: 'execute-part', messageID: 'execute-message', modelID: 'provider/execute', tokens: { input: 5, output: 4 } },
    });

    declareRun.ingestOpenCodeStdout(`${declareLine}\n`);
    executeRun.ingestOpenCodeStdout(`${executeLine}\n`);
    await Promise.all([declareRun.finalize(), executeRun.finalize()]);

    const events = await readUsageEvents({ taskId: 't-overlap' });
    assert.strictEqual(events.length, 2);
    assert.deepStrictEqual(events.map(event => [event.sessionId, event.step, event.model]).sort(), [
      ['declare-session', 'declare', 'provider/declare'],
      ['execute-session', 'execute', 'provider/execute'],
    ]);
  });

  it('flushes a trailing OpenCode JSONL record exactly once during finalization', async () => {
    engineConfig.agentType = 'opencode';
    const invocation = beginTaskRun('t-partial', 'reflection');
    invocation.ingestOpenCodeStdout(JSON.stringify({
      type: 'step_finish', sessionID: 'partial-session',
      part: { id: 'partial-part', messageID: 'partial-message', tokens: { input: 7, output: 1 } },
    }));

    await Promise.all([invocation.finalize(), invocation.finalize()]);

    const events = await readUsageEvents({ taskId: 't-partial' });
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].step, 'reflection');
    assert.strictEqual(events[0].inputTokens, 7);
  });

  it('persists non-task OpenCode usage with scope identity and no task ID', async () => {
    const notifications: string[][] = [];
    const listener = (event: { taskIds: string[] }): void => { notifications.push(event.taskIds); };
    internalEvents.on(USAGE_UPDATED, listener);
    try {
      const invocation = beginOpenCodeUsageInvocation({ scope: 'messaging', scopeId: 'telegram:chat-42' }, 'configured/model');
      const line = JSON.stringify({
        type: 'step_finish', sessionID: 'provider-session',
        part: { id: 'part', messageID: 'message', tokens: { input: 8, output: 3 } },
      });
      invocation.ingestOpenCodeStdout(line.slice(0, 30));
      invocation.ingestOpenCodeStdout(line.slice(30));
      await Promise.all([invocation.finalize(), invocation.finalize()]);
      const repeated = beginOpenCodeUsageInvocation({ scope: 'messaging', scopeId: 'telegram:chat-42' });
      repeated.ingestOpenCodeStdout(`${line}\n`);
      await repeated.finalize();
    } finally {
      internalEvents.off(USAGE_UPDATED, listener);
    }
    const events = await readUsageEvents();
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], {
      id: 'provider-session:message:part', timestamp: events[0].timestamp, scope: 'messaging', scopeId: 'telegram:chat-42', step: 'assistant',
      agentType: 'opencode', source: 'transcript', sessionId: 'provider-session', model: 'configured/model',
      inputTokens: 8, outputTokens: 3, reasoningTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0,
    });
    assert.deepEqual(notifications, [[]]);
  });

  it('finalizes usage for workflow termination outcomes without losing semantic attribution', async () => {
    engineConfig.agentType = 'opencode';
    const outcomes = ['normal-close', 'spawn-error', 'runtime-error', 'timeout', 'sigterm', 'sigkill', 'retry', 'architect', 'quick', 'reflection'];
    const invocations = outcomes.map((step, index) => {
      const invocation = beginTaskRun(`t-${step}`, step, `provider/${step}`);
      invocation.ingestOpenCodeStdout(JSON.stringify({
        type: 'step_finish', sessionID: `session-${step}`,
        part: { id: `part-${step}`, messageID: `message-${step}`, tokens: { input: index + 1, output: 1 } },
      }));
      return invocation;
    });

    await Promise.all(invocations.map(invocation => invocation.finalize()));

    for (const [index, step] of outcomes.entries()) {
      const events = await readUsageEvents({ taskId: `t-${step}` });
      assert.strictEqual(events.length, 1, step);
      assert.strictEqual(events[0].step, step);
      assert.strictEqual(events[0].model, `provider/${step}`);
      assert.strictEqual(events[0].inputTokens, index + 1);
    }
  });

  it('attributes OpenCode SQLite rows once to the active task and current step', async () => {
    if (!isAvailable()) return;

    const databasePath = path.join(workspacePath, 'opencode.db');
    const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>;
    const sqlite = await dynamicImport('node:sqlite') as {
      DatabaseSync: new (location: string) => {
        exec(sql: string): void;
        prepare(sql: string): { run(...parameters: unknown[]): void };
        close(): void;
      };
    };
    const database = new sqlite.DatabaseSync(databasePath);
    try {
      database.exec('CREATE TABLE session (id TEXT PRIMARY KEY, cwd TEXT); CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, data TEXT);');
      database.prepare('INSERT INTO session (id, cwd) VALUES (?, ?)').run('open-session', workspacePath);
      database.prepare('INSERT INTO message (id, session_id, role, data) VALUES (?, ?, ?, ?)').run(
        'open-user', 'open-session', 'user', JSON.stringify({ role: 'user', parts: [{ text: 'Use .formic/tasks/t-130_open-code.' }] }),
      );
      database.prepare('INSERT INTO message (id, session_id, role, data) VALUES (?, ?, ?, ?)').run(
        'open-assistant', 'open-session', 'assistant', JSON.stringify({
          role: 'assistant',
          metadata: { time: { created: Date.now() }, assistant: { modelID: 'test', tokens: { input: 9, output: 4, cache: { read: 2, write: 1 } } } },
        }),
      );
    } finally {
      database.close();
    }

    engineConfig.agentType = 'opencode';
    setOpenCodeUsageDatabasePathForTests(databasePath);
    beginTaskRun('t-130', 'execute');
    await scanUsageCollectorForTests();
    const updatedDatabase = new sqlite.DatabaseSync(databasePath);
    try {
      updatedDatabase.prepare('INSERT INTO message (id, session_id, role, data) VALUES (?, ?, ?, ?)').run(
        'open-assistant-2', 'open-session', 'assistant', JSON.stringify({
          role: 'assistant',
          metadata: { time: { created: Date.now() }, assistant: { modelID: 'test', tokens: { input: 12, output: 6, cache: { read: 0, write: 0 } } } },
        }),
      );
    } finally {
      updatedDatabase.close();
    }
    await scanUsageCollectorForTests();
    await scanUsageCollectorForTests();

    const events = await readUsageEvents({ taskId: 't-130' });
    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[0].id, 'open-session:open-assistant');
    assert.strictEqual(events[0].step, 'execute');
    assert.strictEqual(events[0].agentType, 'opencode');
    assert.strictEqual(events[0].inputTokens, 9);
    assert.strictEqual(events[1].id, 'open-session:open-assistant-2');
  });
});
