import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  beginTaskRun,
  endTaskRun,
  scanUsageCollectorForTests,
  setUsageCollectorProjectDirResolverForTests,
  stopUsageCollector,
} from '../../src/server/services/usageCollector.js';
import { readUsageEvents } from '../../src/server/services/usageStore.js';
import { getWorkspacePath, setWorkspacePath } from '../../src/server/utils/paths.js';

let savedWorkspacePath: string;
let workspacePath: string;
let transcriptDir: string;

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
});

afterEach(async () => {
  stopUsageCollector();
  setUsageCollectorProjectDirResolverForTests(null);
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
});
