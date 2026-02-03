import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { FormicConfig, ConfigWorkspace, ConfigSettings } from '../../types/index.js';
import { getGlobalFormicDir, getGlobalConfigPath } from '../utils/paths.js';

/**
 * Config Store Service
 *
 * Manages persistent global configuration at ~/.formic/config.json.
 * Provides CRUD operations for workspaces, active workspace, and settings.
 * Uses atomic writes (temp file + fs.rename) to prevent corruption.
 */

/** Preset color palette for workspace differentiation */
const COLOR_PALETTE = [
  '#8b5cf6', // Purple
  '#10b981', // Green
  '#3b82f6', // Blue
  '#f59e0b', // Orange
  '#ec4899', // Pink
  '#06b6d4', // Cyan
];

/**
 * Create a default config structure
 */
function createDefaultConfig(): FormicConfig {
  return {
    version: 1,
    workspaces: [],
    activeWorkspaceId: null,
    settings: {
      maxConcurrentSessions: 1,
      theme: 'dark',
      notificationsEnabled: true,
      projectBriefCollapsed: false,
    },
  };
}

/**
 * Ensure the global ~/.formic/ directory exists
 */
async function ensureGlobalFormicDir(): Promise<void> {
  const dir = getGlobalFormicDir();
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
    console.log('[ConfigStore] Created global config directory:', dir);
  }
}

/**
 * Determines the next available color from the palette
 */
function getNextColor(workspaces: ConfigWorkspace[]): string {
  const usedColors = new Set(workspaces.map(ws => ws.color));
  for (const color of COLOR_PALETTE) {
    if (!usedColors.has(color)) {
      return color;
    }
  }
  return COLOR_PALETTE[workspaces.length % COLOR_PALETTE.length];
}

/**
 * Extract the basename from a path for workspace naming
 */
function getBasename(filePath: string): string {
  return path.basename(filePath) || 'Unknown';
}

/**
 * Load the global config from ~/.formic/config.json.
 * Returns default config if the file doesn't exist or is invalid.
 */
export async function loadConfig(): Promise<FormicConfig> {
  await ensureGlobalFormicDir();

  const configPath = getGlobalConfigPath();

  if (!existsSync(configPath)) {
    console.log('[ConfigStore] No config file found, using defaults');
    return createDefaultConfig();
  }

  try {
    const data = await readFile(configPath, 'utf-8');
    const parsed = JSON.parse(data) as FormicConfig;
    // Merge with defaults to ensure all fields exist
    return {
      ...createDefaultConfig(),
      ...parsed,
      settings: {
        ...createDefaultConfig().settings,
        ...parsed.settings,
      },
    };
  } catch (error) {
    const err = error as Error;
    console.error('[ConfigStore] Failed to load config:', err.message);
    return createDefaultConfig();
  }
}

/**
 * Save the config to ~/.formic/config.json using atomic writes.
 * Writes to a temp file first, then renames to avoid corruption.
 */
export async function saveConfig(config: FormicConfig): Promise<void> {
  await ensureGlobalFormicDir();

  const configPath = getGlobalConfigPath();
  const tmpPath = path.join(getGlobalFormicDir(), '.config.json.tmp');

  try {
    await writeFile(tmpPath, JSON.stringify(config, null, 2), 'utf-8');
    await rename(tmpPath, configPath);
  } catch (error) {
    const err = error as Error;
    console.error('[ConfigStore] Failed to save config:', err.message);
    throw new Error(`Failed to save config: ${err.message}`);
  }
}

/**
 * Add a new workspace to the config.
 * If a workspace with the same path already exists, returns it.
 * Auto-activates if this is the first workspace.
 */
export async function addWorkspace(input: {
  path: string;
  name?: string;
  color?: string;
}): Promise<ConfigWorkspace> {
  const config = await loadConfig();

  // Check if workspace with same path already exists
  const existing = config.workspaces.find(ws => ws.path === input.path);
  if (existing) {
    return existing;
  }

  const workspace: ConfigWorkspace = {
    id: `ws-${crypto.randomUUID()}`,
    path: input.path,
    name: input.name || getBasename(input.path),
    color: input.color || getNextColor(config.workspaces),
    lastAccessed: new Date().toISOString(),
  };

  config.workspaces.push(workspace);

  // Auto-activate if this is the first workspace
  if (config.workspaces.length === 1) {
    config.activeWorkspaceId = workspace.id;
  }

  await saveConfig(config);
  console.log('[ConfigStore] Added workspace:', workspace.name, workspace.path);
  return workspace;
}

/**
 * Remove a workspace by ID.
 * Clears activeWorkspaceId if the removed workspace was active.
 */
export async function removeWorkspace(workspaceId: string): Promise<boolean> {
  const config = await loadConfig();
  const index = config.workspaces.findIndex(ws => ws.id === workspaceId);

  if (index === -1) {
    return false;
  }

  config.workspaces.splice(index, 1);

  // Clear activeWorkspaceId if we removed the active workspace
  if (config.activeWorkspaceId === workspaceId) {
    config.activeWorkspaceId = config.workspaces.length > 0
      ? config.workspaces[0].id
      : null;
  }

  await saveConfig(config);
  console.log('[ConfigStore] Removed workspace:', workspaceId);
  return true;
}

/**
 * Set the active workspace by ID and update its lastAccessed timestamp.
 */
export async function setActiveWorkspace(workspaceId: string): Promise<boolean> {
  const config = await loadConfig();
  const workspace = config.workspaces.find(ws => ws.id === workspaceId);

  if (!workspace) {
    return false;
  }

  config.activeWorkspaceId = workspaceId;
  workspace.lastAccessed = new Date().toISOString();

  await saveConfig(config);
  console.log('[ConfigStore] Active workspace set to:', workspace.name);
  return true;
}

/**
 * Get the currently active workspace, or null if none.
 */
export async function getActiveWorkspace(): Promise<ConfigWorkspace | null> {
  const config = await loadConfig();
  if (!config.activeWorkspaceId) {
    return null;
  }
  return config.workspaces.find(ws => ws.id === config.activeWorkspaceId) || null;
}

/**
 * Get a single setting value by key.
 */
export async function getSetting<K extends keyof ConfigSettings>(
  key: K
): Promise<ConfigSettings[K]> {
  const config = await loadConfig();
  return config.settings[key];
}

/**
 * Update a single setting value by key.
 */
export async function setSetting<K extends keyof ConfigSettings>(
  key: K,
  value: ConfigSettings[K]
): Promise<void> {
  const config = await loadConfig();
  config.settings[key] = value;
  await saveConfig(config);
  console.log('[ConfigStore] Setting updated:', key, '=', value);
}
