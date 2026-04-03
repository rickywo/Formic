/**
 * Tool Catalog Service
 * Manages reusable agent-created tools stored as individual directories
 * in .formic/tools/<tool-name>/ with a manifest.json and script files.
 */
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { getFormicDir } from '../utils/paths.js';
import type { Tool, ToolManifest } from '../../types/index.js';

/** Returns the absolute path to the .formic/tools/ directory. */
export function getToolsDir(): string {
  return path.join(getFormicDir(), 'tools');
}

/** Creates the .formic/tools/ directory if it does not exist. */
async function ensureToolsDir(): Promise<void> {
  await mkdir(getToolsDir(), { recursive: true });
}

/**
 * Type guard that validates an unknown value is a valid ToolManifest.
 * Checks that all required fields exist with correct types.
 */
export function validateToolManifest(manifest: unknown): manifest is ToolManifest {
  if (typeof manifest !== 'object' || manifest === null) return false;
  const m = manifest as Record<string, unknown>;
  return (
    typeof m.name === 'string' && m.name.length > 0 &&
    typeof m.description === 'string' &&
    typeof m.command === 'string' &&
    typeof m.created_by === 'string' &&
    typeof m.usage_count === 'number'
  );
}

/**
 * List all tools in .formic/tools/.
 * Reads each subdirectory's manifest.json, validates it, and returns resolved Tool objects.
 * Skips subdirectories with missing or malformed manifests.
 */
export async function listTools(): Promise<Tool[]> {
  const toolsDir = getToolsDir();
  if (!existsSync(toolsDir)) return [];

  const tools: Tool[] = [];
  let entries: string[];
  try {
    entries = await readdir(toolsDir);
  } catch {
    return [];
  }

  for (const entry of entries) {
    const manifestPath = path.join(toolsDir, entry, 'manifest.json');
    if (!existsSync(manifestPath)) continue;

    try {
      const content = await readFile(manifestPath, 'utf-8');
      const parsed: unknown = JSON.parse(content);
      if (!validateToolManifest(parsed)) {
        console.warn(`[Tools] Skipping tool '${entry}': malformed manifest`);
        continue;
      }
      tools.push({
        name: parsed.name,
        scriptPath: path.join(toolsDir, entry),
        manifestPath,
        manifest: parsed,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      console.warn(`[Tools] Skipping tool '${entry}': ${msg}`);
    }
  }

  return tools;
}

/**
 * Get a single tool by name.
 * Returns null if the tool directory or manifest does not exist.
 */
export async function getTool(name: string): Promise<Tool | null> {
  const toolsDir = getToolsDir();
  const manifestPath = path.join(toolsDir, name, 'manifest.json');
  if (!existsSync(manifestPath)) return null;

  try {
    const content = await readFile(manifestPath, 'utf-8');
    const parsed: unknown = JSON.parse(content);
    if (!validateToolManifest(parsed)) {
      console.warn(`[Tools] Tool '${name}' has malformed manifest`);
      return null;
    }
    return {
      name: parsed.name,
      scriptPath: path.join(toolsDir, name),
      manifestPath,
      manifest: parsed,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.warn(`[Tools] Failed to load tool '${name}': ${msg}`);
    return null;
  }
}

/**
 * Increment usage_count in a tool's manifest.json.
 * No-ops silently if the tool is not found.
 */
export async function recordToolUsage(name: string): Promise<void> {
  const toolsDir = getToolsDir();
  const manifestPath = path.join(toolsDir, name, 'manifest.json');
  if (!existsSync(manifestPath)) return;

  try {
    const content = await readFile(manifestPath, 'utf-8');
    const parsed: unknown = JSON.parse(content);
    if (!validateToolManifest(parsed)) return;

    const updated: ToolManifest = { ...parsed, usage_count: parsed.usage_count + 1 };
    await writeFile(manifestPath, JSON.stringify(updated, null, 2), 'utf-8');
    console.log(`[Tools] Incremented usage for ${name}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.warn(`[Tools] Failed to record usage for '${name}': ${msg}`);
  }
}

/**
 * Register a new tool by creating a subdirectory with manifest.json.
 * Throws if the tool already exists or input is invalid.
 */
export async function addTool(input: { name: string; description: string; command: string; created_by: string }): Promise<Tool> {
  if (!input.name || !/^[a-z0-9-]+$/.test(input.name)) {
    throw new Error('[Tools] name must be a non-empty slug containing only lowercase letters, digits, and hyphens');
  }
  if (!input.description || !input.command) {
    throw new Error('[Tools] description and command are required');
  }

  const toolsDir = getToolsDir();
  const toolDir = path.join(toolsDir, input.name);
  const manifestPath = path.join(toolDir, 'manifest.json');

  if (existsSync(toolDir)) {
    throw new Error(`[Tools] A tool named '${input.name}' already exists`);
  }

  await ensureToolsDir();
  await mkdir(toolDir, { recursive: true });

  const manifest: ToolManifest = {
    name: input.name,
    description: input.description,
    command: input.command,
    created_by: input.created_by,
    usage_count: 0,
  };

  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
  console.log(`[Tools] Added tool ${manifest.name}`);

  return {
    name: manifest.name,
    scriptPath: toolDir,
    manifestPath,
    manifest,
  };
}
