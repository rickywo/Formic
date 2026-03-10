/**
 * Tool Catalog Service
 * Persists a catalog of reusable agent-created tools to .formic/tools/tools.json.
 * Tools are shell commands registered by agents during task execution and can be
 * looked up and invoked (with usage tracking) across future tasks.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { getFormicDir } from '../utils/paths.js';
import type { Tool, ToolStore } from '../../types/index.js';

// In-memory async mutex to serialize concurrent read-modify-write operations on tools.json.
let writeLock: Promise<void> = Promise.resolve();

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = writeLock.then(fn);
  // Swallow rejections on the lock chain so one failure doesn't permanently block the queue.
  writeLock = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** Returns the absolute path to the tools catalog JSON file. */
export function getToolStorePath(): string {
  return path.join(getFormicDir(), 'tools', 'tools.json');
}

/** Creates the .formic/tools/ directory if it does not exist. */
async function ensureToolsDir(): Promise<void> {
  await mkdir(path.join(getFormicDir(), 'tools'), { recursive: true });
}

/**
 * Load the tool store from disk.
 * Returns a default empty store if the file does not exist or is malformed.
 */
export async function loadToolStore(): Promise<ToolStore> {
  const storePath = getToolStorePath();

  if (!existsSync(storePath)) {
    return { version: '1.0', tools: [] };
  }

  try {
    const content = await readFile(storePath, 'utf-8');
    const parsed = JSON.parse(content) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'version' in parsed &&
      'tools' in parsed &&
      Array.isArray((parsed as { tools: unknown }).tools)
    ) {
      return parsed as ToolStore;
    }
    console.warn('[Tools] tools.json has unexpected structure, returning empty store');
    return { version: '1.0', tools: [] };
  } catch (error) {
    console.warn('[Tools] Failed to load tool store:', error);
    return { version: '1.0', tools: [] };
  }
}

/**
 * Persist the tool store to disk.
 * Creates the .formic/tools/ directory lazily before writing.
 */
export async function saveToolStore(store: ToolStore): Promise<void> {
  await ensureToolsDir();
  await writeFile(getToolStorePath(), JSON.stringify(store, null, 2), 'utf-8');
}

/**
 * Return all tools in the catalog.
 */
export async function listTools(): Promise<Tool[]> {
  const store = await loadToolStore();
  return store.tools;
}

/**
 * Look up a single tool by name.
 * Returns undefined if no tool with that name is registered.
 */
export async function getTool(name: string): Promise<Tool | undefined> {
  const store = await loadToolStore();
  return store.tools.find(t => t.name === name);
}

/**
 * Validate a tool input before registration.
 * Enforces that name is a non-empty alphanumeric-plus-hyphens slug,
 * and that description and command are non-empty strings.
 */
export function validateTool(
  tool: Omit<Tool, 'created_at' | 'usage_count'>
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!tool.name || !/^[a-z0-9-]+$/.test(tool.name)) {
    errors.push('name must be a non-empty slug containing only lowercase letters, digits, and hyphens');
  }
  if (!tool.description || tool.description.trim().length === 0) {
    errors.push('description must be a non-empty string');
  }
  if (!tool.command || tool.command.trim().length === 0) {
    errors.push('command must be a non-empty string');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Register a new tool in the catalog.
 * Validates the input, guards against duplicate names, auto-generates
 * created_at and usage_count, persists, and returns the saved Tool.
 */
export async function addTool(
  input: Omit<Tool, 'created_at' | 'usage_count'>
): Promise<Tool> {
  const { valid, errors } = validateTool(input);
  if (!valid) {
    throw new Error(`[Tools] Invalid tool: ${errors.join('; ')}`);
  }

  const store = await loadToolStore();
  const existing = store.tools.find(t => t.name === input.name);
  if (existing) {
    throw new Error(`[Tools] A tool named '${input.name}' already exists`);
  }

  const tool: Tool = {
    ...input,
    created_at: new Date().toISOString(),
    usage_count: 0,
  };

  store.tools.push(tool);
  await saveToolStore(store);
  console.log(`[Tools] Added tool ${tool.name}`);
  return tool;
}

/**
 * Increment the usage_count of a named tool by 1 and persist.
 * No-ops silently if the tool is not found.
 */
export async function incrementUsage(name: string): Promise<void> {
  const store = await loadToolStore();
  const tool = store.tools.find(t => t.name === name);
  if (!tool) {
    return;
  }
  tool.usage_count += 1;
  await saveToolStore(store);
  console.log(`[Tools] Incremented usage for ${name}`);
}
