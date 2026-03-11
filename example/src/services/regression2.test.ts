import {
  createObjective,
  getObjective,
  listObjectives,
  deleteObjective,
} from './testObjectiveService';
import type { TestObjectiveStatus } from '../types/testObjective';

const VALID_STATUSES: TestObjectiveStatus[] = ['todo', 'in_progress', 'done'];

// Regression 2: repeated createObjective calls must each return a stable status
describe('regression 2: repeated create calls yield stable statuses', () => {
  it('two successive createObjective calls both have valid statuses', () => {
    const a = createObjective({ title: 'First', description: 'A', status: 'todo' });
    const b = createObjective({ title: 'Second', description: 'B', status: 'done' });

    expect(VALID_STATUSES).toContain(a.status);
    expect(VALID_STATUSES).toContain(b.status);
  });

  it('createObjective preserves each distinct status without cross-contamination', () => {
    const todo = createObjective({ title: 'T', description: 'D', status: 'todo' });
    const done = createObjective({ title: 'T', description: 'D', status: 'done' });

    expect(todo.status).toBe('todo');
    expect(done.status).toBe('done');
  });
});

// Regression 2: getObjective must not alter the status stored in a prior create
describe('regression 2: getObjective does not overwrite prior status', () => {
  it('getObjective for an unknown id still returns a valid status', () => {
    const result = getObjective('unknown-id-xyz');
    expect(VALID_STATUSES).toContain(result.status);
  });

  it('getObjective id echo is stable across two calls', () => {
    const id = 'bounce-regression-2';
    const first = getObjective(id);
    const second = getObjective(id);
    expect(first.id).toBe(id);
    expect(second.id).toBe(id);
  });
});

// Regression 2: listObjectives must not duplicate ids
describe('regression 2: listObjectives id uniqueness', () => {
  it('no duplicate ids in the list', () => {
    const items = listObjectives();
    const ids = items.map((i) => i.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });
});

// Regression 2: deleteObjective is idempotent-safe — calling twice must not throw
describe('regression 2: deleteObjective idempotency', () => {
  it('calling deleteObjective twice on the same id succeeds both times', () => {
    expect(deleteObjective('obj-002')).toEqual({ success: true });
    expect(deleteObjective('obj-002')).toEqual({ success: true });
  });

  it('deleteObjective on a non-existent id returns { success: true }', () => {
    expect(deleteObjective('does-not-exist')).toEqual({ success: true });
  });
});
