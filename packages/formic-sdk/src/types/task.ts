// Task-related types — verbatim copies from src/types/index.ts

export type TaskStatus = 'todo' | 'queued' | 'briefing' | 'planning' | 'declaring' | 'running' | 'architecting' | 'verifying' | 'review' | 'done' | 'blocked' | (string & {});
export type TaskPriority = 'low' | 'medium' | 'high';
export type WorkflowStep = 'pending' | 'brief' | 'plan' | 'declare' | 'execute' | 'verify' | 'architect' | 'complete' | (string & {});
export type TaskType = 'standard' | 'quick' | 'goal' | (string & {});

export interface WorkflowLogs {
  brief?: string | string[];
  plan?: string | string[];
  execute?: string | string[];
  verify?: string | string[];
  architect?: string | string[];
  [key: string]: string | string[] | undefined;
}

/** Declared files manifest produced by the declare skill */
export interface DeclaredFiles {
  exclusive: string[];
  shared: string[];
}

/** A detected file conflict for hotspot/shared files */
export interface FileConflict {
  filePath: string;
  expectedHash: string;
  actualHash: string;
  conflictingTaskId?: string;
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
  // Task type: 'standard' uses full workflow (brief → plan → execute), 'quick' skips to execute
  type?: TaskType;
  // Workflow fields
  workflowStep?: WorkflowStep;
  workflowLogs?: WorkflowLogs;
  // Progress indicator (0-100, calculated from workflow stage + subtask completion)
  progress?: number;
  // Timestamps for queue ordering
  createdAt?: string;
  queuedAt?: string;
  // Duration tracking timestamps
  startedAt?: string;
  completedAt?: string;
  // Whether this task has subtasks requiring manual user action (pending or skipped)
  hasManualSubtasks?: boolean;
  // Goal task: ID of the parent goal that spawned this task
  parentGoalId?: string;
  // Goal task: IDs of child tasks created by the architect
  childTaskIds?: string[];
  // DAG dependency fields: architect-assigned symbolic task IDs (for traceability)
  dependsOn?: string[];
  // DAG dependency fields: resolved Formic task IDs at child-task creation time
  dependsOnResolved?: string[];
  // Lease-based concurrency fields
  declaredFiles?: DeclaredFiles;
  leaseExpiresAt?: string;
  yieldCount?: number;
  /** Human-readable reason the task last yielded (e.g., 'lease-conflict:src/server/services/store.ts') */
  yieldReason?: string;
  /** When set, the queue processor resumes this task at the indicated step instead of running the full workflow */
  resumeFromStep?: WorkflowStep;
  fileConflicts?: FileConflict[];
  /** Commit SHA auto-saved before task execution (git rollback target) */
  safePointCommit?: string | null;
  /** Number of verification/retry attempts for this task */
  retryCount?: number | null;
  /** ID of the task that this task is a fix for (links auto-created fix tasks to originals) */
  fixForTaskId?: string | null;
  /** IDs of memory entries created by the reflection step for this task */
  reflectionMemories?: string[];
}

export interface CreateTaskInput {
  title: string;
  context: string;
  priority?: TaskPriority;
  type?: TaskType;
  /** If this task was auto-created as a fix for another task, the original task ID */
  fixForTaskId?: string | null;
  /** ID of the parent goal task that spawned this child task */
  parentGoalId?: string | null;
}
