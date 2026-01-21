# Phase 8: Skill-Based Task Documentation Workflow - Checklist

## Status
**COMPLETE** - All phases implemented ✅

---

## Phase 8.1: Core Workflow (COMPLETE)

### Pre-Implementation
- [x] README.md specification reviewed and approved
- [x] Technical approach validated against existing codebase
- [x] Dependencies identified (no new dependencies required)
- [x] Test strategy defined

### Implementation

### Phase 1: Bundled Skills
- [x] `skills/brief/SKILL.md` created and tested
- [x] `skills/plan/SKILL.md` created and tested
- [x] Skills generate correct output format
- [x] Skills use `$TASK_DOCS_PATH` variable correctly

### Phase 2: Skill Copying Service
- [x] `src/server/services/skills.ts` created
- [x] `copySkillsToWorkspace()` implemented
- [x] Skills copied during workspace init (before bootstrap)
- [x] Skips copy if skills already exist

### Phase 3: Workflow Service
- [x] `src/server/services/workflow.ts` created
- [x] `executeFullWorkflow()` orchestrates all steps
- [x] `executeSingleStep('brief')` generates README.md
- [x] `executeSingleStep('plan')` generates PLAN.md + CHECKLIST.md
- [x] Step transitions work correctly
- [x] `loadProjectGuidelines()` implemented for guideline injection
- [x] Guidelines injected into all workflow step prompts
- [x] `runner.ts` updated with same guideline injection for legacy execution

### Phase 4: Type Definitions
- [x] `workflowStep` field added to Task interface
- [x] `workflowLogs` field added to Task interface
- [x] `TaskStatus` extended with `briefing` and `planning`

### Phase 5: API Routes
- [x] `POST /api/tasks/:id/workflow/brief` endpoint added
- [x] `POST /api/tasks/:id/workflow/plan` endpoint added
- [x] `POST /api/tasks/:id/workflow/execute` endpoint added
- [x] `GET /api/tasks/:id/workflow` endpoint added
- [x] `POST /api/tasks/:id/run` uses full workflow pipeline by default

### Phase 6: Frontend
- [x] Workflow step indicator displayed on task cards
- [x] `briefing` status has distinct color (purple)
- [x] `planning` status has distinct color (indigo)
- [x] Board column logic handles new statuses

### Phase 7: Docker
- [x] `skills/` directory added to Dockerfile COPY

## Quality Gates
- [x] TypeScript compiles without errors
- [x] WebSocket logs handler updated for workflow support

## Documentation
- [x] Main README.md updated with workflow feature
- [x] SPEC.md updated with workflow specification
- [x] Phase 8 marked as COMPLETE in SPEC.md
- [x] docs/08/README.md status updated to COMPLETE
- [x] PLAN.md updated with completion status

### Post-Implementation (Phase 8.1)
- [x] All implementation code complete
- [x] TypeScript build verified
- [x] SPEC.md Development Roadmap updated
- [x] docs/08 documentation updated

---

## Phase 8.2: Runtime Skill File Reading (COMPLETE)

### Technical Discovery
- [x] Researched Claude Code skill invocation
- [x] Confirmed: Skills cannot be invoked in print mode (`claude -p /brief`)
- [x] Documented limitation and workaround in README.md

### Skill Location Update
- [x] Update `skills.ts` to copy skills to `.claude/commands/` instead of `.formic/skills/`
- [x] Verify skills are discoverable by Claude Code
- [x] Test backwards compatibility

### Skill Reader Service
- [x] Create `src/server/services/skillReader.ts`
- [x] Implement `readSkillFile(skillName)` function
- [x] Parse SKILL.md frontmatter (YAML)
- [x] Extract markdown content (skip frontmatter)
- [x] Handle file not found gracefully

### Variable Substitution
- [x] Implement `substituteVariables()` function
- [x] Support `$TASK_TITLE` variable
- [x] Support `$TASK_CONTEXT` variable
- [x] Support `$TASK_DOCS_PATH` variable
- [x] Inject guidelines before skill content

### Workflow Service Update
- [x] Replace `buildBriefPrompt()` with skill file reading
- [x] Replace `buildPlanPrompt()` with skill file reading
- [x] Add fallback to hardcoded prompts if skill missing
- [x] Maintain guideline injection behavior

### Skill File Updates
- [x] Update `skills/brief/SKILL.md` with supported variables
- [x] Update `skills/plan/SKILL.md` with supported variables
- [x] Remove hardcoded guideline file references
- [x] Test variable substitution works

### Testing & Verification
- [x] Test skill reading from `.claude/commands/`
- [x] Test variable substitution produces correct output
- [x] Test skill modification changes output
- [x] Test fallback when skill file missing
- [x] Run full workflow with new implementation

### Documentation
- [x] Update README.md status to COMPLETE
- [x] Update PLAN.md status to COMPLETE
- [x] Update SPEC.md with runtime skill reading details
- [x] Update main README.md if needed
