# Phase 2: Data Layer - Checklist

## Pre-Implementation
- [x] Feature specification reviewed (README.md)
- [x] Storage structure defined (workspace-based)
- [x] TypeScript types identified for update
- [x] Dependencies identified (none new required)

## Implementation

### Types
- [x] `Task` interface includes `docsPath: string`
- [x] Types compile without errors

### Utilities
- [x] `generateSlug()` function created and working
- [x] Workspace path helpers created
- [x] All paths derived from `WORKSPACE_PATH` env var

### Templates
- [x] Task README.md template created
- [x] Task PLAN.md template created
- [x] Task CHECKLIST.md template created
- [x] Templates accept task title and context parameters

### Store Service
- [x] Board loads from `{workspace}/.formic/board.json`
- [x] Board saves to workspace path
- [x] `.formic/` directory auto-created if missing
- [x] Default board created with project name from folder

### Task Documentation Service
- [x] `createTaskDocsFolder()` implemented
- [x] `deleteTaskDocsFolder()` implemented
- [x] `output/` subdirectory created with task folder
- [x] All three template files written on task creation

### Task CRUD
- [x] `createTask()` generates docsPath and creates folder
- [x] `deleteTask()` optionally removes docs folder
- [x] `updateTask()` prevents docsPath modification

## Quality Gates
- [x] `npm run build` compiles without errors
- [x] `npm run dev` starts server successfully
- [x] Board loads from workspace on startup
- [x] Creating task creates docs folder with correct structure
- [x] Deleting task removes docs folder (when enabled)
- [x] Slug generation handles edge cases (special chars, long titles)

## Manual Testing Scenarios
- [x] Fresh workspace: `.formic/` created automatically
- [x] Existing workspace: loads existing board.json
- [x] Create task: folder appears at `.formic/tasks/{id}_{slug}/`
- [x] Create task: README.md, PLAN.md, CHECKLIST.md, output/ all present
- [x] Delete task (preserve=false): folder removed
- [x] Delete task (preserve=true): folder kept

## Documentation
- [x] PLAN.md tracks implementation progress
- [x] CHECKLIST.md updated as items complete

---

**Phase 2 Status: COMPLETE**
