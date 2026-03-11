export type TestObjectiveStatus = 'todo' | 'in_progress' | 'done';

export interface TestObjective {
  id: string;
  title: string;
  description: string;
  status: TestObjectiveStatus;
}
