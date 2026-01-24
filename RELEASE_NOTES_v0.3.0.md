# Formic v0.3.0 - AI Task Manager & Mobile PWA

**The Local-First Agent Orchestration Environment**

*Vibe Coding with autonomous agents. Your repo, your rules, their labor.*

---

## Highlights

This release introduces the **AI Task Manager** — a chat-based interface for creating tasks with codebase-aware prompts — along with full **Progressive Web App (PWA)** support for native mobile experience and **real-time board notifications** via WebSocket.

---

## What's New

### AI Task Manager
- **Chat-Based Task Creation** - Describe what you want in natural language, AI crafts optimized prompts
- **Codebase-Aware Context** - AI understands your repository structure, patterns, and conventions
- **Conversational Interface** - Multi-turn chat for refining task requirements
- **Claude Code Integration** - Powered by Claude Code CLI for intelligent task generation
- **Floating Action Button** - Quick access to AI assistant from anywhere in the app

### Progressive Web App (PWA)
- **Installable App** - Add to home screen on iOS, Android, and desktop
- **Native Feel** - Standalone mode with no browser chrome
- **Offline-Ready** - Service worker caches assets for instant startup
- **App Icons** - Custom SVG icons (192x192 and 512x512) with maskable support
- **Portrait Orientation** - Optimized for mobile-first usage

### Mobile Board View
- **Tactical View** - Compact mobile-optimized board layout
- **Touch-Optimized** - Designed for finger navigation and gestures
- **Safe Area Support** - Proper insets for notched devices (iPhone, etc.)
- **Responsive Chat Panel** - Full-screen chat on mobile devices
- **Floating Action Buttons** - Context-aware FABs for quick actions

### Real-Time Board Updates
- **WebSocket Notifications** - Board state syncs instantly across all connected clients
- **Live Task Updates** - See task status changes without refreshing
- **Multi-Device Sync** - Changes on mobile reflect immediately on desktop

### UI/UX Improvements
- **Create Task Card** - New task card directly in TODO column for quick task creation
- **Luminous Void Chat UI** - AI Assistant styled with glass-morphic design language
- **Tactical FAB Positioning** - Refined floating button placement for mobile usability

---

## Features

### Core Functionality
- **Kanban Board** - Drag-and-drop task management across `todo`, `queued`, `running`, `review`, `done` columns
- **Priority Queue** - Smart queueing system with priority-based ordering
- **Live Terminal** - Real-time agent output streaming via WebSocket using xterm.js
- **3-Step Workflow** - Automated Brief → Plan → Execute pipeline for every task
- **AI Task Manager** - Chat with AI to create optimized tasks

### Task Management
- **Auto-Documentation** - Every task generates README.md (spec), PLAN.md (implementation plan), and subtasks.json (progress tracking)
- **Iterative Execution** - Agent loops until all subtasks are complete (configurable max iterations)
- **Subtask Progress Tracking** - Visual progress bars and completion stats for each task
- **Queue Position Badges** - Shows task position in the priority queue

### Smart Features
- **Project Bootstrap** - Auto-generates project-specific AI development guidelines on first run
- **Skill-Based Documentation** - Runtime skill file reading and guidelines injection
- **Task Detail Modal** - Click any task to view full context, subtasks, and workflow status
- **Codebase-Aware Prompts** - AI Task Manager analyzes your repo for context

### Mobile & PWA
- **Progressive Web App** - Install on any device for native experience
- **Mobile Board View** - Tactical layout optimized for small screens
- **Remote Access** - Use with Tailscale for secure remote development
- **Real-Time Sync** - WebSocket-based board notifications

### Multi-Agent Support
- **Claude Code CLI** - Default agent using Anthropic API
- **GitHub Copilot CLI** - Alternative agent using GitHub OAuth
- Easy switching via `AGENT_TYPE` environment variable

### UI/UX
- **Luminous Void Design** - Glass-morphic dark theme with blur effects
- **Theme Support** - Dark, Light, and Auto modes with smooth transitions
- **Responsive Layout** - Works on desktop and mobile devices
- **Modern Typography** - Inter font with optimized letter-spacing

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

### Install as PWA
1. Open Formic in Chrome/Safari
2. Click "Add to Home Screen" or install prompt
3. Launch from your home screen for native experience

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `8000` |
| `HOST` | Server hostname | `0.0.0.0` |
| `WORKSPACE_PATH` | Project directory | `./workspace` |
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

- `aa146ea` Update documentation for v0.3.0 release
- `d852759` Implement board update notifications via WebSocket connections
- `43235a1` Refine Tactical FAB styling and positioning for improved mobile usability
- `83ef05c` Adjust mobile chat FAB positioning for safe area insets
- `349bfad` Add mobile board view and chat panel for AI Assistant
- `34ace30` Fix Mobile PWA native feel and icon support
- `907181d` Add PWA support with tactical view for mobile devices
- `b1f044b` Add Create Task card to TODO column
- `f0c922f` Transform AI Assistant into Formic Task Manager
- `3a69ba1` Refactor AI Assistant UI to Luminous Void design style
- `94d84d1` Fix AI Assistant chat to properly communicate with Claude Code CLI
- `7847bf4` Implement AI Assistant feature with chat panel and floating action button

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

**Full Changelog**: https://github.com/rickywo/Formic/compare/v0.2.0...v0.3.0
