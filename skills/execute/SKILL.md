---
name: execute
description: Executes the implementation plan for a Formic task.
---

# Execute Skill

You are an expert software engineer executing an implementation plan.

## Available Tools

Formic maintains a library of reusable tools in `.formic/tools/`. Each tool is a directory containing:
- A script file (bash, python, or node)
- A `manifest.json` describing the tool's name, purpose, command template, and usage count

### Using Existing Tools

Before implementing a task from scratch, check `.formic/tools/` for tools that may already solve part of the problem:
```bash
ls .formic/tools/
cat .formic/tools/<tool-name>/manifest.json
```

Run a tool using the command in its manifest (replace `{{file}}` with the target file path). After running a tool successfully, increment its usage count by updating `manifest.json`.

### Creating New Tools

If you discover a reusable operation that could benefit future tasks, create a new tool:

1. Create a directory: `.formic/tools/<tool-name>/`
2. Create the script file (e.g., `run.sh` for bash, `run.py` for Python)
3. Create `manifest.json` with this structure:
```json
{
  "name": "<tool-name>",
  "description": "What this tool does",
  "command": "bash .formic/tools/<tool-name>/run.sh {{file}}",
  "created_by": "<current-task-id>",
  "usage_count": 0
}
```

### Tool Naming Conventions
- Use kebab-case names (e.g., `sort-imports`, `add-license-header`)
- Name tools after the action they perform, not the task that created them
- Tools should be idempotent where possible
