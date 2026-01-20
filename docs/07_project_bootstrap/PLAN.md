# Phase 7: Project Bootstrap & Development Guidelines - Implementation Plan

## Status
**COMPLETE** - All implementation tasks finished and verified.

## Project Context & Problem Statement

When users start AgentRunner against a new project, Claude has no context about the project's coding standards, architectural patterns, or conventions. This leads to inconsistent code suggestions and requires users to manually correct Claude's output to match their project style.

### Current Issues
- **No project awareness:** Claude generates code without understanding existing patterns
- **Inconsistent output:** Each task may produce code in different styles
- **Manual correction overhead:** Users must repeatedly explain project conventions
- **Onboarding friction:** New projects require extensive context setup

### Goal
Automatically generate project-specific AI development guidelines on first run, ensuring Claude follows consistent coding standards for all subsequent tasks.

### Technologies
- **Backend**: Node.js, TypeScript, Fastify
- **Frontend**: Vanilla HTML/CSS/JS
- **Storage**: JSON file-based persistence
- **Agent**: Claude Code CLI

---

## Work Plan

### TDD Workflow Steps
1. Write failing unit tests for bootstrap detection
2. Implement bootstrap service
3. Write failing integration tests for API changes
4. Implement API modifications
5. Write frontend tests (manual verification)
6. Implement frontend changes
7. End-to-end verification

---

## Agent: Backend Specialist
**Objective**: Implement bootstrap detection service and API modifications

### Task 1.1: Create Bootstrap Service (`src/server/services/bootstrap.ts`)

#### 1.1.1 Write Bootstrap Detection Logic
- [x] Create `checkBootstrapRequired()` function
- [x] Check if `kanban-development-guideline.md` exists in `WORKSPACE_PATH`
- [x] Return `{ required: boolean, guidelinesPath: string | null }`

#### 1.1.2 Write Bootstrap Task Factory
- [x] Create `createBootstrapTask()` function
- [x] Generate task with ID `t-bootstrap` and slug `setup-guidelines`
- [x] Populate task with preconfigured audit prompt
- [x] Set priority to `high` and status to `todo`

#### 1.1.3 Write Template Reader
- [x] Create `getBootstrapPrompt()` function
- [x] Read template from `templates/development-guideline.md`
- [x] Construct full prompt with audit instructions
- [x] Include output path instruction for `kanban-development-guideline.md`

### Task 1.2: Modify Store Service (`src/server/services/store.ts`)

#### 1.2.1 Add Bootstrap Integration
- [x] Modify `getBoard()` to call `checkBootstrapRequired()`
- [x] If bootstrap required and no `t-bootstrap` task exists, create it
- [x] Add `bootstrapRequired` field to board response

#### 1.2.2 Handle Bootstrap Task Lifecycle
- [x] Ensure `t-bootstrap` task is created only once per workspace
- [x] Allow deletion of bootstrap task for re-bootstrap flow
- [x] Do not auto-recreate if user manually deleted it

### Task 1.3: Modify Board Route (`src/server/routes/board.ts`)

#### 1.3.1 Update API Response
- [x] Include `bootstrapRequired: boolean` in `GET /api/board` response
- [x] Include `guidelinesPath: string | null` for frontend display

### Task 1.4: Bundle Template File

#### 1.4.1 Ensure Template Availability
- [x] Verify `templates/development-guideline.md` exists
- [x] Update Dockerfile to copy `templates/` directory
- [x] Update `.dockerignore` if needed

---

## Agent: Frontend Specialist
**Objective**: Visually distinguish bootstrap task and show bootstrap status

### Task 2.1: Update Board State Handling

#### 2.1.1 Handle Bootstrap Status
- [x] Parse `bootstrapRequired` from board API response
- [x] Store bootstrap status in frontend state

### Task 2.2: Style Bootstrap Task Card

#### 2.2.1 Visual Differentiation
- [x] Add CSS class `.task-card--bootstrap` for bootstrap tasks
- [x] Add distinct border or background color (suggest: purple/indigo accent)
- [x] Add "Setup" or "Bootstrap" badge to card header
- [x] Add icon or indicator showing this is a system task

#### 2.2.2 Bootstrap Task Content
- [x] Display informative description about what the task does
- [x] Show "This task will analyze your codebase and generate development guidelines"

### Task 2.3: Add Bootstrap Banner (Optional Enhancement)

#### 2.3.1 First-Run Banner
- [x] Show banner at top of board when `bootstrapRequired` is true
- [x] Message: "Run the bootstrap task to generate AI development guidelines for this project"
- [x] Dismiss when bootstrap task is completed or deleted

---

## Agent: Quality Assurance & Testing

### Integration Test Cases

| Test Case | Description | Preconditions | Steps | Expected Result | Status |
|-----------|-------------|---------------|-------|-----------------|--------|
| TC-01 | Bootstrap detection - new project | No `kanban-development-guideline.md` in workspace | Call `GET /api/board` | Response includes `bootstrapRequired: true` and `t-bootstrap` task | ✅ PASS |
| TC-02 | Bootstrap detection - existing project | `kanban-development-guideline.md` exists | Call `GET /api/board` | Response includes `bootstrapRequired: false`, no bootstrap task | ✅ PASS |
| TC-03 | Bootstrap task execution | Bootstrap task exists | Run `t-bootstrap` task | Claude generates `kanban-development-guideline.md` | ✅ PASS |
| TC-04 | Re-bootstrap flow | Guidelines exist, user deletes them | Delete guidelines file, call `GET /api/board` | New bootstrap task created | ✅ PASS |
| TC-05 | Bootstrap task deletion | Bootstrap task exists | Delete `t-bootstrap` task | Task removed, not auto-recreated on next request | ✅ PASS |

### Manual Test Checklist
- [x] Start AgentRunner against empty project folder
- [x] Verify bootstrap task appears in Todo column
- [x] Verify bootstrap task has distinct visual styling
- [x] Run bootstrap task and verify guidelines file created
- [x] Restart AgentRunner, verify bootstrap task not recreated
- [x] Delete guidelines file, restart, verify new bootstrap task created

---

## Agent: Documentation Specialist

### Task 4.1: Update API Documentation

- [x] Document `bootstrapRequired` field in board response
- [x] Document `guidelinesPath` field in board response
- [x] Document bootstrap task special ID `t-bootstrap`

### Task 4.2: Update User Guide

- [x] Add "Getting Started" section about bootstrap process
- [x] Document how to customize the template
- [x] Document re-bootstrap flow

---

## Success Metrics

### Technical Metrics
- [x] Bootstrap detection works in < 10ms
- [x] Template loading works in < 50ms
- [x] No regression in existing task CRUD operations
- [x] Bootstrap task executes successfully with Claude CLI

### User Experience Metrics
- [x] Bootstrap task is clearly identifiable as a system task
- [x] User understands the purpose of bootstrap without reading docs
- [x] Re-bootstrap flow is intuitive

### Quality Assurance
- [x] All test cases pass
- [x] No TypeScript errors
- [x] Docker build includes templates
- [x] Documentation is complete and accurate
