import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { getChangedFilesSince } from '../../src/server/utils/gitUtils.js';
import { checkNoDiffVerification } from '../../src/server/services/workflow.js';
import { setWorkspacePath, getWorkspacePath } from '../../src/server/utils/paths.js';
import type { Task } from '../../src/types/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid Task shape used across test cases */
function makeTask(overrides: Partial<Task> & { id: string; docsPath: string }): Task {
  return {
    id: overrides.id,
    title: 'test task',
    status: 'running',
    priority: 'medium',
    context: 'test context',
    docsPath: overrides.docsPath,
    agentLogs: [],
    pid: null,
    ...overrides,
  };
}

const NO_DOCS = '.formic/tasks/t-none_noop';
const FIXTURE_FILE = 'changed-file.txt';
const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Workspace isolation — each test gets an independent git repository with one
// committed file and one deterministic uncommitted change.
// ---------------------------------------------------------------------------
let savedWorkspace: string;
let workspacePath: string;
let safePointCommit: string;

beforeEach(async () => {
  savedWorkspace = getWorkspacePath();
  workspacePath = await mkdtemp(path.join(os.tmpdir(), 'formic-no-diff-test-'));
  setWorkspacePath(workspacePath);

  await execFileAsync('git', ['init'], { cwd: workspacePath });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: workspacePath });
  await execFileAsync('git', ['config', 'user.name', 'Formic Test'], { cwd: workspacePath });
  await writeFile(path.join(workspacePath, FIXTURE_FILE), 'initial contents\n', 'utf-8');
  await execFileAsync('git', ['add', FIXTURE_FILE], { cwd: workspacePath });
  await execFileAsync('git', ['commit', '-m', 'fixture safe point'], { cwd: workspacePath });
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: workspacePath });
  safePointCommit = stdout.trim();
  await writeFile(path.join(workspacePath, FIXTURE_FILE), 'modified contents\n', 'utf-8');
});

afterEach(async () => {
  setWorkspacePath(savedWorkspace);
  await rm(workspacePath, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// getChangedFilesSince
// ---------------------------------------------------------------------------
describe('getChangedFilesSince', () => {
  it('returns an array when diffing against HEAD', async () => {
    const files = await getChangedFilesSince('HEAD');
    assert.deepStrictEqual(files, [FIXTURE_FILE]);
  });

  it('returns empty array for a nonexistent commit (graceful)', async () => {
    const files = await getChangedFilesSince('deadbeef0000000000000000000000000000000000');
    assert.deepStrictEqual(files, []);
  });
});

// ---------------------------------------------------------------------------
// checkNoDiffVerification
// ---------------------------------------------------------------------------

describe('checkNoDiffVerification', () => {
  it('returns null when safePointCommit is missing', async () => {
    const task = makeTask({ id: 't-test', docsPath: NO_DOCS, safePointCommit: null });
    const warning = await checkNoDiffVerification('t-test', task);
    assert.strictEqual(warning, null);
  });

  it('returns warning when no declared files match the diff', async () => {
    const task = makeTask({
      id: 't-test',
      docsPath: NO_DOCS,
      safePointCommit,
      declaredFiles: {
        exclusive: ['nonexistent-file.xyz'],
        shared: [],
      },
    });
    const warning = await checkNoDiffVerification('t-test', task);
    assert.ok(warning !== null, 'expected a warning string');
    assert.ok(warning!.includes('no changes to declared files'), `unexpected message: ${warning}`);
  });

  it('returns null when at least one declared exclusive file is in the diff', async () => {
    const task = makeTask({
      id: 't-test',
      docsPath: NO_DOCS,
      safePointCommit,
      declaredFiles: {
        exclusive: [FIXTURE_FILE],
        shared: [],
      },
    });
    const warning = await checkNoDiffVerification('t-test', task);
    assert.strictEqual(warning, null);
  });

  it('returns warning for quick task (no declared files) when diff is empty', async () => {
    const task = makeTask({
      id: 't-test',
      docsPath: NO_DOCS,
      safePointCommit: 'deadbeef0000000000000000000000000000000000',
      declaredFiles: undefined,
    });
    const warning = await checkNoDiffVerification('t-test', task);
    assert.ok(warning !== null, 'expected warning for empty diff');
    assert.ok(warning!.includes('no file changes detected'), `unexpected message: ${warning}`);
  });

  it('returns null for quick task when diff is non-empty', async () => {
    const task = makeTask({
      id: 't-test',
      docsPath: NO_DOCS,
      safePointCommit,
      declaredFiles: undefined,
    });
    const warning = await checkNoDiffVerification('t-test', task);
    assert.strictEqual(warning, null);
  });

  it('includes missing subtasks.json in the warning when diff gate also fires', async () => {
    const task = makeTask({
      id: 't-test',
      docsPath: NO_DOCS,
      safePointCommit: 'deadbeef0000000000000000000000000000000000',
      declaredFiles: undefined,
    });
    // Empty diff fires the primary gate; missing subtasks adds secondary detail.
    const warning = await checkNoDiffVerification('t-test', task);
    assert.ok(warning !== null, 'expected a warning');
    assert.ok(
      warning!.includes('subtasks.json is missing'),
      `expected subtasks.json mention: ${warning}`
    );
  });

  it('does not mention subtasks.json when it exists and diff gate fires', async () => {
    // Create a temporary task dir with a subtasks.json file in the fixture.
    const tmpId = 't-no-diff-test-tmp';
    const tmpBase = `.formic/tasks/${tmpId}_noop`;
    const tmpDir = path.join(getWorkspacePath(), tmpBase);
    const subtasksJson = path.join(tmpDir, 'subtasks.json');

    try {
      await mkdir(tmpDir, { recursive: true });
      await writeFile(subtasksJson, JSON.stringify({
        version: '1.0',
        taskId: tmpId,
        title: 'tmp',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        subtasks: [],
      }), 'utf-8');

      // Declare bogus exclusive files so the diff gate fires.
      const task = makeTask({
        id: tmpId,
        docsPath: tmpBase,
        safePointCommit,
        declaredFiles: {
          exclusive: ['nonexistent-file.xyz'],
          shared: [],
        },
      });
      const warning = await checkNoDiffVerification(tmpId, task);
      assert.ok(warning !== null, 'expected warning for missing declared files');
      assert.ok(
        !warning!.includes('subtasks.json'),
        `should NOT mention subtasks.json: ${warning}`
      );
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
