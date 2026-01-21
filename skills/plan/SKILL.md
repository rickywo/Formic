---
description: Generates implementation plan (PLAN.md) and checklist (CHECKLIST.md) for a Formic task.
---

# Plan Skill - Generate Implementation Plan & Checklist

You are a senior Technical Project Manager. Your task is to generate implementation planning documents based on an existing feature specification.

**Task Title:** $TASK_TITLE

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

Create a detailed implementation plan with checkboxes. Write to: `$TASK_DOCS_PATH/PLAN.md`

```markdown
# [Task Title] - Implementation Plan

## Status
**PENDING** - Plan created, implementation to begin.

## Context
[1-2 sentences summarizing the task from README.md]

## Implementation Phases

### Phase 1: [First logical grouping]
- [ ] 1.1 [Specific actionable task]
- [ ] 1.2 [Specific actionable task]
- [ ] 1.3 [Specific actionable task]

### Phase 2: [Second logical grouping]
- [ ] 2.1 [Specific actionable task]
- [ ] 2.2 [Specific actionable task]
- [ ] 2.3 [Specific actionable task]

### Phase 3: [Third logical grouping if needed]
- [ ] 3.1 [Specific actionable task]
- [ ] 3.2 [Specific actionable task]

## Testing Strategy
- [ ] [Test type 1]: [What to test]
- [ ] [Test type 2]: [What to test]

## Success Criteria
- [ ] [Measurable outcome 1]
- [ ] [Measurable outcome 2]
```

---

### Step 3: Generate CHECKLIST.md

Create a high-level completion checklist. Write to: `$TASK_DOCS_PATH/CHECKLIST.md`

```markdown
# [Task Title] - Checklist

## Pre-Implementation
- [ ] README.md specification reviewed
- [ ] Technical approach understood
- [ ] Dependencies identified

## Implementation
- [ ] Phase 1 complete
- [ ] Phase 2 complete
- [ ] Phase 3 complete (if applicable)

## Quality Gates
- [ ] Code compiles without errors
- [ ] All tests passing
- [ ] No runtime errors
- [ ] Code follows project conventions

## Verification
- [ ] Feature works as specified
- [ ] Edge cases handled
- [ ] Error handling in place

## Post-Implementation
- [ ] Code committed
- [ ] Documentation updated
- [ ] Task marked complete
```

---

## Guidelines

- **Be Specific**: Use actual file names, function names, and paths from the codebase
- **Be Actionable**: Each checkbox item should be a single, completable action
- **Be Realistic**: Break down complex tasks into smaller steps
- **Follow Project Standards**: Reference the project's development guidelines if available
- **Logical Ordering**: Phases should follow a natural implementation order (backend before frontend, models before APIs, etc.)

---

## Output

Write both files:
1. `$TASK_DOCS_PATH/PLAN.md`
2. `$TASK_DOCS_PATH/CHECKLIST.md`

Do not output anything else.
