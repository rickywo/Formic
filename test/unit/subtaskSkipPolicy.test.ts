import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatInvalidSkippedSubtasksWarning, getInvalidSkippedSubtasks } from '../../src/server/services/subtasks.js';
import type { SubtasksFile } from '../../src/types/index.js';

function makeSubtasks(contents: Array<{ content: string; status: 'completed' | 'skipped' }>): SubtasksFile {
  return {
    version: '1.0', taskId: 't-policy', title: 'policy', createdAt: '', updatedAt: '',
    subtasks: contents.map((subtask, index) => ({ id: String(index + 1), ...subtask })),
  };
}

describe('skipped subtask verification policy', () => {
  it('allows subjective human review and unavailable external access', () => {
    const subtasks = makeSubtasks([
      { status: 'skipped', content: 'Perform subjective visual design review with a human stakeholder.' },
      { status: 'skipped', content: 'Confirm the production partner dashboard, which is unavailable to this agent.' },
    ]);
    assert.deepStrictEqual(getInvalidSkippedSubtasks(subtasks), []);
  });

  it('rejects skipped automated engineering work', () => {
    const subtasks = makeSubtasks([
      { status: 'skipped', content: 'Write unit tests for the new service.' },
      { status: 'skipped', content: 'Run integration tests and npm test.' },
      { status: 'skipped', content: 'Run type-check, build, lint, and local fixture verification.' },
    ]);
    const warning = formatInvalidSkippedSubtasksWarning('t-policy', subtasks);
    assert.match(warning ?? '', /1 \(Write unit tests/);
    assert.match(warning ?? '', /2 \(Run integration tests/);
    assert.match(warning ?? '', /3 \(Run type-check/);
  });

  it('rejects mixed wording when it includes automatable work', () => {
    const subtasks = makeSubtasks([
      { status: 'skipped', content: 'Ask a human to review the page and run the local test fixture.' },
    ]);
    assert.strictEqual(getInvalidSkippedSubtasks(subtasks).length, 1);
  });
});
