# Formic v0.4.0 - Multi-Workspace Support

**The Local-First Agent Orchestration Environment**

*Vibe Coding with autonomous agents. Your repo, your rules, their labor.*

---

## Highlights

This release introduces **Multi-Workspace Support** — switch between project repositories without restarting the server. Also includes significant improvements to the **AI Task Manager** with multiple task creation and full **GitHub Copilot CLI** integration.

---

## What's New

### Multi-Workspace Support
- **Live Workspace Switching** — Change projects on-the-fly without restarting Formic
- **Path Validation** — Validates directories before switching (absolute path, exists, writable)
- **Auto-Initialize** — Creates `.formic/` directory automatically for new workspaces
- **Workspace Info API** — Shows task counts and last activity per workspace
- **Real-Time Sync** — WebSocket broadcasts workspace changes to all connected clients
- **Workspace Switcher UI** — Header dropdown for quick project switching

### AI Task Manager Improvements
- **Multiple Task Creation** — Create multiple tasks in a single AI response
- **GitHub Copilot CLI Support** — Full integration with Copilot for AI-assisted task creation
- **Cleaner Output Parsing** — Filters XML tool calls from Copilot responses
- **Flexible Task Format** — Improved regex matching for task-create blocks

### Workflow Improvements
- **Stall Detection** — Tasks no longer hang on manual testing subtasks
- **Skipped Status** — New `skipped` status for non-automatable subtasks (e.g., manual testing)
- **Auto-Completion** — Tasks automatically move to review when stalled for 2+ iterations

### UI/UX Fixes
- **Project Brief Panel** — Fixed overlapping with header elements
- **Workspace Input Field** — Improved visibility and sizing
- **Dropdown Width** — Increased workspace dropdown width for better readability
- **Workspace Switching UI** — Fixed mobile tactical view and project brief panel not refreshing on workspace switch

---

## Features

### Core Functionality
- **Multi-Workspace** — Switch between project repositories without restarting
- **Kanban Board** — Drag-and-drop task management across `todo`, `queued`, `running`, `review`, `done` columns
- **Priority Queue** — Smart queueing system with priority-based ordering
- **Live Terminal** — Real-time agent output streaming via WebSocket using xterm.js
- **3-Step Workflow** — Automated Brief → Plan → Execute pipeline for every task
- **AI Task Manager** — Chat with AI to create optimized tasks

### Task Management
- **Auto-Documentation** — Every task generates README.md (spec), PLAN.md (implementation plan), and subtasks.json (progress tracking)
- **Iterative Execution** — Agent loops until all subtasks are complete (configurable max iterations)
- **Stall Detection** — Auto-completes tasks stuck on manual testing subtasks
- **Subtask Progress Tracking** — Visual progress bars and completion stats for each task
- **Queue Position Badges** — Shows task position in the priority queue

### Smart Features
- **Project Bootstrap** — Auto-generates project-specific AI development guidelines on first run
- **Skill-Based Documentation** — Runtime skill file reading and guidelines injection
- **Task Detail Modal** — Click any task to view full context, subtasks, and workflow status
- **Codebase-Aware Prompts** — AI Task Manager analyzes your repo for context

### Mobile & PWA
- **Progressive Web App** — Install on any device for native experience
- **Mobile Board View** — Tactical layout optimized for small screens
- **Remote Access** — Use with Tailscale for secure remote development
- **Real-Time Sync** — WebSocket-based board notifications

### Multi-Agent Support
- **Claude Code CLI** — Default agent using Anthropic API
- **GitHub Copilot CLI** — Alternative agent using GitHub OAuth (full AI Task Manager support)
- Easy switching via `AGENT_TYPE` environment variable

### UI/UX
- **Luminous Void Design** — Glass-morphic dark theme with blur effects
- **Theme Support** — Dark, Light, and Auto modes with smooth transitions
- **Responsive Layout** — Works on desktop and mobile devices
- **Modern Typography** — Inter font with optimized letter-spacing

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
| PWA | Service Worker + Web App Manifest |
| Deployment | Docker |

---

## Quick Start

### Docker (Recommended)
```bash
docker run -p 8000:8000 \
  -v /path/to/your/project:/app/workspace \
  -e ANTHROPIC_API_KEY=your-api-key \
  ghcr.io/rickywo/formic:latest
```

### From Source
```bash
git clone https://github.com/rickywo/Formic.git
cd Formic
npm install
npm run dev
```

Open `http://localhost:8000` and start creating tasks.

### Switch Workspaces
1. Click the workspace dropdown in the header
2. Enter the absolute path to your project directory
3. Click "Switch" to change workspaces
4. Board loads with the new project's tasks

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `8000` |
| `HOST` | Server hostname | `0.0.0.0` |
| `WORKSPACE_PATH` | Initial project directory | `./workspace` |
| `AGENT_TYPE` | Agent to use (`claude` or `copilot`) | `claude` |
| `ANTHROPIC_API_KEY` | Claude API key | Required for Claude |
| `QUEUE_ENABLED` | Enable/disable queue processor | `true` |
| `QUEUE_POLL_INTERVAL` | Queue polling interval (ms) | `5000` |
| `MAX_CONCURRENT_TASKS` | Max simultaneous running tasks | `1` |
| `MAX_EXECUTE_ITERATIONS` | Max execute loop iterations | `5` |
| `STEP_TIMEOUT_MS` | Timeout per workflow step (ms) | `600000` |

---

## API Endpoints

### Board & Tasks
| Endpoint | Description |
|----------|-------------|
| `GET /api/board` | Fetch board state with all tasks |
| `POST /api/tasks` | Create task (title, context, priority) |
| `PUT /api/tasks/:id` | Update task properties |
| `DELETE /api/tasks/:id` | Delete task |

### Workspace Management
| Endpoint | Description |
|----------|-------------|
| `POST /api/workspace/validate` | Validate a workspace path |
| `GET /api/workspace/info` | Get current workspace metadata |
| `POST /api/workspace/switch` | Switch to a different workspace |

### Execution & Queue
| Endpoint | Description |
|----------|-------------|
| `POST /api/tasks/:id/run` | Execute full workflow (brief → plan → execute) |
| `POST /api/tasks/:id/queue` | Add task to priority queue |
| `POST /api/tasks/:id/stop` | Stop running workflow |

### Workflow Steps
| Endpoint | Description |
|----------|-------------|
| `POST /api/tasks/:id/workflow/brief` | Run only brief step |
| `POST /api/tasks/:id/workflow/plan` | Run only plan step |
| `POST /api/tasks/:id/workflow/execute` | Run only execute step |

### AI Assistant
| Endpoint | Description |
|----------|-------------|
| `POST /api/assistant/chat` | Send message to AI Task Manager |
| `WS /ws/assistant` | WebSocket for streaming AI responses |

### Subtasks
| Endpoint | Description |
|----------|-------------|
| `GET /api/tasks/:id/subtasks` | Get all subtasks |
| `PUT /api/tasks/:id/subtasks/:subtaskId` | Update subtask status |
| `GET /api/tasks/:id/subtasks/completion` | Get completion stats |

### WebSocket
| Endpoint | Description |
|----------|-------------|
| `WS /ws/logs/:taskId` | Stream real-time agent output |
| `WS /ws/board` | Board update notifications |
| `WS /ws/assistant` | AI Task Manager streaming |

---

## Commits in this Release

- `fd2d152` Fix mobile tactical view and project brief panel on workspace switch
- `b5a03b4` Update documentation for v0.4.0 release
- `78ff8bb` Fix AI assistant to create multiple tasks from single response
- `dfc4111` Improve workspace path input field visibility
- `c061d7f` Fix project brief panel overlapping with header elements
- `ef2ac6b` Fix GitHub Copilot CLI integration for Task Manager assistant
- `bcca928` Fix task hanging on manual testing subtasks with stall detection
- `2a2bcdd` Add workspace management features and integrate workspace routes

---

## What's Next

- [ ] Task dependencies and workflows
- [ ] Git auto-commit per task
- [ ] Cloud deployment option
- [ ] Team collaboration features
- [ ] Custom agent configurations

---

## License

MIT License - Use it, fork it, ship it.

---

**Full Changelog**: https://github.com/rickywo/Formic/compare/v0.3.0...v0.4.0
