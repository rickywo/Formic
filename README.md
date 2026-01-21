# Formic

A local-first agent orchestration and execution environment. A web-based "Mission Control" that sits on top of a local repository, allowing you to define tasks and spawn AI coding agents to execute them.

## Overview

Formic provides a Kanban-style interface for managing AI-assisted development tasks. Define your tasks, click "Run", and watch your AI coding agent work on your codebase in real-time.

**Supported Agents:**
- **Claude Code CLI** (default) - Anthropic's agentic coding assistant
- **GitHub Copilot CLI** - GitHub's terminal-based coding agent

## Features

- **Kanban Board**: Drag-and-drop task management with `todo`, `running`, `review`, and `done` columns
- **Agent Execution**: Spawn Claude CLI processes directly against your local repository
- **Live Terminal Output**: Stream agent logs via WebSocket to see real-time progress
- **Task Documentation**: Each task gets a folder with README, PLAN, and structured subtasks for context
- **Smart Completion**: Iterative execution loop verifies all subtasks are complete before marking done
- **Single Project Focus**: One board, one repository, zero context switching
- **Auto-Bootstrap**: Automatically generates project-specific AI development guidelines on first run

## Tech Stack

| Component | Technology |
|-----------|------------|
| Runtime | Node.js 20 + TypeScript |
| Server | Fastify |
| WebSocket | @fastify/websocket |
| Frontend | Vanilla HTML/CSS/JS |
| Terminal UI | xterm.js |
| Storage | JSON file (workspace-based) |
| Agent | Claude Code CLI or GitHub Copilot CLI |
| Deployment | Docker |

## Prerequisites

- Docker & Docker Compose (for containerized deployment)
- Node.js 20+ (for local development)
- One of the following AI coding agents:
  - **Claude Code CLI** + Anthropic API key, OR
  - **GitHub Copilot CLI** + GitHub Copilot subscription (Pro/Business/Enterprise)

## Quick Start

### Option 1: Docker Compose (Recommended)

```bash
# Clone the repository
git clone <repo-url>
cd formic

# Set path to your project
export WORKSPACE_PATH=/path/to/your/project

# --- For Claude Code (default) ---
export ANTHROPIC_API_KEY=your-api-key

# --- OR for GitHub Copilot CLI ---
export AGENT_COMMAND=copilot
export AGENT_TYPE=copilot
# (Copilot uses your GitHub authentication automatically)

# Build and run
docker-compose up -d

# Open http://localhost:8000
```

### Option 2: Docker Run

```bash
# Build the image
docker build -t formic .

# Run with your API key
docker run -p 8000:8000 \
  -v /path/to/your/project:/app/workspace \
  -e ANTHROPIC_API_KEY=your-api-key \
  formic
```

> **Note about OAuth**: Claude Code OAuth credentials are stored in your system's keychain (macOS Keychain, Windows Credential Manager, etc.), which is not accessible from within Docker containers. For Docker deployments, use an API key instead.

### Option 3: Local Development

```bash
# Install dependencies
npm install

# Run in development mode (with hot reload)
npm run dev

# Open http://localhost:8000
```

## Volume Mount

Formic requires a single volume mount for your project workspace:

```bash
-v /path/to/your/project:/app/workspace
```

All Formic data (board state, task documentation) is stored inside the workspace at `.formic/`:

```
your-project/
├── src/
├── package.json
└── .formic/           # Created automatically
    ├── board.json          # Kanban board state
    └── tasks/
        └── t-1_task-name/  # Task documentation folder
            ├── README.md       # Feature specification (human-readable)
            ├── PLAN.md         # High-level implementation steps (human-readable)
            ├── subtasks.json   # Structured subtask list (agent source of truth)
            └── output/
```

This design makes each project self-contained and portable.

## Usage

1. **Create a Task**: Click "+ New Task" and provide a title and context/prompt
2. **Run Agent**: Click "Run" on any task in the Todo column
3. **Monitor**: Watch the live terminal output as Claude works
4. **Review**: Completed tasks move to Review for your approval
5. **Done**: Drag reviewed tasks to Done when satisfied

## Auto-Bootstrap: Development Guidelines

When you first start Formic against a new project, it automatically creates a bootstrap task to generate AI development guidelines specific to your codebase.

### How It Works

1. **Detection**: Formic checks if `kanban-development-guideline.md` exists in your project root
2. **Bootstrap Task**: If missing, a special task is created automatically
3. **Codebase Audit**: Claude analyzes your repository structure, dependencies, and patterns
4. **Guidelines Generated**: A comprehensive `kanban-development-guideline.md` is created

### What's Analyzed

The bootstrap process examines:
- Tech stack and core libraries (with versions)
- Folder structure and architectural patterns
- Testing frameworks and strategies
- Linting/formatting configurations
- Existing coding conventions

### Generated Guidelines Include

```markdown
## Tech Stack & Core Libraries
[Discovered frameworks and versions]

## Architectural Patterns
[Folder structure and design patterns]

## Testing Strategy
[Testing framework and requirements]

## Coding Standards
[Naming conventions, typing rules, formatting]

## Explicit Anti-Patterns
[Patterns to avoid in this codebase]

## Behavioral Rules
[Context-first development guidelines]
```

### Customizing the Template

The template is located at `templates/development-guideline.md`. Modify it to match your organization's standards before running the bootstrap task.

### Re-running Bootstrap

To regenerate guidelines (e.g., after major refactoring):
1. Delete `kanban-development-guideline.md` from your project root
2. Restart Formic
3. The bootstrap task will be created again

## Skill-Based Task Workflow

Formic uses a structured 3-step workflow for task execution, ensuring comprehensive documentation is generated before implementation begins.

### Workflow Steps

```
┌─────────────────────────────────────────────────────────────┐
│  1. BRIEF → Generate README.md (feature specification)      │
│                         ↓                                   │
│  2. PLAN  → Generate PLAN.md + subtasks.json                │
│                         ↓                                   │
│  3. EXECUTE → Iterative loop until all subtasks complete    │
│               (Ralph Wiggum style completion verification)  │
└─────────────────────────────────────────────────────────────┘
```

### How It Works

1. **Create Task**: Enter a title and context/prompt describing what you want to build
2. **Click Run**: Formic automatically:
   - **Loads Guidelines**: Injects `kanban-development-guideline.md` into every prompt
   - **Step 1 (Brief)**: Generates `README.md` with goals, capabilities, and requirements
   - **Step 2 (Plan)**: Generates `PLAN.md` (human-readable overview) and `subtasks.json` (structured task list)
   - **Step 3 (Execute)**: Runs the agent in an iterative loop, checking `subtasks.json` for completion
3. **Smart Completion**: The execute step loops until all subtasks are marked complete (or max iterations reached)
4. **Monitor Progress**: Watch each step and iteration complete in the terminal view

### Automatic Guidelines Injection

When you run the bootstrap task, it generates `kanban-development-guideline.md` in your project root. This file is **automatically injected into every workflow step prompt**, ensuring Claude always follows your project's coding standards, architectural patterns, and best practices.

This means:
- Claude receives project-specific rules in every prompt (not relying on file discovery)
- All generated documentation follows your project's coding standards
- All code changes comply with your architectural patterns
- Consistent behavior across all workflow steps (brief, plan, execute)

### Task Documentation Structure

Each task gets a complete documentation folder:

```
.formic/tasks/t-1_implement-user-auth/
├── README.md       # Generated by /brief - feature specification (human-readable)
├── PLAN.md         # Generated by /plan - high-level steps (human-readable)
├── subtasks.json   # Generated by /plan - structured subtask list (agent source of truth)
└── output/         # Agent-generated artifacts
```

### subtasks.json Schema

The `subtasks.json` file is the **source of truth** for the agent during execution:

```json
{
  "version": "1.0",
  "taskId": "t-1",
  "title": "Implement user authentication",
  "createdAt": "2024-01-21T10:00:00Z",
  "updatedAt": "2024-01-21T12:30:00Z",
  "subtasks": [
    {
      "id": "1",
      "content": "Create auth service in src/services/auth.ts",
      "status": "completed",
      "completedAt": "2024-01-21T11:00:00Z"
    },
    {
      "id": "2",
      "content": "Add JWT middleware",
      "status": "in_progress"
    },
    {
      "id": "3",
      "content": "Write unit tests for auth service",
      "status": "pending"
    }
  ]
}
```

The agent reads this file to understand what work remains, updates subtask status as it progresses, and can even add new subtasks discovered during implementation.

### Bundled Skills

Formic includes two built-in skills that are automatically copied to your workspace during initialization (same timing as bootstrap detection):

| Skill | Purpose | Output |
|-------|---------|--------|
| `/brief` | Generate feature specification | README.md |
| `/plan` | Generate implementation plan | PLAN.md, subtasks.json |

Skills are stored at `.claude/skills/` in your workspace. They use the standard `SKILL.md` format with YAML frontmatter, which is compatible with both Claude Code and GitHub Copilot CLI. Skills are copied once on first access and can be customized for your project's needs.

### Manual Step Execution

You can trigger individual workflow steps via the API:

```bash
# Run only the brief step
curl -X POST http://localhost:8000/api/tasks/t-1/workflow/brief

# Run only the plan step
curl -X POST http://localhost:8000/api/tasks/t-1/workflow/plan

# Run only the execute step
curl -X POST http://localhost:8000/api/tasks/t-1/workflow/execute
```

### Task Statuses

| Status | Description |
|--------|-------------|
| `todo` | Task created, waiting to start |
| `briefing` | Generating README.md |
| `planning` | Generating PLAN.md and subtasks.json |
| `running` | Executing the task (iterating until subtasks complete) |
| `review` | All subtasks complete, awaiting human review |
| `done` | Task approved and closed |

## Project Structure

```
formic/
├── src/
│   ├── server/
│   │   ├── index.ts          # Fastify server entry point
│   │   ├── routes/
│   │   │   ├── board.ts      # GET /api/board
│   │   │   └── tasks.ts      # Task CRUD + run/stop + workflow
│   │   ├── ws/
│   │   │   └── logs.ts       # WebSocket log streaming
│   │   ├── services/
│   │   │   ├── runner.ts     # Claude CLI process management
│   │   │   ├── store.ts      # JSON file storage
│   │   │   ├── bootstrap.ts  # First-run detection & setup
│   │   │   ├── workflow.ts   # 3-step task workflow orchestration
│   │   │   ├── taskDocs.ts   # Task documentation folders
│   │   │   └── subtasks.ts   # Subtask management & completion checking
│   │   ├── templates/        # Task doc templates
│   │   └── utils/            # Slug, paths helpers
│   ├── client/
│   │   └── index.html        # Frontend UI
│   └── types/
│       └── index.ts          # Shared TypeScript types
├── skills/                   # Bundled Claude skills
│   ├── brief/
│   │   └── SKILL.md          # README.md generator
│   └── plan/
│       └── SKILL.md          # PLAN.md + CHECKLIST.md generator
├── templates/
│   └── development-guideline.md  # Bootstrap template
├── Dockerfile
├── docker-compose.yml
└── package.json
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/board` | Get full board state |
| POST | `/api/tasks` | Create a new task |
| PUT | `/api/tasks/:id` | Update a task |
| DELETE | `/api/tasks/:id` | Delete a task |
| POST | `/api/tasks/:id/run` | Start full workflow (brief → plan → execute loop) |
| POST | `/api/tasks/:id/stop` | Stop running agent |
| POST | `/api/tasks/:id/workflow/brief` | Run only the brief step |
| POST | `/api/tasks/:id/workflow/plan` | Run only the plan step |
| POST | `/api/tasks/:id/workflow/execute` | Run only the execute step |
| GET | `/api/tasks/:id/subtasks` | Get subtasks for a task |
| PUT | `/api/tasks/:id/subtasks/:subtaskId` | Update a subtask status |
| GET | `/api/tasks/:id/subtasks/completion` | Get completion percentage |
| WS | `/ws/logs/:taskId` | Stream agent logs |

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `8000` |
| `WORKSPACE_PATH` | Path to mounted workspace | `/app/workspace` |
| `AGENT_COMMAND` | CLI command to run | `claude` |
| `AGENT_TYPE` | Agent type for flag selection | `claude` |
| `ANTHROPIC_API_KEY` | API key for Claude Code | Required for Claude |

### Agent Configuration

**For Claude Code (default):**
```bash
export AGENT_COMMAND=claude
export AGENT_TYPE=claude
export ANTHROPIC_API_KEY=your-api-key
```

**For GitHub Copilot CLI:**
```bash
export AGENT_COMMAND=copilot
export AGENT_TYPE=copilot
# No API key needed - uses GitHub authentication
```

## Limitations (v1)

- Single agent concurrency (one task running at a time)
- Single project/repository per instance
- No task dependencies or workflows
- Logs limited to last 50 lines per task

## Troubleshooting

### Agent fails with "Command not found"

**For Claude Code:**
```bash
npm install -g @anthropic-ai/claude-code
```

**For GitHub Copilot CLI:**
```bash
# Install via Homebrew (macOS/Linux)
brew install github/gh/copilot-cli

# Or via npm
npm install -g @github/copilot-cli
```

### Container health check failing
The container needs a few seconds to start. Check logs with:
```bash
docker logs <container-id>
```

### Permission denied on workspace
Ensure the mounted directory is readable/writable by the container user.

### OAuth/Authentication issues in Docker

**Claude Code:** OAuth credentials are stored in your system's keychain, which is not accessible from within Docker containers. Use `ANTHROPIC_API_KEY` for Docker deployments.

**GitHub Copilot CLI:** Requires GitHub authentication. Run `gh auth login` on the host before starting the container, or configure GitHub token via environment variables.

## License

MIT
