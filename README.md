# AgentRunner

A local-first agent orchestration and execution environment. A web-based "Mission Control" that sits on top of a local repository, allowing you to define tasks and spawn Claude CLI processes to execute them.

## Overview

AgentRunner provides a Kanban-style interface for managing AI-assisted development tasks. Define your tasks, click "Run", and watch Claude Code work on your codebase in real-time.

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
cd agentrunner

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
docker build -t agentrunner .

# Run with your API key
docker run -p 8000:8000 \
  -v /path/to/your/project:/app/workspace \
  -e ANTHROPIC_API_KEY=your-api-key \
  agentrunner
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

AgentRunner requires a single volume mount for your project workspace:

```bash
-v /path/to/your/project:/app/workspace
```

All AgentRunner data (board state, task documentation) is stored inside the workspace at `.agentrunner/`:

```
your-project/
├── src/
├── package.json
└── .agentrunner/           # Created automatically
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

When you first start AgentRunner against a new project, it automatically creates a bootstrap task to generate AI development guidelines specific to your codebase.

### How It Works

1. **Detection**: AgentRunner checks if `kanban-development-guideline.md` exists in your project root
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
2. Restart AgentRunner
3. The bootstrap task will be created again

## Project Structure

```
agentrunner/
├── src/
│   ├── server/
│   │   ├── index.ts          # Fastify server entry point
│   │   ├── routes/
│   │   │   ├── board.ts      # GET /api/board
│   │   │   └── tasks.ts      # Task CRUD + run/stop
│   │   ├── ws/
│   │   │   └── logs.ts       # WebSocket log streaming
│   │   ├── services/
│   │   │   ├── runner.ts     # Claude CLI process management
│   │   │   ├── store.ts      # JSON file storage
│   │   │   ├── bootstrap.ts  # First-run detection & setup
│   │   │   └── taskDocs.ts   # Task documentation folders
│   │   ├── templates/        # Task doc templates
│   │   └── utils/            # Slug, paths helpers
│   ├── client/
│   │   └── index.html        # Frontend UI
│   └── types/
│       └── index.ts          # Shared TypeScript types
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
| POST | `/api/tasks/:id/run` | Start agent execution |
| POST | `/api/tasks/:id/stop` | Stop running agent |
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
