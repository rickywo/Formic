export type TaskStatus = 'todo' | 'queued' | 'briefing' | 'planning' | 'running' | 'review' | 'done';
export type TaskPriority = 'low' | 'medium' | 'high';
export type WorkflowStep = 'pending' | 'brief' | 'plan' | 'execute' | 'complete';
export type BranchStatus = 'created' | 'ahead' | 'behind' | 'conflicts' | 'merged';

export interface WorkflowLogs {
  brief?: string[];
  plan?: string[];
  execute?: string[];
}

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  context: string;
  docsPath: string;
  agentLogs: string[];
  pid: number | null;
  // Workflow fields
  workflowStep?: WorkflowStep;
  workflowLogs?: WorkflowLogs;
  // Branch fields (Phase 11)
  branch?: string;
  branchStatus?: BranchStatus;
  baseBranch?: string;
  createdAt?: string;
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
  baseBranch?: string;
}

export interface UpdateTaskInput {
  title?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  context?: string;
  workflowStep?: WorkflowStep;
  workflowLogs?: WorkflowLogs;
  // Branch fields (Phase 11)
  branch?: string;
  branchStatus?: BranchStatus;
  baseBranch?: string;
}

export interface LogMessage {
  type: 'stdout' | 'stderr' | 'exit' | 'error';
  data: string;
  timestamp: string;
}

// Subtask Management Types (Phase 9)
export type SubtaskStatus = 'pending' | 'in_progress' | 'completed';

export interface Subtask {
  id: string;
  content: string;
  status: SubtaskStatus;
  completedAt?: string; // ISO 8601 timestamp
}

export interface SubtasksFile {
  version: string;
  taskId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  subtasks: Subtask[];
}
