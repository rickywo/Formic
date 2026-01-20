# Setup AI Development Guidelines

## Overview

You are a Senior Engineer contributing to this repository. Your task is to audit this codebase and create a development guideline document.

## CRITICAL: Workspace Boundary

You MUST ONLY examine files within this workspace directory: /Users/rickywo/WebstormProjects/Kanban/test_react_project

DO NOT:
- Navigate to parent directories (no "cd .." or "../")
- Read files outside the workspace
- Reference external projects or parent folders

The workspace root is: /Users/rickywo/WebstormProjects/Kanban/test_react_project
All file paths must be relative to this directory or absolute paths within it.

## Instructions

1. First, explore the repository structure WITHIN THE WORKSPACE ONLY:
   - List the contents of /Users/rickywo/WebstormProjects/Kanban/test_react_project (the workspace root)
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

# AI Development Guidelines

## 1. Project Overview
- **Type:** [e.g., Chrome Extension / Next.js Web App / Python Automation Script]
- **Core Stack:** [e.g., React, TypeScript, TailwindCSS, Vite] / [Python, Pandas, FastAPI]
- **Primary Goal:** [One sentence summary of what the software does]

## 2. Architectural Patterns
- **State Management:** [e.g., Use React Context for global state; local state for components]
- **File Structure:** - `/src/components`: Reusable UI components
    - `/src/lib`: Utility functions and helpers
    - `/src/features`: Feature-specific logic
- **Design Pattern:** [e.g., Functional composition over inheritance; Mobile-first design]

## 3. Coding Standards (Strict)
- **Language:** [e.g., TypeScript strict mode enabled; No `any` types]
- **Styling:** [e.g., Tailwind classes only; no CSS modules unless necessary]
- **Naming:** - Variables/Functions: `camelCase` (descriptive, no abbreviations like `ctx` or `res`)
    - Components/Classes: `PascalCase`
    - Constants: `SCREAMING_SNAKE_CASE`
- **Error Handling:** [e.g., Wrap async calls in try/catch; Log errors to console with "[Error]: " prefix]

## 4. Preferred Libraries & Tools
- **Routing:** [e.g., React Router v6]
- **Testing:** [e.g., Vitest for unit tests; Playwright for E2E]
- **API Fetching:** [e.g., Axios / TanStack Query]
- **Validation:** [e.g., Zod]

## 5. Development Workflow (The "Plan-Act" Loop)
1. **Analysis:** Before writing code, analyze the file structure and existing imports.
2. **Thinking:** Use `thinking` mode to outline the implementation steps.
3. **Execution:** Implement changes incrementally.
4. **Verification:**
    - Run `npm run lint` to check for style issues.
    - Run `npm run test` to verify no regressions.
    - *Only* submit code after these checks pass.

## 6. Build & Test Commands
- **Start Dev Server:** `npm run dev`
- **Run Tests:** `npm run test`
- **Build Production:** `npm run build`
- **Lint Code:** `npm run lint`

## 7. Forbidden Practices 🛑
- Do not use `useEffect` without a comprehensive dependency array.
- Do not remove comments that start with `TODO:` or `FIXME:`.
- Do not introduce new dependencies without explicit permission.
- Do not leave console logs (`console.log`) in production code.

## Output

Create a file named `kanban-development-guideline.md` in the workspace root (/Users/rickywo/WebstormProjects/Kanban/test_react_project) with:

- Filled-in sections based ONLY on files found within the workspace
- If the workspace is empty/new, provide sensible defaults and recommendations
- Specific, actionable guidelines tailored to this codebase
- Version numbers for key dependencies (if found)

IMPORTANT: Only document what actually exists in /Users/rickywo/WebstormProjects/Kanban/test_react_project. Do not describe files or structures from outside this directory.

Save the completed guidelines to: kanban-development-guideline.md

## Goals

- [ ] Define specific goals here

## Key Capabilities

- Describe what this task will accomplish

## Non-Goals

- What is explicitly out of scope

## Requirements

- List technical and functional requirements
