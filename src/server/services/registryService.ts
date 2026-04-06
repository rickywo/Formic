/**
 * Registry Service
 *
 * Fetches the community plugin registry from GitHub, caches it in memory
 * with TTL-based invalidation, and provides search, filter, detail lookup,
 * and update-check capabilities against that registry data.
 *
 * This is a foundational service that marketplace routes and the plugin
 * manager UI depend on for discovering and querying available plugins.
 *
 * All errors are logged with [RegistryService] prefix.
 */

import type { RegistryEntry, MarketplaceFilter, MarketplaceUpdate } from '../../types/index.js';

// ==================== Constants ====================

/** TTL for the in-memory registry cache (default: 5 minutes) */
export const REGISTRY_CACHE_TTL_MS = 5 * 60 * 1000;

/** URL of the community plugin registry hosted on GitHub */
const REGISTRY_URL = 'https://raw.githubusercontent.com/rickywo/formic-community-plugins/main/registry.json';

// ==================== Cache State ====================

/** Cached registry entries (null when cache is empty) */
let cachedEntries: RegistryEntry[] | null = null;

/** Timestamp of the last successful fetch (epoch ms) */
let cacheTimestamp = 0;

// ==================== Private Helpers ====================

/**
 * Validate that fetched data is a valid registry array.
 * Filters out entries missing required fields (`id`, `name`, `npm`, `version`)
 * and logs warnings for each invalid entry.
 */
function validateRegistryData(data: unknown): RegistryEntry[] {
  if (!Array.isArray(data)) {
    console.warn('[RegistryService] Fetched registry data is not an array');
    return [];
  }

  const valid: RegistryEntry[] = [];

  for (let i = 0; i < data.length; i++) {
    const entry = data[i] as Record<string, unknown>;
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof entry.id !== 'string' ||
      typeof entry.name !== 'string' ||
      typeof entry.npm !== 'string' ||
      typeof entry.version !== 'string'
    ) {
      console.warn(`[RegistryService] Skipping invalid registry entry at index ${i}: missing required fields`);
      continue;
    }
    valid.push(entry as unknown as RegistryEntry);
  }

  return valid;
}

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

// ==================== Exported Functions ====================

/**
 * Fetch the community plugin registry from GitHub.
 *
 * Returns cached data if the cache is still valid (within TTL).
 * On network failure, returns stale cached data with a warning,
 * or an empty array if no cache exists.
 */
export async function fetchRegistry(): Promise<RegistryEntry[]> {
  const now = Date.now();

  // Return cached data if TTL has not expired
  if (cachedEntries !== null && (now - cacheTimestamp) < REGISTRY_CACHE_TTL_MS) {
    return cachedEntries;
  }

  try {
    const response = await fetch(REGISTRY_URL);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const data: unknown = await response.json();
    const entries = validateRegistryData(data);

    // Update cache
    cachedEntries = entries;
    cacheTimestamp = Date.now();

    return entries;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.warn(`[RegistryService] Failed to fetch registry: ${message}`);

    // Graceful degradation: return stale cache if available
    if (cachedEntries !== null) {
      console.warn('[RegistryService] Returning stale cached data');
      return cachedEntries;
    }

    return [];
  }
}

/**
 * Clear the in-memory registry cache.
 * Useful for testing and manual refresh.
 */
export function invalidateCache(): void {
  cachedEntries = null;
  cacheTimestamp = 0;
}

/**
 * Search and filter registry entries with pagination.
 *
 * Applies case-insensitive substring match on `name`/`description` for `query`,
 * AND-logic tag matching for `tags`, and verified flag filtering.
 * Returns paginated results with the total count before pagination.
 */
export async function searchPlugins(filter: MarketplaceFilter): Promise<{ entries: RegistryEntry[]; total: number }> {
  let entries = await fetchRegistry();

  // Filter by free-text query (case-insensitive substring match on name or description)
  if (filter.query) {
    const q = filter.query.toLowerCase();
    entries = entries.filter(
      (e) => e.name.toLowerCase().includes(q) || e.description.toLowerCase().includes(q),
    );
  }

  // Filter by tags (AND-logic: plugin must include ALL listed tags)
  if (filter.tags && filter.tags.length > 0) {
    const requiredTags = filter.tags.map((t) => t.toLowerCase());
    entries = entries.filter((e) => {
      const pluginTags = (e.tags ?? []).map((t) => t.toLowerCase());
      return requiredTags.every((rt) => pluginTags.includes(rt));
    });
  }

  // Filter by verified status
  if (filter.verified === true) {
    entries = entries.filter((e) => e.verified);
  }

  const total = entries.length;

  // Pagination (1-based page, default page 1, default pageSize 20)
  const page = Math.max(1, filter.page ?? 1);
  const pageSize = Math.max(1, filter.pageSize ?? 20);
  const start = (page - 1) * pageSize;
  const paged = entries.slice(start, start + pageSize);

  return { entries: paged, total };
}

/**
 * Get details for a single plugin by its unique ID.
 * Returns the matching `RegistryEntry` or `null` if not found.
 */
export async function getPluginDetails(id: string): Promise<RegistryEntry | null> {
  const entries = await fetchRegistry();
  return entries.find((e) => e.id === id) ?? null;
}

/**
 * Check for available updates for installed plugins.
 *
 * Cross-references installed plugins (by npm package name or id)
 * against registry entries and returns updates where the registry
 * version is newer than the installed version.
 */
export async function checkUpdates(
  installedPlugins: Array<{ name: string; version: string }>,
): Promise<MarketplaceUpdate[]> {
  const entries = await fetchRegistry();
  const updates: MarketplaceUpdate[] = [];

  for (const installed of installedPlugins) {
    // Match by npm package name or by plugin id
    const match = entries.find(
      (e) => e.npm === installed.name || e.id === installed.name,
    );

    if (!match) {
      continue;
    }

    // Only report if registry version is strictly newer
    if (compareSemver(match.version, installed.version) > 0) {
      updates.push({
        pluginId: installed.name,
        installedVersion: installed.version,
        latestVersion: match.version,
        registryEntry: match,
      });
    }
  }

  return updates;
}
