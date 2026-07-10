import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { existsSync, mkdirSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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

// Paths used in tests
const NO_DOCS = '.formic/tasks/t-none_noop';

// ---------------------------------------------------------------------------
// Env isolation — set WORKSPACE_PATH to the repo root so path-based helpers
// (subtasksExist, etc.) resolve correctly.
// ---------------------------------------------------------------------------
let savedWorkspace: string | undefined;

beforeEach(() => {
  savedWorkspace = getWorkspacePath();
  // Use the repo root (where the test runs from) as the workspace.
  setWorkspacePath(process.cwd());
});

afterEach(() => {
  setWorkspacePath(savedWorkspace);
});

// ---------------------------------------------------------------------------
// getChangedFilesSince
// ---------------------------------------------------------------------------
describe('getChangedFilesSince', () => {
  it('returns an array when diffing against HEAD', async () => {
    const files = await getChangedFilesSince('HEAD');
    assert.ok(Array.isArray(files), 'expected an array');
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
      safePointCommit: 'HEAD',
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
    // This file is known to be modified (it is in the diff vs HEAD).
    const task = makeTask({
      id: 't-test',
      docsPath: NO_DOCS,
      safePointCommit: 'HEAD',
      declaredFiles: {
        exclusive: ['src/server/services/workflow.ts'],
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
      safePointCommit: 'HEAD',
      declaredFiles: undefined,
    });
    // HEAD diff is non-empty in this worktree, so no warning expected.
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
    // Create a temporary task dir with a subtasks.json file in the workspace.
    const tmpId = 't-no-diff-test-tmp';
    const tmpBase = `.formic/tasks/${tmpId}_noop`;
    const tmpDir = path.join(getWorkspacePath(), tmpBase);
    const subtasksJson = path.join(tmpDir, 'subtasks.json');

    try {
      mkdirSync(tmpDir, { recursive: true });
      writeFileSync(subtasksJson, JSON.stringify({
        version: '1.0',
        taskId: tmpId,
        title: 'tmp',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        subtasks: [],
      }));

      // Declare bogus exclusive files so the diff gate fires.
      const task = makeTask({
        id: tmpId,
        docsPath: tmpBase,
        safePointCommit: 'HEAD',
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
      // Clean up
      try { unlinkSync(subtasksJson); } catch {}
      try { rmdirSync(tmpDir); } catch {}
    }
  });
});
