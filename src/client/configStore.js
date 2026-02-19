/**
 * Formic Config Store - API-backed configuration management
 *
 * Manages workspaces and application settings via server-side ~/.formic/config.json.
 * Uses an in-memory cache populated on init() for synchronous reads, with async
 * mutations that update cache immediately and persist via API calls.
 *
 * Includes one-time migration from localStorage to server on first load.
 *
 * @module configStore
 */

/** localStorage key for legacy config (used for migration detection) */
const LEGACY_CONFIG_KEY = 'formic-config';

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

/** In-memory cache of the config, populated by init() */
let _cache = { ...DEFAULT_CONFIG, settings: { ...DEFAULT_CONFIG.settings } };

/** Whether init() has completed */
let _initialized = false;

/**
 * Extracts the folder name from a path
 * @param {string} filePath - Absolute file path
 * @returns {string} The basename of the path
 */
function getBasename(filePath) {
  if (!filePath) return 'Unknown';
  const normalized = filePath.replace(/\\/g, '/').replace(/\/$/, '');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || 'Unknown';
}

/**
 * Determines the next available color from the palette
 * @param {Array} workspaces - Existing workspaces
 * @returns {string} Hex color code
 */
function getNextColor(workspaces) {
  const usedColors = new Set(workspaces.map(ws => ws.color));
  for (const color of COLOR_PALETTE) {
    if (!usedColors.has(color)) {
      return color;
    }
  }
  return COLOR_PALETTE[workspaces.length % COLOR_PALETTE.length];
}

/**
 * Fetch the full config from the server API
 * @returns {Promise<Config>} The server-side configuration
 */
async function fetchConfigFromServer() {
  try {
    const res = await fetch('/api/config');
    if (res.ok) {
      const config = await res.json();
      return {
        ...DEFAULT_CONFIG,
        ...config,
        settings: {
          ...DEFAULT_CONFIG.settings,
          ...(config.settings || {}),
        },
      };
    }
  } catch (error) {
    console.error('[ConfigStore] Failed to fetch config from server:', error);
  }
  return { ...DEFAULT_CONFIG, settings: { ...DEFAULT_CONFIG.settings } };
}

/**
 * Retrieves the full configuration from cache
 * @returns {Config} The configuration object
 */
function getConfig() {
  return _cache;
}

/**
 * Persists the full configuration to the server.
 * Updates the local cache immediately.
 * @param {Config} config - The configuration object to save
 * @returns {boolean} True (always succeeds for cache; server write is async)
 */
function saveConfig(config) {
  _cache = config;
  // Note: full config save is not exposed as a single server endpoint.
  // Individual mutations (addWorkspace, setSetting, etc.) handle their own persistence.
  // This function exists for backward compatibility with UI code that calls saveConfig directly.
  return true;
}

/**
 * Retrieves all workspaces from cache
 * @returns {Workspace[]} Array of workspace objects
 */
function getWorkspaces() {
  return _cache.workspaces;
}

/**
 * Adds a new workspace to the configuration.
 * Updates cache immediately and persists to server asynchronously.
 * @param {Object} options - Workspace options
 * @param {string} options.path - Absolute path to the workspace
 * @param {string} [options.name] - Display name (auto-derived from path if not provided)
 * @param {string} [options.color] - Hex color (auto-assigned if not provided)
 * @returns {Workspace} The newly created workspace object
 */
function addWorkspace({ path, name, color }) {
  // Check if workspace with same path already exists in cache
  const existing = _cache.workspaces.find(ws => ws.path === path);
  if (existing) {
    return existing;
  }

  const workspace = {
    id: `ws-${crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36)}`,
    path: path,
    name: name || getBasename(path),
    color: color || getNextColor(_cache.workspaces),
    lastAccessed: new Date().toISOString(),
  };

  _cache.workspaces.push(workspace);

  if (_cache.workspaces.length === 1) {
    _cache.activeWorkspaceId = workspace.id;
  }

  // Persist to server asynchronously
  fetch('/api/config/workspaces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, name, color }),
  }).then(res => {
    if (res.ok) {
      return res.json().then(serverWorkspace => {
        // Update cache with server-assigned ID (server generates its own UUID)
        const idx = _cache.workspaces.findIndex(ws => ws.path === path);
        if (idx !== -1) {
          _cache.workspaces[idx] = serverWorkspace;
          if (_cache.activeWorkspaceId === workspace.id) {
            _cache.activeWorkspaceId = serverWorkspace.id;
          }
        }
      });
    }
  }).catch(err => {
    console.error('[ConfigStore] Failed to persist addWorkspace:', err);
  });

  return workspace;
}

/**
 * Removes a workspace by ID.
 * Updates cache immediately and persists to server asynchronously.
 * @param {string} workspaceId - The workspace ID to remove
 * @returns {boolean} True if workspace was removed, false if not found
 */
function removeWorkspace(workspaceId) {
  const index = _cache.workspaces.findIndex(ws => ws.id === workspaceId);

  if (index === -1) {
    return false;
  }

  _cache.workspaces.splice(index, 1);

  if (_cache.activeWorkspaceId === workspaceId) {
    _cache.activeWorkspaceId = _cache.workspaces.length > 0
      ? _cache.workspaces[0].id
      : null;
  }

  // Persist to server asynchronously
  fetch(`/api/config/workspaces/${workspaceId}`, {
    method: 'DELETE',
  }).catch(err => {
    console.error('[ConfigStore] Failed to persist removeWorkspace:', err);
  });

  return true;
}

/**
 * Sets the active workspace and updates its lastAccessed timestamp.
 * Updates cache immediately and persists to server asynchronously.
 * @param {string} workspaceId - The workspace ID to activate
 * @returns {boolean} True if workspace was found and activated
 */
function setActiveWorkspace(workspaceId) {
  const workspace = _cache.workspaces.find(ws => ws.id === workspaceId);

  if (!workspace) {
    return false;
  }

  _cache.activeWorkspaceId = workspaceId;
  workspace.lastAccessed = new Date().toISOString();

  // Persist to server asynchronously
  fetch('/api/config/active-workspace', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId }),
  }).catch(err => {
    console.error('[ConfigStore] Failed to persist setActiveWorkspace:', err);
  });

  return true;
}

/**
 * Retrieves the currently active workspace from cache
 * @returns {Workspace|null} The active workspace object, or null if none
 */
function getActiveWorkspace() {
  if (!_cache.activeWorkspaceId) {
    return null;
  }
  return _cache.workspaces.find(ws => ws.id === _cache.activeWorkspaceId) || null;
}

/**
 * Retrieves a setting value by key from cache
 * @param {string} key - The setting key
 * @returns {*} The setting value, or undefined if not found
 */
function getSetting(key) {
  return _cache.settings[key];
}

/**
 * Updates a setting value.
 * Updates cache immediately and persists to server asynchronously.
 * @param {string} key - The setting key
 * @param {*} value - The value to set
 * @returns {boolean} True (always succeeds for cache)
 */
function setSetting(key, value) {
  _cache.settings[key] = value;

  // Persist to server asynchronously
  fetch(`/api/config/settings/${key}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value }),
  }).catch(err => {
    console.error('[ConfigStore] Failed to persist setSetting:', err);
  });

  return true;
}

/**
 * Checks if the config store has been initialized
 * @returns {boolean} True if init() has completed
 */
function isInitialized() {
  return _initialized;
}

/**
 * Initializes the config store by fetching config from the server.
 * Performs one-time localStorage-to-server migration if needed.
 * Must be called once before using any other configStore functions.
 * @returns {Promise<void>}
 */
async function init() {
  // Fetch current server config
  const serverConfig = await fetchConfigFromServer();

  // One-time migration: if server config has no workspaces but localStorage has data,
  // migrate localStorage data to the server
  const legacyData = localStorage.getItem(LEGACY_CONFIG_KEY);
  const legacyTheme = localStorage.getItem(LEGACY_THEME_KEY);

  if (serverConfig.workspaces.length === 0 && (legacyData || legacyTheme)) {
    console.log('[ConfigStore] Detected legacy localStorage data, migrating to server...');

    let migrateConfig = { ...DEFAULT_CONFIG, settings: { ...DEFAULT_CONFIG.settings } };

    // Parse legacy localStorage config
    if (legacyData) {
      try {
        const parsed = JSON.parse(legacyData);
        migrateConfig = {
          ...migrateConfig,
          ...parsed,
          version: 1,
          settings: {
            ...migrateConfig.settings,
            ...(parsed.settings || {}),
          },
        };
      } catch (err) {
        console.error('[ConfigStore] Failed to parse legacy config:', err);
      }
    }

    // Migrate legacy theme setting
    if (legacyTheme) {
      migrateConfig.settings.theme = legacyTheme;
    }

    // If no workspaces in legacy data, import current workspace from board
    if (migrateConfig.workspaces.length === 0) {
      try {
        const res = await fetch('/api/board');
        if (res.ok) {
          const board = await res.json();
          if (board.meta && board.meta.repoPath) {
            const workspace = {
              id: `ws-${crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36)}`,
              path: board.meta.repoPath,
              name: board.meta.projectName || getBasename(board.meta.repoPath),
              color: COLOR_PALETTE[0],
              lastAccessed: new Date().toISOString(),
            };
            migrateConfig.workspaces.push(workspace);
            migrateConfig.activeWorkspaceId = workspace.id;
            console.log('[ConfigStore] Imported workspace from board:', workspace.name);
          }
        }
      } catch (err) {
        console.error('[ConfigStore] Failed to import workspace from board:', err);
      }
    }

    // Send migration data to server
    try {
      const res = await fetch('/api/config/migrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(migrateConfig),
      });

      if (res.ok) {
        const result = await res.json();
        if (result.migrated) {
          _cache = result.config;
          console.log('[ConfigStore] Migration to server complete');

          // Clear legacy localStorage keys
          localStorage.removeItem(LEGACY_CONFIG_KEY);
          if (legacyTheme) {
            localStorage.removeItem(LEGACY_THEME_KEY);
          }
          console.log('[ConfigStore] Cleared legacy localStorage data');
        } else {
          // Server already had data, use server config
          _cache = serverConfig;
        }
      } else {
        // Migration failed, use server config as-is
        _cache = serverConfig;
      }
    } catch (err) {
      console.error('[ConfigStore] Migration request failed:', err);
      _cache = serverConfig;
    }
  } else {
    _cache = serverConfig;
  }

  _initialized = true;
  console.log('[ConfigStore] Initialized with', _cache.workspaces.length, 'workspaces');
}

// Export all public functions (preserving window.configStore.* API surface)
window.configStore = {
  init,
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
  // Keep migrateFromLegacy as a no-op alias for backward compatibility
  migrateFromLegacy: async function() { /* migration now handled by init() */ return false; },
  COLOR_PALETTE,
};
