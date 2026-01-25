/**
 * Formic Config Store - Client-side localStorage configuration management
 *
 * Manages workspaces and application settings using a centralized localStorage store.
 * Supports multiple workspaces with auto-assigned colors and migration from legacy storage.
 *
 * @module configStore
 */

/** localStorage key for the config store */
const CONFIG_KEY = 'formic-config';

/** Legacy localStorage key for theme (will be migrated) */
const LEGACY_THEME_KEY = 'formic-theme';

/**
 * Preset color palette for workspace differentiation
 * @type {string[]}
 */
const COLOR_PALETTE = [
  '#8b5cf6', // Purple
  '#10b981', // Green
  '#3b82f6', // Blue
  '#f59e0b', // Orange
  '#ec4899', // Pink
  '#06b6d4', // Cyan
];

/**
 * Default configuration schema
 * @type {Config}
 */
const DEFAULT_CONFIG = {
  workspaces: [],
  activeWorkspaceId: null,
  settings: {
    maxConcurrentSessions: 1,
    theme: 'dark',
    notificationsEnabled: true,
  },
};

/**
 * @typedef {Object} Workspace
 * @property {string} id - Unique workspace identifier (ws-{uuid})
 * @property {string} path - Absolute path to the workspace directory
 * @property {string} name - Display name for the workspace
 * @property {string} color - Hex color for visual differentiation
 * @property {string} lastAccessed - ISO-8601 timestamp of last access
 */

/**
 * @typedef {Object} Settings
 * @property {number} maxConcurrentSessions - Maximum concurrent task sessions
 * @property {string} theme - Theme preference ('dark' | 'light' | 'auto')
 * @property {boolean} notificationsEnabled - Whether notifications are enabled
 */

/**
 * @typedef {Object} Config
 * @property {Workspace[]} workspaces - Array of workspace configurations
 * @property {string|null} activeWorkspaceId - ID of the currently active workspace
 * @property {Settings} settings - Application settings
 */

/**
 * Generates a unique workspace ID
 * @returns {string} Workspace ID in format 'ws-{uuid}'
 */
function generateWorkspaceId() {
  const uuid = crypto.randomUUID ? crypto.randomUUID() :
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  return `ws-${uuid}`;
}

/**
 * Extracts the folder name from a path
 * @param {string} path - Absolute file path
 * @returns {string} The basename of the path
 */
function getBasename(path) {
  if (!path) return 'Unknown';
  const normalized = path.replace(/\\/g, '/').replace(/\/$/, '');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || 'Unknown';
}

/**
 * Determines the next available color from the palette
 * @param {Workspace[]} workspaces - Existing workspaces
 * @returns {string} Hex color code
 */
function getNextColor(workspaces) {
  const usedColors = new Set(workspaces.map(ws => ws.color));

  // Find first unused color
  for (const color of COLOR_PALETTE) {
    if (!usedColors.has(color)) {
      return color;
    }
  }

  // All colors used, cycle through palette based on count
  return COLOR_PALETTE[workspaces.length % COLOR_PALETTE.length];
}

/**
 * Retrieves the full configuration from localStorage
 * @returns {Config} The configuration object (or default if none exists)
 */
function getConfig() {
  try {
    const stored = localStorage.getItem(CONFIG_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      // Merge with defaults to ensure all fields exist
      return {
        ...DEFAULT_CONFIG,
        ...parsed,
        settings: {
          ...DEFAULT_CONFIG.settings,
          ...parsed.settings,
        },
      };
    }
  } catch (error) {
    console.error('[ConfigStore] Failed to load config:', error);
  }
  return { ...DEFAULT_CONFIG, settings: { ...DEFAULT_CONFIG.settings } };
}

/**
 * Persists the configuration to localStorage
 * @param {Config} config - The configuration object to save
 * @returns {boolean} True if save succeeded, false otherwise
 */
function saveConfig(config) {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
    return true;
  } catch (error) {
    console.error('[ConfigStore] Failed to save config:', error);
    return false;
  }
}

/**
 * Retrieves all workspaces
 * @returns {Workspace[]} Array of workspace objects
 */
function getWorkspaces() {
  return getConfig().workspaces;
}

/**
 * Adds a new workspace to the configuration
 * @param {Object} options - Workspace options
 * @param {string} options.path - Absolute path to the workspace
 * @param {string} [options.name] - Display name (auto-derived from path if not provided)
 * @param {string} [options.color] - Hex color (auto-assigned if not provided)
 * @returns {Workspace} The newly created workspace object
 */
function addWorkspace({ path, name, color }) {
  const config = getConfig();

  // Check if workspace with same path already exists
  const existing = config.workspaces.find(ws => ws.path === path);
  if (existing) {
    return existing;
  }

  const workspace = {
    id: generateWorkspaceId(),
    path: path,
    name: name || getBasename(path),
    color: color || getNextColor(config.workspaces),
    lastAccessed: new Date().toISOString(),
  };

  config.workspaces.push(workspace);

  // If this is the first workspace, make it active
  if (config.workspaces.length === 1) {
    config.activeWorkspaceId = workspace.id;
  }

  saveConfig(config);
  return workspace;
}

/**
 * Removes a workspace by ID
 * @param {string} workspaceId - The workspace ID to remove
 * @returns {boolean} True if workspace was removed, false if not found
 */
function removeWorkspace(workspaceId) {
  const config = getConfig();
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

  saveConfig(config);
  return true;
}

/**
 * Sets the active workspace and updates its lastAccessed timestamp
 * @param {string} workspaceId - The workspace ID to activate
 * @returns {boolean} True if workspace was found and activated
 */
function setActiveWorkspace(workspaceId) {
  const config = getConfig();
  const workspace = config.workspaces.find(ws => ws.id === workspaceId);

  if (!workspace) {
    return false;
  }

  config.activeWorkspaceId = workspaceId;
  workspace.lastAccessed = new Date().toISOString();

  saveConfig(config);
  return true;
}

/**
 * Retrieves the currently active workspace
 * @returns {Workspace|null} The active workspace object, or null if none
 */
function getActiveWorkspace() {
  const config = getConfig();
  if (!config.activeWorkspaceId) {
    return null;
  }
  return config.workspaces.find(ws => ws.id === config.activeWorkspaceId) || null;
}

/**
 * Retrieves a setting value by key
 * @param {string} key - The setting key
 * @returns {*} The setting value, or undefined if not found
 */
function getSetting(key) {
  const config = getConfig();
  return config.settings[key];
}

/**
 * Updates a setting value
 * @param {string} key - The setting key
 * @param {*} value - The value to set
 * @returns {boolean} True if save succeeded
 */
function setSetting(key, value) {
  const config = getConfig();
  config.settings[key] = value;
  return saveConfig(config);
}

/**
 * Checks if the config store has been initialized (migration completed)
 * @returns {boolean} True if config exists in localStorage
 */
function isInitialized() {
  return localStorage.getItem(CONFIG_KEY) !== null;
}

/**
 * Performs migration from legacy storage and imports current workspace from server
 * Should be called once on first load before initializing the UI
 * @returns {Promise<boolean>} True if migration was performed, false if already initialized
 */
async function migrateFromLegacy() {
  // Skip if already initialized
  if (isInitialized()) {
    return false;
  }

  console.log('[ConfigStore] Performing first-time migration...');

  const config = { ...DEFAULT_CONFIG, settings: { ...DEFAULT_CONFIG.settings } };

  // Migrate legacy theme setting
  const legacyTheme = localStorage.getItem(LEGACY_THEME_KEY);
  if (legacyTheme) {
    config.settings.theme = legacyTheme;
    console.log('[ConfigStore] Migrated theme setting:', legacyTheme);
  }

  // Import current workspace from server
  try {
    const res = await fetch('/api/board');
    if (res.ok) {
      const board = await res.json();
      if (board.meta && board.meta.repoPath) {
        const workspace = {
          id: generateWorkspaceId(),
          path: board.meta.repoPath,
          name: board.meta.projectName || getBasename(board.meta.repoPath),
          color: COLOR_PALETTE[0],
          lastAccessed: new Date().toISOString(),
        };
        config.workspaces.push(workspace);
        config.activeWorkspaceId = workspace.id;
        console.log('[ConfigStore] Imported workspace:', workspace.name);
      }
    }
  } catch (error) {
    console.error('[ConfigStore] Failed to import workspace from server:', error);
  }

  // Save the new config
  saveConfig(config);

  // Remove legacy theme key after successful migration
  if (legacyTheme) {
    localStorage.removeItem(LEGACY_THEME_KEY);
    console.log('[ConfigStore] Removed legacy theme key');
  }

  console.log('[ConfigStore] Migration complete');
  return true;
}

// Export all public functions
window.configStore = {
  getConfig,
  saveConfig,
  getWorkspaces,
  addWorkspace,
  removeWorkspace,
  setActiveWorkspace,
  getActiveWorkspace,
  getSetting,
  setSetting,
  isInitialized,
  migrateFromLegacy,
  COLOR_PALETTE,
};
