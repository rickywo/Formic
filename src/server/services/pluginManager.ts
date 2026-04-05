import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { PluginManifest, PluginEntry, PluginPermission } from '../../types/index.js';
import { getFormicDir } from '../utils/paths.js';
import { getPluginConfig, setPluginConfig } from './configStore.js';

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
]);

/** In-memory plugin registry */
const registry = new Map<string, PluginEntry>();

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

// ==================== Lifecycle Functions ====================

/**
 * Scan .formic/plugins/ for subdirectories containing manifest.json,
 * validate each manifest, and populate the in-memory registry.
 * Returns the registry map.
 */
export async function discoverPlugins(): Promise<Map<string, PluginEntry>> {
  const pluginsDir = path.join(getFormicDir(), 'plugins');

  // Clear existing registry
  registry.clear();

  let entries: string[];
  try {
    entries = await readdir(pluginsDir);
  } catch {
    // plugins/ directory doesn't exist — not an error, just no plugins
    return registry;
  }

  for (const entry of entries) {
    const pluginDir = path.join(pluginsDir, entry);

    try {
      const entryStat = await stat(pluginDir);
      if (!entryStat.isDirectory()) continue;

      const manifestPath = path.join(pluginDir, 'manifest.json');
      let manifestData: string;
      try {
        manifestData = await readFile(manifestPath, 'utf-8');
      } catch {
        // No manifest.json — skip silently
        continue;
      }

      let raw: unknown;
      try {
        raw = JSON.parse(manifestData);
      } catch {
        console.warn(`[PluginManager] Malformed JSON in ${manifestPath}`);
        registry.set(entry, {
          manifest: { name: entry, version: '0.0.0' },
          status: 'error',
          error: 'Malformed JSON in manifest.json',
          pluginDir,
        });
        continue;
      }

      const manifest = validateManifest(raw, pluginDir);
      if (!manifest) {
        registry.set(entry, {
          manifest: { name: entry, version: '0.0.0' },
          status: 'error',
          error: 'Manifest validation failed',
          pluginDir,
        });
        continue;
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

  console.warn(`[PluginManager] Discovered ${registry.size} plugin(s)`);
  return registry;
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
      const mod = await import(entryPath);
      entry.loadedModule = mod;
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
 * Unload a plugin — clear its loaded module and reset status.
 */
export async function unloadPlugin(name: string): Promise<void> {
  const entry = registry.get(name);
  if (!entry) {
    console.warn(`[PluginManager] Cannot unload unknown plugin: ${name}`);
    return;
  }

  try {
    entry.loadedModule = undefined;
    entry.status = 'discovered';
    entry.error = undefined;
    console.warn(`[PluginManager] Unloaded plugin: ${name}`);
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
 */
export async function disablePlugin(name: string): Promise<void> {
  const entry = registry.get(name);
  if (!entry) {
    console.warn(`[PluginManager] Cannot disable unknown plugin: ${name}`);
    return;
  }

  try {
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
