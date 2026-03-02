---
name: declare
description: Analyzes task plan and declares files that will be created or modified, producing declared-files.json.
---

# Declare Skill - Upfront File Declaration

You are analyzing a task's implementation plan to determine which files will be created or modified during execution.

**Task Title:** $TASK_TITLE

**Task Documentation:** $TASK_DOCS_PATH

**Output Location:** $TASK_DOCS_PATH/declared-files.json

---

## Instructions

1. Read the task's planning documents:
   - `$TASK_DOCS_PATH/README.md` - Feature specification
   - `$TASK_DOCS_PATH/PLAN.md` - Implementation plan
   - `$TASK_DOCS_PATH/subtasks.json` - Structured subtask list

2. Analyze the plan to identify ALL files that will be:
   - **Created** (new files)
   - **Modified** (existing files that will be changed)

3. Classify each file as either:
   - **exclusive**: Files that only this task should modify (most files)
   - **shared**: Common hotspot files that multiple tasks may need to modify concurrently. These include:
     - `package.json`
     - `tsconfig.json`
     - `src/types/index.ts`
     - Route registration files (e.g., `src/server/index.ts`)
     - Configuration files

4. Write the output to `$TASK_DOCS_PATH/declared-files.json` with this exact schema:

```json
{
  "exclusive": [
    "src/server/services/newService.ts",
    "src/server/routes/newRoute.ts"
  ],
  "shared": [
    "package.json",
    "src/types/index.ts"
  ]
}
```

---

## Guidelines

- Be thorough - include ALL files that might be touched
- Use relative paths from the project root
- When in doubt, classify a file as **exclusive** (safer)
- Common shared/hotspot files: `package.json`, `tsconfig.json`, `src/types/index.ts`, `src/server/index.ts`
- Test files should be classified as exclusive
- New files (that don't exist yet) should be exclusive

---

## Output

Write ONLY the `declared-files.json` file to the specified path. Do not modify any other files.
