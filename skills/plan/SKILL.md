---
description: Generates implementation plan (PLAN.md) and structured subtasks (subtasks.json) for a Formic task.
---

# Plan Skill - Generate Implementation Plan & Subtasks

You are a senior Technical Project Manager. Your task is to generate implementation planning documents based on an existing feature specification.

**Task Title:** $TASK_TITLE

**Task ID:** $TASK_ID

**Task Docs Path:** $TASK_DOCS_PATH

---

## Instructions

### Step 1: Read the Feature Specification

Read the README.md file at `$TASK_DOCS_PATH/README.md` to understand:
- The task's goals and objectives
- Key capabilities to implement
- Non-goals (what to avoid)
- Requirements to fulfill

Also read `kanban-development-guideline.md` in the project root if it exists for project-specific standards.

---

### Step 2: Generate PLAN.md

Create a high-level implementation overview for human readers. Write to: `$TASK_DOCS_PATH/PLAN.md`

```markdown
# [Task Title] - Implementation Plan

## Status
**PENDING** - Plan created, implementation to begin.

## Context
[1-2 sentences summarizing the task from README.md]

## Implementation Overview

### Phase 1: [First logical grouping]
[Brief description of what this phase accomplishes]

### Phase 2: [Second logical grouping]
[Brief description of what this phase accomplishes]

### Phase 3: [Third logical grouping if needed]
[Brief description of what this phase accomplishes]

## Key Milestones
- [Milestone 1]
- [Milestone 2]
- [Milestone 3]

## Success Criteria
- [Measurable outcome 1]
- [Measurable outcome 2]
```

---

### Step 3: Generate subtasks.json

Create a structured subtask list that the agent will use as the source of truth during execution. Write to: `$TASK_DOCS_PATH/subtasks.json`

The subtasks.json file MUST follow this exact schema:

```json
{
  "version": "1.0",
  "taskId": "$TASK_ID",
  "title": "$TASK_TITLE",
  "createdAt": "[ISO 8601 timestamp]",
  "updatedAt": "[ISO 8601 timestamp]",
  "subtasks": [
    {
      "id": "1",
      "content": "[Specific actionable task - be precise about files/functions]",
      "status": "pending"
    },
    {
      "id": "2",
      "content": "[Another specific actionable task]",
      "status": "pending"
    }
  ]
}
```

**Subtask Guidelines:**
- Each subtask should be a **single, verifiable action**
- Include specific file paths, function names, or component names when applicable
- Order subtasks logically (dependencies first, then dependent tasks)
- Include testing subtasks (e.g., "Write unit tests for auth service")
- Include quality gate subtasks (e.g., "Verify all tests pass", "Run linter")
- Aim for 5-15 subtasks depending on task complexity

**Subtask Status Values:**
- `pending` - Not yet started (initial state for all subtasks)
- `in_progress` - Currently being worked on
- `completed` - Finished and verified

---

## Guidelines

- **Be Specific**: Use actual file names, function names, and paths from the codebase
- **Be Actionable**: Each subtask should be a single, completable action
- **Be Realistic**: Break down complex tasks into smaller steps
- **Follow Project Standards**: Reference the project's development guidelines if available
- **Logical Ordering**: Subtasks should follow a natural implementation order (backend before frontend, models before APIs, etc.)
- **Include Verification**: Add subtasks for testing and quality gates

---

## Output

Write both files:
1. `$TASK_DOCS_PATH/PLAN.md` - Human-readable implementation overview
2. `$TASK_DOCS_PATH/subtasks.json` - Structured subtask list for agent execution

Do not output anything else.
