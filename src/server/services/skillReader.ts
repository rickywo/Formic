import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { getSkillPath, skillExists, getSkillContent } from './skills.js';
import { getWorkspacePath } from '../utils/paths.js';
import type { Task } from '../../types/index.js';

const WORKSPACE_PATH = process.env.WORKSPACE_PATH || './workspace';
const GUIDELINE_FILENAME = 'kanban-development-guideline.md';

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
 * Supports: $TASK_TITLE, $TASK_CONTEXT, $TASK_DOCS_PATH
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
async function loadProjectGuidelines(): Promise<string> {
  const guidelinePath = path.join(WORKSPACE_PATH, GUIDELINE_FILENAME);

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
): Promise<{ success: boolean; content: string; source: 'skill' | 'fallback' }> {
  // Check if skill file exists
  if (!skillExists(skillName)) {
    console.warn(`[SkillReader] Skill '${skillName}' not found, using fallback`);
    return { success: false, content: '', source: 'fallback' };
  }

  try {
    // Read skill file content
    const rawContent = await getSkillContent(skillName);
    if (!rawContent) {
      console.warn(`[SkillReader] Failed to read skill '${skillName}'`);
      return { success: false, content: '', source: 'fallback' };
    }

    // Parse frontmatter and get body
    const { body } = parseSkillFile(rawContent);

    // Build variables for substitution
    const docsPath = path.join(WORKSPACE_PATH, task.docsPath);
    const variables: Record<string, string> = {
      TASK_TITLE: task.title,
      TASK_CONTEXT: task.context,
      TASK_DOCS_PATH: docsPath,
    };

    // Substitute variables in skill body
    const substitutedContent = substituteVariables(body, variables);

    // Load and prepend guidelines
    const guidelines = await loadProjectGuidelines();

    // Combine guidelines + skill content
    const finalContent = guidelines + substitutedContent;

    console.log(`[SkillReader] Loaded skill '${skillName}' with variables substituted`);
    return { success: true, content: finalContent, source: 'skill' };
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

  return skills;
}
