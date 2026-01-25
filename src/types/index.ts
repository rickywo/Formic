export type TaskStatus = 'todo' | 'queued' | 'briefing' | 'planning' | 'running' | 'review' | 'done';
export type TaskPriority = 'low' | 'medium' | 'high';
export type WorkflowStep = 'pending' | 'brief' | 'plan' | 'execute' | 'complete';

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
  // Progress indicator (0-100, calculated from workflow stage + subtask completion)
  progress?: number;
  // Timestamps for queue ordering
  createdAt?: string;
  queuedAt?: string;
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
  workflowStep?: WorkflowStep;
  workflowLogs?: WorkflowLogs;
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

// AI Assistant Types
export type AssistantStatus = 'idle' | 'running' | 'error';

export interface AssistantMessage {
  type: 'user' | 'assistant' | 'system' | 'error';
  content: string;
  timestamp: string;
}

export interface AssistantSession {
  status: AssistantStatus;
  pid: number | null;
  startedAt: string | null;
  lastError: string | null;
}

// Output Parser Types (for agent-agnostic CLI output parsing)
export type OutputEventType = 'text' | 'result' | 'system' | 'error' | 'unknown';

export interface OutputParseResult {
  /** Type of parsed event */
  type: OutputEventType;
  /** Text content if available */
  content?: string;
  /** Whether this is the final result event */
  isFinal?: boolean;
  /** Raw event data for debugging */
  raw?: unknown;
}

// Workspace Management Types
export interface TaskCounts {
  todo: number;
  queued: number;
  briefing: number;
  planning: number;
  running: number;
  review: number;
  done: number;
}

export interface WorkspaceInfo {
  path: string;
  projectName: string;
  taskCounts: TaskCounts;
  formicInitialized: boolean;
  lastActivity: string | null;
}

export interface WorkspaceValidation {
  valid: boolean;
  exists: boolean;
  isDirectory: boolean;
  isWritable: boolean;
  hasFormic: boolean;
  error?: string;
}
