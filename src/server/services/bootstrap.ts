import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Task } from '../../types/index.js';
import { getWorkspacePath } from '../utils/paths.js';

// Get __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Constants
export const BOOTSTRAP_TASK_ID = 't-bootstrap';
export const BOOTSTRAP_TASK_SLUG = 'setup-guidelines';
export const GUIDELINES_FILENAME = 'kanban-development-guideline.md';

/**
 * Get the path to the development guidelines file in the workspace
 */
export function getGuidelinesPath(): string {
  return path.join(getWorkspacePath(), GUIDELINES_FILENAME);
}

/**
 * Get the path to the template file
 */
function getTemplatePath(): string {
  // In production (Docker), templates are at /app/templates
  // In development, templates are at ./templates relative to project root
  const possiblePaths = [
    path.join(process.cwd(), 'templates', 'development-guideline.md'),
    path.join('/app', 'templates', 'development-guideline.md'),
    path.join(__dirname, '..', '..', '..', 'templates', 'development-guideline.md'),
  ];

  for (const templatePath of possiblePaths) {
    if (existsSync(templatePath)) {
      return templatePath;
    }
  }

  // Default to cwd-relative path
  return path.join(process.cwd(), 'templates', 'development-guideline.md');
}

/**
 * Check if bootstrap is required for the current workspace
 */
export interface BootstrapStatus {
  required: boolean;
  guidelinesPath: string | null;
}

export function checkBootstrapRequired(): BootstrapStatus {
  const guidelinesPath = getGuidelinesPath();
  const exists = existsSync(guidelinesPath);

  return {
    required: !exists,
    guidelinesPath: exists ? guidelinesPath : null,
  };
}

/**
 * Read the template file content
 */
async function readTemplateContent(): Promise<string> {
  const templatePath = getTemplatePath();

  if (!existsSync(templatePath)) {
    // Return a default template if file not found
    return `# AI Development Guidelines

## 1. Project Overview
- **Type:** [Discovered project type]
- **Core Stack:** [Discovered tech stack]
- **Primary Goal:** [Project purpose]

## 2. Architectural Patterns
- **File Structure:** [Discovered folder organization]
- **Design Pattern:** [Observed patterns]

## 3. Coding Standards
- **Language:** [Language and typing rules]
- **Naming:** [Naming conventions]
- **Error Handling:** [Error handling patterns]

## 4. Testing Strategy
- **Framework:** [Testing framework]
- **Requirements:** [Testing requirements]

## 5. Forbidden Practices
[Anti-patterns to avoid]
`;
  }

  return await readFile(templatePath, 'utf-8');
}

/**
 * Generate the bootstrap task prompt
 */
export async function getBootstrapPrompt(): Promise<string> {
  const templateContent = await readTemplateContent();
  const workspacePath = getWorkspacePath();

  return `You are a Senior Engineer contributing to this repository. Your task is to audit this codebase and create a development guideline document.

## CRITICAL: Workspace Boundary

You MUST ONLY examine files within this workspace directory: ${workspacePath}

DO NOT:
- Navigate to parent directories (no "cd .." or "../")
- Read files outside the workspace
- Reference external projects or parent folders

The workspace root is: ${workspacePath}
All file paths must be relative to this directory or absolute paths within it.

## Instructions

1. First, explore the repository structure WITHIN THE WORKSPACE ONLY:
   - List the contents of ${workspacePath} (the workspace root)
   - Identify package.json, requirements.txt, or other dependency files in the workspace
   - Review the folder structure within the workspace (src/, lib/, tests/, etc.)
   - If the workspace appears empty or minimal, document that appropriately

2. Identify the tech stack (from files IN THE WORKSPACE):
   - Check package.json for Node.js/JavaScript/TypeScript projects
   - Check requirements.txt or pyproject.toml for Python projects
   - Check Cargo.toml for Rust projects
   - Check go.mod for Go projects
   - Note specific framework versions if found
   - If no dependency files exist, state "No package manager detected"

3. Analyze architectural patterns (WITHIN THE WORKSPACE):
   - Examine the folder organization
   - Look for common patterns (MVC, component-based, service-oriented)
   - If the project is new/empty, provide general best practice recommendations

4. Review testing strategy (WITHIN THE WORKSPACE):
   - Look for test directories (tests/, __tests__/, spec/)
   - Identify testing frameworks if configured
   - If no tests exist, recommend a testing approach

5. Check coding standards (WITHIN THE WORKSPACE):
   - Review .eslintrc, .prettierrc, or similar config files if they exist
   - Look at existing code for naming conventions
   - If no config files exist, recommend standards

6. Document forbidden practices:
   - Based on linting rules and observed patterns
   - Note any anti-patterns to avoid

## Template Reference

Use this template structure as a guide:

${templateContent}

## Output

Create a file named \`${GUIDELINES_FILENAME}\` in the workspace root (${workspacePath}) with:

- Filled-in sections based ONLY on files found within the workspace
- If the workspace is empty/new, provide sensible defaults and recommendations
- Specific, actionable guidelines tailored to this codebase
- Version numbers for key dependencies (if found)

IMPORTANT: Only document what actually exists in ${workspacePath}. Do not describe files or structures from outside this directory.

Save the completed guidelines to: ${GUIDELINES_FILENAME}`;
}

/**
 * Create the bootstrap task object
 */
export async function createBootstrapTask(): Promise<Task> {
  const prompt = await getBootstrapPrompt();

  return {
    id: BOOTSTRAP_TASK_ID,
    title: 'Setup AI Development Guidelines',
    status: 'todo',
    priority: 'high',
    context: prompt,
    docsPath: `.agentrunner/tasks/${BOOTSTRAP_TASK_ID}_${BOOTSTRAP_TASK_SLUG}`,
    agentLogs: [],
    pid: null,
  };
}

/**
 * Check if a task is the bootstrap task
 */
export function isBootstrapTask(task: Task): boolean {
  return task.id === BOOTSTRAP_TASK_ID;
}
