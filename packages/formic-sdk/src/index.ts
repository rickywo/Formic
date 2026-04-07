// @rickywo/formic-sdk — Barrel export
// Re-exports all plugin-facing types for Formic plugin development

// Task types
export type {
  TaskStatus,
  TaskPriority,
  TaskType,
  WorkflowStep,
  WorkflowLogs,
  DeclaredFiles,
  FileConflict,
  Task,
  CreateTaskInput,
} from './types/task.js';

// Plugin system types
export type {
  PluginPermission,
  PluginManifest,
  PluginConfig,
  PluginContext,
  Unsubscribe,
  FormicAPI,
  FormicPlugin,
} from './types/plugin.js';

// Sub-API interfaces
export type {
  TaskApi,
  SkillApi,
  UIApi,
  SettingsApi,
  IntegrationApi,
  MemoryApi,
  PluginLogger,
  EventApi,
} from './types/api.js';

// UI slot types and props
export type {
  UISlot,
  RenderFunction,
  ComponentType,
  SlotRegistration,
  SidebarPanelDefinition,
  ToolbarActionDefinition,
  KanbanCardBadgeProps,
  KanbanCardFooterProps,
  TaskNodeEditorProps,
  TaskStagePanelProps,
  DagVisualizationProps,
  TaskDetailSidebarProps,
  ToolbarRightProps,
  SettingsPanelProps,
} from './types/ui.js';

// Pipeline types
export type {
  StageDescriptor,
  StageRegistration,
  WorkflowPipeline,
  SkillOverride,
  TaskTypeDefinition,
  WorkflowStageDefinition,
  VerifierDefinition,
  VerifierResult,
} from './types/pipeline.js';

// Integration types
export type {
  WebhookHandler,
  WebhookResponse,
  BotCommandDefinition,
} from './types/integrations.js';

// Memory types
export type {
  MemoryType,
  MemoryEntry,
} from './types/memory.js';
