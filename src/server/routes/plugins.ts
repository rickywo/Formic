import type { FastifyInstance } from 'fastify';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { PluginEntry, PluginConfig } from '../../types/index.js';
import {
  getPlugins,
  getPlugin,
  enablePlugin,
  disablePlugin,
  unloadPlugin,
  loadPlugin,
  discoverPlugins,
} from '../services/pluginManager.js';
import {
  getPluginConfig,
  setPluginConfig,
  removePluginConfig,
} from '../services/configStore.js';

/**
 * Serialize a PluginEntry for API responses (omit loadedModule).
 */
function serializePlugin(name: string, entry: PluginEntry) {
  return {
    name,
    version: entry.manifest.version,
    description: entry.manifest.description ?? null,
    author: entry.manifest.author ?? null,
    enabled: entry.status !== 'disabled',
    loaded: entry.status === 'loaded',
    status: entry.status,
    error: entry.error ?? null,
    hasServerEntry: !!entry.manifest.serverEntry,
    hasClientEntry: !!entry.manifest.clientEntry,
  };
}

/**
 * Mask secret-type settings in a settings object.
 * If the manifest declares a setting with type 'secret', replace its value with '***'.
 */
function maskSecrets(
  settings: Record<string, unknown>,
  manifestSettings: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!manifestSettings) return { ...settings };

  const masked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    const schema = manifestSettings[key];
    if (schema && typeof schema === 'object' && (schema as Record<string, unknown>).type === 'secret') {
      masked[key] = value ? '***' : null;
    } else {
      masked[key] = value;
    }
  }
  return masked;
}

/**
 * Validate a setting value against its declared type in the manifest.
 */
function validateSettingType(value: unknown, expectedType: string): boolean {
  switch (expectedType) {
    case 'string':
    case 'secret':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'number':
      return typeof value === 'number' && !isNaN(value);
    default:
      return true;
  }
}

export async function pluginRoutes(fastify: FastifyInstance): Promise<void> {

  // GET /api/plugins — List all installed plugins
  fastify.get('/api/plugins', async (_request, reply) => {
    const registry = getPlugins();
    const plugins = Array.from(registry.entries()).map(([name, entry]) =>
      serializePlugin(name, entry),
    );
    return reply.send({ plugins });
  });

  // GET /api/plugins/:name — Get detailed plugin info
  fastify.get<{ Params: { name: string } }>('/api/plugins/:name', async (request, reply) => {
    const { name } = request.params;
    const entry = getPlugin(name);

    if (!entry) {
      return reply.status(404).send({ error: 'Plugin not found', statusCode: 404 });
    }

    return reply.send({
      plugin: {
        ...serializePlugin(name, entry),
        manifest: entry.manifest,
      },
    });
  });

  // POST /api/plugins/:name/enable — Enable a plugin
  fastify.post<{ Params: { name: string } }>('/api/plugins/:name/enable', async (request, reply) => {
    const { name } = request.params;
    const entry = getPlugin(name);

    if (!entry) {
      return reply.status(404).send({ error: 'Plugin not found', statusCode: 404 });
    }

    await enablePlugin(name);

    // If the plugin has a server entry, attempt to load it
    if (entry.manifest.serverEntry) {
      await loadPlugin(name);
    }

    const updated = getPlugin(name);
    return reply.send({
      success: true,
      plugin: updated ? serializePlugin(name, updated) : { name, status: 'enabled' },
    });
  });

  // POST /api/plugins/:name/disable — Disable a plugin
  fastify.post<{ Params: { name: string } }>('/api/plugins/:name/disable', async (request, reply) => {
    const { name } = request.params;
    const entry = getPlugin(name);

    if (!entry) {
      return reply.status(404).send({ error: 'Plugin not found', statusCode: 404 });
    }

    // Unload if currently loaded
    if (entry.status === 'loaded') {
      await unloadPlugin(name);
    }

    await disablePlugin(name);

    const updated = getPlugin(name);
    return reply.send({
      success: true,
      plugin: updated ? serializePlugin(name, updated) : { name, status: 'disabled' },
    });
  });

  // GET /api/plugins/:name/settings — Get plugin settings
  fastify.get<{ Params: { name: string } }>('/api/plugins/:name/settings', async (request, reply) => {
    const { name } = request.params;
    const entry = getPlugin(name);

    if (!entry) {
      return reply.status(404).send({ error: 'Plugin not found', statusCode: 404 });
    }

    const persistedConfig = await getPluginConfig(name);

    // Merge manifest defaults with persisted settings
    const manifestDefaults = entry.manifest.settings ?? {};
    const persisted = persistedConfig?.settings ?? {};
    const merged: Record<string, unknown> = { ...manifestDefaults, ...persisted };

    return reply.send({
      settings: maskSecrets(merged, entry.manifest.settings),
    });
  });

  // PUT /api/plugins/:name/settings — Update plugin settings
  fastify.put<{ Params: { name: string }; Body: Record<string, unknown> }>(
    '/api/plugins/:name/settings',
    async (request, reply) => {
      const { name } = request.params;
      const entry = getPlugin(name);

      if (!entry) {
        return reply.status(404).send({ error: 'Plugin not found', statusCode: 404 });
      }

      const body = request.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return reply.status(400).send({ error: 'Request body must be a JSON object', statusCode: 400 });
      }

      const manifestSettings = entry.manifest.settings ?? {};

      // Validate each setting against manifest schema
      for (const [key, value] of Object.entries(body)) {
        const schema = manifestSettings[key];
        if (schema && typeof schema === 'object') {
          const expectedType = (schema as Record<string, unknown>).type;
          if (typeof expectedType === 'string' && !validateSettingType(value, expectedType)) {
            return reply.status(400).send({
              error: `Invalid value for setting '${key}': expected type '${expectedType}'`,
              statusCode: 400,
            });
          }
        }
      }

      // Merge with existing settings and persist
      const existingConfig: PluginConfig = (await getPluginConfig(name)) ?? { enabled: true, settings: {} };
      const updatedSettings = { ...existingConfig.settings, ...body };
      await setPluginConfig(name, {
        enabled: existingConfig.enabled,
        settings: updatedSettings,
      });

      return reply.send({
        success: true,
        settings: maskSecrets(updatedSettings, entry.manifest.settings),
      });
    },
  );

  // DELETE /api/plugins/:name — Uninstall a plugin
  fastify.delete<{ Params: { name: string } }>('/api/plugins/:name', async (request, reply) => {
    const { name } = request.params;
    const entry = getPlugin(name);

    if (!entry) {
      return reply.status(404).send({ error: 'Plugin not found', statusCode: 404 });
    }

    // Unload if loaded or enabled to clean up stages and skill overrides
    if (entry.status === 'loaded' || entry.status === 'enabled') {
      await unloadPlugin(name);
    }

    // Remove plugin directory
    try {
      await rm(entry.pluginDir, { recursive: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      return reply.status(500).send({ error: `Failed to remove plugin directory: ${msg}`, statusCode: 500 });
    }

    // Clean up persisted config
    await removePluginConfig(name);

    // Re-discover to update the registry
    await discoverPlugins();

    return reply.send({ success: true });
  });

  // GET /api/plugins/:name/client.js — Serve client-side plugin script
  fastify.get<{ Params: { name: string } }>('/api/plugins/:name/client.js', async (request, reply) => {
    const { name } = request.params;
    const entry = getPlugin(name);

    if (!entry) {
      return reply.status(404).send({ error: 'Plugin not found', statusCode: 404 });
    }

    if (!entry.manifest.clientEntry) {
      return reply.status(404).send({ error: 'Plugin has no client entry', statusCode: 404 });
    }

    const clientPath = path.resolve(entry.pluginDir, entry.manifest.clientEntry);

    try {
      const content = await readFile(clientPath, 'utf-8');
      return reply.type('application/javascript').send(content);
    } catch {
      return reply.status(404).send({ error: 'Client script file not found', statusCode: 404 });
    }
  });
}
