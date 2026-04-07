import { execFile } from 'node:child_process';
import { watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { readFile, readdir, stat, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { PluginManifest, PluginEntry, PluginPermission, FormicPlugin } from '../../types/index.js';
import { getFormicDir } from '../utils/paths.js';
import { getPluginConfig, setPluginConfig, removePluginConfig } from './configStore.js';
import { createFormicAPI, cleanupPluginListeners } from './pluginContext.js';
import { unregisterStages, unregisterCustomTaskTypes, unregisterVerifiers } from './pipelineRegistry.js';
import { unregisterSkillOverrides } from './skillReader.js';
import { unregisterPluginWebhooks } from './pluginWebhookRegistry.js';
import { unregisterBotCommands } from './pluginBotCommands.js';
import { internalEvents, STAGE_UNREGISTERED, BOARD_UPDATE, SERVER_SHUTDOWN } from './internalEvents.js';

/**
 * Plugin Manager Service
 *
 * Discovers plugins in <workspace>/.formic/plugins/, validates their manifests,
 * and manages the full plugin lifecycle (discover, load, unload, enable, disable).
 * Maintains an in-memory registry of all known plugins.
 *
 * Error isolation: a bad plugin never crashes the Formic server.
 * All errors are logged with [PluginManager] prefix and the plugin is marked as errored.
 */

/** Current Formic version — used for minFormicVersion compatibility check */
const FORMIC_VERSION = '0.8.0';

/** Complete set of allowed plugin permissions */
const ALLOWED_PERMISSIONS = new Set<PluginPermission>([
  'tasks:read',
  'tasks:write',
  'config:read',
  'config:write',
  'http:outbound',
  'fs:workspace',
  'process:info',
  'events:subscribe',
  'ui:panel',
  'workflow:extend',
  'skills:override',
  'integrations:webhook',
  'integrations:notify',
  'memory:read',
  'memory:write',
]);

/** In-memory plugin registry */
const registry = new Map<string, PluginEntry>();

/** Promisified execFile for running npm commands */
const execFileAsync = promisify(execFile);

/** Timeout for npm install operations (60 seconds) */
const NPM_INSTALL_TIMEOUT_MS = 60_000;

// ==================== Hot-Reload Watcher State ====================

/** Debounce window in milliseconds for file change events */
const DEBOUNCE_MS = 500;

/** Active file system watcher for --plugins directory, or null when not watching */
let pluginWatcher: FSWatcher | null = null;

/** Per-plugin debounce timers keyed by plugin name */
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Whether ESM cache busting is enabled for dynamic imports */
let cacheBustEnabled = false;

// ==================== Semver Helpers ====================

/**
 * Parse a semver string into [major, minor, patch] tuple.
 * Returns [0, 0, 0] if the string is malformed.
 */
function parseSemver(version: string): [number, number, number] {
  const parts = version.split('.').map(Number);
  if (parts.length < 3 || parts.some(isNaN)) {
    return [0, 0, 0];
  }
  return [parts[0], parts[1], parts[2]];
}

/**
 * Compare two semver strings.
 * Returns -1 if a < b, 0 if a === b, 1 if a > b.
 */
function compareSemver(a: string, b: string): number {
  const [aMaj, aMin, aPat] = parseSemver(a);
  const [bMaj, bMin, bPat] = parseSemver(b);

  if (aMaj !== bMaj) return aMaj < bMaj ? -1 : 1;
  if (aMin !== bMin) return aMin < bMin ? -1 : 1;
  if (aPat !== bPat) return aPat < bPat ? -1 : 1;
  return 0;
}

// ==================== Manifest Validation ====================

/**
 * Validate a raw parsed JSON object as a PluginManifest.
 * Returns the validated manifest on success, or null with a warning on failure.
 */
function validateManifest(raw: unknown, pluginDir: string): PluginManifest | null {
  if (!raw || typeof raw !== 'object') {
    console.warn(`[PluginManager] Invalid manifest in ${pluginDir}: not a JSON object`);
    return null;
  }

  const obj = raw as Record<string, unknown>;

  // Required fields
  if (typeof obj.name !== 'string' || obj.name.length === 0) {
    console.warn(`[PluginManager] Invalid manifest in ${pluginDir}: 'name' must be a non-empty string`);
    return null;
  }

  if (typeof obj.version !== 'string' || obj.version.length === 0) {
    console.warn(`[PluginManager] Invalid manifest in ${pluginDir}: 'version' must be a non-empty string`);
    return null;
  }

  // Optional string fields
  if (obj.description !== undefined && typeof obj.description !== 'string') {
    console.warn(`[PluginManager] Invalid manifest in ${pluginDir}: 'description' must be a string`);
    return null;
  }

  if (obj.author !== undefined && typeof obj.author !== 'string') {
    console.warn(`[PluginManager] Invalid manifest in ${pluginDir}: 'author' must be a string`);
    return null;
  }

  if (obj.serverEntry !== undefined && typeof obj.serverEntry !== 'string') {
    console.warn(`[PluginManager] Invalid manifest in ${pluginDir}: 'serverEntry' must be a string`);
    return null;
  }

  if (obj.clientEntry !== undefined && typeof obj.clientEntry !== 'string') {
    console.warn(`[PluginManager] Invalid manifest in ${pluginDir}: 'clientEntry' must be a string`);
    return null;
  }

  // Validate permissions array
  if (obj.permissions !== undefined) {
    if (!Array.isArray(obj.permissions)) {
      console.warn(`[PluginManager] Invalid manifest in ${pluginDir}: 'permissions' must be an array`);
      return null;
    }
    for (const perm of obj.permissions) {
      if (typeof perm !== 'string' || !ALLOWED_PERMISSIONS.has(perm as PluginPermission)) {
        console.warn(`[PluginManager] Invalid manifest in ${pluginDir}: unknown permission '${perm}'. Allowed: ${[...ALLOWED_PERMISSIONS].join(', ')}`);
        return null;
      }
    }
  }

  // Validate minFormicVersion compatibility
  if (obj.minFormicVersion !== undefined) {
    if (typeof obj.minFormicVersion !== 'string') {
      console.warn(`[PluginManager] Invalid manifest in ${pluginDir}: 'minFormicVersion' must be a string`);
      return null;
    }
    if (compareSemver(FORMIC_VERSION, obj.minFormicVersion) < 0) {
      console.warn(`[PluginManager] Plugin in ${pluginDir} requires Formic >= ${obj.minFormicVersion}, current is ${FORMIC_VERSION}`);
      return null;
    }
  }

  // Validate settings
  if (obj.settings !== undefined && (typeof obj.settings !== 'object' || obj.settings === null || Array.isArray(obj.settings))) {
    console.warn(`[PluginManager] Invalid manifest in ${pluginDir}: 'settings' must be a plain object`);
    return null;
  }

  return {
    name: obj.name,
    version: obj.version,
    description: obj.description as string | undefined,
    author: obj.author as string | undefined,
    minFormicVersion: obj.minFormicVersion as string | undefined,
    permissions: obj.permissions as PluginPermission[] | undefined,
    serverEntry: obj.serverEntry as string | undefined,
    clientEntry: obj.clientEntry as string | undefined,
    settings: obj.settings as Record<string, unknown> | undefined,
  };
}

// ==================== Plugin Format Detection ====================

/**
 * Detect whether a dynamically imported module exports a class-based FormicPlugin.
 * Checks if `mod.default` is a constructor whose prototype has `onLoad` and `onUnload` methods.
 */
function isClassPlugin(mod: unknown): boolean {
  if (!mod || typeof mod !== 'object') return false;
  const defaultExport = (mod as Record<string, unknown>).default;
  if (typeof defaultExport !== 'function') return false;
  const proto = defaultExport.prototype as Record<string, unknown> | undefined;
  if (!proto || typeof proto !== 'object') return false;
  return typeof proto.onLoad === 'function' && typeof proto.onUnload === 'function';
}

// ==================== Hot-Reload Helpers ====================

/**
 * Resolve a changed file path to the name of the plugin that owns it.
 * Iterates the registry and checks if the changed path starts with the plugin's directory.
 * Returns null if no matching plugin is found.
 */
function resolvePluginNameFromPath(changedPath: string): string | null {
  for (const [name, entry] of registry) {
    if (entry.pluginDir && changedPath.startsWith(entry.pluginDir)) {
      return name;
    }
  }
  return null;
}

/**
 * Reload a single plugin by name — unload, then re-load with ESM cache busting.
 * Only class-based plugins are hot-reloaded; legacy-format plugins log a warning.
 */
async function reloadPlugin(name: string): Promise<void> {
  const entry = registry.get(name);
  if (!entry) {
    console.warn(`[PluginManager] Cannot reload unknown plugin: ${name}`);
    return;
  }

  if (entry.format === 'legacy') {
    console.warn(`[PluginManager] Plugin '${name}' uses legacy format — hot-reload is not supported. Restart the server to apply changes.`);
    return;
  }

  console.warn(`[PluginManager] Change detected in '${name}', reloading...`);

  try {
    await unloadPlugin(name);
    cacheBustEnabled = true;
    await loadPlugin(name);
    cacheBustEnabled = false;
    console.warn(`[PluginManager] Plugin '${name}' reloaded successfully`);
  } catch (err) {
    cacheBustEnabled = false;
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.warn(`[PluginManager] Failed to reload plugin '${name}': ${msg}`);
  }
}

// ==================== Lifecycle Functions ====================

/**
 * Scan .formic/plugins/ for subdirectories containing manifest.json,
 * validate each manifest, and populate the in-memory registry.
 * Optionally scans an additional plugins directory for local development.
 * Returns the registry map.
 */
export async function discoverPlugins(additionalPluginsDir?: string): Promise<Map<string, PluginEntry>> {
  const pluginsDir = path.join(getFormicDir(), 'plugins');

  // Clear existing registry
  registry.clear();

  // Scan the default .formic/plugins/ directory
  await scanPluginsDirectory(pluginsDir);

  // Scan the additional plugins directory if provided
  if (additionalPluginsDir) {
    const resolvedPath = path.resolve(additionalPluginsDir);
    console.warn(`[PluginManager] Scanning additional plugins directory: ${resolvedPath}`);

    try {
      const dirStat = await stat(resolvedPath);
      if (!dirStat.isDirectory()) {
        console.warn(`[PluginManager] Additional plugins path is not a directory: ${resolvedPath}`);
      } else {
        // Check if this is a single plugin directory (has manifest.json or package.json at root)
        let isSinglePlugin = false;
        try {
          await stat(path.join(resolvedPath, 'manifest.json'));
          isSinglePlugin = true;
        } catch {
          try {
            await stat(path.join(resolvedPath, 'package.json'));
            isSinglePlugin = true;
          } catch {
            // Neither manifest.json nor package.json — treat as multi-plugin parent directory
          }
        }

        if (isSinglePlugin) {
          // Treat the path itself as a single plugin directory
          console.warn(`[PluginManager] Detected single plugin at: ${resolvedPath}`);
          await scanSinglePluginDirectory(resolvedPath);
        } else {
          // Treat as a directory containing multiple plugin subdirectories
          await scanPluginsDirectory(resolvedPath);
        }
      }
    } catch {
      console.warn(`[PluginManager] Additional plugins path does not exist or is inaccessible: ${resolvedPath}`);
    }
  }

  console.warn(`[PluginManager] Discovered ${registry.size} plugin(s)`);
  return registry;
}

/**
 * Scan a single plugin directory and register it in the registry.
 * Used when --plugins points directly to a plugin (containing manifest.json or package.json).
 */
async function scanSinglePluginDirectory(pluginDir: string): Promise<void> {
  const entry = path.basename(pluginDir);

  try {
    const manifestPath = path.join(pluginDir, 'manifest.json');
    let manifestData: string | null = null;
    try {
      manifestData = await readFile(manifestPath, 'utf-8');
    } catch {
      // No manifest.json — fall back to package.json-based detection
    }

    if (manifestData === null) {
      await registerPackageJsonPlugin(pluginDir, entry);
      return;
    }

    await registerManifestPlugin(pluginDir, entry, manifestData);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.warn(`[PluginManager] Error discovering plugin in ${pluginDir}: ${msg}`);
    registry.set(entry, {
      manifest: { name: entry, version: '0.0.0' },
      status: 'error',
      error: msg,
      pluginDir,
    });
  }
}

/**
 * Scan a directory containing plugin subdirectories and register each one.
 */
async function scanPluginsDirectory(pluginsDir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(pluginsDir);
  } catch {
    // Directory doesn't exist — not an error, just no plugins here
    return;
  }

  for (const entry of entries) {
    const pluginDir = path.join(pluginsDir, entry);

    try {
      const entryStat = await stat(pluginDir);
      if (!entryStat.isDirectory()) continue;

      const manifestPath = path.join(pluginDir, 'manifest.json');
      let manifestData: string | null = null;
      try {
        manifestData = await readFile(manifestPath, 'utf-8');
      } catch {
        // No manifest.json — fall back to package.json-based class plugin detection
      }

      if (manifestData === null) {
        await registerPackageJsonPlugin(pluginDir, entry);
        continue;
      }

      await registerManifestPlugin(pluginDir, entry, manifestData);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      console.warn(`[PluginManager] Error discovering plugin in ${pluginDir}: ${msg}`);
      registry.set(entry, {
        manifest: { name: entry, version: '0.0.0' },
        status: 'error',
        error: msg,
        pluginDir,
      });
    }
  }
}

/**
 * Register a plugin from a directory containing package.json (class-based plugin).
 */
async function registerPackageJsonPlugin(pluginDir: string, entry: string): Promise<void> {
  try {
    const pkgPath = path.join(pluginDir, 'package.json');
    let pkgData: string;
    try {
      pkgData = await readFile(pkgPath, 'utf-8');
    } catch {
      // No package.json either — skip silently
      return;
    }

    let pkg: unknown;
    try {
      pkg = JSON.parse(pkgData);
    } catch {
      console.warn(`[PluginManager] Malformed JSON in ${pkgPath}`);
      registry.set(entry, {
        manifest: { name: entry, version: '0.0.0' },
        status: 'error',
        error: 'Malformed JSON in package.json',
        pluginDir,
      });
      return;
    }

    const pkgObj = pkg as Record<string, unknown>;

    if (typeof pkgObj.name !== 'string' || pkgObj.name.length === 0) {
      console.warn(`[PluginManager] package.json in ${pluginDir}: 'name' must be a non-empty string`);
      registry.set(entry, {
        manifest: { name: entry, version: '0.0.0' },
        status: 'error',
        error: 'package.json missing valid name field',
        pluginDir,
      });
      return;
    }

    if (typeof pkgObj.version !== 'string' || pkgObj.version.length === 0) {
      console.warn(`[PluginManager] package.json in ${pluginDir}: 'version' must be a non-empty string`);
      registry.set(entry, {
        manifest: { name: pkgObj.name, version: '0.0.0' },
        status: 'error',
        error: 'package.json missing valid version field',
        pluginDir,
      });
      return;
    }

    // Resolve entry point from main or exports
    let serverEntry = 'index.js';
    if (typeof pkgObj.main === 'string' && pkgObj.main.length > 0) {
      serverEntry = pkgObj.main;
    } else if (pkgObj.exports && typeof pkgObj.exports === 'object' && !Array.isArray(pkgObj.exports)) {
      const exportsObj = pkgObj.exports as Record<string, unknown>;
      const defaultExport = exportsObj['.'] ?? exportsObj['default'];
      if (typeof defaultExport === 'string') {
        serverEntry = defaultExport;
      }
    }

    const synthesizedManifest: PluginManifest = {
      name: pkgObj.name,
      version: pkgObj.version,
      description: typeof pkgObj.description === 'string' ? pkgObj.description : undefined,
      permissions: [],
      serverEntry,
    };

    const persistedConfig = await getPluginConfig(pkgObj.name);
    let pkgStatus: PluginEntry['status'] = 'discovered';
    if (persistedConfig) {
      pkgStatus = persistedConfig.enabled ? 'discovered' : 'disabled';
    } else {
      await setPluginConfig(pkgObj.name, { enabled: true, settings: {} });
    }

    registry.set(pkgObj.name, {
      manifest: synthesizedManifest,
      status: pkgStatus,
      format: 'class',
      pluginDir,
    });
  } catch (pkgError) {
    const pkgMsg = pkgError instanceof Error ? pkgError.message : 'Unknown error';
    console.warn(`[PluginManager] Error reading package.json in ${pluginDir}: ${pkgMsg}`);
    registry.set(entry, {
      manifest: { name: entry, version: '0.0.0' },
      status: 'error',
      error: pkgMsg,
      pluginDir,
    });
  }
}

/**
 * Register a plugin from a directory containing manifest.json.
 */
async function registerManifestPlugin(pluginDir: string, entry: string, manifestData: string): Promise<void> {
  let raw: unknown;
  try {
    raw = JSON.parse(manifestData);
  } catch {
    console.warn(`[PluginManager] Malformed JSON in ${path.join(pluginDir, 'manifest.json')}`);
    registry.set(entry, {
      manifest: { name: entry, version: '0.0.0' },
      status: 'error',
      error: 'Malformed JSON in manifest.json',
      pluginDir,
    });
    return;
  }

  const manifest = validateManifest(raw, pluginDir);
  if (!manifest) {
    registry.set(entry, {
      manifest: { name: entry, version: '0.0.0' },
      status: 'error',
      error: 'Manifest validation failed',
      pluginDir,
    });
    return;
  }

  // Check persisted config for enabled/disabled state
  const persistedConfig = await getPluginConfig(manifest.name);
  let status: PluginEntry['status'] = 'discovered';
  if (persistedConfig) {
    status = persistedConfig.enabled ? 'discovered' : 'disabled';
  } else {
    // First discovery — persist default config with manifest settings defaults
    await setPluginConfig(manifest.name, {
      enabled: true,
      settings: manifest.settings ? { ...manifest.settings } : {},
    });
  }

  registry.set(manifest.name, {
    manifest,
    status,
    pluginDir,
  });
}

/**
 * Load and activate a single plugin by name.
 * If the plugin has a serverEntry, it is dynamically imported.
 */
export async function loadPlugin(name: string): Promise<void> {
  const entry = registry.get(name);
  if (!entry) {
    console.warn(`[PluginManager] Cannot load unknown plugin: ${name}`);
    return;
  }

  if (entry.status === 'disabled') {
    console.warn(`[PluginManager] Plugin '${name}' is disabled, skipping load`);
    return;
  }

  try {
    if (entry.manifest.serverEntry) {
      const entryPath = path.resolve(entry.pluginDir, entry.manifest.serverEntry);
      const importUrl = cacheBustEnabled ? `${entryPath}?t=${Date.now()}` : entryPath;
      const mod = await import(importUrl);

      if (isClassPlugin(mod)) {
        // Class-based plugin loading
        entry.format = 'class';
        console.warn(`[PluginManager] Plugin '${name}' detected as class format`);

        const PluginClass = (mod as Record<string, new () => FormicPlugin>).default;
        let pluginInstance: FormicPlugin;
        try {
          pluginInstance = new PluginClass();
        } catch (ctorErr) {
          const ctorMsg = ctorErr instanceof Error ? ctorErr.message : 'Unknown error';
          entry.status = 'error';
          entry.error = `Class constructor failed: ${ctorMsg}`;
          console.warn(`[PluginManager] Plugin '${name}' constructor failed: ${ctorMsg}`);
          return;
        }

        // Validate required fields
        if (
          typeof pluginInstance.id !== 'string' ||
          typeof pluginInstance.name !== 'string' ||
          typeof pluginInstance.version !== 'string' ||
          typeof pluginInstance.onLoad !== 'function' ||
          typeof pluginInstance.onUnload !== 'function'
        ) {
          entry.status = 'error';
          entry.error = 'Class plugin missing required fields (id, name, version, onLoad, onUnload)';
          console.warn(`[PluginManager] Plugin '${name}' class missing required fields`);
          return;
        }

        const { api, dispose } = await createFormicAPI(name, entry.manifest);

        try {
          await pluginInstance.onLoad(api);
        } catch (loadErr) {
          const loadMsg = loadErr instanceof Error ? loadErr.message : 'Unknown error';
          entry.status = 'error';
          entry.error = `onLoad failed: ${loadMsg}`;
          console.warn(`[PluginManager] Plugin '${name}' onLoad() failed: ${loadMsg}`);
          return;
        }

        entry.pluginInstance = pluginInstance;
        entry.apiDispose = dispose;
        entry.loadedModule = mod;
      } else {
        // Legacy manifest-based plugin loading
        entry.format = 'legacy';
        console.warn(`[PluginManager] Plugin '${name}' detected as legacy format`);
        entry.loadedModule = mod;
      }
    }
    entry.status = 'loaded';
    entry.error = undefined;
    console.warn(`[PluginManager] Loaded plugin: ${name}`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    entry.status = 'error';
    entry.error = `Failed to load: ${msg}`;
    console.warn(`[PluginManager] Failed to load plugin '${name}': ${msg}`);
  }
}

/**
 * Unload a plugin — clear its loaded module, clean up registered stages
 * and skill overrides, and reset status.
 */
export async function unloadPlugin(name: string): Promise<void> {
  const entry = registry.get(name);
  if (!entry) {
    console.warn(`[PluginManager] Cannot unload unknown plugin: ${name}`);
    return;
  }

  try {
    // Call onUnload() for class-based plugins before cleanup
    if (entry.pluginInstance) {
      try {
        await entry.pluginInstance.onUnload();
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        console.warn(`[PluginManager] Plugin '${name}' onUnload() failed: ${msg}`);
      }
    }

    // Dispose FormicAPI-level event subscriptions
    if (entry.apiDispose) {
      try {
        entry.apiDispose();
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        console.warn(`[PluginManager] Plugin '${name}' apiDispose() failed: ${msg}`);
      }
    }

    // Clean up event subscriptions registered through the plugin's EventApi
    try {
      cleanupPluginListeners(name);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      console.warn(`[PluginManager] Failed to cleanup event listeners for plugin '${name}': ${msg}`);
    }

    // Clean up pipeline stages registered by this plugin
    try {
      const removedCount = unregisterStages(name);
      if (removedCount > 0) {
        console.warn(`[PluginManager] Removed ${removedCount} pipeline stage(s) for plugin: ${name}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      console.warn(`[PluginManager] Failed to unregister stages for plugin '${name}': ${msg}`);
    }

    // Clean up skill overrides registered by this plugin
    try {
      unregisterSkillOverrides(name);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      console.warn(`[PluginManager] Failed to unregister skill overrides for plugin '${name}': ${msg}`);
    }

    // Clean up custom task types registered by this plugin
    try {
      const removedTypes = unregisterCustomTaskTypes(name);
      if (removedTypes > 0) {
        console.warn(`[PluginManager] Removed ${removedTypes} custom task type(s) for plugin: ${name}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      console.warn(`[PluginManager] Failed to unregister task types for plugin '${name}': ${msg}`);
    }

    // Clean up verifiers registered by this plugin
    try {
      const removedVerifiers = unregisterVerifiers(name);
      if (removedVerifiers > 0) {
        console.warn(`[PluginManager] Removed ${removedVerifiers} verifier(s) for plugin: ${name}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      console.warn(`[PluginManager] Failed to unregister verifiers for plugin '${name}': ${msg}`);
    }

    // Clean up webhook routes registered by this plugin
    try {
      const removedWebhooks = unregisterPluginWebhooks(name);
      if (removedWebhooks > 0) {
        console.warn(`[PluginManager] Removed ${removedWebhooks} webhook route(s) for plugin: ${name}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      console.warn(`[PluginManager] Failed to unregister webhooks for plugin '${name}': ${msg}`);
    }

    // Clean up bot commands registered by this plugin
    try {
      const removedCommands = unregisterBotCommands(name);
      if (removedCommands > 0) {
        console.warn(`[PluginManager] Removed ${removedCommands} bot command(s) for plugin: ${name}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      console.warn(`[PluginManager] Failed to unregister bot commands for plugin '${name}': ${msg}`);
    }

    entry.loadedModule = undefined;
    entry.pluginInstance = undefined;
    entry.apiDispose = undefined;
    entry.status = 'discovered';
    entry.error = undefined;

    // Emit events so UI and other services react to the change
    internalEvents.emit(STAGE_UNREGISTERED, { pluginName: name });
    internalEvents.emit(BOARD_UPDATE);

    console.warn(`[PluginManager] Cleaned up stages and skill overrides for plugin: ${name}`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    entry.status = 'error';
    entry.error = `Failed to unload: ${msg}`;
    console.warn(`[PluginManager] Failed to unload plugin '${name}': ${msg}`);
  }
}

/**
 * Enable a plugin and persist the state.
 */
export async function enablePlugin(name: string): Promise<void> {
  const entry = registry.get(name);
  if (!entry) {
    console.warn(`[PluginManager] Cannot enable unknown plugin: ${name}`);
    return;
  }

  try {
    entry.status = 'enabled';
    entry.error = undefined;
    const existingConfig = await getPluginConfig(name);
    await setPluginConfig(name, {
      enabled: true,
      settings: existingConfig?.settings ?? {},
    });
    console.warn(`[PluginManager] Enabled plugin: ${name}`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    entry.status = 'error';
    entry.error = `Failed to enable: ${msg}`;
    console.warn(`[PluginManager] Failed to enable plugin '${name}': ${msg}`);
  }
}

/**
 * Disable a plugin and persist the state.
 * Calls unloadPlugin() first to clean up stages and skill overrides.
 */
export async function disablePlugin(name: string): Promise<void> {
  const entry = registry.get(name);
  if (!entry) {
    console.warn(`[PluginManager] Cannot disable unknown plugin: ${name}`);
    return;
  }

  try {
    // Unload first to clean up pipeline stages and skill overrides
    await unloadPlugin(name);

    entry.status = 'disabled';
    entry.error = undefined;
    const existingConfig = await getPluginConfig(name);
    await setPluginConfig(name, {
      enabled: false,
      settings: existingConfig?.settings ?? {},
    });
    console.warn(`[PluginManager] Disabled plugin: ${name}`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    entry.status = 'error';
    entry.error = `Failed to disable: ${msg}`;
    console.warn(`[PluginManager] Failed to disable plugin '${name}': ${msg}`);
  }
}

/**
 * Install a plugin from npm into .formic/plugins/<pluginId>/ and activate it.
 * Creates the target directory, runs `npm install --prefix`, then calls
 * discoverPlugins() and loadPlugin() to register and activate.
 * On failure, cleans up the partially-created directory before re-throwing.
 */
export async function installPluginFromNpm(packageName: string, pluginId: string): Promise<void> {
  const targetDir = path.join(getFormicDir(), 'plugins', pluginId);
  console.warn(`[PluginManager] Installing plugin '${pluginId}' from npm package '${packageName}' into ${targetDir}`);

  try {
    await mkdir(targetDir, { recursive: true });

    await execFileAsync('npm', ['install', '--prefix', targetDir, packageName], {
      timeout: NPM_INSTALL_TIMEOUT_MS,
    });

    console.warn(`[PluginManager] npm install completed for '${pluginId}', activating plugin`);

    await discoverPlugins();
    await loadPlugin(pluginId);

    console.warn(`[PluginManager] Successfully installed and activated plugin '${pluginId}'`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.warn(`[PluginManager] Failed to install plugin '${pluginId}': ${msg}`);

    // Clean up partially-created directory
    try {
      await rm(targetDir, { recursive: true, force: true });
    } catch (cleanupErr) {
      const cleanupMsg = cleanupErr instanceof Error ? cleanupErr.message : 'Unknown error';
      console.warn(`[PluginManager] Failed to clean up directory after failed install for '${pluginId}': ${cleanupMsg}`);
    }

    throw err;
  }
}

/**
 * Fully uninstall a plugin — unload runtime state, remove persisted config,
 * delete the plugin directory, and evict from the in-memory registry.
 */
export async function uninstallPlugin(pluginId: string): Promise<void> {
  const entry = registry.get(pluginId);
  if (!entry) {
    console.warn(`[PluginManager] Cannot uninstall unknown plugin: ${pluginId}`);
    return;
  }

  const pluginDir = entry.pluginDir;
  if (!pluginDir) {
    console.warn(`[PluginManager] Cannot uninstall plugin '${pluginId}': no pluginDir recorded`);
    return;
  }

  console.warn(`[PluginManager] Uninstalling plugin '${pluginId}' from ${pluginDir}`);

  try {
    // 1. Unload runtime state (event listeners, pipeline stages, skill overrides)
    await unloadPlugin(pluginId);

    // 2. Remove persisted config
    await removePluginConfig(pluginId);

    // 3. Delete plugin directory
    await rm(pluginDir, { recursive: true, force: true });

    // 4. Evict from in-memory registry
    registry.delete(pluginId);

    // 5. Notify UI
    internalEvents.emit(BOARD_UPDATE);

    console.warn(`[PluginManager] Successfully uninstalled plugin '${pluginId}'`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.warn(`[PluginManager] Failed to uninstall plugin '${pluginId}': ${msg}`);
    throw err;
  }
}

/**
 * Get all plugins in the registry.
 */
export function getPlugins(): Map<string, PluginEntry> {
  return registry;
}

/**
 * Get a single plugin by name.
 */
export function getPlugin(name: string): PluginEntry | undefined {
  return registry.get(name);
}

// ==================== Hot-Reload File Watcher ====================

/** File extensions eligible for triggering a hot-reload */
const WATCHED_EXTENSIONS = new Set(['.ts', '.js', '.json']);

/**
 * Start watching the --plugins directory for file changes and automatically
 * reload affected class-based plugins. Only files with .ts, .js, or .json
 * extensions trigger a reload. Changes are debounced per-plugin with a 500ms window.
 *
 * Legacy-format plugins are not hot-reloaded; a warning is logged instead.
 * The watcher is stopped automatically on SERVER_SHUTDOWN.
 */
export function watchPluginDir(pluginsDirPath: string): void {
  const resolvedPath = path.resolve(pluginsDirPath);

  // Prevent duplicate watchers
  if (pluginWatcher) {
    console.warn(`[PluginManager] Already watching for plugin changes, stopping previous watcher`);
    stopWatchingPlugins();
  }

  try {
    pluginWatcher = watch(resolvedPath, { recursive: true }, (_eventType, filename) => {
      if (!filename) return;

      // Filter by file extension
      const ext = path.extname(filename);
      if (!WATCHED_EXTENSIONS.has(ext)) return;

      // Resolve the full path of the changed file
      const fullPath = path.resolve(resolvedPath, filename);

      // Determine which plugin owns this file
      const pluginName = resolvePluginNameFromPath(fullPath);
      if (!pluginName) return;

      // Clear any existing debounce timer for this plugin
      const existingTimer = debounceTimers.get(pluginName);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      // Set a new debounce timer
      const timer = setTimeout(() => {
        debounceTimers.delete(pluginName);
        reloadPlugin(pluginName).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : 'Unknown error';
          console.warn(`[PluginManager] Unhandled error reloading plugin '${pluginName}': ${msg}`);
        });
      }, DEBOUNCE_MS);

      debounceTimers.set(pluginName, timer);
    });

    pluginWatcher.on('error', (err: Error) => {
      console.warn(`[PluginManager] File watcher error: ${err.message}`);
    });

    // Stop watching on graceful server shutdown
    internalEvents.on(SERVER_SHUTDOWN, () => {
      stopWatchingPlugins();
    });

    console.warn(`[PluginManager] Watching ${resolvedPath} for changes...`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.warn(`[PluginManager] Failed to start file watcher: ${msg}`);
  }
}

/**
 * Stop the file watcher and clear all pending debounce timers.
 * Safe to call even if no watcher is active (no-op).
 */
export function stopWatchingPlugins(): void {
  if (pluginWatcher) {
    pluginWatcher.close();
    pluginWatcher = null;
    console.warn(`[PluginManager] Stopped watching for plugin changes`);
  }

  // Clear all pending debounce timers
  for (const timer of debounceTimers.values()) {
    clearTimeout(timer);
  }
  debounceTimers.clear();
}
