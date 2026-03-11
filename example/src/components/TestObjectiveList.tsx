import React from 'react';
import { TestObjective } from '../types/testObjective';

const MOCK_OBJECTIVES: TestObjective[] = [
  {
    id: 'obj-001',
    title: 'Implement authentication',
    description: 'Add JWT-based user authentication to the API',
    status: 'done',
  },
  {
    id: 'obj-002',
    title: 'Build checkout flow',
    description: 'Implement full-stack e-commerce checkout with Stripe',
    status: 'in_progress',
  },
  {
    id: 'obj-003',
    title: 'Add product search',
    description: 'Implement full-text product search with filters',
    status: 'todo',
  },
];

export function TestObjectiveList(): React.ReactElement {
  return (
    <ul>
      {MOCK_OBJECTIVES.map((objective) => (
        <li key={objective.id}>
          <span>{objective.id}</span>
          <span>{objective.title}</span>
          <span>{objective.status}</span>
        </li>
      ))}
    </ul>
  );
}
