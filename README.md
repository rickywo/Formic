# AgentRunner

A local-first agent orchestration and execution environment. A web-based "Mission Control" that sits on top of a local repository, allowing you to define tasks and spawn Claude CLI processes to execute them.

## Overview

AgentRunner provides a Kanban-style interface for managing AI-assisted development tasks. Define your tasks, click "Run", and watch Claude Code work on your codebase in real-time.

## Features

- **Kanban Board**: Drag-and-drop task management with `todo`, `running`, `review`, and `done` columns
- **Agent Execution**: Spawn Claude CLI processes directly against your local repository
- **Live Terminal Output**: Stream agent logs via WebSocket to see real-time progress
- **Single Project Focus**: One board, one repository, zero context switching

## Tech Stack

| Component | Technology |
|-----------|------------|
| Runtime | Node.js 20 + TypeScript |
| Server | Fastify |
| WebSocket | @fastify/websocket |
| Frontend | Vanilla HTML/CSS/JS (React-ready) |
| Terminal UI | xterm.js |
| Database | Local JSON file (`data/board.json`) |
| Agent | Claude Code CLI |
| Deployment | Docker |

## Prerequisites

- Docker & Docker Compose
- A local code repository to work on
- Anthropic API key (for Claude Code)

## Quick Start

### 1. Clone this repository

```bash
git clone <repo-url>
cd agentrunner
```

### 2. Run with Docker

```bash
docker build -t agentrunner .

docker run -p 8000:8000 \
  -v ./data:/app/data \
  -v /path/to/your/project:/app/workspace \
  -e ANTHROPIC_API_KEY=your-api-key \
  agentrunner
```

### 3. Open the dashboard

Navigate to `http://localhost:8000` in your browser.

## Volume Mounts

AgentRunner requires two volume mounts:

| Mount | Purpose |
|-------|---------|
| `-v ./data:/app/data` | Persists the Kanban board state |
| `-v /path/to/project:/app/workspace` | Your codebase that agents will work on |

## Development

### Local Development

```bash
# Install dependencies
npm install

# Run in development mode (with hot reload)
npm run dev

# Build for production
npm run build

# Run production build
npm start
```

### Project Structure

```
src/
├── server/
│   ├── index.ts          # Fastify server entry point
│   ├── routes/
│   │   ├── board.ts      # Board/task CRUD endpoints
│   │   └── agent.ts      # Agent run/stop endpoints
│   ├── ws/
│   │   └── logs.ts       # WebSocket log streaming
│   └── services/
│       └── runner.ts     # Claude CLI process management
├── client/
│   └── index.html        # Frontend UI
├── types/
│   └── index.ts          # Shared TypeScript types
data/
└── board.json            # Persistent board state
```

## Usage

1. **Create a Task**: Click "New Task" and provide a title and context/prompt
2. **Run Agent**: Click the green play button on any task in the `todo` column
3. **Monitor**: Watch the live terminal output as Claude works
4. **Review**: Completed tasks move to `review` for your approval
5. **Done**: Drag reviewed tasks to `done` when satisfied

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
| `DATA_PATH` | Path to data directory | `/app/data` |
| `ANTHROPIC_API_KEY` | API key for Claude | Required |

## Limitations (v1)

- Single agent concurrency (one task running at a time)
- Single project/repository per instance
- No task dependencies or workflows
- Logs limited to last 50 lines per task

## License

MIT
