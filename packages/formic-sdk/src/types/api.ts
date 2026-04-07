// Sub-API interface types — verbatim copies from src/types/index.ts

import type { Task, CreateTaskInput } from './task.js';
import type { UISlot, ComponentType, RenderFunction, SidebarPanelDefinition, ToolbarActionDefinition } from './ui.js';
import type { TaskTypeDefinition, VerifierDefinition } from './pipeline.js';
import type { MemoryEntry } from './memory.js';
import type { WebhookHandler, BotCommandDefinition } from './integrations.js';
import type { Unsubscribe } from './plugin.js';

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

/** Generic typed key-value settings API */
export interface SettingsApi {
  get<T = unknown>(key: string, defaultValue?: T): Promise<T | undefined>;
  set<T = unknown>(key: string, value: T): Promise<void>;
}

export interface IntegrationApi {
  registerWebhook(path: string, handler: WebhookHandler): void;
  registerBotCommand(command: BotCommandDefinition): void;
  sendNotification(message: string): Promise<void>;
}

export interface MemoryApi {
  getLessons(filter?: { tags?: string[] }): Promise<MemoryEntry[]>;
  addLesson(lesson: Omit<MemoryEntry, 'id' | 'created_at'>): Promise<MemoryEntry>;
  onReflection(handler: (task: Task, lessons: MemoryEntry[]) => void): Unsubscribe;
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
