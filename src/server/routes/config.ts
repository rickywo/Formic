import type { FastifyInstance } from 'fastify';
import {
  loadConfig,
  saveConfig,
  addWorkspace,
  removeWorkspace,
  setActiveWorkspace,
  getSetting,
  setSetting,
} from '../services/configStore.js';
import type { FormicConfig, ConfigSettings } from '../../types/index.js';

export async function configRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /api/config - Return full config
  fastify.get('/api/config', async (_request, reply) => {
    const config = await loadConfig();
    return reply.send(config);
  });

  // POST /api/config/workspaces - Add a workspace
  fastify.post<{ Body: { path: string; name?: string; color?: string } }>(
    '/api/config/workspaces',
    async (request, reply) => {
      const { path, name, color } = request.body;

      if (!path) {
        return reply.status(400).send({ error: 'Path is required' });
      }

      const workspace = await addWorkspace({ path, name, color });
      return reply.send(workspace);
    }
  );

  // DELETE /api/config/workspaces/:id - Remove a workspace
  fastify.delete<{ Params: { id: string } }>(
    '/api/config/workspaces/:id',
    async (request, reply) => {
      const { id } = request.params;
      const removed = await removeWorkspace(id);

      if (!removed) {
        return reply.status(404).send({ error: 'Workspace not found' });
      }

      return reply.send({ success: true });
    }
  );

  // PUT /api/config/active-workspace - Set active workspace
  fastify.put<{ Body: { workspaceId: string } }>(
    '/api/config/active-workspace',
    async (request, reply) => {
      const { workspaceId } = request.body;

      if (!workspaceId) {
        return reply.status(400).send({ error: 'workspaceId is required' });
      }

      const success = await setActiveWorkspace(workspaceId);

      if (!success) {
        return reply.status(404).send({ error: 'Workspace not found' });
      }

      return reply.send({ success: true });
    }
  );

  // GET /api/config/settings/:key - Get a single setting
  fastify.get<{ Params: { key: string } }>(
    '/api/config/settings/:key',
    async (request, reply) => {
      const { key } = request.params;
      const validKeys: Array<keyof ConfigSettings> = [
        'maxConcurrentSessions',
        'theme',
        'notificationsEnabled',
        'projectBriefCollapsed',
      ];

      if (!validKeys.includes(key as keyof ConfigSettings)) {
        return reply.status(400).send({ error: `Invalid setting key: ${key}` });
      }

      const value = await getSetting(key as keyof ConfigSettings);
      return reply.send({ key, value });
    }
  );

  // PUT /api/config/settings/:key - Update a single setting
  fastify.put<{ Params: { key: string }; Body: { value: unknown } }>(
    '/api/config/settings/:key',
    async (request, reply) => {
      const { key } = request.params;
      const { value } = request.body;
      const validKeys: Array<keyof ConfigSettings> = [
        'maxConcurrentSessions',
        'theme',
        'notificationsEnabled',
        'projectBriefCollapsed',
      ];

      if (!validKeys.includes(key as keyof ConfigSettings)) {
        return reply.status(400).send({ error: `Invalid setting key: ${key}` });
      }

      if (value === undefined) {
        return reply.status(400).send({ error: 'Value is required' });
      }

      await setSetting(
        key as keyof ConfigSettings,
        value as ConfigSettings[keyof ConfigSettings]
      );
      return reply.send({ success: true });
    }
  );

  // POST /api/config/migrate - Accept full config from client localStorage migration
  fastify.post<{ Body: FormicConfig }>(
    '/api/config/migrate',
    async (request, reply) => {
      const incomingConfig = request.body;

      if (!incomingConfig || typeof incomingConfig !== 'object') {
        return reply.status(400).send({ error: 'Invalid config body' });
      }

      // Merge incoming config with defaults to ensure schema validity
      const currentConfig = await loadConfig();

      // Only migrate if server config is empty (no workspaces)
      if (currentConfig.workspaces.length > 0) {
        console.log('[ConfigStore] Migration skipped: server config already has workspaces');
        return reply.send({ migrated: false, reason: 'Server config already has data' });
      }

      const migratedConfig: FormicConfig = {
        version: 1,
        workspaces: Array.isArray(incomingConfig.workspaces) ? incomingConfig.workspaces : [],
        activeWorkspaceId: incomingConfig.activeWorkspaceId || null,
        settings: {
          ...currentConfig.settings,
          ...(incomingConfig.settings || {}),
        },
      };

      await saveConfig(migratedConfig);
      console.log('[ConfigStore] Migration from localStorage complete:', migratedConfig.workspaces.length, 'workspaces');
      return reply.send({ migrated: true, config: migratedConfig });
    }
  );
}
