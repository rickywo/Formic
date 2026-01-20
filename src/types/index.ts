export type TaskStatus = 'todo' | 'running' | 'review' | 'done';
export type TaskPriority = 'low' | 'medium' | 'high';

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  context: string;
  docsPath: string;
  agentLogs: string[];
  pid: number | null;
}

export interface BoardMeta {
  projectName: string;
  repoPath: string;
  createdAt: string;
}

export interface Board {
  meta: BoardMeta;
  tasks: Task[];
  bootstrapRequired?: boolean;
  guidelinesPath?: string | null;
}

export interface CreateTaskInput {
  title: string;
  context: string;
  priority?: TaskPriority;
}

export interface UpdateTaskInput {
  title?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  context?: string;
}

export interface LogMessage {
  type: 'stdout' | 'stderr' | 'exit' | 'error';
  data: string;
  timestamp: string;
}
