import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { getFormicDir, getSkillsDir, getBundledSkillsPath } from '../utils/paths.js';

/**
 * Get the path to the workspace skills directory (.claude/skills/)
 */
export function getWorkspaceSkillsPath(): string {
  return getSkillsDir();
}

/**
 * Get the legacy skills path (.formic/skills/)
 */
export function getLegacySkillsPath(): string {
  return path.join(getFormicDir(), 'skills');
}

/**
 * Check if skills have already been copied to the workspace
 * Checks both new (.claude/skills/) and legacy (.formic/skills/) locations
 */
export function skillsExistInWorkspace(): boolean {
  const newPath = getWorkspaceSkillsPath();
  const legacyPath = getLegacySkillsPath();
  return existsSync(newPath) || existsSync(legacyPath);
}

/**
 * Recursively copy a directory
 */
async function copyDirectory(src: string, dest: string): Promise<void> {
  // Create destination directory if it doesn't exist
  if (!existsSync(dest)) {
    await mkdir(dest, { recursive: true });
  }

  const entries = await readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      await copyDirectory(srcPath, destPath);
    } else {
      const content = await readFile(srcPath, 'utf-8');
      await writeFile(destPath, content, 'utf-8');
    }
  }
}

/**
 * Copy bundled skills to the workspace .claude/skills/ directory
 * Only copies if skills don't already exist in the workspace (checks both new and legacy locations)
 */
export async function copySkillsToWorkspace(): Promise<{ copied: boolean; skills: string[] }> {
  // Skip if skills already exist in either location
  if (skillsExistInWorkspace()) {
    console.log('[Skills] Skills already exist in workspace, skipping copy');
    return { copied: false, skills: [] };
  }

  const bundledSkillsPath = getBundledSkillsPath();
  const workspaceSkillsPath = getWorkspaceSkillsPath(); // Points to .claude/skills/

  // Check if bundled skills exist
  if (!existsSync(bundledSkillsPath)) {
    console.warn('[Skills] Bundled skills directory not found at:', bundledSkillsPath);
    return { copied: false, skills: [] };
  }

  try {
    // Ensure .claude directory exists
    const claudeDir = path.dirname(workspaceSkillsPath);
    if (!existsSync(claudeDir)) {
      await mkdir(claudeDir, { recursive: true });
    }

    // Copy the entire skills directory to .claude/skills/
    await copyDirectory(bundledSkillsPath, workspaceSkillsPath);

    // Get list of copied skills
    const skillDirs = await readdir(workspaceSkillsPath);
    const skills = skillDirs.filter(async (dir) => {
      const skillPath = path.join(workspaceSkillsPath, dir);
      const stats = await stat(skillPath);
      return stats.isDirectory();
    });

    console.log('[Skills] Copied skills to workspace .claude/skills/:', skills);
    return { copied: true, skills };
  } catch (error) {
    console.error('[Skills] Error copying skills to workspace:', error);
    return { copied: false, skills: [] };
  }
}

/**
 * Get the path to a specific skill in the workspace
 * Checks new location (.claude/skills/) first, then falls back to legacy (.formic/skills/)
 */
export function getSkillPath(skillName: string): string {
  const newPath = path.join(getWorkspaceSkillsPath(), skillName, 'SKILL.md');
  const legacyPath = path.join(getLegacySkillsPath(), skillName, 'SKILL.md');

  // Prefer new location, fall back to legacy
  if (existsSync(newPath)) {
    return newPath;
  }
  if (existsSync(legacyPath)) {
    return legacyPath;
  }

  // Default to new location for new files
  return newPath;
}

/**
 * Check if a specific skill exists in the workspace (either location)
 */
export function skillExists(skillName: string): boolean {
  const newPath = path.join(getWorkspaceSkillsPath(), skillName, 'SKILL.md');
  const legacyPath = path.join(getLegacySkillsPath(), skillName, 'SKILL.md');
  return existsSync(newPath) || existsSync(legacyPath);
}

/**
 * Get the content of a skill file
 */
export async function getSkillContent(skillName: string): Promise<string | null> {
  const skillPath = getSkillPath(skillName);

  if (!existsSync(skillPath)) {
    return null;
  }

  return await readFile(skillPath, 'utf-8');
}
