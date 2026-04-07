// UI slot types and prop types — verbatim copies from src/types/index.ts

import type { Task } from './task.js';

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

/** Vanilla JS render function for mounting plugin UI into a container element */
export type RenderFunction<P extends Record<string, unknown> = Record<string, unknown>> = (container: HTMLElement, props: P) => void | (() => void);

/** React-compatible component type — supports both class-based and functional components */
export type ComponentType<P extends Record<string, unknown> = Record<string, unknown>> = { new(props: P): unknown } | ((props: P) => unknown);

/** Metadata-only registration record for a server-side slot (transmittable over HTTP) */
export interface SlotRegistration {
  slotId: UISlot;
  componentType: 'render-function' | 'react-component';
  pluginName: string;
  /** Serialized metadata — actual render functions cannot be transmitted over HTTP */
  meta?: Record<string, unknown>;
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
