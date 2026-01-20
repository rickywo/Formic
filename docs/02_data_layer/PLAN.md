# Phase 2: Data Layer - Implementation Plan

## Task 1: Update TypeScript Types

- [ ] 1.1 Add `docsPath` field to `Task` interface in `src/types/index.ts`
- [ ] 1.2 Update `CreateTaskInput` to not include `docsPath` (auto-generated)
- [ ] 1.3 Verify types compile without errors

## Task 2: Create Utility Functions

- [ ] 2.1 Create `src/server/utils/slug.ts` with `generateSlug(title: string): string`
  - Lowercase the title
  - Replace spaces and special chars with hyphens
  - Remove consecutive hyphens
  - Truncate to max 30 characters
- [ ] 2.2 Create `src/server/utils/paths.ts` with workspace path helpers
  - `getWorkspacePath(): string` - returns `WORKSPACE_PATH` env var
  - `getAgentRunnerDir(): string` - returns `{workspace}/.agentrunner`
  - `getBoardPath(): string` - returns `{workspace}/.agentrunner/board.json`
  - `getTasksDir(): string` - returns `{workspace}/.agentrunner/tasks`
  - `getTaskDocsPath(id: string, slug: string): string` - returns full task folder path

## Task 3: Create Task Documentation Templates

- [ ] 3.1 Create `src/server/templates/task-readme.ts` - README.md template
- [ ] 3.2 Create `src/server/templates/task-plan.ts` - PLAN.md template
- [ ] 3.3 Create `src/server/templates/task-checklist.ts` - CHECKLIST.md template
- [ ] 3.4 Each template should be a function that takes task title and context

## Task 4: Update Store Service

- [ ] 4.1 Update `loadBoard()` to read from `{workspace}/.agentrunner/board.json`
- [ ] 4.2 Update `saveBoard()` to write to workspace path
- [ ] 4.3 Update `createDefaultBoard()` to derive project name from workspace folder
- [ ] 4.4 Update `ensureDataDir()` to create `.agentrunner/` directory in workspace
- [ ] 4.5 Add `ensureTasksDir()` to create `.agentrunner/tasks/` directory

## Task 5: Implement Task Documentation Folder Management

- [ ] 5.1 Create `src/server/services/taskDocs.ts` service
- [ ] 5.2 Implement `createTaskDocsFolder(taskId: string, title: string, context: string): Promise<string>`
  - Generate slug from title
  - Create folder at `.agentrunner/tasks/{id}_{slug}/`
  - Create `output/` subdirectory
  - Write README.md from template
  - Write PLAN.md from template
  - Write CHECKLIST.md from template
  - Return the docsPath
- [ ] 5.3 Implement `deleteTaskDocsFolder(docsPath: string, preserveHistory?: boolean): Promise<void>`
- [ ] 5.4 Implement `taskDocsFolderExists(docsPath: string): Promise<boolean>`

## Task 6: Update Task CRUD Operations

- [ ] 6.1 Update `createTask()` to:
  - Generate task ID
  - Generate slug from title
  - Call `createTaskDocsFolder()`
  - Set `docsPath` on task object
  - Save to board
- [ ] 6.2 Update `deleteTask()` to optionally delete docs folder
- [ ] 6.3 Ensure `updateTask()` does NOT allow changing `docsPath`

## Task 7: Verification

- [ ] 7.1 Run `npm run build` - verify TypeScript compiles
- [ ] 7.2 Run `npm run dev` - verify server starts
- [ ] 7.3 Manually test: Create workspace folder with `.agentrunner/`
- [ ] 7.4 Manually test: Board loads from workspace
- [ ] 7.5 Manually test: Creating a task creates docs folder with templates
- [ ] 7.6 Manually test: Deleting a task removes docs folder (when not preserving)
