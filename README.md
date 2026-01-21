# Formic

A local-first agent orchestration and execution environment. A web-based "Mission Control" that sits on top of a local repository, allowing you to define tasks and spawn Claude CLI processes to execute them.

## Overview

Formic provides a Kanban-style interface for managing AI-assisted development tasks. Define your tasks, click "Run", and watch Claude Code work on your codebase in real-time.

## Features

- **Kanban Board**: Drag-and-drop task management with `todo`, `running`, `review`, and `done` columns
- **Agent Execution**: Spawn Claude CLI processes directly against your local repository
- **Live Terminal Output**: Stream agent logs via WebSocket to see real-time progress
- **Task Documentation**: Each task gets a folder with README, PLAN, and CHECKLIST for context
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
| Agent | Claude Code CLI |
| Deployment | Docker |

## Prerequisites

- Docker & Docker Compose (for containerized deployment)
- Node.js 20+ (for local development)
- Anthropic API key (for Claude Code)

## Quick Start

### Option 1: Docker Compose (Recommended)

```bash
# Clone the repository
git clone <repo-url>
cd formic

# Set your API key
export ANTHROPIC_API_KEY=your-api-key

# Set path to your project
export WORKSPACE_PATH=/path/to/your/project

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
            ├── README.md
            ├── PLAN.md
            ├── CHECKLIST.md
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
│  2. PLAN  → Generate PLAN.md + CHECKLIST.md                 │
│                         ↓                                   │
│  3. EXECUTE → Run the task with full documentation context  │
└─────────────────────────────────────────────────────────────┘
```

### How It Works

1. **Create Task**: Enter a title and context/prompt describing what you want to build
2. **Click Run**: Formic automatically:
   - **Loads Guidelines**: Injects `kanban-development-guideline.md` into every prompt
   - **Step 1 (Brief)**: Generates `README.md` with goals, capabilities, and requirements
   - **Step 2 (Plan)**: Generates `PLAN.md` (implementation steps) and `CHECKLIST.md` (quality gates)
   - **Step 3 (Execute)**: Runs the agent with all documentation as context
3. **Monitor Progress**: Watch each step complete in the terminal view

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
├── README.md       # Generated by /brief - feature specification
├── PLAN.md         # Generated by /plan - implementation steps
├── CHECKLIST.md    # Generated by /plan - quality gates
└── output/         # Agent-generated artifacts
```

### Bundled Skills

Formic includes two built-in skills that are automatically copied to your workspace during initialization (same timing as bootstrap detection):

| Skill | Purpose | Output |
|-------|---------|--------|
| `/brief` | Generate feature specification | README.md |
| `/plan` | Generate implementation plan | PLAN.md, CHECKLIST.md |

Skills are stored at `.formic/skills/` in your workspace. They are copied once on first access and can be customized for your project's needs.

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
| `planning` | Generating PLAN.md and CHECKLIST.md |
| `running` | Executing the actual task |
| `review` | Task complete, awaiting review |
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
│   │   │   └── taskDocs.ts   # Task documentation folders
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
| POST | `/api/tasks/:id/run` | Start full workflow (brief → plan → execute) |
| POST | `/api/tasks/:id/stop` | Stop running agent |
| POST | `/api/tasks/:id/workflow/brief` | Run only the brief step |
| POST | `/api/tasks/:id/workflow/plan` | Run only the plan step |
| POST | `/api/tasks/:id/workflow/execute` | Run only the execute step |
| WS | `/ws/logs/:taskId` | Stream agent logs |

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `8000` |
| `WORKSPACE_PATH` | Path to mounted workspace | `/app/workspace` |
| `ANTHROPIC_API_KEY` | API key for Claude | Required |
| `AGENT_COMMAND` | CLI command to run | `claude` |

## Limitations (v1)

- Single agent concurrency (one task running at a time)
- Single project/repository per instance
- No task dependencies or workflows
- Logs limited to last 50 lines per task

## Troubleshooting

### Agent fails with "Command 'claude' not found"
Ensure Claude Code CLI is installed. In Docker, it's pre-installed. For local development:
```bash
npm install -g @anthropic-ai/claude-code
```

### Container health check failing
The container needs a few seconds to start. Check logs with:
```bash
docker logs <container-id>
```

### Permission denied on workspace
Ensure the mounted directory is readable/writable by the container user.

### OAuth login doesn't work in Docker
Claude Code OAuth credentials are stored in your system's keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service), which is not accessible from within Docker containers. Use an API key for Docker deployments.

## License

MIT
