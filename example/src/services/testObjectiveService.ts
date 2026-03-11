import { TestObjective } from '../types/testObjective';

const MOCK_OBJECTIVE_1: TestObjective = {
  id: 'obj-001',
  title: 'Implement authentication',
  description: 'Add JWT-based user authentication to the API',
  status: 'done',
};

const MOCK_OBJECTIVE_2: TestObjective = {
  id: 'obj-002',
  title: 'Build checkout flow',
  description: 'Implement full-stack e-commerce checkout with Stripe',
  status: 'in_progress',
};

export function createObjective(input: Omit<TestObjective, 'id'>): TestObjective {
  return { id: 'obj-new', ...input };
}

export function getObjective(id: string): TestObjective {
  return { ...MOCK_OBJECTIVE_1, id };
}

export function listObjectives(): TestObjective[] {
  return [MOCK_OBJECTIVE_1, MOCK_OBJECTIVE_2];
}

export function deleteObjective(id: string): { success: boolean } {
  return { success: true };
}
