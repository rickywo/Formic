import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAgentRunnerDir } from '../utils/paths.js';

// Get __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
 * Get the path to the workspace skills directory
 */
export function getWorkspaceSkillsPath(): string {
  return path.join(getAgentRunnerDir(), 'skills');
}

/**
 * Check if skills have already been copied to the workspace
 */
export function skillsExistInWorkspace(): boolean {
  const workspaceSkillsPath = getWorkspaceSkillsPath();
  return existsSync(workspaceSkillsPath);
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
 * Copy bundled skills to the workspace .agentrunner/skills/ directory
 * Only copies if skills don't already exist in the workspace
 */
export async function copySkillsToWorkspace(): Promise<{ copied: boolean; skills: string[] }> {
  // Skip if skills already exist
  if (skillsExistInWorkspace()) {
    console.log('[Skills] Skills already exist in workspace, skipping copy');
    return { copied: false, skills: [] };
  }

  const bundledSkillsPath = getBundledSkillsPath();
  const workspaceSkillsPath = getWorkspaceSkillsPath();

  // Check if bundled skills exist
  if (!existsSync(bundledSkillsPath)) {
    console.warn('[Skills] Bundled skills directory not found at:', bundledSkillsPath);
    return { copied: false, skills: [] };
  }

  try {
    // Copy the entire skills directory
    await copyDirectory(bundledSkillsPath, workspaceSkillsPath);

    // Get list of copied skills
    const skillDirs = await readdir(workspaceSkillsPath);
    const skills = skillDirs.filter(async (dir) => {
      const skillPath = path.join(workspaceSkillsPath, dir);
      const stats = await stat(skillPath);
      return stats.isDirectory();
    });

    console.log('[Skills] Copied skills to workspace:', skills);
    return { copied: true, skills };
  } catch (error) {
    console.error('[Skills] Error copying skills to workspace:', error);
    return { copied: false, skills: [] };
  }
}

/**
 * Get the path to a specific skill in the workspace
 */
export function getSkillPath(skillName: string): string {
  return path.join(getWorkspaceSkillsPath(), skillName, 'SKILL.md');
}

/**
 * Check if a specific skill exists in the workspace
 */
export function skillExists(skillName: string): boolean {
  return existsSync(getSkillPath(skillName));
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
