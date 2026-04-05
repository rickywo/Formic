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
} from '../../types/index.js';
import { PluginPermissionError } from '../../types/index.js';
import { loadBoard, getTask, createTask, updateTask } from './store.js';
import { getPluginSetting, setPluginSetting } from './configStore.js';
import { internalEvents, BOARD_UPDATE } from './internalEvents.js';

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

  return {
    board,
    tasks,
    config,
    events,
    logger,
    http,
    process: processCtx,
  };
}
