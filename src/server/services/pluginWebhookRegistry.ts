/**
 * Plugin Webhook Registry Service
 *
 * In-memory registry mapping pluginName -> path -> WebhookHandler.
 * Allows plugins to register HTTP webhook endpoints that are dispatched
 * via the dynamic route in webhooks.ts at POST /api/webhooks/:pluginName/:path.
 */

import type { WebhookHandler, WebhookResponse } from '../../types/index.js';

/** Nested map: pluginName -> path -> handler */
const registry = new Map<string, Map<string, WebhookHandler>>();

/**
 * Register a webhook handler for a plugin at the given path.
 * Normalizes the path by stripping a leading slash if present.
 */
export function registerPluginWebhook(pluginName: string, path: string, handler: WebhookHandler): void {
  if (!path || typeof path !== 'string' || path.trim().length === 0) {
    throw new Error('[WebhookRegistry] Webhook path must be a non-empty string');
  }
  if (typeof handler !== 'function') {
    throw new Error('[WebhookRegistry] Webhook handler must be a function');
  }

  // Normalize path by stripping leading slash
  const normalizedPath = path.replace(/^\/+/, '');

  if (!registry.has(pluginName)) {
    registry.set(pluginName, new Map());
  }
  registry.get(pluginName)!.set(normalizedPath, handler);

  console.warn(`[WebhookRegistry] Registered webhook: ${pluginName}/${normalizedPath}`);
}

/**
 * Unregister all webhook handlers for a plugin.
 * Returns the count of removed handlers.
 */
export function unregisterPluginWebhooks(pluginName: string): number {
  const pluginHandlers = registry.get(pluginName);
  if (!pluginHandlers) {
    return 0;
  }

  const count = pluginHandlers.size;
  registry.delete(pluginName);

  console.warn(`[WebhookRegistry] Unregistered ${count} webhook(s) for plugin: ${pluginName}`);
  return count;
}

/**
 * Dispatch an incoming webhook request to the registered handler.
 * Returns the handler's WebhookResponse, or null if no handler is found.
 */
export async function dispatchPluginWebhook(
  pluginName: string,
  path: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<WebhookResponse | null> {
  // Normalize path by stripping leading slash
  const normalizedPath = path.replace(/^\/+/, '');

  const pluginHandlers = registry.get(pluginName);
  if (!pluginHandlers) {
    return null;
  }

  const handler = pluginHandlers.get(normalizedPath);
  if (!handler) {
    return null;
  }

  return handler(body, headers);
}
