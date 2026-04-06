/**
 * Plugin Context Factory
 *
 * Creates a sandboxed, permission-gated context object for plugins to interact
 * with Formic's server-side capabilities. Each method checks the plugin's declared
 * permissions before delegating to the underlying service.
 */

import type {
  PluginManifest,
  PluginContext,
  PluginPermission,
  Task,
  CreateTaskInput,
  Board,
  StageRegistration,
  StageDescriptor,
  FormicAPI,
  TaskApi,
  SkillApi,
  SettingsApi,
  UIApi,
  IntegrationApi,
  MemoryApi,
  EventApi,
  PluginLogger,
  Unsubscribe,
  TaskTypeDefinition,
  VerifierDefinition,
  SidebarPanelDefinition,
  ToolbarActionDefinition,
  MemoryEntry,
  TaskPriority,
  TaskType,
} from '../../types/index.js';
import { PluginPermissionError } from '../../types/index.js';
import { loadBoard, getTask, createTask, updateTask } from './store.js';
import { getPluginSetting, setPluginSetting } from './configStore.js';
import {
  internalEvents,
  BOARD_UPDATE,
  TASK_CREATED,
  TASK_UPDATED,
  TASK_COMPLETED,
  TASK_FAILED,
  STAGE_CHANGED,
} from './internalEvents.js';
import { registerStage, getRegisteredStages } from './pipelineRegistry.js';
import { registerSkillOverride, getAvailableSkills } from './skillReader.js';

/**
 * Check if a plugin has a specific permission.
 */
function hasPermission(manifest: PluginManifest, permission: PluginPermission): boolean {
  return manifest.permissions?.includes(permission) ?? false;
}

/**
 * Assert a plugin has a permission, throwing PluginPermissionError if not.
 */
function requirePermission(pluginName: string, manifest: PluginManifest, permission: PluginPermission): void {
  if (!hasPermission(manifest, permission)) {
    throw new PluginPermissionError(pluginName, permission);
  }
}

/**
 * Create a sandboxed PluginContext for the given plugin.
 * Methods are permission-gated based on the plugin's manifest.
 */
export function createPluginContext(pluginName: string, manifest: PluginManifest): PluginContext {
  // Logger is always available regardless of permissions
  const logger = {
    info(...args: unknown[]): void {
      console.warn(`[Plugin:${pluginName}]`, ...args);
    },
    warn(...args: unknown[]): void {
      console.warn(`[Plugin:${pluginName}]`, ...args);
    },
    error(...args: unknown[]): void {
      console.error(`[Plugin:${pluginName}]`, ...args);
    },
  };

  const board = {
    async getTasks(): Promise<Task[]> {
      requirePermission(pluginName, manifest, 'tasks:read');
      const b = await loadBoard();
      return structuredClone(b.tasks);
    },
    async getTask(id: string): Promise<Task | null> {
      requirePermission(pluginName, manifest, 'tasks:read');
      const task = await getTask(id);
      return task ? structuredClone(task) : null;
    },
    onUpdate(cb: (board: Board) => void): void {
      requirePermission(pluginName, manifest, 'tasks:read');
      internalEvents.on(BOARD_UPDATE, (payload: { board: Board }) => {
        cb(structuredClone(payload.board));
      });
    },
  };

  const tasks = {
    async create(data: CreateTaskInput): Promise<Task> {
      requirePermission(pluginName, manifest, 'tasks:write');
      const task = await createTask(data);
      return structuredClone(task);
    },
    async update(id: string, data: Partial<Task>): Promise<Task> {
      requirePermission(pluginName, manifest, 'tasks:write');
      const result = await updateTask(id, data);
      if (!result) {
        throw new Error(`Task "${id}" not found`);
      }
      return structuredClone(result);
    },
  };

  const config = {
    async get(key: string): Promise<unknown> {
      requirePermission(pluginName, manifest, 'config:read');
      return getPluginSetting(pluginName, key);
    },
    async set(key: string, value: unknown): Promise<void> {
      requirePermission(pluginName, manifest, 'config:write');
      await setPluginSetting(pluginName, key, value);
    },
  };

  const events = {
    on(event: string, handler: (...args: unknown[]) => void): void {
      requirePermission(pluginName, manifest, 'events:subscribe');
      internalEvents.on(event, handler);
    },
    off(event: string, handler: (...args: unknown[]) => void): void {
      requirePermission(pluginName, manifest, 'events:subscribe');
      internalEvents.off(event, handler);
    },
  };

  const http = {
    async fetch(url: string, options?: RequestInit): Promise<Response> {
      requirePermission(pluginName, manifest, 'http:outbound');
      const method = options?.method ?? 'GET';
      logger.warn(`HTTP ${method} ${url}`);
      const headers = new Headers(options?.headers);
      headers.set('User-Agent', `Formic-Plugin/${pluginName}`);
      return globalThis.fetch(url, { ...options, headers });
    },
  };

  const processCtx = {
    uptime(): number {
      requirePermission(pluginName, manifest, 'process:info');
      return process.uptime();
    },
    memoryUsage(): NodeJS.MemoryUsage {
      requirePermission(pluginName, manifest, 'process:info');
      return process.memoryUsage();
    },
  };

  const BUILTIN_STAGES = new Set(['brief', 'plan', 'declare', 'execute', 'verify', 'architect']);

  const workflow = {
    async registerStage(config: StageRegistration): Promise<void> {
      requirePermission(pluginName, manifest, 'workflow:extend');

      // Validate input
      if (!config.name || typeof config.name !== 'string' || config.name.trim().length === 0) {
        throw new Error('Stage registration requires a non-empty "name"');
      }
      if (!config.after || typeof config.after !== 'string') {
        throw new Error('Stage registration requires a valid "after" stage reference');
      }
      if (!config.skillContent && !config.skillPath && !config.handler) {
        throw new Error('Stage registration requires at least one of "skillContent", "skillPath", or "handler"');
      }

      // Validate that 'after' references an existing stage
      const existingStages = getRegisteredStages();
      const anchorExists = existingStages.some(s => s.name === config.after);
      if (!anchorExists) {
        throw new Error(`Anchor stage "${config.after}" does not exist`);
      }

      registerStage(config, pluginName);

      // If skillContent is provided, also register it as a skill override
      if (config.skillContent) {
        registerSkillOverride(config.name, config.skillContent, pluginName);
      }

      console.warn(`[PluginContext] Plugin '${pluginName}' registered workflow stage '${config.name}'`);
    },

    async getStages(): Promise<StageDescriptor[]> {
      requirePermission(pluginName, manifest, 'workflow:extend');
      return structuredClone(getRegisteredStages());
    },
  };

  const skills = {
    async register(stageName: string, content: string): Promise<void> {
      if (BUILTIN_STAGES.has(stageName)) {
        requirePermission(pluginName, manifest, 'skills:override');
      } else {
        requirePermission(pluginName, manifest, 'workflow:extend');
      }

      registerSkillOverride(stageName, content, pluginName);
      console.warn(`[PluginContext] Plugin '${pluginName}' registered skill override for '${stageName}'`);
    },

    async getAvailable(): Promise<string[]> {
      requirePermission(pluginName, manifest, 'tasks:read');

      const builtinSkills = getAvailableSkills();
      const registeredStages = getRegisteredStages();
      const pluginSkillNames = registeredStages
        .filter(s => s.source === 'plugin')
        .map(s => s.name);

      // Combine and deduplicate
      const allSkills = new Set([...builtinSkills, ...pluginSkillNames]);
      return [...allSkills];
    },
  };

  return {
    board,
    tasks,
    config,
    events,
    logger,
    http,
    process: processCtx,
    workflow,
    skills,
  };
}

// ==================== FormicAPI Factory ====================

/** Module-level registry for plugin-registered task types */
export const taskTypeRegistry = new Map<string, TaskTypeDefinition>();

/** Get all registered task types (for use by the workflow engine) */
export function getRegisteredTaskTypes(): TaskTypeDefinition[] {
  return [...taskTypeRegistry.values()];
}

/** Module-level registry for plugin-registered verifiers */
export const verifierRegistry = new Map<string, VerifierDefinition>();

/** Get all registered verifiers (for use by the workflow engine) */
export function getRegisteredVerifiers(): VerifierDefinition[] {
  return [...verifierRegistry.values()];
}

/** Per-plugin listener tracking for bulk cleanup on unload */
const pluginListeners = new Map<string, Set<{ event: string; handler: (...args: unknown[]) => void }>>();

/** Track a listener registration for a specific plugin */
function trackListener(pluginName: string, event: string, handler: (...args: unknown[]) => void): void {
  if (!pluginListeners.has(pluginName)) {
    pluginListeners.set(pluginName, new Set());
  }
  pluginListeners.get(pluginName)!.add({ event, handler });
}

/** Remove a specific listener from the plugin's tracking set */
function untrackListener(pluginName: string, event: string, handler: (...args: unknown[]) => void): void {
  const listeners = pluginListeners.get(pluginName);
  if (!listeners) return;
  for (const entry of listeners) {
    if (entry.event === event && entry.handler === handler) {
      listeners.delete(entry);
      break;
    }
  }
}

/** Remove all event subscriptions registered by a plugin */
export function cleanupPluginListeners(pluginName: string): void {
  const listeners = pluginListeners.get(pluginName);
  if (!listeners) return;
  for (const entry of listeners) {
    internalEvents.off(entry.event, entry.handler);
  }
  pluginListeners.delete(pluginName);
}

const BUILTIN_STAGES_SET = new Set(['brief', 'plan', 'declare', 'execute', 'verify', 'architect']);

function buildTaskApi(
  pluginName: string,
  manifest: PluginManifest,
  boardSnapshot: Board,
): TaskApi {
  // Mutable reference updated via BOARD_UPDATE events
  let cachedBoard = boardSnapshot;

  const boardHandler = (payload: unknown): void => {
    const p = payload as { board: Board };
    if (p.board) {
      cachedBoard = p.board;
    }
  };
  internalEvents.on(BOARD_UPDATE, boardHandler);
  trackListener(pluginName, BOARD_UPDATE, boardHandler);

  function createLifecycleHook<TArgs extends unknown[]>(
    eventName: string,
    wrapHandler: (handler: (...args: TArgs) => void) => (payload: unknown) => void,
  ): (handler: (...args: TArgs) => void) => Unsubscribe {
    return (handler: (...args: TArgs) => void): Unsubscribe => {
      requirePermission(pluginName, manifest, 'events:subscribe');
      const wrapped = wrapHandler(handler);
      internalEvents.on(eventName, wrapped);
      trackListener(pluginName, eventName, wrapped);
      const unsub: Unsubscribe = () => {
        internalEvents.off(eventName, wrapped);
        untrackListener(pluginName, eventName, wrapped);
      };
      return unsub;
    };
  }

  return {
    getTask(id: string): Task | undefined {
      requirePermission(pluginName, manifest, 'tasks:read');
      const task = cachedBoard.tasks.find(t => t.id === id);
      return task ? structuredClone(task) : undefined;
    },

    getAllTasks(): Task[] {
      requirePermission(pluginName, manifest, 'tasks:read');
      return structuredClone(cachedBoard.tasks);
    },

    async createTask(
      title: string,
      context: string,
      options?: { priority?: TaskPriority; type?: TaskType },
    ): Promise<Task> {
      requirePermission(pluginName, manifest, 'tasks:write');
      const input: CreateTaskInput = {
        title,
        context,
        priority: options?.priority,
        type: options?.type,
      };
      const task = await createTask(input);
      return structuredClone(task);
    },

    async updateTask(
      id: string,
      updates: Partial<Pick<Task, 'title' | 'context' | 'priority'>>,
    ): Promise<Task | null> {
      requirePermission(pluginName, manifest, 'tasks:write');
      const result = await updateTask(id, updates);
      return result ? structuredClone(result) : null;
    },

    onTaskCreated: createLifecycleHook<[Task]>(
      TASK_CREATED,
      (handler) => (payload: unknown) => {
        const p = payload as { task: Task };
        if (p.task) handler(structuredClone(p.task));
      },
    ),

    onTaskUpdated: createLifecycleHook<[Task]>(
      TASK_UPDATED,
      (handler) => (payload: unknown) => {
        const p = payload as { task: Task };
        if (p.task) handler(structuredClone(p.task));
      },
    ),

    onTaskCompleted: createLifecycleHook<[Task]>(
      TASK_COMPLETED,
      (handler) => (payload: unknown) => {
        const p = payload as { task: Task };
        if (p.task) handler(structuredClone(p.task));
      },
    ),

    onTaskFailed: createLifecycleHook<[Task, string]>(
      TASK_FAILED,
      (handler) => (payload: unknown) => {
        const p = payload as { task: Task; error: string };
        if (p.task) handler(structuredClone(p.task), p.error ?? 'Unknown error');
      },
    ),

    onStageChanged: createLifecycleHook<[Task, string, string]>(
      STAGE_CHANGED,
      (handler) => (payload: unknown) => {
        const p = payload as { task: Task; fromStage: string; toStage: string };
        if (p.task) handler(structuredClone(p.task), p.fromStage, p.toStage);
      },
    ),
  };
}

const BUILTIN_TASK_TYPES = new Set(['standard', 'quick', 'goal']);

function buildSkillApi(pluginName: string, manifest: PluginManifest): SkillApi {
  return {
    register(stageName: string, content: string): void {
      if (BUILTIN_STAGES_SET.has(stageName)) {
        requirePermission(pluginName, manifest, 'skills:override');
      } else {
        requirePermission(pluginName, manifest, 'workflow:extend');
      }
      registerSkillOverride(stageName, content, pluginName);
      console.warn(`[PluginContext] Plugin '${pluginName}' registered skill override for '${stageName}'`);
    },

    registerSkillOverride(stageName: string, content: string): void {
      this.register(stageName, content);
    },

    getAvailable(): string[] {
      const builtinSkills = getAvailableSkills();
      const registeredStages = getRegisteredStages();
      const pluginSkillNames = registeredStages
        .filter(s => s.source === 'plugin')
        .map(s => s.name);
      const allSkills = new Set([...builtinSkills, ...pluginSkillNames]);
      return [...allSkills];
    },

    registerTaskType(definition: TaskTypeDefinition): void {
      requirePermission(pluginName, manifest, 'workflow:extend');
      if (BUILTIN_TASK_TYPES.has(definition.id)) {
        throw new Error(`Cannot override built-in task type '${definition.id}'`);
      }
      if (taskTypeRegistry.has(definition.id)) {
        throw new Error(`Task type '${definition.id}' is already registered`);
      }
      taskTypeRegistry.set(definition.id, definition);
      let previousStageName = '';
      const existingStages = getRegisteredStages();
      if (existingStages.length > 0) {
        previousStageName = existingStages[existingStages.length - 1].name;
      }
      for (const stage of definition.workflow) {
        const registration: StageRegistration = {
          name: stage.name,
          displayName: stage.displayName,
          after: previousStageName,
          skillContent: definition.skillPrompt,
        };
        registerStage(registration, pluginName);
        previousStageName = stage.name;
      }
      console.warn(`[PluginContext] Plugin '${pluginName}' registered task type '${definition.id}'`);
    },

    registerVerifier(verifier: VerifierDefinition): void {
      requirePermission(pluginName, manifest, 'workflow:extend');
      verifierRegistry.set(verifier.id, verifier);
      console.warn(`[PluginContext] Plugin '${pluginName}' registered verifier '${verifier.id}'`);
    },
  };
}

function buildSettingsApi(pluginName: string, manifest: PluginManifest): SettingsApi {
  return {
    get<T = unknown>(key: string, defaultValue?: T): T | undefined {
      requirePermission(pluginName, manifest, 'config:read');
      // getPluginSetting is async but SettingsApi.get is sync — use cached approach
      // For sync access, we return the default and log a warning.
      // TODO: Consider making SettingsApi async in a future iteration
      let result: T | undefined = defaultValue;
      getPluginSetting(pluginName, key)
        .then(val => {
          if (val !== undefined) {
            result = val as T;
          }
        })
        .catch((err: unknown) => {
          console.error(`[PluginContext] Failed to get setting '${key}' for plugin '${pluginName}':`, err instanceof Error ? err.message : 'Unknown error');
        });
      return result;
    },

    set<T = unknown>(key: string, value: T): void {
      requirePermission(pluginName, manifest, 'config:write');
      setPluginSetting(pluginName, key, value).catch((err: unknown) => {
        console.error(`[PluginContext] Failed to set setting '${key}' for plugin '${pluginName}':`, err instanceof Error ? err.message : 'Unknown error');
      });
    },
  };
}

function buildEventApi(
  pluginName: string,
  manifest: PluginManifest,
): EventApi {
  return {
    on(event: string, handler: (...args: unknown[]) => void): Unsubscribe {
      requirePermission(pluginName, manifest, 'events:subscribe');
      internalEvents.on(event, handler);
      trackListener(pluginName, event, handler);
      const unsub: Unsubscribe = () => {
        internalEvents.off(event, handler);
        untrackListener(pluginName, event, handler);
      };
      return unsub;
    },

    off(event: string, handler: (...args: unknown[]) => void): void {
      requirePermission(pluginName, manifest, 'events:subscribe');
      internalEvents.off(event, handler);
      untrackListener(pluginName, event, handler);
    },
  };
}

function buildLogger(pluginName: string): PluginLogger {
  return {
    info(message: string, ...args: unknown[]): void {
      console.warn(`[Plugin:${pluginName}]`, message, ...args);
    },
    warn(message: string, ...args: unknown[]): void {
      console.warn(`[Plugin:${pluginName}]`, message, ...args);
    },
    error(message: string, ...args: unknown[]): void {
      console.error(`[Plugin:${pluginName}]`, message, ...args);
    },
  };
}

function buildUIApi(logger: PluginLogger): UIApi {
  return {
    registerSidebarPanel(_panel: SidebarPanelDefinition): Unsubscribe {
      logger.warn('UIApi.registerSidebarPanel() is not yet implemented');
      return () => {};
    },
    registerToolbarAction(_action: ToolbarActionDefinition): Unsubscribe {
      logger.warn('UIApi.registerToolbarAction() is not yet implemented');
      return () => {};
    },
  };
}

function buildIntegrationApi(logger: PluginLogger): IntegrationApi {
  return {
    register(_name: string, _config: Record<string, unknown>): void {
      logger.warn('IntegrationApi.register() is not yet implemented');
    },
  };
}

function buildMemoryApi(logger: PluginLogger): MemoryApi {
  return {
    async getRelevant(_tags: string[]): Promise<MemoryEntry[]> {
      logger.warn('MemoryApi.getRelevant() is not yet implemented');
      return [];
    },
    async add(entry: Omit<MemoryEntry, 'id' | 'created_at'>): Promise<MemoryEntry> {
      logger.warn('MemoryApi.add() is not yet implemented');
      return {
        ...entry,
        id: `mem-${Date.now()}`,
        created_at: new Date().toISOString(),
      };
    },
  };
}

/**
 * Create a fully typed FormicAPI object for the given plugin.
 * Returns both the API and a dispose function for cleanup on unload.
 */
export async function createFormicAPI(
  pluginName: string,
  manifest: PluginManifest,
): Promise<{ api: FormicAPI; dispose: () => void }> {
  const boardSnapshot = await loadBoard();
  const logger = buildLogger(pluginName);

  const api: FormicAPI = {
    tasks: buildTaskApi(pluginName, manifest, boardSnapshot),
    skills: buildSkillApi(pluginName, manifest),
    settings: buildSettingsApi(pluginName, manifest),
    events: buildEventApi(pluginName, manifest),
    logger,
    ui: buildUIApi(logger),
    integrations: buildIntegrationApi(logger),
    memory: buildMemoryApi(logger),
  };

  return {
    api,
    dispose(): void {
      cleanupPluginListeners(pluginName);
    },
  };
}
