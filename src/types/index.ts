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

// ==================== Usage Meter Types ====================

/** Status of the agent usage meter */
export type UsageStatus = 'ok' | 'warning' | 'critical' | 'unknown';

/** Usage information returned by the /api/usage endpoint */
export interface UsageInfo {
  /** Configured agent type */
  agent: string;
  /** Credits or units consumed */
  used: number;
  /** Total credit/unit limit */
  limit: number;
  /** Percentage of limit consumed (0–100) */
  percentage: number;
  /** Human-readable label (e.g., "1,847 / 2,500 credits") */
  label: string;
  /** Threshold status: ok (>50% remaining), warning (10–50%), critical (<10%), unknown */
  status: UsageStatus;
}

// ==================== Plugin System Types ====================

/** Allowed plugin permission values */
export type PluginPermission =
  | 'tasks:read'
  | 'tasks:write'
  | 'config:read'
  | 'config:write'
  | 'http:outbound'
  | 'fs:workspace'
  | 'process:info'
  | 'events:subscribe'
  | 'ui:panel'
  | 'workflow:extend'
  | 'skills:override';

/** Error thrown when a plugin attempts an action it lacks permission for */
export class PluginPermissionError extends Error {
  public readonly pluginName: string;
  public readonly permission: string;

  constructor(pluginName: string, permission: string) {
    super(`Plugin "${pluginName}" lacks permission "${permission}"`);
    this.name = 'PluginPermissionError';
    this.pluginName = pluginName;
    this.permission = permission;
  }
}

/**
 * Sandboxed context object provided to plugins.
 * @deprecated Use FormicAPI instead. PluginContext will be removed in a future version.
 */
export interface PluginContext {
  board: {
    getTasks(): Promise<Task[]>;
    getTask(id: string): Promise<Task | null>;
    onUpdate(cb: (board: Board) => void): void;
  };
  tasks: {
    create(data: CreateTaskInput): Promise<Task>;
    update(id: string, data: Partial<Task>): Promise<Task>;
  };
  config: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
  };
  events: {
    on(event: string, handler: (...args: unknown[]) => void): void;
    off(event: string, handler: (...args: unknown[]) => void): void;
  };
  logger: {
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
  };
  http: {
    fetch(url: string, options?: RequestInit): Promise<Response>;
  };
  process: {
    uptime(): number;
    memoryUsage(): NodeJS.MemoryUsage;
  };
  workflow: {
    registerStage(config: StageRegistration): Promise<void>;
    getStages(): Promise<StageDescriptor[]>;
  };
  skills: {
    register(stageName: string, content: string): Promise<void>;
    getAvailable(): Promise<string[]>;
  };
}

/** Manifest schema for a plugin's manifest.json */
export interface PluginManifest {
  /** Plugin name (required, kebab-case) */
  name: string;
  /** Semver version string (required) */
  version: string;
  /** Human-readable description */
  description?: string;
  /** Author name or identifier */
  author?: string;
  /** Minimum Formic version required (semver) */
  minFormicVersion?: string;
  /** Declared permissions the plugin requires */
  permissions?: PluginPermission[];
  /** Relative path to the server-side Fastify plugin entry point */
  serverEntry?: string;
  /** Relative path to the client-side module entry point */
  clientEntry?: string;
  /** Default settings with their initial values */
  settings?: Record<string, unknown>;
}

/** Runtime state of a discovered plugin */
export interface PluginEntry {
  /** Parsed and validated manifest */
  manifest: PluginManifest;
  /** Current lifecycle status */
  status: 'discovered' | 'loaded' | 'enabled' | 'disabled' | 'error';
  /** Error message if status is 'error' */
  error?: string;
  /** Reference to the dynamically imported server module */
  loadedModule?: unknown;
  /** Absolute path to the plugin directory */
  pluginDir: string;
  /** Instantiated class-based plugin (undefined for legacy plugins) */
  pluginInstance?: FormicPlugin;
  /** Which loading path was used */
  format?: 'legacy' | 'class';
  /** Dispose function returned by createFormicAPI() — cleans up API-level event subscriptions */
  apiDispose?: () => void;
}

// ==================== Configurable Pipeline Types ====================

/** Describes a single pipeline stage in the workflow */
export interface StageDescriptor {
  /** Unique stage identifier (e.g., 'brief', 'plan', 'lint') */
  name: string;
  /** Human-readable label for board UI */
  displayName: string;
  /** Skill to load (maps to skills/{skillName}/SKILL.md or plugin-provided content) */
  skillName: string;
  /** The TaskStatus value to set when this stage is active */
  taskStatus: string;
  /** The WorkflowStep value for this stage */
  workflowStep: string;
  /** Whether this stage is core or plugin-contributed */
  source: 'builtin' | 'plugin';
  /** Which plugin registered this stage (if source is 'plugin') */
  pluginName?: string;
  /** Position in the pipeline sequence */
  order: number;
  /** Optional custom handler identifier */
  handler?: string;
}

/** Input type for plugins registering a custom stage */
export interface StageRegistration {
  /** Unique stage name */
  name: string;
  /** Human-readable label */
  displayName: string;
  /** Insert after this existing stage name */
  after: string;
  /** Inline skill prompt content */
  skillContent?: string;
  /** Path to skill file */
  skillPath?: string;
  /** Custom execution handler */
  handler?: (taskId: string) => Promise<void>;
}

/** Ordered array of StageDescriptor objects representing the full pipeline */
export type WorkflowPipeline = StageDescriptor[];

/** Plugin skill override registration */
export interface SkillOverride {
  /** Stage name to override */
  stageName: string;
  /** Override skill content */
  content: string;
  /** Plugin that registered this override */
  pluginName: string;
}

/** Persisted plugin configuration (enabled state + user settings) */
export interface PluginConfig {
  /** Whether the plugin is enabled */
  enabled: boolean;
  /** User-configurable settings */
  settings: Record<string, unknown>;
}

// ==================== Next-Gen Plugin API Types ====================

/** Callback disposal handle returned by event subscription methods */
export type Unsubscribe = () => void;

/** Defines a custom task type that plugins can register */
export interface TaskTypeDefinition {
  /** Unique identifier for the task type */
  id: string;
  /** Human-readable label */
  label: string;
  /** Optional icon identifier */
  icon?: string;
  /** Ordered workflow stages for this task type */
  workflow: StageDescriptor[];
  /** Optional skill prompt content */
  skillPrompt?: string;
}

/** Defines a single stage within a workflow */
export interface WorkflowStageDefinition {
  /** Stage identifier */
  name: string;
  /** Human-readable display name */
  displayName: string;
  /** Optional skill name to invoke during this stage */
  skillName?: string;
  /** Optional custom handler function for this stage */
  handler?: (taskId: string) => Promise<void>;
}

/** Defines a custom verification step that plugins can register */
export interface VerifierDefinition {
  /** Unique identifier for the verifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Name of the plugin that registered this verifier */
  pluginName: string;
  /** Optional description of what this verifier checks */
  description?: string;
  /** Verification handler — receives task ID, returns pass/fail with message and optional details */
  verify(taskId: string): Promise<VerifierResult>;
}

/** Result returned by a verifier's verify method */
export interface VerifierResult {
  /** Whether the verification passed */
  passed: boolean;
  /** Optional human-readable message */
  message?: string;
  /** Optional detailed output (e.g., test logs, diff) */
  details?: string;
}

/** Task read/write access and lifecycle event hooks */
export interface TaskApi {
  getTask(id: string): Promise<Task | null>;
  getAllTasks(): Promise<Task[]>;
  createTask(data: CreateTaskInput): Promise<Task>;
  updateTask(id: string, data: Partial<Task>): Promise<Task>;
  onTaskCreated(handler: (task: Task) => void): Unsubscribe;
  onTaskUpdated(handler: (task: Task) => void): Unsubscribe;
  onTaskCompleted(handler: (task: Task) => void): Unsubscribe;
  onTaskFailed(handler: (task: Task, error: string) => void): Unsubscribe;
  onStageChanged(handler: (task: Task, fromStage: string, toStage: string) => void): Unsubscribe;
}

/** Skill and workflow registration API */
export interface SkillApi {
  register(stageName: string, content: string): Promise<void>;
  registerTaskType(definition: TaskTypeDefinition): void;
  registerVerifier(verifier: VerifierDefinition): void;
  registerSkillOverride(stageName: string, content: string): void;
  getAvailable(): Promise<string[]>;
}

/** Generic typed key-value settings API */
export interface SettingsApi {
  get<T = unknown>(key: string, defaultValue?: T): Promise<T | undefined>;
  set<T = unknown>(key: string, value: T): Promise<void>;
}

/** Plugin-scoped logger with prefixed output */
export interface PluginLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/** Event subscription and unsubscription API */
export interface EventApi {
  on(event: string, handler: (...args: unknown[]) => void): Unsubscribe;
  off(event: string, handler: (...args: unknown[]) => void): void;
}

/** Definition for a sidebar panel extension */
export interface SidebarPanelDefinition {
  id: string;
  title: string;
  icon?: string;
  mountPoint: UISlot | string;
}

/** Definition for a toolbar action extension */
export interface ToolbarActionDefinition {
  id: string;
  label: string;
  icon?: string;
  onClick: () => void;
}

/** Vanilla JS render function for mounting plugin UI into a container element */
export type RenderFunction<P extends Record<string, unknown> = Record<string, unknown>> = (container: HTMLElement, props: P) => void | (() => void);

/** React-compatible component type — supports both class-based and functional components */
export type ComponentType<P extends Record<string, unknown> = Record<string, unknown>> = { new(props: P): unknown } | ((props: P) => unknown);

/** Named UI extension slots */
export type UISlot =
  | 'task-node-editor'
  | 'task-stage-panel'
  | 'dag-visualization'
  | 'kanban-card-badge'
  | 'kanban-card-footer'
  | 'settings-panel'
  | 'task-detail-sidebar'
  | 'toolbar-right';

/** Props for the kanban-card-badge slot */
export interface KanbanCardBadgeProps {
  task: Task;
}

/** Props for the kanban-card-footer slot */
export interface KanbanCardFooterProps {
  task: Task;
}

/** Props for the task-node-editor slot */
export interface TaskNodeEditorProps {
  task: Task;
  onUpdate: (patch: Partial<Task>) => void;
}

/** Props for the task-stage-panel slot */
export interface TaskStagePanelProps {
  task: Task;
  stage: string;
  onUpdate: (patch: Partial<Task>) => void;
}

/** Props for the dag-visualization slot */
export interface DagVisualizationProps {
  tasks: Task[];
  edges: Array<{ from: string; to: string }>;
}

/** Props for the task-detail-sidebar slot */
export interface TaskDetailSidebarProps {
  task: Task;
}

/** Props for the toolbar-right slot */
export type ToolbarRightProps = Record<string, never>;

/** Props for the settings-panel slot */
export type SettingsPanelProps = Record<string, never>;

/** Slot-based UI extension API */
export interface UIApi {
  /** Register a component or render function against a named slot */
  registerSlot(slotId: UISlot, component: ComponentType<Record<string, unknown>> | RenderFunction<Record<string, unknown>>): Unsubscribe;
  /** Unregister a previously registered component or render function from a slot */
  unregisterSlot(slotId: UISlot, component: ComponentType<Record<string, unknown>> | RenderFunction<Record<string, unknown>>): void;
  /** Register a sidebar panel extension */
  registerSidebarPanel(panel: SidebarPanelDefinition): Unsubscribe;
  /** Register a toolbar action extension */
  registerToolbarAction(action: ToolbarActionDefinition): Unsubscribe;
}

/** @todo External service integration API — future implementation */
export interface IntegrationApi {
  /** TODO: Register an external integration */
  register(name: string, config: Record<string, unknown>): void;
}

/** @todo Plugin memory / state persistence API — future implementation */
export interface MemoryApi {
  /** TODO: Retrieve relevant memory entries by tags */
  getRelevant(tags: string[]): Promise<MemoryEntry[]>;
  /** TODO: Add a new memory entry */
  add(entry: Omit<MemoryEntry, 'id' | 'created_at'>): Promise<MemoryEntry>;
}

/** Aggregated API surface exposed to plugins via onLoad */
export interface FormicAPI {
  ui: UIApi;
  tasks: TaskApi;
  skills: SkillApi;
  settings: SettingsApi;
  integrations: IntegrationApi;
  memory: MemoryApi;
  logger: PluginLogger;
  events: EventApi;
}

/** Next-generation plugin contract */
export interface FormicPlugin {
  id: string;
  name: string;
  version: string;
  description?: string;
  onLoad(api: FormicAPI): Promise<void>;
  onUnload(): Promise<void>;
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

/** Manifest file stored alongside each tool script in .formic/tools/ */
export interface ToolManifest {
  /** Tool name (kebab-case, unique) */
  name: string;
  /** Human-readable description of what the tool does */
  description: string;
  /** Shell command template; use {{file}} as a placeholder for a target file path */
  command: string;
  /** Task ID that created this tool */
  created_by: string;
  /** Number of times the tool has been invoked */
  usage_count: number;
}

/** A resolved tool entry (manifest + resolved script path) */
export interface Tool {
  /** Tool name (matches manifest name) */
  name: string;
  /** Absolute path to the tool script */
  scriptPath: string;
  /** Absolute path to the manifest.json */
  manifestPath: string;
  /** Parsed manifest data */
  manifest: ToolManifest;
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
  /** Whether the queue processor is currently running (for AGI kill switch monitoring) */
  queueEnabled?: boolean;
  /** Task counts per status (for AGI phase health metrics) */
  counts?: TaskCounts;
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
  /** ID of the parent goal task that spawned this child task */
  parentGoalId?: string | null;
}

export interface UpdateTaskInput {
  title?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  context?: string;
  workflowStep?: WorkflowStep;
  workflowLogs?: WorkflowLogs;
  safePointCommit?: string | null;
  /** OS process ID of the child process executing this task */
  pid?: number | null;
  /** Number of verification/retry attempts — patchable for critic kill-switch logic */
  retryCount?: number | null;
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
export type OutputEventType = 'text' | 'result' | 'system' | 'error' | 'status' | 'unknown';

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
  // Execution retry limit (prevents infinite re-queue on repeated failures)
  maxExecutionRetries?: number;
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
  /** Plugin enabled/disabled state and user settings */
  plugins?: Record<string, PluginConfig>;
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

// ==================== Plugin Marketplace Types ====================

/** A single entry from the community plugin registry */
export interface RegistryEntry {
  /** Unique plugin identifier, e.g. 'com.acme.gantt-view' */
  id: string;
  /** Human-readable plugin name */
  name: string;
  /** Short description of the plugin */
  description: string;
  /** Plugin author name or organisation */
  author: string;
  /** npm package name, e.g. '@acme/formic-gantt-view' */
  npm: string;
  /** Latest published version available in the registry */
  version: string;
  /** Searchable tags for categorisation */
  tags: string[];
  /** Whether the plugin has been verified by the Formic team */
  verified: boolean;
}

/** Query parameters for filtering the plugin registry */
export interface MarketplaceFilter {
  /** Free-text search against name and description */
  query?: string;
  /** Restrict results to entries that match all provided tags */
  tags?: string[];
  /** When true, return only verified plugins */
  verified?: boolean;
  /** 1-based page number for pagination */
  page?: number;
  /** Number of results per page */
  pageSize?: number;
}

/** Represents an available update for an installed plugin */
export interface MarketplaceUpdate {
  /** Local plugin identifier (matches installed plugin name) */
  pluginId: string;
  /** Currently installed version */
  installedVersion: string;
  /** Latest version available in the registry */
  latestVersion: string;
  /** Full registry listing for the updated plugin */
  registryEntry: RegistryEntry;
}

/** Request body for installing a plugin from the marketplace */
export interface MarketplaceInstallRequest {
  /** RegistryEntry.id of the plugin to install */
  id: string;
  /** When true, user has confirmed the unverified-plugin warning */
  confirmed?: boolean;
}
