import {
  createObjective,
  getObjective,
  listObjectives,
  deleteObjective,
} from './testObjectiveService';
import type { TestObjective, TestObjectiveStatus } from '../types/testObjective';

const VALID_STATUSES: TestObjectiveStatus[] = ['todo', 'in_progress', 'done'];

describe('createObjective', () => {
  it('returns a TestObjective with id, title, description, and valid status', () => {
    const result = createObjective({ title: 'Test', description: 'Desc', status: 'todo' });

    expect(result).toHaveProperty('id');
    expect(result).toHaveProperty('title', 'Test');
    expect(result).toHaveProperty('description', 'Desc');
    expect(result).toHaveProperty('status');
    expect(VALID_STATUSES).toContain(result.status);
  });

  it('preserves the provided status value', () => {
    const result = createObjective({ title: 'X', description: 'Y', status: 'in_progress' });
    expect(result.status).toBe('in_progress');
  });
});

describe('getObjective', () => {
  it('returns a TestObjective whose id matches the passed-in id', () => {
    const result = getObjective('obj-test');

    expect(result).toHaveProperty('id', 'obj-test');
    expect(result).toHaveProperty('title');
    expect(result).toHaveProperty('description');
    expect(VALID_STATUSES).toContain(result.status);
  });
});

describe('listObjectives', () => {
  it('returns a non-empty array of TestObjective objects', () => {
    const result = listObjectives();

    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it('each element has id, title, description, and valid status', () => {
    const result = listObjectives();

    for (const item of result) {
      expect(item).toHaveProperty('id');
      expect(item).toHaveProperty('title');
      expect(item).toHaveProperty('description');
      expect(VALID_STATUSES).toContain(item.status);
    }
  });
});

describe('deleteObjective', () => {
  it('returns { success: true }', () => {
    const result = deleteObjective('obj-001');
    expect(result).toEqual({ success: true });
  });
});
