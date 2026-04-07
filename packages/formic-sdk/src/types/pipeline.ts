// Configurable pipeline types — verbatim copies from src/types/index.ts

/** Describes a single pipeline stage in the workflow */
export interface StageDescriptor {
  /** Unique stage identifier (e.g., 'brief', 'plan', 'lint') */
  name: string;
  /** Human-readable label for board UI */
  displayName: string;
  /** Skill to load (maps to skills/{skillName}/SKILL.md or plugin-provided content) */
  skillName: string;
  /** The TaskStatus value to set when this stage is active */
  taskStatus: string;
  /** The WorkflowStep value for this stage */
  workflowStep: string;
  /** Whether this stage is core or plugin-contributed */
  source: 'builtin' | 'plugin';
  /** Which plugin registered this stage (if source is 'plugin') */
  pluginName?: string;
  /** Position in the pipeline sequence */
  order: number;
  /** Optional custom handler identifier */
  handler?: string;
}

/** Input type for plugins registering a custom stage */
export interface StageRegistration {
  /** Unique stage name */
  name: string;
  /** Human-readable label */
  displayName: string;
  /** Insert after this existing stage name */
  after: string;
  /** Inline skill prompt content */
  skillContent?: string;
  /** Path to skill file */
  skillPath?: string;
  /** Custom execution handler */
  handler?: (taskId: string) => Promise<void>;
}

/** Ordered array of StageDescriptor objects representing the full pipeline */
export type WorkflowPipeline = StageDescriptor[];

/** Plugin skill override registration */
export interface SkillOverride {
  /** Stage name to override */
  stageName: string;
  /** Override skill content */
  content: string;
  /** Plugin that registered this override */
  pluginName: string;
}

/** Defines a custom task type that plugins can register */
export interface TaskTypeDefinition {
  /** Unique identifier for the task type */
  id: string;
  /** Human-readable label */
  label: string;
  /** Optional icon identifier */
  icon?: string;
  /** Ordered workflow stages for this task type */
  workflow: StageDescriptor[];
  /** Optional skill prompt content */
  skillPrompt?: string;
}

/** Defines a single stage within a workflow */
export interface WorkflowStageDefinition {
  /** Stage identifier */
  name: string;
  /** Human-readable display name */
  displayName: string;
  /** Optional skill name to invoke during this stage */
  skillName?: string;
  /** Optional custom handler function for this stage */
  handler?: (taskId: string) => Promise<void>;
}

/** Defines a custom verification step that plugins can register */
export interface VerifierDefinition {
  /** Unique identifier for the verifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Name of the plugin that registered this verifier */
  pluginName: string;
  /** Optional description of what this verifier checks */
  description?: string;
  /** Verification handler — receives task ID, returns pass/fail with message and optional details */
  verify(taskId: string): Promise<VerifierResult>;
}

/** Result returned by a verifier's verify method */
export interface VerifierResult {
  /** Whether the verification passed */
  passed: boolean;
  /** Optional human-readable message */
  message?: string;
  /** Optional detailed output (e.g., test logs, diff) */
  details?: string;
}
