/**
 * Broken Test Plugin — Server Entry
 *
 * This plugin deliberately throws during registration to test that
 * pluginManager.ts properly isolates errors and marks the plugin as
 * status: 'error' without crashing the Formic server or preventing
 * other plugins from loading.
 */

export default async function brokenTestPlugin() {
  throw new Error('Intentional plugin error for testing error isolation');
}
