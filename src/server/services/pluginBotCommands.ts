/**
 * Plugin Bot Commands Registry Service
 *
 * In-memory registry mapping command names to plugin-registered bot command handlers.
 * Allows plugins to register custom slash commands (e.g. /deploy, /metrics) that
 * Telegram and LINE users can invoke directly in chat.
 */

import type { BotCommandDefinition } from '../../types/index.js';

/** Backing store: command name -> { pluginName, command } */
const registry = new Map<string, { pluginName: string; command: BotCommandDefinition }>();

/**
 * Register a bot command for a plugin.
 * Stores the command keyed by its name (without leading slash).
 */
export function registerBotCommand(pluginName: string, command: BotCommandDefinition): void {
  if (!command.name || typeof command.name !== 'string' || command.name.trim().length === 0) {
    throw new Error('[BotCommands] Bot command name must be a non-empty string');
  }
  if (typeof command.handler !== 'function') {
    throw new Error('[BotCommands] Bot command handler must be a function');
  }

  // Normalize name by stripping leading slash if present
  const normalizedName = command.name.replace(/^\/+/, '');

  registry.set(normalizedName, { pluginName, command });

  console.warn(`[BotCommands] Plugin '${pluginName}' registered command /${normalizedName}`);
}

/**
 * Unregister all bot commands for a plugin.
 * Returns the count of removed commands.
 */
export function unregisterBotCommands(pluginName: string): number {
  let count = 0;

  for (const [name, entry] of registry) {
    if (entry.pluginName === pluginName) {
      registry.delete(name);
      count++;
    }
  }

  if (count > 0) {
    console.warn(`[BotCommands] Unregistered ${count} command(s) for plugin: ${pluginName}`);
  }

  return count;
}

/**
 * Dispatch an incoming bot command to the registered handler.
 * Strips leading `/` from the command name if present.
 * Returns the handler's response string, or null if no matching command is found.
 */
export async function dispatchBotCommand(
  commandName: string,
  args: string,
  chatId: string,
): Promise<string | null> {
  // Normalize by stripping leading slash
  const normalizedName = commandName.replace(/^\/+/, '');

  const entry = registry.get(normalizedName);
  if (!entry) {
    return null;
  }

  try {
    return await entry.command.handler(args, chatId);
  } catch (err) {
    console.error(
      `[BotCommands] Error dispatching command /${normalizedName}:`,
      err instanceof Error ? err.message : 'Unknown error',
    );
    return null;
  }
}
