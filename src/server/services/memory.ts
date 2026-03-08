/**
 * Memory Store Service
 * Persists structured memory entries to .formic/memory.json.
 * Used by the reflection step to record learnings and pitfalls after task completion.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getFormicDir } from '../utils/paths.js';
import type { MemoryEntry, MemoryStore, Task } from '../../types/index.js';

export const MAX_RELEVANT_MEMORIES = 5;

function getMemoryPath(): string {
  return path.join(getFormicDir(), 'memory.json');
}

/**
 * Load the memory store from disk.
 * Returns a default empty store if the file does not exist.
 */
export async function loadMemoryStore(): Promise<MemoryStore> {
  const memoryPath = getMemoryPath();

  if (!existsSync(memoryPath)) {
    return { version: '1.0', entries: [] };
  }

  try {
    const content = await readFile(memoryPath, 'utf-8');
    const parsed = JSON.parse(content) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'version' in parsed &&
      'entries' in parsed &&
      Array.isArray((parsed as { entries: unknown }).entries)
    ) {
      return parsed as MemoryStore;
    }
    console.warn('[Memory] memory.json has unexpected structure, returning empty store');
    return { version: '1.0', entries: [] };
  } catch (error) {
    console.warn('[Memory] Failed to load memory store:', error);
    return { version: '1.0', entries: [] };
  }
}

/**
 * Persist the memory store to disk.
 * Creates the .formic/ directory if it does not exist.
 */
export async function saveMemoryStore(store: MemoryStore): Promise<void> {
  await mkdir(getFormicDir(), { recursive: true });
  await writeFile(getMemoryPath(), JSON.stringify(store, null, 2), 'utf-8');
}

/**
 * Append a new memory entry to the store and persist it.
 * Generates a unique id and created_at timestamp automatically.
 */
export async function addMemory(
  entry: Omit<MemoryEntry, 'id' | 'created_at'>
): Promise<MemoryEntry> {
  const newEntry: MemoryEntry = {
    id: 'mem-' + randomUUID(),
    created_at: new Date().toISOString(),
    ...entry,
  };
  const store = await loadMemoryStore();
  store.entries.push(newEntry);
  await saveMemoryStore(store);
  console.log(`[Memory] Added memory entry ${newEntry.id} (type: ${newEntry.type}) for task ${newEntry.source_task}`);
  return newEntry;
}

/**
 * Return all memory entries from the store.
 */
export async function getMemories(): Promise<MemoryEntry[]> {
  const store = await loadMemoryStore();
  return store.entries;
}

/**
 * Compute a relevance score for a single memory entry against a task.
 * - Tag overlap: +2 per relevance_tag that appears (case-insensitive) in task title or context
 * - File path boost: +3 extra per matching tag that looks like a file path (contains '/' or '.')
 * - Recency decay: subtract up to −5 (weeks elapsed since creation, capped at 5)
 * Returns a score of minimum 0.
 */
function scoreMemory(entry: MemoryEntry, task: Task): number {
  const text = `${task.title} ${task.context}`.toLowerCase();
  let score = 0;

  for (const tag of entry.relevance_tags) {
    if (text.includes(tag.toLowerCase())) {
      score += 2;
      if (tag.includes('/') || tag.includes('.')) {
        score += 3;
      }
    }
  }

  const weeksElapsed = (Date.now() - Date.parse(entry.created_at)) / (7 * 24 * 60 * 60 * 1000);
  score -= Math.min(5, Math.floor(weeksElapsed));

  return Math.max(0, score);
}

/**
 * Return memory entries most relevant to the given task, scored and ranked.
 *
 * Scoring strategy:
 * - Tag overlap: +2 per relevance_tag that appears (case-insensitive) in task title or context
 * - File path boost: +3 extra per matching tag that looks like a file path (contains '/' or '.')
 * - Recency decay: subtract up to −5 (weeks elapsed since creation, capped at 5)
 *
 * Only entries with score > 0 are returned, sorted descending by score,
 * capped at MAX_RELEVANT_MEMORIES results.
 */
export async function getRelevantMemories(task: Task): Promise<MemoryEntry[]> {
  const entries = await getMemories();
  return entries
    .map(entry => ({ entry, score: scoreMemory(entry, task) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RELEVANT_MEMORIES)
    .map(({ entry }) => entry);
}
