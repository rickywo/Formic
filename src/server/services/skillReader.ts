import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { getSkillPath, skillExists, getSkillContent } from './skills.js';
import { getWorkspacePath } from '../utils/paths.js';
import type { Task, SkillOverride, VerifierDefinition, VerifierResult } from '../../types/index.js';
import { internalEvents, SKILL_LOADED, BEFORE_SKILL_LOAD } from './internalEvents.js';

const GUIDELINE_FILENAME = 'kanban-development-guideline.md';

// ── Skill Override Registry ──────────────────────────────────────────────────

const skillOverrides = new Map<string, SkillOverride>();

// ── Verifier Registry ────────────────────────────────────────────────────────

const verifierRegistry = new Map<string, VerifierDefinition & { registeredByPlugin: string }>();

/**
 * Register a custom verifier contributed by a plugin.
 * Validates that the verifier ID is unique.
 */
export function registerVerifier(verifier: VerifierDefinition, pluginName: string): void {
  if (verifierRegistry.has(verifier.id)) {
    throw new Error(`[SkillReader] Verifier '${verifier.id}' is already registered`);
  }
  verifierRegistry.set(verifier.id, { ...verifier, registeredByPlugin: pluginName });
  console.warn(`[SkillReader] Verifier registered: ${verifier.id} by ${pluginName}`);
}

/**
 * Remove all verifiers registered by a given plugin.
 * Returns the count of removed verifiers.
 */
export function unregisterVerifiers(pluginName: string): number {
  let count = 0;
  for (const [id, entry] of verifierRegistry) {
    if (entry.registeredByPlugin === pluginName) {
      verifierRegistry.delete(id);
      count++;
    }
  }
  if (count > 0) {
    console.warn(`[SkillReader] Unregistered ${count} verifier(s) from plugin '${pluginName}'`);
  }
  return count;
}

/**
 * Return all currently registered verifier definitions.
 */
export function getVerifiers(): VerifierDefinition[] {
  return [...verifierRegistry.values()].map(({ registeredByPlugin: _reg, ...def }) => def);
}

/** Canonical alias for getVerifiers, as specified in the SkillApi requirements. */
export const getRegisteredVerifiers = getVerifiers;

/**
 * Execute all registered verifiers against the given task ID.
 * Errors are caught per-verifier so one failure doesn't block others.
 */
export async function runVerifiers(taskId: string): Promise<Array<{ verifierId: string; passed: boolean; message?: string }>> {
  const results: Array<{ verifierId: string; passed: boolean; message?: string }> = [];

  for (const [id, entry] of verifierRegistry) {
    try {
      const result: VerifierResult = await entry.verify(taskId);
      results.push({ verifierId: id, passed: result.passed, message: result.message });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error(`[SkillReader] Verifier '${id}' threw an error: ${message}`);
      results.push({ verifierId: id, passed: false, message: `Verifier error: ${message}` });
    }
  }

  return results;
}

/**
 * Register a plugin's skill content override for a given stage name.
 * Last-registered wins if multiple plugins override the same stage.
 */
export function registerSkillOverride(stageName: string, content: string, pluginName: string): void {
  const existing = skillOverrides.get(stageName);
  if (existing && existing.pluginName !== pluginName) {
    console.warn(
      `[SkillReader] Plugin '${pluginName}' is overriding skill '${stageName}' previously set by '${existing.pluginName}'`
    );
  }
  skillOverrides.set(stageName, { stageName, content, pluginName });
}

/**
 * Remove all skill overrides registered by a given plugin.
 */
export function unregisterSkillOverrides(pluginName: string): void {
  for (const [stage, override] of skillOverrides) {
    if (override.pluginName === pluginName) {
      skillOverrides.delete(stage);
    }
  }
}

/**
 * Return the override for a stage if one exists, or null.
 */
export function getSkillOverride(stageName: string): SkillOverride | null {
  return skillOverrides.get(stageName) ?? null;
}

/**
 * Parse SKILL.md frontmatter and extract content
 * Returns the markdown content without the YAML frontmatter
 */
function parseSkillFile(content: string): { frontmatter: Record<string, string>; body: string } {
  const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;
  const match = content.match(frontmatterRegex);

  if (!match) {
    // No frontmatter, return entire content as body
    return { frontmatter: {}, body: content };
  }

  const [, frontmatterStr, body] = match;
  const frontmatter: Record<string, string> = {};

  // Parse simple YAML key: value pairs
  frontmatterStr.split('\n').forEach(line => {
    const colonIndex = line.indexOf(':');
    if (colonIndex > 0) {
      const key = line.slice(0, colonIndex).trim();
      const value = line.slice(colonIndex + 1).trim();
      frontmatter[key] = value;
    }
  });

  return { frontmatter, body };
}

/**
 * Substitute variables in skill content
 * Supports: $TASK_ID, $TASK_TITLE, $TASK_CONTEXT, $TASK_DOCS_PATH
 */
function substituteVariables(content: string, variables: Record<string, string>): string {
  let result = content;

  for (const [key, value] of Object.entries(variables)) {
    // Replace $VARIABLE_NAME with the value
    const regex = new RegExp(`\\$${key}`, 'g');
    result = result.replace(regex, value);
  }

  return result;
}

/**
 * Load project development guidelines if they exist
 */
export async function loadProjectGuidelines(): Promise<string> {
  const guidelinePath = path.join(getWorkspacePath(), GUIDELINE_FILENAME);

  if (!existsSync(guidelinePath)) {
    return '';
  }

  try {
    const content = await readFile(guidelinePath, 'utf-8');
    return `
## Project Development Guidelines
The following guidelines MUST be followed for all code changes in this project:

${content}

---
END OF GUIDELINES

`;
  } catch (error) {
    console.warn('[SkillReader] Failed to load project guidelines:', error);
    return '';
  }
}

/**
 * Load a skill file, substitute variables, and prepend guidelines
 * Returns the fully prepared prompt content
 */
export async function loadSkillPrompt(
  skillName: string,
  task: Task
): Promise<{ success: boolean; content: string; source: 'override' | 'filesystem' | 'fallback' }> {
  // Allow plugins to register just-in-time overrides
  internalEvents.emit(BEFORE_SKILL_LOAD, { skillName, taskId: task.id });

  // Build variables for substitution (shared by override and filesystem paths)
  const docsPath = path.join(getWorkspacePath(), task.docsPath);
  const variables: Record<string, string> = {
    TASK_ID: task.id,
    TASK_TITLE: task.title,
    TASK_CONTEXT: task.context,
    TASK_DOCS_PATH: docsPath,
  };

  // Check for plugin override before hitting the filesystem
  const override = getSkillOverride(skillName);
  if (override) {
    try {
      const substitutedContent = substituteVariables(override.content, variables);
      const guidelines = await loadProjectGuidelines();
      const finalContent = guidelines + substitutedContent;

      console.warn(`[SkillReader] Using override for skill '${skillName}' from plugin '${override.pluginName}'`);
      internalEvents.emit(SKILL_LOADED, { skillName, taskId: task.id, source: 'override' as const });
      return { success: true, content: finalContent, source: 'override' };
    } catch (error) {
      console.error(`[SkillReader] Error applying override for skill '${skillName}':`, error);
      return { success: false, content: '', source: 'fallback' };
    }
  }

  // Filesystem path — existing behavior
  if (!skillExists(skillName)) {
    console.warn(`[SkillReader] Skill '${skillName}' not found, using fallback`);
    return { success: false, content: '', source: 'fallback' };
  }

  try {
    const rawContent = await getSkillContent(skillName);
    if (!rawContent) {
      console.warn(`[SkillReader] Failed to read skill '${skillName}'`);
      return { success: false, content: '', source: 'fallback' };
    }

    const { body } = parseSkillFile(rawContent);
    const substitutedContent = substituteVariables(body, variables);
    const guidelines = await loadProjectGuidelines();
    const finalContent = guidelines + substitutedContent;

    console.warn(`[SkillReader] Loaded skill '${skillName}' with variables substituted`);
    internalEvents.emit(SKILL_LOADED, { skillName, taskId: task.id, source: 'filesystem' as const });
    return { success: true, content: finalContent, source: 'filesystem' };
  } catch (error) {
    console.error(`[SkillReader] Error loading skill '${skillName}':`, error);
    return { success: false, content: '', source: 'fallback' };
  }
}

/**
 * Get available skills in the workspace
 */
export function getAvailableSkills(): string[] {
  const skills: string[] = [];

  if (skillExists('brief')) {
    skills.push('brief');
  }
  if (skillExists('plan')) {
    skills.push('plan');
  }
  if (skillExists('architect')) {
    skills.push('architect');
  }

  return skills;
}
