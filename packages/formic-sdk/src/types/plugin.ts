// Plugin system types — verbatim copies from src/types/index.ts

import type { Task, CreateTaskInput, TaskPriority, TaskType } from './task.js';
import type { UIApi } from './api.js';
import type { TaskApi, SkillApi, SettingsApi, IntegrationApi, MemoryApi, EventApi, PluginLogger } from './api.js';
import type { StageDescriptor, StageRegistration } from './pipeline.js';

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
  | 'skills:override'
  | 'integrations:webhook'
  | 'integrations:notify'
  | 'memory:read'
  | 'memory:write';

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

/** Persisted plugin configuration (enabled state + user settings) */
export interface PluginConfig {
  /** Whether the plugin is enabled */
  enabled: boolean;
  /** User-configurable settings */
  settings: Record<string, unknown>;
}

/**
 * Sandboxed context object provided to plugins.
 * @deprecated Use FormicAPI instead. PluginContext will be removed in a future version.
 */
export interface PluginContext {
  board: {
    getTasks(): Promise<Task[]>;
    getTask(id: string): Promise<Task | null>;
    onUpdate(cb: (board: { meta: unknown; tasks: Task[] }) => void): void;
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

/** Callback disposal handle returned by event subscription methods */
export type Unsubscribe = () => void;

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
