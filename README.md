<p align="center">
  <img src="images/formic.png" alt="Formic Logo" width="400">
</p>

<p align="center">
  <strong>The Local-First Agent Orchestration Environment</strong>
</p>

<p align="center">
  <em>Vibe Coding with autonomous agents. Your repo, your rules, their labor.</em>
</p>

<p align="center">
  <a href="#quickstart"><img src="https://img.shields.io/badge/Docker-Ready-2496ED?style=flat-square&logo=docker" alt="Docker Ready"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/Status-Alpha-orange?style=flat-square" alt="Alpha Status">
  <img src="https://img.shields.io/badge/Built%20with-Claude-blueviolet?style=flat-square" alt="Built with Claude">
</p>

<p align="center">
  <a href="#quickstart">Quickstart</a> •
  <a href="#why-formic">Why?</a> •
  <a href="#features">Features</a> •
  <a href="#supported-agents">Agents</a> •
  <a href="#documentation">Docs</a> •
  <a href="#contributing">Contributing</a>
</p>

---

<p align="center">
  <img src="images/screenshot.png" alt="Formic Dashboard" width="800">
  <br>
  <em>Mission Control for your AI coding agents</em>
</p>

---

## Why Formic?

**The Problem:** You have an AI coding agent. You have a codebase. But every task becomes a context dump, a prompt engineering session, and a prayer that the agent remembers what you told it five minutes ago.

**The Solution:** Formic sits between you and your AI agent like a competent project manager. You describe what you want. Formic breaks it into specs, plans, and subtasks. The agent executes. You review.

```
┌─────────────────────────────────────────────────────┐
│  You: "Add dark mode"                               │
│           ↓                                         │
│  Formic: Queue task (priority: high/medium/low)     │
│           ↓                                         │
│  Formic: Generates README.md (spec)                 │
│           ↓                                         │
│  Formic: Generates PLAN.md + subtasks.json          │
│           ↓                                         │
│  Agent: Implements all subtasks autonomously        │
│           ↓                                         │
│  You: Review, approve, ship                         │
└─────────────────────────────────────────────────────┘
```

**Vibe Coding Philosophy:**
- 🐜 **Agents do the labor** — You define intent, they write code
- ⚡ **Local-first** — Your repo, your machine, zero cloud lock-in
- 🎯 **Structured autonomy** — Every task gets specs, plans, and tracked subtasks

---

## Quickstart

### 🐳 One Command

```bash
docker run -p 8000:8000 \
  -v /path/to/your/project:/app/workspace \
  -e ANTHROPIC_API_KEY=your-api-key \
  ghcr.io/your-org/formic:latest
```

Open `http://localhost:8000` and start creating tasks.

### Three Steps to Autonomous Development

1. **Create a task** — Describe what you want in plain English
2. **Run or Queue** — Click **Run** for immediate execution, or **Queue** to add to the priority queue
3. **Review & ship** — Agent moves completed work to Review for your approval

That's it. No prompt engineering. No context management. No babysitting.

> **Tip:** Use the Queue system to batch multiple tasks. High-priority tasks automatically run before medium and low priority ones.

---

## Features

| Feature | Description |
|---------|-------------|
| 🐜 **Kanban Board** | Drag-and-drop task management across `todo`, `queued`, `running`, `review`, `done` |
| 📊 **Priority Queue** | Smart queueing system with priority-based ordering (high → medium → low) |
| ⚡ **Live Terminal** | Real-time agent output streaming via WebSocket |
| 📋 **Auto-Documentation** | Every task gets README.md, PLAN.md, and structured subtasks |
| 🔄 **Iterative Execution** | Agent loops until all subtasks are complete (configurable iterations) |
| 🎯 **Smart Bootstrap** | Auto-generates project-specific coding guidelines on first run |
| 🔌 **Multi-Agent** | Switch between Claude Code CLI and GitHub Copilot CLI |
| 🌙 **Theme Support** | Dark, Light, and Auto theme modes |

### Workflow

```
┌─────────────────────────────────────────────────────────────┐
│  TODO → Task created, ready to run or queue                 │
│           ↓                                                 │
│  QUEUED → Waiting in priority queue (high > medium > low)   │
│           ↓                                                 │
│  BRIEF → Generate README.md (what to build)                 │
│           ↓                                                 │
│  PLAN  → Generate PLAN.md + subtasks.json (how to build)    │
│           ↓                                                 │
│  EXECUTE → Iterative loop until all subtasks complete       │
│           ↓                                                 │
│  REVIEW → Ready for human review                            │
└─────────────────────────────────────────────────────────────┘
```

### Priority Queue System

Tasks can be queued for automated execution with priority-based ordering:

- **High priority** tasks run first
- **Medium priority** tasks run after high
- **Low priority** tasks run last
- Within the same priority, tasks run in FIFO order (first queued, first run)

Queue position is displayed on each queued task card. Configure concurrency with `MAX_CONCURRENT_TASKS`.

---

## Supported Agents

| Agent | Command | Auth | Status |
|-------|---------|------|--------|
| **Claude Code CLI** | `claude` | `ANTHROPIC_API_KEY` | ✅ Default |
| **GitHub Copilot CLI** | `copilot` | GitHub OAuth | ✅ Supported |

Switch agents via environment variable:

```bash
# Claude (default)
export AGENT_TYPE=claude
export ANTHROPIC_API_KEY=your-key

# GitHub Copilot
export AGENT_TYPE=copilot
# Uses your existing GitHub auth
```

---

## Documentation

### Project Structure

```
your-project/
├── src/
├── package.json
└── .formic/                      # Auto-created
    ├── board.json                # Kanban state
    └── tasks/
        └── t-1_add-dark-mode/
            ├── README.md         # Feature spec
            ├── PLAN.md           # Implementation plan
            └── subtasks.json     # Tracked progress
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `8000` |
| `HOST` | Server hostname | `0.0.0.0` |
| `WORKSPACE_PATH` | Project directory | `./workspace` |
| `AGENT_TYPE` | Agent to use (`claude` or `copilot`) | `claude` |
| `AGENT_COMMAND` | Override agent CLI command | (derived from AGENT_TYPE) |
| `ANTHROPIC_API_KEY` | Claude API key | Required for Claude |
| `QUEUE_ENABLED` | Enable/disable queue processor | `true` |
| `QUEUE_POLL_INTERVAL` | Queue polling interval (ms) | `5000` |
| `MAX_CONCURRENT_TASKS` | Max simultaneous running tasks | `1` |
| `MAX_EXECUTE_ITERATIONS` | Max execute loop iterations | `5` |
| `STEP_TIMEOUT_MS` | Timeout per workflow step (ms) | `600000` (10 min) |

### API

**Board & Tasks**
| Endpoint | Description |
|----------|-------------|
| `GET /api/board` | Fetch board state with all tasks |
| `POST /api/tasks` | Create task (title, context, priority) |
| `PUT /api/tasks/:id` | Update task properties |
| `DELETE /api/tasks/:id` | Delete task |

**Execution & Queue**
| Endpoint | Description |
|----------|-------------|
| `POST /api/tasks/:id/run` | Execute full workflow (brief → plan → execute) |
| `POST /api/tasks/:id/queue` | Add task to priority queue |
| `POST /api/tasks/:id/stop` | Stop running workflow |

**Workflow Steps** (granular control)
| Endpoint | Description |
|----------|-------------|
| `POST /api/tasks/:id/workflow/brief` | Run only brief step |
| `POST /api/tasks/:id/workflow/plan` | Run only plan step |
| `POST /api/tasks/:id/workflow/execute` | Run only execute step |

**Subtasks**
| Endpoint | Description |
|----------|-------------|
| `GET /api/tasks/:id/subtasks` | Get all subtasks |
| `PUT /api/tasks/:id/subtasks/:subtaskId` | Update subtask status |
| `GET /api/tasks/:id/subtasks/completion` | Get completion stats |

**WebSocket**
| Endpoint | Description |
|----------|-------------|
| `WS /ws/logs/:taskId` | Stream real-time agent output |

Full API reference in [SPEC.md](SPEC.md).

---

## Tech Stack

| Component | Technology |
|-----------|------------|
| Runtime | Node.js 20 + TypeScript |
| Server | Fastify |
| WebSocket | @fastify/websocket |
| Frontend | Vanilla JS + Tailwind CSS |
| Terminal | xterm.js |
| Font | Inter (Google Fonts) |
| Agent | Claude Code / GitHub Copilot |
| Deployment | Docker |

---

## Development

```bash
# Clone
git clone https://github.com/your-org/formic.git
cd formic

# Install
npm install

# Run (development)
npm run dev

# Build
npm run build

# Run (production)
npm start
```

---

## Roadmap

- [x] Kanban board with drag-and-drop
- [x] Live terminal output streaming
- [x] Auto-bootstrap project guidelines
- [x] 3-step workflow (brief → plan → execute)
- [x] Iterative execution with subtask tracking
- [x] Multi-agent support (Claude + Copilot)
- [x] Priority-based task queue system
- [x] Configurable concurrency limits
- [x] Theme support (dark/light/auto)
- [ ] Task dependencies
- [ ] Git auto-commit per task
- [ ] Cloud deployment option

---

## Contributing

Contributions welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting PRs.

```bash
# Run tests
npm test

# Lint
npm run lint
```

---

## License

[MIT](LICENSE) — Use it, fork it, ship it.

---

<p align="center">
  <strong>🐜 Formic</strong>
  <br>
  <em>Let the agents do the work.</em>
</p>
