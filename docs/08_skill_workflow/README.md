# Phase 8: Skill-Based Task Documentation Workflow

## Status
**COMPLETE** - Implementation finished and verified.

## Overview

A structured 3-step workflow for task execution that uses bundled Claude Code skills to automatically generate comprehensive documentation before any implementation begins. When a user clicks "Run" on a task, AgentRunner first invokes the `/brief` skill to generate a feature specification (README.md), then invokes the `/plan` skill to generate implementation plans (PLAN.md, CHECKLIST.md), and only then executes the actual task with full documentation context.

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

## Non-Goals

- Custom skill creation UI within AgentRunner
- Skill marketplace or remote skill fetching
- Parallel execution of workflow steps
- Conditional workflow branching or skip logic
- Workflow templates or presets beyond Brief → Plan → Execute
- Automatic skill updates (skills are copied once and owned by the workspace)

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
