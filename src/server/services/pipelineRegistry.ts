/**
 * Pipeline Registry Service
 *
 * Manages the ordered list of workflow pipeline stages for each task type.
 * Provides default pipelines for standard, quick, and goal workflows,
 * and supports plugin-contributed stage insertion.
 */

import type { StageDescriptor, StageRegistration, WorkflowPipeline, TaskType } from '../../types/index.js';
import { internalEvents, STAGE_REGISTERED } from './internalEvents.js';

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
    default:
      console.warn(`[Pipeline] Unknown task type '${taskType}', returning standard pipeline`);
      return structuredClone(STANDARD_PIPELINE);
  }
}

/**
 * Returns the default pipeline merged with any plugin-registered stages,
 * sorted by order.
 */
export function getActivePipeline(taskType: TaskType | string): WorkflowPipeline {
  const pipeline = getDefaultPipeline(taskType);

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

  // Store under plugin name
  if (!pluginStages.has(pluginName)) {
    pluginStages.set(pluginName, []);
  }
  pluginStages.get(pluginName)!.push(descriptor);

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
  pluginStages.delete(pluginName);
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
