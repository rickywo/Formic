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
  UISlot,
  SlotRegistration,
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
  WebhookHandler,
  BotCommandDefinition,
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
  TASK_STAGE_CHANGED,
} from './internalEvents.js';
import {
  registerStage,
  getRegisteredStages,
  registerCustomTaskType as pipelineRegisterTaskType,
  unregisterTaskTypes,
  unregisterStages,
} from './pipelineRegistry.js';
import {
  registerSkillOverride,
  getAvailableSkills,
  registerVerifier as skillReaderRegisterVerifier,
  unregisterVerifiers as skillReaderUnregisterVerifiers,
  unregisterSkillOverrides,
  getVerifiers as skillReaderGetVerifiers,
  runVerifiers as skillReaderRunVerifiers,
} from './skillReader.js';
import { getMemories, addMemory } from './memory.js';
import {
  registerPluginWebhook,
  unregisterPluginWebhooks,
} from './pluginWebhookRegistry.js';
import {
  registerBotCommand as registryRegisterBotCommand,
  unregisterBotCommands,
} from './pluginBotCommands.js';
import { broadcastToWorkspace } from './messagingNotifier.js';
import { getWorkspacePath } from '../utils/paths.js';
import type { VerifierDefinition as _VerifierDef } from '../../types/index.js';

export { skillReaderGetVerifiers as getVerifiers, skillReaderRunVerifiers as runVerifiers };

export function getVerifier(id: string): _VerifierDef | undefined {
  return skillReaderGetVerifiers().find(v => v.id === id);
}

export function unregisterVerifiers(pluginName: string): number {
  return skillReaderUnregisterVerifiers(pluginName);
}

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
 * @deprecated Use createFormicAPI() instead. This function will be removed in a future version.
 */
// Use FormicAPI via createFormicAPI() instead
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
    async getTask(id: string): Promise<Task | null> {
      requirePermission(pluginName, manifest, 'tasks:read');
      const task = cachedBoard.tasks.find(t => t.id === id);
      return task ? structuredClone(task) : null;
    },

    async getAllTasks(): Promise<Task[]> {
      requirePermission(pluginName, manifest, 'tasks:read');
      return structuredClone(cachedBoard.tasks);
    },

    async createTask(data: CreateTaskInput): Promise<Task> {
      requirePermission(pluginName, manifest, 'tasks:write');
      const task = await createTask(data);
      return structuredClone(task);
    },

    async updateTask(
      id: string,
      data: Partial<Task>,
    ): Promise<Task> {
      requirePermission(pluginName, manifest, 'tasks:write');
      const result = await updateTask(id, data);
      if (!result) {
        throw new Error(`Task "${id}" not found`);
      }
      return structuredClone(result);
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
      TASK_STAGE_CHANGED,
      (handler) => (payload: unknown) => {
        const p = payload as { task: Task; fromStage: string; toStage: string };
        if (p.task) handler(structuredClone(p.task), p.fromStage, p.toStage);
      },
    ),
  };
}

function buildSkillApi(pluginName: string, manifest: PluginManifest): SkillApi {
  return {
    async register(stageName: string, content: string): Promise<void> {
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

    async getAvailable(): Promise<string[]> {
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
      if (!definition.id || definition.id.trim() === '') {
        throw new Error('[SkillApi] registerTaskType: definition.id must be a non-empty string');
      }
      if (!definition.label || definition.label.trim() === '') {
        throw new Error('[SkillApi] registerTaskType: definition.label must be a non-empty string');
      }
      if (!Array.isArray(definition.workflow) || definition.workflow.length === 0) {
        throw new Error('[SkillApi] registerTaskType: definition.workflow must be a non-empty array');
      }
      pipelineRegisterTaskType(definition, pluginName);
      console.warn(`[SkillApi] Plugin '${pluginName}' registered task type '${definition.id}'`);
    },

    registerVerifier(verifier: VerifierDefinition): void {
      requirePermission(pluginName, manifest, 'workflow:extend');
      if (!verifier.id || verifier.id.trim() === '') {
        throw new Error('[SkillApi] registerVerifier: verifier.id must be a non-empty string');
      }
      if (!verifier.name || verifier.name.trim() === '') {
        throw new Error('[SkillApi] registerVerifier: verifier.name must be a non-empty string');
      }
      if (typeof verifier.verify !== 'function') {
        throw new Error('[SkillApi] registerVerifier: verifier.verify must be a function');
      }
      skillReaderRegisterVerifier(verifier, pluginName);
      console.warn(`[SkillApi] Plugin '${pluginName}' registered verifier '${verifier.id}'`);
    },
  };
}

function buildSettingsApi(pluginName: string, manifest: PluginManifest): SettingsApi {
  return {
    async get<T = unknown>(key: string, defaultValue?: T): Promise<T | undefined> {
      requirePermission(pluginName, manifest, 'config:read');
      const val = await getPluginSetting(pluginName, key);
      return val !== undefined ? val as T : defaultValue;
    },

    async set<T = unknown>(key: string, value: T): Promise<void> {
      requirePermission(pluginName, manifest, 'config:write');
      await setPluginSetting(pluginName, key, value);
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

/* ------------------------------------------------------------------ */
/*  Module-level slot registry for server-side UI registrations       */
/* ------------------------------------------------------------------ */

/** Tracks slot registrations by plugin name (server-side, metadata-only) */
const _slotRegistry = new Map<string, SlotRegistration[]>();

/** Return all active slot registrations from every server-loaded plugin */
export function getSlotRegistrations(): SlotRegistration[] {
  return Array.from(_slotRegistry.values()).flat();
}

/** Clear all slot registrations for a given plugin (called on unload/disable) */
export function clearSlotRegistrations(pluginName: string): void {
  _slotRegistry.delete(pluginName);
}

function buildUIApi(logger: PluginLogger, pluginName: string): UIApi {
  return {
    registerSlot(slotId: UISlot, _component): Unsubscribe {
      const registrations = _slotRegistry.get(pluginName) ?? [];
      const entry: SlotRegistration = {
        slotId,
        pluginName,
        componentType: typeof _component === 'function'
          && _component.prototype
          && Object.getOwnPropertyNames(_component.prototype).length > 1
          ? 'react-component' : 'render-function',
      };
      registrations.push(entry);
      _slotRegistry.set(pluginName, registrations);
      logger.warn(`UIApi.registerSlot('${slotId}') registered for server plugin '${pluginName}'. Note: server-side components are metadata-only; implement a clientEntry for full rendering.`);
      return () => {
        const list = _slotRegistry.get(pluginName) ?? [];
        const idx = list.indexOf(entry);
        if (idx !== -1) list.splice(idx, 1);
        _slotRegistry.set(pluginName, list);
      };
    },
    unregisterSlot(slotId: UISlot, _component): void {
      const list = _slotRegistry.get(pluginName) ?? [];
      _slotRegistry.set(pluginName, list.filter(r => r.slotId !== slotId));
    },
    registerSidebarPanel(panel: SidebarPanelDefinition): Unsubscribe {
      const registrations = _slotRegistry.get(pluginName) ?? [];
      const mountSlot = panel.mountPoint as UISlot;
      const entry: SlotRegistration = {
        slotId: mountSlot,
        pluginName,
        componentType: 'render-function',
        meta: { title: panel.title, icon: panel.icon },
      };
      registrations.push(entry);
      _slotRegistry.set(pluginName, registrations);
      logger.warn(`UIApi.registerSidebarPanel('${mountSlot}') registered for server plugin '${pluginName}'.`);
      return () => {
        const list = _slotRegistry.get(pluginName) ?? [];
        const idx = list.indexOf(entry);
        if (idx !== -1) list.splice(idx, 1);
        _slotRegistry.set(pluginName, list);
      };
    },
    registerToolbarAction(action: ToolbarActionDefinition): Unsubscribe {
      const registrations = _slotRegistry.get(pluginName) ?? [];
      const entry: SlotRegistration = {
        slotId: 'toolbar-right',
        pluginName,
        componentType: 'render-function',
        meta: { label: action.label, icon: action.icon },
      };
      registrations.push(entry);
      _slotRegistry.set(pluginName, registrations);
      logger.warn(`UIApi.registerToolbarAction() registered for server plugin '${pluginName}'.`);
      return () => {
        const list = _slotRegistry.get(pluginName) ?? [];
        const idx = list.indexOf(entry);
        if (idx !== -1) list.splice(idx, 1);
        _slotRegistry.set(pluginName, list);
      };
    },
  };
}

function buildIntegrationApi(pluginName: string, manifest: PluginManifest, _logger: PluginLogger): IntegrationApi {
  return {
    registerWebhook(path: string, handler: WebhookHandler): void {
      requirePermission(pluginName, manifest, 'integrations:webhook');
      registerPluginWebhook(pluginName, path, handler);
    },
    registerBotCommand(command: BotCommandDefinition): void {
      requirePermission(pluginName, manifest, 'integrations:webhook');
      registryRegisterBotCommand(pluginName, command);
      console.warn(`[PluginContext] Plugin '${pluginName}' registered bot command '/${command.name}'`);
    },
    async sendNotification(message: string): Promise<void> {
      requirePermission(pluginName, manifest, 'integrations:notify');
      const workspacePath = getWorkspacePath();
      await broadcastToWorkspace(workspacePath, { chatId: '', text: message, parseMode: 'plain' });
      console.warn(`[PluginContext] Plugin '${pluginName}' sent notification`);
    },
  };
}

/**
 * Build a stub IntegrationApi for the legacy PluginContext adapter.
 * The adapter lacks pluginName/manifest context so registerWebhook logs a warning.
 */
function buildIntegrationApiStub(logger: PluginLogger): IntegrationApi {
  return {
    registerWebhook(_path: string, _handler: WebhookHandler): void {
      logger.warn('IntegrationApi.registerWebhook() is not available via the legacy PluginContext adapter');
    },
    registerBotCommand(_command: BotCommandDefinition): void {
      logger.warn('IntegrationApi.registerBotCommand() is not yet implemented');
    },
    async sendNotification(_message: string): Promise<void> {
      logger.warn('IntegrationApi.sendNotification() is not yet implemented');
    },
  };
}

function buildMemoryApi(pluginName: string, manifest: PluginManifest, logger: PluginLogger): MemoryApi {
  return {
    async getLessons(filter?: { tags?: string[] }): Promise<MemoryEntry[]> {
      requirePermission(pluginName, manifest, 'memory:read');
      const entries = await getMemories();
      if (filter?.tags && filter.tags.length > 0) {
        const filterTags = new Set(filter.tags);
        return entries.filter(entry =>
          entry.relevance_tags.some(tag => filterTags.has(tag)),
        );
      }
      return entries;
    },

    async addLesson(lesson: Omit<MemoryEntry, 'id' | 'created_at'>): Promise<MemoryEntry> {
      requirePermission(pluginName, manifest, 'memory:write');
      return addMemory(lesson);
    },

    onReflection(handler: (task: Task, lessons: MemoryEntry[]) => void): Unsubscribe {
      requirePermission(pluginName, manifest, 'memory:read');

      const wrappedHandler = async (payload: unknown): Promise<void> => {
        try {
          const p = payload as { task: Task };
          if (!p.task) return;
          const reflectionIds = p.task.reflectionMemories;
          if (!reflectionIds || reflectionIds.length === 0) return;
          const allEntries = await getMemories();
          const idSet = new Set(reflectionIds);
          const matchingLessons = allEntries.filter(entry => idSet.has(entry.id));
          handler(structuredClone(p.task), matchingLessons);
        } catch (err) {
          console.warn('[PluginContext] Error in onReflection handler:', err instanceof Error ? err.message : 'Unknown error');
        }
      };

      // Cast to the expected handler signature for internalEvents compatibility
      const eventHandler = wrappedHandler as (...args: unknown[]) => void;
      internalEvents.on(TASK_COMPLETED, eventHandler);
      trackListener(pluginName, TASK_COMPLETED, eventHandler);

      const unsub: Unsubscribe = () => {
        internalEvents.off(TASK_COMPLETED, eventHandler);
        untrackListener(pluginName, TASK_COMPLETED, eventHandler);
      };
      return unsub;
    },
  };
}

/**
 * Build a stub MemoryApi for the legacy PluginContext adapter.
 * The adapter lacks pluginName/manifest context so methods log warnings.
 */
function buildMemoryApiStub(logger: PluginLogger): MemoryApi {
  return {
    async getLessons(_filter?: { tags?: string[] }): Promise<MemoryEntry[]> {
      logger.warn('MemoryApi.getLessons() is not available via the legacy PluginContext adapter');
      return [];
    },
    async addLesson(lesson: Omit<MemoryEntry, 'id' | 'created_at'>): Promise<MemoryEntry> {
      logger.warn('MemoryApi.addLesson() is not available via the legacy PluginContext adapter');
      return {
        ...lesson,
        id: `mem-${Date.now()}`,
        created_at: new Date().toISOString(),
      };
    },
    onReflection(_handler: (task: Task, lessons: MemoryEntry[]) => void): Unsubscribe {
      logger.warn('MemoryApi.onReflection() is not available via the legacy PluginContext adapter');
      return () => {};
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
    ui: buildUIApi(logger, pluginName),
    integrations: buildIntegrationApi(pluginName, manifest, logger),
    memory: buildMemoryApi(pluginName, manifest, logger),
  };

  return {
    api,
    dispose(): void {
      cleanupPluginListeners(pluginName);
      skillReaderUnregisterVerifiers(pluginName);
      unregisterSkillOverrides(pluginName);
      unregisterStages(pluginName);
      unregisterTaskTypes(pluginName);
      unregisterPluginWebhooks(pluginName);
      unregisterBotCommands(pluginName);
      clearSlotRegistrations(pluginName);
    },
  };
}

/**
 * Adapter that wraps a legacy flat PluginContext into the hierarchical FormicAPI shape.
 * Enables legacy plugins to interoperate with code expecting a FormicAPI.
 *
 * Note: TaskApi lifecycle hooks (onTaskCreated, etc.) are not available via PluginContext
 * and return no-op unsubscribe functions. SkillApi.registerTaskType and registerVerifier
 * are also unavailable and log a warning when called.
 */
export function pluginContextToFormicAPI(ctx: PluginContext): FormicAPI {
  const logger: PluginLogger = {
    info(message: string, ...args: unknown[]): void {
      ctx.logger.info(message, ...args);
    },
    warn(message: string, ...args: unknown[]): void {
      ctx.logger.warn(message, ...args);
    },
    error(message: string, ...args: unknown[]): void {
      ctx.logger.error(message, ...args);
    },
  };

  const tasks: TaskApi = {
    async getTask(id: string): Promise<Task | null> {
      return ctx.board.getTask(id);
    },
    async getAllTasks(): Promise<Task[]> {
      return ctx.board.getTasks();
    },
    async createTask(data: CreateTaskInput): Promise<Task> {
      return ctx.tasks.create(data);
    },
    async updateTask(id: string, data: Partial<Task>): Promise<Task> {
      return ctx.tasks.update(id, data);
    },
    onTaskCreated(_handler: (task: Task) => void): Unsubscribe {
      logger.warn('onTaskCreated() is not available via the legacy PluginContext adapter');
      return () => {};
    },
    onTaskUpdated(_handler: (task: Task) => void): Unsubscribe {
      logger.warn('onTaskUpdated() is not available via the legacy PluginContext adapter');
      return () => {};
    },
    onTaskCompleted(_handler: (task: Task) => void): Unsubscribe {
      logger.warn('onTaskCompleted() is not available via the legacy PluginContext adapter');
      return () => {};
    },
    onTaskFailed(_handler: (task: Task, error: string) => void): Unsubscribe {
      logger.warn('onTaskFailed() is not available via the legacy PluginContext adapter');
      return () => {};
    },
    onStageChanged(_handler: (task: Task, fromStage: string, toStage: string) => void): Unsubscribe {
      logger.warn('onStageChanged() is not available via the legacy PluginContext adapter');
      return () => {};
    },
  };

  const skills: SkillApi = {
    async register(stageName: string, content: string): Promise<void> {
      return ctx.skills.register(stageName, content);
    },
    registerSkillOverride(stageName: string, content: string): void {
      void ctx.skills.register(stageName, content);
    },
    async getAvailable(): Promise<string[]> {
      return ctx.skills.getAvailable();
    },
    registerTaskType(_definition: TaskTypeDefinition): void {
      logger.warn('registerTaskType() is not available via the legacy PluginContext adapter');
    },
    registerVerifier(_verifier: VerifierDefinition): void {
      logger.warn('registerVerifier() is not available via the legacy PluginContext adapter');
    },
  };

  const settings: SettingsApi = {
    async get<T = unknown>(key: string, defaultValue?: T): Promise<T | undefined> {
      const val = await ctx.config.get(key);
      return val !== undefined ? val as T : defaultValue;
    },
    async set<T = unknown>(key: string, value: T): Promise<void> {
      return ctx.config.set(key, value);
    },
  };

  const events: EventApi = {
    on(event: string, handler: (...args: unknown[]) => void): Unsubscribe {
      ctx.events.on(event, handler);
      return () => ctx.events.off(event, handler);
    },
    off(event: string, handler: (...args: unknown[]) => void): void {
      ctx.events.off(event, handler);
    },
  };

  const ui: UIApi = buildUIApi(logger, 'legacy-adapter');
  const integrations: IntegrationApi = buildIntegrationApiStub(logger);
  const memory: MemoryApi = buildMemoryApiStub(logger);

  return { tasks, skills, settings, events, logger, ui, integrations, memory };
}
