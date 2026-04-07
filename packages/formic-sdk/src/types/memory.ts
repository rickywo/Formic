// Long-term memory types — verbatim copies from src/types/index.ts

/** Type of memory: learned pattern, known pitfall, or user preference */
export type MemoryType = 'pattern' | 'pitfall' | 'preference';

/** A single memory entry persisted by the reflection step */
export interface MemoryEntry {
  /** Unique ID (mem-{uuid}) */
  id: string;
  /** Category of memory */
  type: MemoryType;
  /** Human-readable description of the memory */
  content: string;
  /** Task ID that generated this memory */
  source_task: string;
  /** ISO-8601 creation timestamp */
  created_at: string;
  /** Tags for relevance matching (file paths, keywords) */
  relevance_tags: string[];
}
