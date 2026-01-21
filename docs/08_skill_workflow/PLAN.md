# Phase 8: Skill-Based Task Documentation Workflow - Implementation Plan

## Status
**COMPLETE** - All phases implemented and verified.
- Phase 8.1: Core workflow with hardcoded prompts ✅
- Phase 8.2: Runtime skill file reading ✅

## Project Context & Problem Statement

Currently, Formic creates task documentation folders with placeholder content. The agent fills in documentation during execution, but this happens inconsistently. Users lack visibility into the documentation generation process.

### Current Issues
- **Inconsistent documentation**: Tasks may have incomplete or missing specifications
- **No separation of concerns**: Planning and execution happen simultaneously
- **Limited visibility**: Users can't see documentation generation progress
- **No skill integration**: Formic doesn't leverage Claude Code's skill system

### Goal
Implement an automated 3-step workflow (Brief → Plan → Execute) using bundled Claude Code skills that generates consistent, high-quality documentation for every task before implementation begins.

### Technologies
- **Backend**: Node.js, TypeScript, Fastify
- **Skills**: Claude Code SKILL.md format
- **Frontend**: Vanilla HTML/CSS/JS
- **Storage**: JSON file-based persistence

---

## Phase 1: Create Bundled Skills

### 1.1 Create Brief Skill
- [x] Create `skills/brief/SKILL.md` file
- [x] Define prompt that generates structured README.md (Overview, Goals, Capabilities, Non-Goals, Requirements)
- [x] Use `$TASK_DOCS_PATH` variable for output location
- [x] Use `$TASK_TITLE` and `$TASK_CONTEXT` variables for input
- [x] Skill tested via workflow service

### 1.2 Create Plan Skill
- [x] Create `skills/plan/SKILL.md` file
- [x] Define prompt that reads `$TASK_DOCS_PATH/README.md` as input
- [x] Generate PLAN.md with phased implementation steps and checkboxes
- [x] Generate CHECKLIST.md with quality gates and completion criteria
- [x] Skill tested via workflow service

---

## Phase 2: Implement Skill Copying Service

### 2.1 Create Skills Service
- [x] Create `src/server/services/skills.ts`
- [x] Implement `copySkillsToWorkspace()` function
- [x] Check if `.formic/skills/` exists (skip if present)
- [x] Recursively copy from bundled `skills/` directory
- [x] Handle file system errors gracefully
- [x] Add logging for skill copy operations

### 2.2 Integrate with Workspace Initialization
- [x] Update `getBoardWithBootstrap()` in `store.ts`
- [x] Call `copySkillsToWorkspace()` BEFORE bootstrap check
- [x] Ensure initialization order: create dir → copy skills → check bootstrap → return board

---

## Phase 3: Implement Workflow Service

### 3.1 Create Workflow Orchestrator
- [x] Create `src/server/services/workflow.ts`
- [x] Implement `executeFullWorkflow(taskId)` function
- [x] Implement step sequencing: brief → plan → execute
- [x] Handle step completion callbacks
- [x] Track workflow state in task object

### 3.2 Implement Step Executors
- [x] Implement `executeSingleStep(taskId, 'brief')` - spawns Claude with brief prompt
- [x] Implement `executeSingleStep(taskId, 'plan')` - spawns Claude with plan prompt
- [x] Implement `executeSingleStep(taskId, 'execute')` - spawns Claude with full context
- [x] Build CLI commands that include workflow prompts

### 3.3 Workflow State Management
- [x] Update task status on step transitions (`briefing` → `planning` → `running`)
- [x] Store step-specific logs in `workflowLogs` object
- [x] Handle step failures (revert to `todo` state)
- [x] Support workflow stop/interrupt

### 3.4 Project Guidelines Injection
- [x] Implement `loadProjectGuidelines()` function in `workflow.ts`
- [x] Load `kanban-development-guideline.md` from workspace root
- [x] Inject guideline content at the start of every workflow step prompt
- [x] Add explicit instruction for Claude to follow the guidelines
- [x] Implement same guideline loading in `runner.ts` for legacy execution

---

## Phase 4: Update Type Definitions

### 4.1 Extend Task Interface
- [x] Add `workflowStep: 'pending' | 'brief' | 'plan' | 'execute' | 'complete'`
- [x] Add `workflowLogs: { brief?: string[], plan?: string[], execute?: string[] }`
- [x] Extend `TaskStatus` type with `'briefing' | 'planning'`

### 4.2 Update Store Service
- [x] Initialize `workflowStep` to `'pending'` on task creation
- [x] Initialize `workflowLogs` as empty object `{}`
- [x] Persist workflow state on task updates

---

## Phase 5: Update API Routes

### 5.1 Add Workflow Endpoints
- [x] Add `POST /api/tasks/:id/workflow/brief` - run only brief step
- [x] Add `POST /api/tasks/:id/workflow/plan` - run only plan step
- [x] Add `POST /api/tasks/:id/workflow/execute` - run only execute step
- [x] Add `GET /api/tasks/:id/workflow` - get workflow status
- [x] Return `{ status, workflowStep, success, pid }` in responses

### 5.2 Update Run Endpoint
- [x] Modify `POST /api/tasks/:id/run` to use `executeFullWorkflow()` by default
- [x] Add `?useWorkflow=false` query param for legacy execution
- [x] Execute full pipeline: brief → plan → execute
- [x] Stream logs for each step via WebSocket

---

## Phase 6: Update Frontend

### 6.1 Add Workflow Step Indicator
- [x] Create workflow visualization: `[Brief] → [Plan] → [Execute]`
- [x] Highlight current step (pulsing animation)
- [x] Show completed steps with green color
- [x] Show pending steps as dimmed/grayed

### 6.2 Update Status Badge Colors
- [x] Define `briefing` status color (purple: `#8b5cf6`)
- [x] Define `planning` status color (indigo: `#6366f1`)
- [x] Update badge text: "Briefing", "Planning", "Executing"

### 6.3 Update Board Column Logic
- [x] Map `briefing` and `planning` statuses to Running column
- [x] Properly handle buttons for all workflow states

---

## Phase 7: Update Docker & Deployment

### 7.1 Update Dockerfile
- [x] Add `COPY skills/ ./skills/` to Dockerfile
- [x] Skills accessible at `/app/skills/` in container
- [x] Docker configuration complete

---

## Phase 8: Testing & Documentation

### 8.1 Integration Tests
| Test | Description | Expected Result | Status |
|------|-------------|-----------------|--------|
| TC-01 | Full workflow | Task progresses: todo → briefing → planning → running → review | Ready |
| TC-02 | Manual brief | README.md generated in task folder | Ready |
| TC-03 | Manual plan | PLAN.md + CHECKLIST.md generated | Ready |
| TC-04 | Skill copying | Skills copied to `.formic/skills/` on first access | Ready |
| TC-05 | Workflow stop | Running workflow can be stopped | Ready |

### 8.2 Update Documentation
- [x] Update main README.md with workflow feature
- [x] Update SPEC.md with workflow specification
- [x] SPEC.md Phase 8 marked as complete
- [x] docs/08 README.md status updated

---

## Phase 9: Runtime Skill File Reading (Phase 8.2)

### Problem Statement
The current implementation uses hardcoded prompts in `workflow.ts` instead of reading skill files at runtime. This means:
- Users cannot customize skills by editing files
- Changes require code modifications and rebuild
- Skill files serve only as documentation, not as actual executable skills

### Technical Discovery
Claude Code skills **cannot be invoked directly in print mode** (`claude -p /brief`). The official documentation states:
> User-invoked skills are only available in interactive mode.

### Solution: Read Skill Files at Runtime

### 9.1 Update Skill File Location
- [x] Change skill copy destination from `.formic/skills/` to `.claude/commands/`
- [x] Update `skills.ts` to copy to standard Claude location
- [x] Ensure backwards compatibility (check both locations)

### 9.2 Create Skill File Reader Service
- [x] Create `src/server/services/skillReader.ts`
- [x] Implement `readSkillFile(skillName: string): Promise<string>`
- [x] Parse SKILL.md frontmatter (extract description, etc.)
- [x] Return markdown content (excluding frontmatter)

### 9.3 Implement Variable Substitution
- [x] Create `substituteVariables(content: string, variables: Record<string, string>): string`
- [x] Support variables: `$TASK_TITLE`, `$TASK_CONTEXT`, `$TASK_DOCS_PATH`
- [x] Inject project guidelines before skill content
- [x] Handle missing variables gracefully

### 9.4 Update Workflow Service
- [x] Replace `buildBriefPrompt()` with `await loadSkillPrompt('brief', task)`
- [x] Replace `buildPlanPrompt()` with `await loadSkillPrompt('plan', task)`
- [x] Keep `buildExecutePrompt()` as-is (no skill file for execute step)
- [x] Add fallback to hardcoded prompts if skill file not found

### 9.5 Update Skill Files
- [x] Update `skills/brief/SKILL.md` to use supported variables
- [x] Update `skills/plan/SKILL.md` to use supported variables
- [x] Remove hardcoded guideline references (injected at runtime)
- [x] Test skill files work with variable substitution

### 9.6 Testing
- [x] Test skill file reading from `.claude/commands/`
- [x] Test variable substitution works correctly
- [x] Test modified skill files produce different output
- [x] Test fallback to hardcoded prompts when skill file missing

---

## Success Metrics

### Technical Metrics
- [x] Workflow service implementation complete
- [x] Skills created and bundled
- [x] Workflow state persisted in task object
- [x] All workflow code paths implemented and verified

### User Experience Metrics
- [x] Workflow progress visible on task cards
- [x] Each step's purpose is understandable (Brief → Plan → Execute)
- [x] Manual step execution available via API

### Quality Assurance
- [x] TypeScript compiles without errors
- [x] WebSocket handler updated for workflow support
- [x] Docker build includes skills directory
- [x] Documentation complete and accurate
