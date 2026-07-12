import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AgentStdoutFormatter, emitAgentStdoutEntries } from '../../src/server/services/runner.js';

const STEP_START = JSON.stringify({
  type: 'step_start',
  sessionID: 'secret-session',
  part: { snapshot: 'secret-snapshot', type: 'step-start' },
});
const TEXT = JSON.stringify({
  type: 'text',
  sessionID: 'secret-session',
  part: { type: 'text', text: 'Inspecting the implementation.' },
});
const TOOL_USE = JSON.stringify({
  type: 'tool_use',
  sessionID: 'secret-session',
  part: {
    tool: 'read',
    state: {
      status: 'completed',
      input: { filePath: '/private/project/src/secret.ts' },
      output: 'COMPLETE PRIVATE FILE CONTENT',
      metadata: { tokens: 999 },
      title: 'secret.ts',
    },
  },
});
const CHECKPOINT = JSON.stringify({
  type: 'step_finish',
  sessionID: 'secret-session',
  part: { reason: 'tool-calls', tokens: { total: 100 } },
});
const TERMINAL = JSON.stringify({
  type: 'step_finish',
  sessionID: 'secret-session',
  part: { reason: 'stop', tokens: { total: 200 } },
});

describe('AgentStdoutFormatter', () => {
  it('renders only readable OpenCode text and tool statuses', () => {
    const formatter = new AgentStdoutFormatter('opencode');
    const output = formatter.push(
      `${STEP_START}\n${TEXT}\n${TOOL_USE}\n${CHECKPOINT}\n${TERMINAL}\n`
    );

    assert.deepEqual(output, ['Inspecting the implementation.', 'secret.ts']);
    const rendered = output.join('\n');
    assert.doesNotMatch(rendered, /\{"type"/);
    assert.doesNotMatch(rendered, /secret-session|secret-snapshot|PRIVATE FILE|tokens/);
  });

  it('processes multiple events in one chunk in order exactly once', () => {
    const formatter = new AgentStdoutFormatter('opencode');
    assert.deepEqual(formatter.push(`${TEXT}\n${TOOL_USE}\n`), [
      'Inspecting the implementation.',
      'secret.ts',
    ]);
    assert.deepEqual(formatter.flush(), []);
  });

  it('buffers an event split across chunks without exposing fragments', () => {
    const formatter = new AgentStdoutFormatter('opencode');
    const splitAt = Math.floor(TEXT.length / 2);

    assert.deepEqual(formatter.push(TEXT.slice(0, splitAt)), []);
    assert.deepEqual(formatter.push(`${TEXT.slice(splitAt)}\n`), ['Inspecting the implementation.']);
    assert.deepEqual(formatter.flush(), []);
  });

  it('flushes a final unterminated event once', () => {
    const formatter = new AgentStdoutFormatter('opencode');
    assert.deepEqual(formatter.push(TEXT), []);
    assert.deepEqual(formatter.flush(), ['Inspecting the implementation.']);
    assert.deepEqual(formatter.flush(), []);
  });

  it('suppresses malformed and unknown OpenCode envelopes', () => {
    const formatter = new AgentStdoutFormatter('opencode');
    const unknown = JSON.stringify({ type: 'session', sessionID: 'secret-session' });
    assert.deepEqual(formatter.push(`not-json\n${unknown}\n`), []);
  });

  it('leaves Claude and Copilot stdout chunks unchanged', () => {
    const claude = new AgentStdoutFormatter('claude');
    const copilot = new AgentStdoutFormatter('copilot');
    const chunk = 'first line\nsecond line\n';

    assert.deepEqual(claude.push(chunk), [chunk]);
    assert.deepEqual(copilot.push(chunk), [chunk]);
    assert.deepEqual(claude.flush(), []);
    assert.deepEqual(copilot.flush(), []);
  });
});

describe('emitAgentStdoutEntries', () => {
  it('fans out identical sanitized content to persisted and live logs', () => {
    const persisted: string[] = [];
    const live: string[] = [];
    const formatter = new AgentStdoutFormatter('opencode');
    const entries = formatter.push(`${TEXT}\n${TOOL_USE}\n`);

    emitAgentStdoutEntries(entries, entry => persisted.push(entry), entry => live.push(entry));

    assert.deepEqual(persisted, ['Inspecting the implementation.', 'secret.ts']);
    assert.deepEqual(live, persisted);
  });

  it('does not alter stderr-style content supplied outside the stdout formatter', () => {
    const persisted: string[] = [];
    const live: string[] = [];
    const stderr = '{"error":"raw stderr remains unchanged"}';

    emitAgentStdoutEntries([stderr], entry => persisted.push(entry), entry => live.push(entry));

    assert.deepEqual(persisted, [stderr]);
    assert.deepEqual(live, [stderr]);
  });
});
