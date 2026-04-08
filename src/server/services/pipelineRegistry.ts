/**
 * Pipeline Registry Service
 *
 * Manages the ordered list of workflow pipeline stages for each task type.
 * Provides default pipelines for standard, quick, and goal workflows,
 * and supports plugin-contributed stage insertion.
 */

import type { StageDescriptor, StageRegistration, WorkflowPipeline, TaskType, TaskTypeDefinition } from '../../types/index.js';
import { internalEvents, STAGE_REGISTERED, TASK_TYPE_REGISTERED } from './internalEvents.js';
import { VALID_TASK_STATUSES } from './store.js';
export {
  registerVerifier,
  unregisterVerifiers,
  getRegisteredVerifiers,
  runVerifiers,
} from './skillReader.js';

// ==================== Default Pipeline Definitions ====================

const STANDARD_PIPELINE: WorkflowPipeline = [
  {
    name: 'brief',
    displayName: 'Briefing',
    skillName: 'brief',
    taskStatus: 'briefing',
    workflowStep: 'brief',
    source: 'builtin',
    order: 0,
  },
  {
    name: 'plan',
    displayName: 'Planning',
    skillName: 'plan',
    taskStatus: 'planning',
    workflowStep: 'plan',
    source: 'builtin',
    order: 1,
  },
  {
    name: 'declare',
    displayName: 'Declaring',
    skillName: 'declare',
    taskStatus: 'declaring',
    workflowStep: 'declare',
    source: 'builtin',
    order: 2,
  },
  {
    name: 'execute',
    displayName: 'Running',
    skillName: 'execute',
    taskStatus: 'running',
    workflowStep: 'execute',
    source: 'builtin',
    order: 3,
  },
  {
    name: 'verify',
    displayName: 'Verifying',
    skillName: 'verify',
    taskStatus: 'verifying',
    workflowStep: 'verify',
    source: 'builtin',
    order: 4,
  },
];

const QUICK_PIPELINE: WorkflowPipeline = [
  {
    name: 'execute',
    displayName: 'Running',
    skillName: 'execute',
    taskStatus: 'running',
    workflowStep: 'execute',
    source: 'builtin',
    order: 0,
  },
  {
    name: 'verify',
    displayName: 'Verifying',
    skillName: 'verify',
    taskStatus: 'verifying',
    workflowStep: 'verify',
    source: 'builtin',
    order: 1,
  },
];

const GOAL_PIPELINE: WorkflowPipeline = [
  {
    name: 'architect',
    displayName: 'Architecting',
    skillName: 'architect',
    taskStatus: 'architecting',
    workflowStep: 'architect',
    source: 'builtin',
    order: 0,
  },
];

// ==================== Plugin Stage Registry ====================

/** Plugin-registered stages, keyed by plugin name */
const pluginStages = new Map<string, StageDescriptor[]>();

/** Plugin-provided custom handler functions, keyed by stage name */
const pluginHandlers = new Map<string, (taskId: string) => Promise<void>>();

// ==================== Custom Task Type Registry ====================

/** Plugin-registered custom task types, keyed by task type ID */
const customTaskTypes = new Map<string, TaskTypeDefinition & { pluginName: string }>();

/** Compiled pipelines for custom task types, keyed by task type ID */
const customPipelines = new Map<string, WorkflowPipeline>();

// ==================== Public API ====================

/**
 * Returns a deep copy of the default pipeline for a given task type.
 */
export function getDefaultPipeline(taskType: TaskType | string): WorkflowPipeline {
  switch (taskType) {
    case 'standard':
      return structuredClone(STANDARD_PIPELINE);
    case 'quick':
      return structuredClone(QUICK_PIPELINE);
    case 'goal':
      return structuredClone(GOAL_PIPELINE);
    default: {
      const custom = customPipelines.get(taskType);
      if (custom) {
        return structuredClone(custom);
      }
      console.warn(`[Pipeline] Unknown task type '${taskType}', returning standard pipeline`);
      return structuredClone(STANDARD_PIPELINE);
    }
  }
}

/**
 * Returns the default pipeline merged with any plugin-registered stages,
 * sorted by order.
 */
export function getActivePipeline(taskType: TaskType | string): WorkflowPipeline {
  const pipeline = getDefaultPipeline(taskType);

  // For custom task types, return their pipeline as-is (they define their own stages)
  if (customPipelines.has(taskType)) {
    return pipeline;
  }

  // Collect all plugin stages
  const allPluginStages: StageDescriptor[] = [];
  for (const stages of pluginStages.values()) {
    allPluginStages.push(...stages);
  }

  if (allPluginStages.length === 0) {
    return pipeline;
  }

  // Insert each plugin stage after its declared anchor
  for (const pluginStage of allPluginStages) {
    // Find the anchor stage in the current pipeline by matching the 'after' position
    // Plugin stages store their anchor in the handler field during registration
    // We need to find where to insert based on order
    pipeline.push(pluginStage);
  }

  // Re-sort by order and re-number
  pipeline.sort((a, b) => a.order - b.order);
  for (let i = 0; i < pipeline.length; i++) {
    pipeline[i].order = i;
  }

  return pipeline;
}

const BUILTIN_TASK_TYPES = new Set(['standard', 'quick', 'goal']);

/**
 * Registers a custom pipeline for a task type.
 * Lower-level function; stores stages directly into the custom pipeline map.
 * Rejects built-in task types to prevent overriding core workflows.
 */
export function registerCustomPipeline(taskType: string, stages: StageDescriptor[]): void {
  if (BUILTIN_TASK_TYPES.has(taskType)) {
    throw new Error(`[Pipeline] Cannot override built-in task type '${taskType}'`);
  }
  const pipeline: WorkflowPipeline = stages.map((stage, index) => ({
    ...stage,
    source: 'plugin' as const,
    order: index,
  }));
  customPipelines.set(taskType, pipeline);
  console.warn(`[Pipeline] Registered custom pipeline for task type '${taskType}'`);
}

/**
 * Removes the custom pipeline for a specific task type.
 * Returns true if a pipeline existed and was removed.
 */
export function unregisterCustomPipeline(taskType: string): boolean {
  const existed = customPipelines.has(taskType);
  if (existed) {
    customPipelines.delete(taskType);
    console.warn(`[Pipeline] Unregistered custom pipeline for task type '${taskType}'`);
  }
  return existed;
}

/**
 * Registers a custom task type contributed by a plugin.
 * Validates uniqueness against built-in types and previously registered types.
 */
export function registerTaskType(definition: TaskTypeDefinition, pluginName: string): void {
  if (BUILTIN_TASK_TYPES.has(definition.id)) {
    throw new Error(`[Pipeline] Cannot override built-in task type '${definition.id}'`);
  }
  if (customTaskTypes.has(definition.id)) {
    throw new Error(`[Pipeline] Task type '${definition.id}' is already registered`);
  }

  registerCustomPipeline(definition.id, definition.workflow);
  // Annotate the pipeline entries with the plugin name
  const pipeline = customPipelines.get(definition.id)!;
  customPipelines.set(definition.id, pipeline.map(stage => ({ ...stage, pluginName })));

  customTaskTypes.set(definition.id, { ...definition, pluginName });

  console.warn(`[Pipeline] Registered custom task type '${definition.id}' from plugin '${pluginName}'`);
  internalEvents.emit(TASK_TYPE_REGISTERED, { taskTypeId: definition.id, pluginName });
}

/**
 * Removes all custom task types registered by a given plugin.
 * Returns the count of removed task types.
 */
export function unregisterTaskTypes(pluginName: string): number {
  let count = 0;
  for (const [id, entry] of customTaskTypes) {
    if (entry.pluginName === pluginName) {
      customTaskTypes.delete(id);
      customPipelines.delete(id);
      count++;
    }
  }
  if (count > 0) {
    console.warn(`[Pipeline] Unregistered ${count} task type(s) from plugin '${pluginName}'`);
  }
  return count;
}

/** Canonical alias for registerTaskType, as specified in the requirements. */
export const registerCustomTaskType = registerTaskType;

/** Canonical alias for unregisterTaskTypes, as specified in the requirements. */
export const unregisterCustomTaskTypes = unregisterTaskTypes;

/**
 * Returns all registered custom task types.
 */
export function getCustomTaskTypes(): TaskTypeDefinition[] {
  return [...customTaskTypes.values()].map(({ pluginName: _pluginName, ...def }) => def);
}

/**
 * Registers a plugin stage into the pipeline, inserted after the named anchor stage.
 * Validates uniqueness and anchor existence.
 */
export function registerStage(registration: StageRegistration, pluginName: string): StageDescriptor {
  // Check for duplicate stage name across all pipelines
  const allStageNames = new Set<string>();
  for (const stage of STANDARD_PIPELINE) allStageNames.add(stage.name);
  for (const stage of QUICK_PIPELINE) allStageNames.add(stage.name);
  for (const stage of GOAL_PIPELINE) allStageNames.add(stage.name);
  for (const stages of pluginStages.values()) {
    for (const stage of stages) allStageNames.add(stage.name);
  }

  if (allStageNames.has(registration.name)) {
    throw new Error(`[Pipeline] Stage name '${registration.name}' is already registered`);
  }

  // Validate the anchor stage exists in at least one default pipeline
  const allDefaultStages = [...STANDARD_PIPELINE, ...QUICK_PIPELINE, ...GOAL_PIPELINE];
  const allExistingStages = [...allDefaultStages];
  for (const stages of pluginStages.values()) {
    allExistingStages.push(...stages);
  }

  const anchorStage = allExistingStages.find(s => s.name === registration.after);
  if (!anchorStage) {
    throw new Error(`[Pipeline] Anchor stage '${registration.after}' does not exist`);
  }

  // Create the stage descriptor
  const descriptor: StageDescriptor = {
    name: registration.name,
    displayName: registration.displayName,
    skillName: registration.name,
    taskStatus: registration.name,
    workflowStep: registration.name,
    source: 'plugin',
    pluginName,
    order: anchorStage.order + 0.5, // Insert after anchor; will be re-numbered on getActivePipeline
  };

  // Store custom handler function if provided
  if (registration.handler) {
    pluginHandlers.set(registration.name, registration.handler);
  }

  // Store under plugin name
  if (!pluginStages.has(pluginName)) {
    pluginStages.set(pluginName, []);
  }
  pluginStages.get(pluginName)!.push(descriptor);

  // Allow the custom taskStatus to pass board validation
  if (!VALID_TASK_STATUSES.includes(descriptor.taskStatus)) {
    VALID_TASK_STATUSES.push(descriptor.taskStatus);
  }

  console.warn(`[Pipeline] Registered stage '${registration.name}' from plugin '${pluginName}' after '${registration.after}'`);
  internalEvents.emit(STAGE_REGISTERED, { stageName: registration.name, pluginName });

  return descriptor;
}

/**
 * Removes all stages registered by a given plugin.
 * Returns the count of removed stages.
 */
export function unregisterStages(pluginName: string): number {
  const stages = pluginStages.get(pluginName);
  if (!stages) return 0;

  const count = stages.length;
  // Clean up handler functions for removed stages
  for (const stage of stages) {
    pluginHandlers.delete(stage.name);
  }
  pluginStages.delete(pluginName);

  // Remove plugin-contributed statuses that are no longer referenced by any remaining stage
  const remainingStatuses = new Set<string>(
    [...pluginStages.values()].flatMap(ss => ss.map(s => s.taskStatus))
  );
  for (const stage of stages) {
    if (!remainingStatuses.has(stage.taskStatus)) {
      const idx = VALID_TASK_STATUSES.indexOf(stage.taskStatus);
      if (idx !== -1) VALID_TASK_STATUSES.splice(idx, 1);
    }
  }

  console.warn(`[Pipeline] Unregistered ${count} stage(s) from plugin '${pluginName}'`);
  return count;
}

/**
 * Returns all currently registered stages (built-in + plugin).
 */
export function getRegisteredStages(): StageDescriptor[] {
  const allStages: StageDescriptor[] = [
    ...structuredClone(STANDARD_PIPELINE),
    ...structuredClone(QUICK_PIPELINE),
    ...structuredClone(GOAL_PIPELINE),
  ];

  // Deduplicate built-in stages (execute/verify appear in multiple pipelines)
  const seen = new Set<string>();
  const deduped: StageDescriptor[] = [];
  for (const stage of allStages) {
    if (!seen.has(stage.name)) {
      seen.add(stage.name);
      deduped.push(stage);
    }
  }

  // Add plugin stages
  for (const stages of pluginStages.values()) {
    deduped.push(...structuredClone(stages));
  }

  return deduped;
}

/**
 * Returns the custom handler function for a plugin stage, if one was registered.
 */
export function getStageHandler(stageName: string): ((taskId: string) => Promise<void>) | undefined {
  return pluginHandlers.get(stageName);
}
