/**
 * Hello World Plugin — Server Entry
 *
 * Demonstrates server-side plugin capabilities:
 * - Registering a scoped Fastify route (GET /hello)
 * - Reading plugin settings via the Formic settings API
 *
 * This file is loaded by pluginManager.ts via dynamic import() and registered
 * as a Fastify plugin with prefix `/api/plugins/hello-world`.
 */

/**
 * Extract a usable value from a plugin setting.
 * Settings may be stored as schema objects ({ type, default, description })
 * when first discovered, or as plain values after user edits.
 */
function resolveSettingValue(raw, fallback) {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw === 'object' && raw !== null && 'default' in raw) {
    return raw.default ?? fallback;
  }
  return raw;
}

export default async function helloWorldPlugin(fastify) {
  // GET /hello — returns a greeting with timestamp
  fastify.get('/hello', async () => {
    let greeting = 'Hello from Formic!';

    try {
      const res = await fastify.inject({
        method: 'GET',
        url: '/api/plugins/hello-world/settings',
      });
      const data = JSON.parse(res.body);
      greeting = resolveSettingValue(data?.settings?.greeting, greeting);
    } catch {
      // Fall back to default greeting on any error
    }

    return { greeting, timestamp: Date.now() };
  });

  console.warn('[Plugin:hello-world] Hello World plugin registered');
}
