# Phase 8: Skill-Based Task Documentation Workflow

## Status
**COMPLETE** - Both phases implemented and verified.
- Phase 8.1: Core workflow with hardcoded prompts ✅
- Phase 8.2: Runtime skill file reading ✅

## Overview

A structured 3-step workflow for task execution that generates comprehensive documentation before any implementation begins. When a user clicks "Run" on a task, AgentRunner progresses through Brief → Plan → Execute steps.

### Implementation Details
The workflow **reads skill files at runtime** from `.claude/commands/` and substitutes variables (`$TASK_TITLE`, `$TASK_CONTEXT`, `$TASK_DOCS_PATH`) before passing to Claude. If a skill file is not found, the system falls back to hardcoded prompts for reliability.

**Key files:**
- `src/server/services/skillReader.ts` - Reads and processes skill files
- `src/server/services/skills.ts` - Copies skills to `.claude/commands/`
- `src/server/services/workflow.ts` - Orchestrates the 3-step workflow

## Goals

- Enforce a consistent documentation-first workflow for every task (Brief → Plan → Execute)
- Bundle `/brief` and `/plan` skills within AgentRunner, adapted from user's local Claude commands
- Copy bundled skills to workspace `.agentrunner/skills/` during initialization (same timing as bootstrap)
- Provide Claude with comprehensive, structured context before any implementation begins
- Give users visibility into workflow progress with distinct statuses (`briefing`, `planning`, `running`)
- Allow manual triggering of individual workflow steps for flexibility

## Key Capabilities

- **3-Step Workflow Pipeline**: Automatic progression through Brief → Plan → Execute when user clicks "Run"
- **Bundled Skills**: `/brief` and `/plan` skills shipped with AgentRunner in `skills/` directory
- **Automatic Skill Initialization**: Skills copied to `.agentrunner/skills/` during workspace init (before bootstrap)
- **Task Documentation Generation**: README.md, PLAN.md, and CHECKLIST.md generated in each task's folder
- **Workflow Status Tracking**: New `briefing` and `planning` statuses show current workflow step
- **Manual Step Execution**: API endpoints to trigger individual steps (`/workflow/brief`, `/workflow/plan`, `/workflow/execute`)
- **Customizable Skills**: Users can modify copied skills in `.agentrunner/skills/` for project-specific needs
- **Project Guidelines Injection**: `kanban-development-guideline.md` is automatically loaded and injected into every workflow step prompt

## Non-Goals

- Custom skill creation UI within AgentRunner
- Skill marketplace or remote skill fetching
- Parallel execution of workflow steps
- Conditional workflow branching or skip logic
- Workflow templates or presets beyond Brief → Plan → Execute
- Direct CLI skill invocation (`claude /brief`) - not supported in print mode

## Technical Discovery: Skill Invocation Limitation

### The Limitation
Claude Code skills **cannot be invoked directly in print mode**. From the official documentation:

> User-invoked skills like `/commit` and built-in commands are **only available in interactive mode**. In `-p` mode, describe the task you want to accomplish instead.

This means `claude -p /brief "task context"` does **NOT** work.

### Current Workaround (Phase 8.1)
Prompts are hardcoded in `workflow.ts`:
```typescript
function buildBriefPrompt(task: Task, guidelines: string): string {
  return `${guidelines}
You are generating a feature specification for a task.
TASK_TITLE: ${task.title}
...`;
}
```

### Implemented Solution (Phase 8.2)
Skills are now read at runtime, with variables substituted before passing to Claude:
```
┌─────────────────────────────────────────────────────────────────┐
│  1. Copy skills to workspace .claude/commands/brief/SKILL.md    │
│                         ↓                                        │
│  2. At runtime, READ the SKILL.md file content                   │
│                         ↓                                        │
│  3. Substitute variables ($TASK_TITLE → actual value)            │
│                         ↓                                        │
│  4. Pass substituted content as prompt to `claude -p "content"`  │
│                         ↓                                        │
│  5. Claude executes with the skill's instructions                │
└─────────────────────────────────────────────────────────────────┘
```

### Benefits
- Skills are in standard Claude location (`.claude/commands/`)
- Users can customize skills by editing the files directly
- Changes to skill files take effect immediately (no rebuild needed)
- Fallback to hardcoded prompts if skill file not found
- Guidelines are automatically injected into every prompt

## Requirements

- Skills must be bundled in AgentRunner's `skills/brief/SKILL.md` and `skills/plan/SKILL.md`
- Skills must be copied to workspace `.agentrunner/skills/` during initialization, before bootstrap task creation
- `/brief` skill must generate structured README.md with Overview, Goals, Capabilities, Non-Goals, Requirements
- `/plan` skill must read the generated README.md and produce PLAN.md (implementation steps) and CHECKLIST.md (quality gates)
- All generated files must be written to the task's documentation folder (`$TASK_DOCS_PATH`)
- Task status must transition through `briefing` → `planning` → `running` → `review`
- API must support manual step execution via `POST /api/tasks/:id/workflow/:step`
- Frontend must display workflow step indicators showing current progress
- Docker must include `skills/` directory in the container image
- Project guidelines (`kanban-development-guideline.md`) must be loaded and injected into every prompt

## Project Guidelines Integration

The `kanban-development-guideline.md` file (generated by the bootstrap task) is automatically injected into every workflow step prompt:

```
┌─────────────────────────────────────────────────────────────────┐
│  Workflow Step Execution                                         │
│                                                                  │
│  1. Load kanban-development-guideline.md from workspace root     │
│  2. Inject guidelines content at the start of the prompt         │
│  3. Execute the step (brief/plan/execute)                        │
│  4. Claude follows project-specific rules in all code changes    │
└─────────────────────────────────────────────────────────────────┘
```

This ensures:
- All generated documentation follows project coding standards
- All code changes comply with project-specific rules
- Consistent behavior across all workflow steps
- No reliance on Claude "discovering" the guidelines file
