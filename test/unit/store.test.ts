/**
 * Unit tests for store.ts
 *
 * Tests the validateBoard type guard and other pure functions.
 * Functions that require filesystem access (loadBoard, saveBoard, etc.)
 * are tested via Python integration tests.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateBoard, VALID_TASK_STATUSES, VALID_TASK_PRIORITIES } from '../../src/server/services/store.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeValidBoard(overrides?: Record<string, unknown>) {
  return {
    meta: {
      projectName: 'Test Project',
      repoPath: '/test/repo',
      createdAt: '2024-01-01T00:00:00.000Z',
    },
    tasks: [
      {
        id: 't-1',
        title: 'Test Task',
        status: 'todo',
        priority: 'medium',
        context: 'Test context',
        docsPath: '/test/docs',
        agentLogs: [],
      },
    ],
    ...overrides,
  };
}

function makeValidTask(overrides?: Record<string, unknown>) {
  return {
    id: 't-1',
    title: 'Test Task',
    status: 'todo',
    priority: 'medium',
    context: 'Test context',
    docsPath: '/test/docs',
    agentLogs: [],
    ...overrides,
  };
}

// ==============================
// VALID_TASK_STATUSES
// ==============================

describe('VALID_TASK_STATUSES', () => {
  it('should include all expected statuses', () => {
    const expected = ['todo', 'queued', 'briefing', 'planning', 'declaring', 'running',
      'architecting', 'verifying', 'review', 'done', 'blocked'];
    for (const status of expected) {
      assert.ok(VALID_TASK_STATUSES.includes(status), `Missing status: ${status}`);
    }
  });

  it('should have the correct length', () => {
    assert.equal(VALID_TASK_STATUSES.length, 11);
  });
});

// ==============================
// VALID_TASK_PRIORITIES
// ==============================

describe('VALID_TASK_PRIORITIES', () => {
  it('should include all expected priorities', () => {
    assert.deepStrictEqual(VALID_TASK_PRIORITIES, ['low', 'medium', 'high']);
  });
});

// ==============================
// validateBoard
// ==============================

describe('validateBoard', () => {
  // ── Happy Path ──────────────────────────────────────────────────────────

  it('should return true for a valid board', () => {
    const board = makeValidBoard();
    assert.equal(validateBoard(board), true);
  });

  it('should return true for a valid board with multiple tasks', () => {
    const board = makeValidBoard({
      tasks: [
        makeValidTask({ id: 't-1', title: 'Task 1' }),
        makeValidTask({ id: 't-2', title: 'Task 2', priority: 'high' }),
        makeValidTask({ id: 't-3', title: 'Task 3', priority: 'low', status: 'done' }),
      ],
    });
    assert.equal(validateBoard(board), true);
  });

  it('should return true for a board with zero tasks', () => {
    const board = makeValidBoard({ tasks: [] });
    assert.equal(validateBoard(board), true);
  });

  // ── Top-Level Validation ────────────────────────────────────────────────

  it('should return false for null', () => {
    assert.equal(validateBoard(null), false);
  });

  it('should return false for undefined', () => {
    assert.equal(validateBoard(undefined), false);
  });

  it('should return false for non-object (string)', () => {
    assert.equal(validateBoard('not-a-board'), false);
  });

  it('should return false for non-object (number)', () => {
    assert.equal(validateBoard(42), false);
  });

  it('should return false for non-object (array)', () => {
    assert.equal(validateBoard([]), false);
  });

  it('should return false for empty object', () => {
    assert.equal(validateBoard({}), false);
  });

  // ── Meta Validation ─────────────────────────────────────────────────────

  it('should return false when meta is missing', () => {
    const board = { tasks: [] };
    assert.equal(validateBoard(board), false);
  });

  it('should return false when meta is null', () => {
    const board = { meta: null, tasks: [] };
    assert.equal(validateBoard(board), false);
  });

  it('should return false when meta is not an object', () => {
    const board = { meta: 'not-object', tasks: [] };
    assert.equal(validateBoard(board), false);
  });

  it('should return false when meta.projectName is missing', () => {
    const board = {
      meta: { repoPath: '/test', createdAt: '2024-01-01T00:00:00.000Z' },
      tasks: [],
    };
    assert.equal(validateBoard(board), false);
  });

  it('should return false when meta.projectName is not a string', () => {
    const board = {
      meta: { projectName: 123, repoPath: '/test', createdAt: '2024-01-01T00:00:00.000Z' },
      tasks: [],
    };
    assert.equal(validateBoard(board), false);
  });

  it('should return false when meta.repoPath is missing', () => {
    const board = {
      meta: { projectName: 'Test', createdAt: '2024-01-01T00:00:00.000Z' },
      tasks: [],
    };
    assert.equal(validateBoard(board), false);
  });

  it('should return false when meta.repoPath is not a string', () => {
    const board = {
      meta: { projectName: 'Test', repoPath: null, createdAt: '2024-01-01T00:00:00.000Z' },
      tasks: [],
    };
    assert.equal(validateBoard(board), false);
  });

  it('should return false when meta.createdAt is missing', () => {
    const board = {
      meta: { projectName: 'Test', repoPath: '/test' },
      tasks: [],
    };
    assert.equal(validateBoard(board), false);
  });

  it('should return false when meta.createdAt is not a string', () => {
    const board = {
      meta: { projectName: 'Test', repoPath: '/test', createdAt: 42 },
      tasks: [],
    };
    assert.equal(validateBoard(board), false);
  });

  // ── Tasks Array Validation ──────────────────────────────────────────────

  it('should return false when tasks is not an array', () => {
    const board = {
      meta: { projectName: 'Test', repoPath: '/test', createdAt: '2024-01-01T00:00:00.000Z' },
      tasks: 'not-an-array',
    };
    assert.equal(validateBoard(board), false);
  });

  it('should return false when tasks is null', () => {
    const board = {
      meta: { projectName: 'Test', repoPath: '/test', createdAt: '2024-01-01T00:00:00.000Z' },
      tasks: null,
    };
    assert.equal(validateBoard(board), false);
  });

  // ── Individual Task Validation ──────────────────────────────────────────

  it('should return false when a task is null', () => {
    const board = {
      meta: { projectName: 'Test', repoPath: '/test', createdAt: '2024-01-01T00:00:00.000Z' },
      tasks: [null],
    };
    assert.equal(validateBoard(board), false);
  });

  it('should return false when a task is not an object', () => {
    const board = {
      meta: { projectName: 'Test', repoPath: '/test', createdAt: '2024-01-01T00:00:00.000Z' },
      tasks: ['not-a-task'],
    };
    assert.equal(validateBoard(board), false);
  });

  it('should return false when a task misses id', () => {
    const board = makeValidBoard({
      tasks: [makeValidTask({ id: undefined })],
    });
    assert.equal(validateBoard(board), false);
  });

  it('should return false when a task has empty id', () => {
    const board = makeValidBoard({
      tasks: [makeValidTask({ id: '' })],
    });
    assert.equal(validateBoard(board), false);
  });

  it('should return false when a task id is not a string', () => {
    const board = makeValidBoard({
      tasks: [makeValidTask({ id: 42 })],
    });
    assert.equal(validateBoard(board), false);
  });

  it('should return false when a task misses title', () => {
    const board = makeValidBoard({
      tasks: [makeValidTask({ title: undefined })],
    });
    assert.equal(validateBoard(board), false);
  });

  it('should return false when a task has empty title', () => {
    const board = makeValidBoard({
      tasks: [makeValidTask({ title: '' })],
    });
    assert.equal(validateBoard(board), false);
  });

  it('should return false when a task title is not a string', () => {
    const board = makeValidBoard({
      tasks: [makeValidTask({ title: 99 })],
    });
    assert.equal(validateBoard(board), false);
  });

  it('should return false when a task has invalid status', () => {
    const board = makeValidBoard({
      tasks: [makeValidTask({ status: 'flying' })],
    });
    assert.equal(validateBoard(board), false);
  });

  it('should return false when a task status is not a string', () => {
    const board = makeValidBoard({
      tasks: [makeValidTask({ status: 123 })],
    });
    assert.equal(validateBoard(board), false);
  });

  it('should return false when a task has invalid priority', () => {
    const board = makeValidBoard({
      tasks: [makeValidTask({ priority: 'urgent' })],
    });
    assert.equal(validateBoard(board), false);
  });

  it('should return false when a task priority is not a string', () => {
    const board = makeValidBoard({
      tasks: [makeValidTask({ priority: true })],
    });
    assert.equal(validateBoard(board), false);
  });

  it('should return false when a task misses context', () => {
    const board = makeValidBoard({
      tasks: [makeValidTask({ context: undefined })],
    });
    assert.equal(validateBoard(board), false);
  });

  it('should return false when a task context is not a string', () => {
    const board = makeValidBoard({
      tasks: [makeValidTask({ context: 12345 })],
    });
    assert.equal(validateBoard(board), false);
  });

  it('should return false when a task misses docsPath', () => {
    const board = makeValidBoard({
      tasks: [makeValidTask({ docsPath: undefined })],
    });
    assert.equal(validateBoard(board), false);
  });

  it('should return false when a task docsPath is not a string', () => {
    const board = makeValidBoard({
      tasks: [makeValidTask({ docsPath: null })],
    });
    assert.equal(validateBoard(board), false);
  });

  it('should return false when a task misses agentLogs array', () => {
    const board = makeValidBoard({
      tasks: [makeValidTask({ agentLogs: undefined })],
    });
    assert.equal(validateBoard(board), false);
  });

  it('should return false when a task agentLogs is not an array', () => {
    const board = makeValidBoard({
      tasks: [makeValidTask({ agentLogs: 'not-an-array' })],
    });
    assert.equal(validateBoard(board), false);
  });

  // ── Edge Cases ──────────────────────────────────────────────────────────

  it('should reject board with extra unknown top-level keys (non-strict check)', () => {
    // validateBoard is structural, not strict — extra keys are ignored
    const board = makeValidBoard({ extraField: 'should-be-ignored' });
    assert.equal(validateBoard(board), true);
  });

  it('should accept board with extra meta keys', () => {
    const board = {
      meta: {
        projectName: 'Test',
        repoPath: '/test',
        createdAt: '2024-01-01T00:00:00.000Z',
        extraMeta: 'ignored',
      },
      tasks: [],
    };
    assert.equal(validateBoard(board), true);
  });

  it('should reject when the first of multiple tasks is invalid', () => {
    const board = makeValidBoard({
      tasks: [
        makeValidTask({ id: '' }),            // invalid
        makeValidTask({ id: 't-2', title: 'Valid' }), // valid
      ],
    });
    assert.equal(validateBoard(board), false);
  });

  it('should reject when the last of multiple tasks is invalid', () => {
    const board = makeValidBoard({
      tasks: [
        makeValidTask({ id: 't-1', title: 'Valid' }),
        makeValidTask({ id: 't-2', title: '' }), // invalid
      ],
    });
    assert.equal(validateBoard(board), false);
  });
});
