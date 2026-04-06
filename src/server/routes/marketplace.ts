import type { FastifyInstance } from 'fastify';
import type { RegistryEntry, MarketplaceFilter, MarketplaceUpdate } from '../../types/index.js';
import {
  searchPlugins,
  getPluginDetails,
  checkUpdates,
} from '../services/registryService.js';
import {
  getPlugins,
  installPluginFromNpm,
  uninstallPlugin,
} from '../services/pluginManager.js';

export async function marketplaceRoutes(fastify: FastifyInstance): Promise<void> {

  // GET /api/marketplace — Search and filter registry entries with pagination
  fastify.get<{
    Querystring: {
      query?: string;
      tags?: string;
      verified?: string;
      page?: string;
      pageSize?: string;
    };
  }>('/api/marketplace', async (request, reply) => {
    try {
      const { query, tags, verified, page, pageSize } = request.query;

      const filter: MarketplaceFilter = {};

      if (query) {
        filter.query = query;
      }

      if (tags) {
        filter.tags = tags.split(',').map((t) => t.trim()).filter(Boolean);
      }

      if (verified !== undefined) {
        filter.verified = verified === 'true';
      }

      if (page) {
        filter.page = parseInt(page, 10);
      }

      if (pageSize) {
        filter.pageSize = parseInt(pageSize, 10);
      }

      const result = await searchPlugins(filter);

      return reply.send({
        entries: result.entries,
        total: result.total,
        page: filter.page ?? 1,
        pageSize: filter.pageSize ?? 20,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error(`[MarketplaceRoutes] GET /api/marketplace failed: ${message}`);
      return reply.status(500).send({ error: message });
    }
  });

  // GET /api/marketplace/updates — Check for available updates for installed plugins
  fastify.get('/api/marketplace/updates', async (_request, reply) => {
    try {
      const pluginRegistry = getPlugins();
      const installed: Array<{ name: string; version: string }> = [];

      for (const [name, entry] of pluginRegistry) {
        installed.push({
          name,
          version: entry.manifest.version,
        });
      }

      const updates: MarketplaceUpdate[] = await checkUpdates(installed);
      return reply.send({ updates });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error(`[MarketplaceRoutes] GET /api/marketplace/updates failed: ${message}`);
      return reply.status(500).send({ error: message });
    }
  });

  // GET /api/marketplace/:id — Get details for a single registry entry
  fastify.get<{ Params: { id: string } }>('/api/marketplace/:id', async (request, reply) => {
    try {
      const { id } = request.params;
      const entry: RegistryEntry | null = await getPluginDetails(id);

      if (!entry) {
        return reply.status(404).send({ error: 'Plugin not found in registry' });
      }

      return reply.send(entry);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error(`[MarketplaceRoutes] GET /api/marketplace/:id failed: ${message}`);
      return reply.status(500).send({ error: message });
    }
  });

  // POST /api/marketplace/:id/install — Install a plugin from the marketplace
  fastify.post<{
    Params: { id: string };
    Body: { confirmed?: boolean };
  }>('/api/marketplace/:id/install', async (request, reply) => {
    try {
      const { id } = request.params;
      const body = request.body ?? {};

      const entry: RegistryEntry | null = await getPluginDetails(id);
      if (!entry) {
        return reply.status(404).send({ error: 'Plugin not found in registry' });
      }

      // Enforce verified-plugin consent gate
      if (entry.verified === false && body.confirmed !== true) {
        return reply.status(403).send({
          error: 'unverified_plugin',
          message: 'This plugin has not been verified by the Formic team. Set confirmed: true to proceed.',
        });
      }

      await installPluginFromNpm(entry.npm, entry.id);
      return reply.send({ success: true, pluginId: entry.id });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error(`[MarketplaceRoutes] POST /api/marketplace/:id/install failed: ${message}`);
      return reply.status(500).send({ error: message });
    }
  });

  // POST /api/marketplace/:id/update — Update an installed plugin to the latest version
  fastify.post<{ Params: { id: string } }>('/api/marketplace/:id/update', async (request, reply) => {
    try {
      const { id } = request.params;

      const entry: RegistryEntry | null = await getPluginDetails(id);
      if (!entry) {
        return reply.status(404).send({ error: 'Plugin not found in registry' });
      }

      await uninstallPlugin(id);
      await installPluginFromNpm(entry.npm, entry.id);

      return reply.send({ success: true, pluginId: entry.id, version: entry.version });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error(`[MarketplaceRoutes] POST /api/marketplace/:id/update failed: ${message}`);
      return reply.status(500).send({ error: message });
    }
  });
}
