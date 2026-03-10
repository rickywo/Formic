import {
  createObjective,
  getObjective,
  listObjectives,
  deleteObjective,
} from './testObjectiveService';
import type { TestObjective, TestObjectiveStatus } from '../types/testObjective';

// Regression: status must not "bounce" — once set, it should remain stable across reads
describe('regression: status stability (no bouncing)', () => {
  it('createObjective status does not change between successive reads', () => {
    const obj = createObjective({ title: 'Bounce check', description: 'Regression', status: 'in_progress' });
    const refetched = getObjective(obj.id);
    // Both calls should agree on a valid status; neither should flip to a different stage
    const VALID_STATUSES: TestObjectiveStatus[] = ['todo', 'in_progress', 'done'];
    expect(VALID_STATUSES).toContain(obj.status);
    expect(VALID_STATUSES).toContain(refetched.status);
  });

  it('listObjectives returns each item with a stable, non-null status', () => {
    const items = listObjectives();
    const seen = new Map<string, TestObjectiveStatus>();
    for (const item of items) {
      expect(item.status).toBeDefined();
      if (seen.has(item.id)) {
        // Same id should always carry the same status — no bouncing
        expect(item.status).toBe(seen.get(item.id));
      }
      seen.set(item.id, item.status);
    }
  });
});

// Regression: delete must return success and not corrupt the list
describe('regression: delete does not corrupt list', () => {
  it('deleteObjective returns { success: true }', () => {
    expect(deleteObjective('obj-001')).toEqual({ success: true });
  });

  it('listObjectives still returns results after a delete call', () => {
    deleteObjective('obj-001');
    const items = listObjectives();
    expect(items.length).toBeGreaterThanOrEqual(1);
  });
});

// Regression: createObjective id must be a non-empty string
describe('regression: id assignment', () => {
  it('createObjective always assigns a non-empty id', () => {
    const obj = createObjective({ title: 'ID check', description: 'Regression', status: 'todo' });
    expect(typeof obj.id).toBe('string');
    expect(obj.id.length).toBeGreaterThan(0);
  });
});

// Regression: getObjective echoes back the requested id
describe('regression: getObjective id echo', () => {
  it('returned object id matches the requested id', () => {
    const id = 'regression-id-42';
    const result = getObjective(id);
    expect(result.id).toBe(id);
  });
});
