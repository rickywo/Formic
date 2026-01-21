# Phase 2: Data Layer

## Overview

Implement the persistence layer for Formic using a JSON file-based store. This phase creates the service responsible for reading and writing board state, along with CRUD operations for both the board metadata and individual tasks. All data is stored **inside the user's workspace** at `.formic/`, making each project self-contained and portable.

## Goals

- Implement a JSON file store service for persistent board state
- Create Board read/update operations
- Create Task CRUD operations (create, read, update, delete)
- Implement task documentation folder management
- Ensure data integrity with atomic file writes
- Support multi-project usage through workspace-based storage

## Key Capabilities

- Load board state from `{workspace}/.formic/board.json` on startup
- Create default board and `.formic/` directory if not exists
- Create new tasks with auto-generated IDs and documentation folders
- Initialize task documentation folder with template files (README.md, PLAN.md, CHECKLIST.md)
- Update task properties (title, context, priority, status)
- Delete tasks and optionally clean up associated documentation folders
- Update task status and PID for agent execution tracking
- Append logs to task with 50-line limit
- Generate `docsPath` from task ID and slugified title

## Storage Structure

All Formic data lives inside the workspace:

```
{workspace}/.formic/
├── board.json                    # Project's board state
└── tasks/
    └── t-1_implement-user-auth/
        ├── README.md             # Task specification
        ├── PLAN.md               # Implementation plan
        ├── CHECKLIST.md          # Completion tracking
        └── output/               # Agent-generated artifacts
```

**Example for multiple projects:**

| Project | Board Path | Tasks Path |
|---------|------------|------------|
| bigtoy | `/app/workspace/.formic/board.json` | `/app/workspace/.formic/tasks/` |
| webapp | `/app/workspace/.formic/board.json` | `/app/workspace/.formic/tasks/` |

> When you mount a different workspace, Formic automatically loads that project's board and tasks.

**Benefits:**
- **Self-contained**: Each project has its own board + tasks
- **Portable**: Clone repo = get all task history
- **Multi-project**: Switch workspace, get that project's board automatically
- **Version controlled**: Board state and task docs can be committed with project

## Non-Goals

- Database integration (SQLite, PostgreSQL, etc.)
- Multi-user support or concurrent write handling
- Data migration or versioning
- Backup or recovery mechanisms
- API endpoint implementation (covered in later phases)
- Template customization for documentation files

## Requirements

### Store Service
- Must be async/await compatible
- All operations must read fresh data from disk
- File writes must be atomic (write complete JSON)
- All paths relative to `WORKSPACE_PATH` environment variable

### Board Management
- Board stored at `{WORKSPACE_PATH}/.formic/board.json`
- Create `.formic/` directory if it doesn't exist
- Initialize default board if `board.json` doesn't exist
- Default board should have empty tasks array and meta with project name from folder

### Task Management
- Task IDs must follow format `t-{number}`
- Task ID generation must find max existing ID and increment
- `docsPath` must follow format `.formic/tasks/{id}_{slug}`
- Slug must be generated from title (lowercase, hyphens, max 30 chars)

### Documentation Folders
- Folder must be created at `{WORKSPACE_PATH}/.formic/tasks/{id}_{slug}/`
- README.md, PLAN.md, CHECKLIST.md must be initialized with templates
- `output/` subdirectory must be created for agent artifacts
- Folder deletion should be optional (preserve history option)

### Data Integrity
- Board must initialize with default values if file missing
- Log buffer must be capped at 50 entries per task
- TypeScript types must be enforced for all operations
