export type TaskStatus = 'todo' | 'queued' | 'briefing' | 'planning' | 'declaring' | 'running' | 'architecting' | 'verifying' | 'review' | 'done' | 'blocked';
export type TaskPriority = 'low' | 'medium' | 'high';
export type WorkflowStep = 'pending' | 'brief' | 'plan' | 'declare' | 'execute' | 'verify' | 'architect' | 'complete';
export type TaskType = 'standard' | 'quick' | 'goal';

export interface WorkflowLogs {
  brief?: string[];
  plan?: string[];
  execute?: string[];
  verify?: string[];
  architect?: string[];
}

// ==================== Lease-Based Concurrency Types ====================

/** Declared files manifest produced by the declare skill */
export interface DeclaredFiles {
  exclusive: string[];
  shared: string[];
}

/** A file lease granting a task exclusive access to a file */
export interface FileLease {
  filePath: string;
  taskId: string;
  acquiredAt: string;
  expiresAt: string;
  leaseType: 'exclusive' | 'shared';
  yieldSignal?: boolean;
}

/** Persisted lease store snapshot written to .formic/leases.json */
export interface LeaseStoreSnapshot {
  version: string;
  savedAt: string;
  leases: Array<{ key: string; lease: FileLease }>;
}

/** Request to acquire file leases for a task */
export interface LeaseRequest {
  taskId: string;
  exclusiveFiles: string[];
  sharedFiles: string[];
  leaseDurationMs?: number;
}

/** Result of a lease acquisition attempt */
export interface LeaseResult {
  granted: boolean;
  leases: FileLease[];
  conflictingFiles: string[];
}

/** A detected file conflict for hotspot/shared files */
export interface FileConflict {
  filePath: string;
  expectedHash: string;
  actualHash: string;
  conflictingTaskId?: string;
}

/** Result of a merge attempt on conflicting files */
export interface MergeResult {
  success: boolean;
  conflicts: FileConflict[];
}

// ==================== Long-Term Memory Types ====================

/** Type of memory: learned pattern, known pitfall, or user preference */
export type MemoryType = 'pattern' | 'pitfall' | 'preference';

/** A single memory entry persisted by the reflection step */
export interface MemoryEntry {
  /** Unique ID (mem-{uuid}) */
  id: string;
  /** Category of memory */
  type: MemoryType;
  /** Human-readable description of the memory */
  content: string;
  /** Task ID that generated this memory */
  source_task: string;
  /** ISO-8601 creation timestamp */
  created_at: string;
  /** Tags for relevance matching (file paths, keywords) */
  relevance_tags: string[];
}

/** Root schema for .formic/memory.json */
export interface MemoryStore {
  version: string;
  entries: MemoryEntry[];
}

// ==================== Tool Forging Types ====================

/** A single reusable tool created and registered by an agent */
export interface Tool {
  /** Unique tool name (slug, e.g. 'run-eslint-fix') */
  name: string;
  /** Human-readable description of what the tool does */
  description: string;
  /** Shell command to execute this tool (may contain {args} placeholder) */
  command: string;
  /** Task ID that originally created this tool */
  created_by: string;
  /** ISO-8601 creation timestamp */
  created_at: string;
  /** Number of times this tool has been invoked */
  usage_count: number;
}

/** Root schema for .formic/tools/tools.json */
export interface ToolStore {
  version: string;
  tools: Tool[];
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
  type?: TaskType;
  /** If this task was auto-created as a fix for another task, the original task ID */
  fixForTaskId?: string | null;
}

export interface UpdateTaskInput {
  title?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  context?: string;
  workflowStep?: WorkflowStep;
  workflowLogs?: WorkflowLogs;
  safePointCommit?: string | null;
  yieldCount?: number;
  yieldReason?: string;
  /** When set, routes the task directly to this step instead of the full workflow on next dispatch */
  resumeFromStep?: WorkflowStep;
  reflectionMemories?: string[];
  startedAt?: string;
  completedAt?: string;
}

export interface LogMessage {
  type: 'stdout' | 'stderr' | 'exit' | 'error';
  data: string;
  timestamp: string;
}

// Subtask Management Types (Phase 9)
// 'skipped' status is for subtasks that require manual verification and cannot be automated
export type SubtaskStatus = 'pending' | 'in_progress' | 'completed' | 'skipped';

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

// ==================== Queue Analysis Types ====================

/** Per-task scoring entry returned by getQueueAnalysis() for observability/debugging */
export interface QueueAnalysisEntry {
  /** ID of the queued task */
  taskId: string;
  /** Computed priority score (higher = picked first) */
  score: number;
  /** Number of transitively blocked tasks that would become runnable after this task completes */
  unblockingPotential: number;
  /** Human-readable breakdown of the score components */
  reasoning: string;
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
  declaring: number;
  running: number;
  architecting: number;
  verifying: number;
  review: number;
  done: number;
  blocked: number;
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

// ==================== Global Config Types ====================

/** A workspace entry in the global config */
export interface ConfigWorkspace {
  /** Unique workspace identifier (ws-{uuid}) */
  id: string;
  /** Absolute path to the workspace directory */
  path: string;
  /** Display name for the workspace */
  name: string;
  /** Hex color for visual differentiation */
  color: string;
  /** ISO-8601 timestamp of last access */
  lastAccessed: string;
}

/** User settings stored in global config */
export interface ConfigSettings {
  maxConcurrentSessions: number;
  theme: string;
  notificationsEnabled: boolean;
  projectBriefCollapsed: boolean;
  // Execution settings
  verifyCommand: string;
  skipVerify: boolean;
  maxExecuteIterations: number;
  stepTimeoutMs: number;
  // Queue & concurrency settings
  queuePollIntervalMs: number;
  maxYieldCount: number;
  // Lease management settings
  leaseDurationMs: number;
  watchdogIntervalMs: number;
}

/** Root schema for ~/.formic/config.json */
export interface FormicConfig {
  /** Schema version for future migrations */
  version: number;
  /** Registered workspaces */
  workspaces: ConfigWorkspace[];
  /** ID of the currently active workspace, or null */
  activeWorkspaceId: string | null;
  /** User settings */
  settings: ConfigSettings;
}

// CLI Server Options
export interface ServerOptions {
  /** Server port (default: 8000) */
  port?: number;
  /** Server host (default: 0.0.0.0) */
  host?: string;
  /** Workspace directory path (default: process.cwd()) */
  workspacePath?: string;
}

// ==================== Messaging Integration Types ====================

/** Supported messaging platforms */
export type MessagingPlatform = 'telegram' | 'line';

/** Notification preferences for a chat session */
export interface NotificationPreferences {
  onTaskComplete: boolean;
  onTaskFailed: boolean;
  onReviewReady: boolean;
}

/** A linked chat session that can receive notifications and commands */
export interface MessagingSession {
  /** Unique session ID (platform:chatId) */
  id: string;
  /** Platform type */
  platform: MessagingPlatform;
  /** Platform-specific chat/channel ID */
  chatId: string;
  /** Platform-specific user ID (who linked the chat) */
  userId: string;
  /** Optional user display name */
  userName?: string;
  /** Workspace path this chat is linked to */
  workspacePath: string;
  /** Notification preferences */
  notifications: NotificationPreferences;
  /** When the session was created */
  createdAt: string;
  /** When the session was last active */
  lastActiveAt: string;
}

/** Structure of the messaging.json file */
export interface MessagingStore {
  version: string;
  sessions: MessagingSession[];
}

/** Parsed command from a messaging platform */
export interface MessagingCommand {
  /** Command name (board, status, run, start, help) */
  name: string;
  /** Command arguments (e.g., task ID) */
  args: string[];
  /** Raw message text */
  rawText: string;
}

/** Incoming message from a messaging platform */
export interface IncomingMessage {
  /** Platform type */
  platform: MessagingPlatform;
  /** Platform-specific chat ID */
  chatId: string;
  /** Platform-specific user ID */
  userId: string;
  /** User display name */
  userName?: string;
  /** Message text content */
  text: string;
  /** Platform-specific message ID */
  messageId: string;
  /** Timestamp */
  timestamp: string;
}

/** Outgoing message to a messaging platform */
export interface OutgoingMessage {
  /** Chat ID to send to */
  chatId: string;
  /** Message text (supports markdown for Telegram, plain text for Line) */
  text: string;
  /** Optional inline keyboard buttons (Telegram) or quick reply (Line) */
  buttons?: MessageButton[];
  /** Parse mode for text (markdown, html, plain) */
  parseMode?: 'markdown' | 'html' | 'plain';
  /** Optional media attachment (photo/image) */
  media?: MediaAttachment;
}

/** Button for inline keyboards/quick replies */
export interface MessageButton {
  /** Button label */
  label: string;
  /** Callback data or URL */
  data: string;
  /** Button type */
  type: 'callback' | 'url';
}

/** Configuration for messaging integrations */
export interface MessagingConfig {
  telegram: {
    enabled: boolean;
    botToken?: string;
  };
  line: {
    enabled: boolean;
    channelAccessToken?: string;
    channelSecret?: string;
  };
}

/** Result of sending a message */
export interface SendMessageResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

// ==================== AI Conversation Types for Messaging ====================

/** Role of a message in AI conversation */
export type AIConversationRole = 'user' | 'assistant';

/** A message in the AI conversation history */
export interface AIConversationMessage {
  /** Role of the message sender */
  role: AIConversationRole;
  /** Message content */
  content: string;
  /** Timestamp of the message */
  timestamp: string;
}

/** AI conversation history for a messaging session */
export interface AIConversationHistory {
  /** List of messages in chronological order */
  messages: AIConversationMessage[];
  /** When the conversation was last updated */
  lastUpdatedAt: string;
}

/** Extended messaging session with AI capabilities */
export interface MessagingSessionAI extends MessagingSession {
  /** Whether AI mode is enabled for this session */
  aiEnabled: boolean;
  /** AI conversation history */
  conversationHistory?: AIConversationHistory;
}

// ==================== Media/Image Types for Messaging ====================

/** Source type for media attachments */
export type MediaSource = 'url' | 'file' | 'buffer';

/** Media attachment for outgoing messages */
export interface MediaAttachment {
  /** Type of media (currently only photo supported) */
  type: 'photo';
  /** Source type: URL, file path, or Buffer */
  source: MediaSource;
  /** URL string, file path, or base64-encoded Buffer data */
  data: string;
  /** Optional caption for the media */
  caption?: string;
}

/** LINE image message format */
export interface LineImageMessage {
  type: 'image';
  /** URL of the original image (max 10MB) */
  originalContentUrl: string;
  /** URL of the preview image (max 1MB) */
  previewImageUrl: string;
}
