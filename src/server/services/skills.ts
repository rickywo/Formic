import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAgentRunnerDir, getClaudeCommandsDir } from '../utils/paths.js';

// Get __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Legacy path for backwards compatibility
const LEGACY_SKILLS_PATH = '.agentrunner/skills';

/**
 * Get the path to the bundled skills directory
 */
function getBundledSkillsPath(): string {
  // Check multiple possible locations for the skills directory
  const possiblePaths = [
    path.join(process.cwd(), 'skills'),
    path.join('/app', 'skills'),
    path.join(__dirname, '..', '..', '..', 'skills'),
  ];

  for (const skillsPath of possiblePaths) {
    if (existsSync(skillsPath)) {
      return skillsPath;
    }
  }

  // Default to cwd-relative path
  return path.join(process.cwd(), 'skills');
}

/**
 * Get the path to the workspace skills directory (new location: .claude/commands/)
 */
export function getWorkspaceSkillsPath(): string {
  return getClaudeCommandsDir();
}

/**
 * Get the legacy skills path (.agentrunner/skills/)
 */
export function getLegacySkillsPath(): string {
  return path.join(getAgentRunnerDir(), 'skills');
}

/**
 * Check if skills have already been copied to the workspace
 * Checks both new (.claude/commands/) and legacy (.agentrunner/skills/) locations
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
 * Copy bundled skills to the workspace .claude/commands/ directory
 * Only copies if skills don't already exist in the workspace (checks both new and legacy locations)
 */
export async function copySkillsToWorkspace(): Promise<{ copied: boolean; skills: string[] }> {
  // Skip if skills already exist in either location
  if (skillsExistInWorkspace()) {
    console.log('[Skills] Skills already exist in workspace, skipping copy');
    return { copied: false, skills: [] };
  }

  const bundledSkillsPath = getBundledSkillsPath();
  const workspaceSkillsPath = getWorkspaceSkillsPath(); // Now points to .claude/commands/

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

    // Copy the entire skills directory to .claude/commands/
    await copyDirectory(bundledSkillsPath, workspaceSkillsPath);

    // Get list of copied skills
    const skillDirs = await readdir(workspaceSkillsPath);
    const skills = skillDirs.filter(async (dir) => {
      const skillPath = path.join(workspaceSkillsPath, dir);
      const stats = await stat(skillPath);
      return stats.isDirectory();
    });

    console.log('[Skills] Copied skills to workspace .claude/commands/:', skills);
    return { copied: true, skills };
  } catch (error) {
    console.error('[Skills] Error copying skills to workspace:', error);
    return { copied: false, skills: [] };
  }
}

/**
 * Get the path to a specific skill in the workspace
 * Checks new location (.claude/commands/) first, then falls back to legacy (.agentrunner/skills/)
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
