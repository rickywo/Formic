# Phase 7: Project Bootstrap & Development Guidelines - Implementation Plan

## Status
**PENDING** - Specification defined, implementation to begin.

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
- [ ] Create `checkBootstrapRequired()` function
- [ ] Check if `kanban-development-guideline.md` exists in `WORKSPACE_PATH`
- [ ] Return `{ required: boolean, guidelinesPath: string | null }`

#### 1.1.2 Write Bootstrap Task Factory
- [ ] Create `createBootstrapTask()` function
- [ ] Generate task with ID `t-bootstrap` and slug `setup-guidelines`
- [ ] Populate task with preconfigured audit prompt
- [ ] Set priority to `high` and status to `todo`

#### 1.1.3 Write Template Reader
- [ ] Create `getBootstrapPrompt()` function
- [ ] Read template from `templates/development-guideline.md`
- [ ] Construct full prompt with audit instructions
- [ ] Include output path instruction for `kanban-development-guideline.md`

### Task 1.2: Modify Store Service (`src/server/services/store.ts`)

#### 1.2.1 Add Bootstrap Integration
- [ ] Modify `getBoard()` to call `checkBootstrapRequired()`
- [ ] If bootstrap required and no `t-bootstrap` task exists, create it
- [ ] Add `bootstrapRequired` field to board response

#### 1.2.2 Handle Bootstrap Task Lifecycle
- [ ] Ensure `t-bootstrap` task is created only once per workspace
- [ ] Allow deletion of bootstrap task for re-bootstrap flow
- [ ] Do not auto-recreate if user manually deleted it

### Task 1.3: Modify Board Route (`src/server/routes/board.ts`)

#### 1.3.1 Update API Response
- [ ] Include `bootstrapRequired: boolean` in `GET /api/board` response
- [ ] Include `guidelinesPath: string | null` for frontend display

### Task 1.4: Bundle Template File

#### 1.4.1 Ensure Template Availability
- [ ] Verify `templates/development-guideline.md` exists
- [ ] Update Dockerfile to copy `templates/` directory
- [ ] Update `.dockerignore` if needed

---

## Agent: Frontend Specialist
**Objective**: Visually distinguish bootstrap task and show bootstrap status

### Task 2.1: Update Board State Handling

#### 2.1.1 Handle Bootstrap Status
- [ ] Parse `bootstrapRequired` from board API response
- [ ] Store bootstrap status in frontend state

### Task 2.2: Style Bootstrap Task Card

#### 2.2.1 Visual Differentiation
- [ ] Add CSS class `.task-card--bootstrap` for bootstrap tasks
- [ ] Add distinct border or background color (suggest: purple/indigo accent)
- [ ] Add "Setup" or "Bootstrap" badge to card header
- [ ] Add icon or indicator showing this is a system task

#### 2.2.2 Bootstrap Task Content
- [ ] Display informative description about what the task does
- [ ] Show "This task will analyze your codebase and generate development guidelines"

### Task 2.3: Add Bootstrap Banner (Optional Enhancement)

#### 2.3.1 First-Run Banner
- [ ] Show banner at top of board when `bootstrapRequired` is true
- [ ] Message: "Run the bootstrap task to generate AI development guidelines for this project"
- [ ] Dismiss when bootstrap task is completed or deleted

---

## Agent: Quality Assurance & Testing

### Integration Test Cases

| Test Case | Description | Preconditions | Steps | Expected Result |
|-----------|-------------|---------------|-------|-----------------|
| TC-01 | Bootstrap detection - new project | No `kanban-development-guideline.md` in workspace | Call `GET /api/board` | Response includes `bootstrapRequired: true` and `t-bootstrap` task |
| TC-02 | Bootstrap detection - existing project | `kanban-development-guideline.md` exists | Call `GET /api/board` | Response includes `bootstrapRequired: false`, no bootstrap task |
| TC-03 | Bootstrap task execution | Bootstrap task exists | Run `t-bootstrap` task | Claude generates `kanban-development-guideline.md` |
| TC-04 | Re-bootstrap flow | Guidelines exist, user deletes them | Delete guidelines file, call `GET /api/board` | New bootstrap task created |
| TC-05 | Bootstrap task deletion | Bootstrap task exists | Delete `t-bootstrap` task | Task removed, not auto-recreated on next request |

### Manual Test Checklist
- [ ] Start AgentRunner against empty project folder
- [ ] Verify bootstrap task appears in Todo column
- [ ] Verify bootstrap task has distinct visual styling
- [ ] Run bootstrap task and verify guidelines file created
- [ ] Restart AgentRunner, verify bootstrap task not recreated
- [ ] Delete guidelines file, restart, verify new bootstrap task created

---

## Agent: Documentation Specialist

### Task 4.1: Update API Documentation

- [ ] Document `bootstrapRequired` field in board response
- [ ] Document `guidelinesPath` field in board response
- [ ] Document bootstrap task special ID `t-bootstrap`

### Task 4.2: Update User Guide

- [ ] Add "Getting Started" section about bootstrap process
- [ ] Document how to customize the template
- [ ] Document re-bootstrap flow

---

## Success Metrics

### Technical Metrics
- [ ] Bootstrap detection works in < 10ms
- [ ] Template loading works in < 50ms
- [ ] No regression in existing task CRUD operations
- [ ] Bootstrap task executes successfully with Claude CLI

### User Experience Metrics
- [ ] Bootstrap task is clearly identifiable as a system task
- [ ] User understands the purpose of bootstrap without reading docs
- [ ] Re-bootstrap flow is intuitive

### Quality Assurance
- [ ] All test cases pass
- [ ] No TypeScript errors
- [ ] Docker build includes templates
- [ ] Documentation is complete and accurate
