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
} from '../../types/index.js';
import { PluginPermissionError } from '../../types/index.js';
import { loadBoard, getTask, createTask, updateTask } from './store.js';
import { getPluginSetting, setPluginSetting } from './configStore.js';
import { internalEvents, BOARD_UPDATE } from './internalEvents.js';
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
