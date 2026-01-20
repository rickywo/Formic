# Product Specification: AgentRunner v1

## 1. Executive Summary

| Attribute | Value |
|-----------|-------|
| Product Name | AgentRunner |
| Version | 1.0 |
| Type | Local-First Agent Orchestration & Execution Environment |
| Target Audience | Developers using Claude Code for project development |

### Core Concept

A web-based "Mission Control" dashboard that sits on top of a local repository. Users define tasks via a Kanban interface, and the system spawns Claude CLI processes inside the repository to execute those tasks autonomously.

---

## 2. Technical Architecture

### 2.1 Technology Stack

| Layer | Technology | Purpose |
|-------|------------|---------|
| Runtime | Node.js 20 + TypeScript | Unified language for full stack |
| Server | Fastify | Fast, low-overhead web framework |
| WebSocket | @fastify/websocket | Real-time log streaming |
| Frontend | HTML + CSS + Vanilla JS | Simple, no-build-step UI |
| Terminal UI | xterm.js | Log display in browser |
| Database | JSON file (`data/board.json`) | Local state persistence |
| Agent | Claude Code CLI | Task execution |
| Deployment | Docker | Containerized environment |

### 2.2 Project Structure

**AgentRunner Application:**
```
agentrunner/
├── src/
│   ├── server/
│   │   ├── index.ts              # Fastify entry point
│   │   ├── routes/
│   │   │   ├── board.ts          # GET /api/board
│   │   │   └── tasks.ts          # Task CRUD + run/stop
│   │   ├── ws/
│   │   │   └── logs.ts           # WebSocket handler
│   │   └── services/
│   │       ├── runner.ts         # Process spawning & management
│   │       └── store.ts          # JSON file read/write
│   ├── client/
│   │   └── index.html            # Single-page frontend
│   └── types/
│       └── index.ts              # Shared type definitions
├── package.json
├── tsconfig.json
├── Dockerfile
└── README.md
```

**User's Workspace (mounted project):**
```
/app/workspace/bigtoy/            # User's project
├── src/
├── package.json
└── .agentrunner/                 # AgentRunner data (inside workspace)
    ├── board.json                # Project's board state
    └── tasks/
        └── t-1_implement-user-auth/
            ├── README.md         # Task specification
            ├── PLAN.md           # Implementation plan
            ├── CHECKLIST.md      # Completion tracking
            └── output/           # Agent output artifacts
```

> **Note:** All AgentRunner state is stored inside the workspace. This makes each project self-contained and allows switching between projects by mounting different workspaces.

### 2.5 Task Documentation Folders

Task documentation is stored **inside the user's workspace** at `.agentrunner/tasks/`. This allows the Claude agent to naturally discover and read the context files when exploring the codebase.

**Purpose:**

1. **Context Memory**: The agent reads README.md, PLAN.md, and CHECKLIST.md to understand the task scope, implementation approach, and current progress.

2. **Outcome Capture**: All artifacts produced by the agent (code snippets, analysis, logs) are stored in the `output/` subdirectory.

3. **Progress Tracking**: CHECKLIST.md is updated by the agent as work progresses, providing visibility into completion status.

4. **Version Control**: Task documentation can be committed with the project, preserving history.

**Folder Structure:**
```
{workspace}/.agentrunner/tasks/{task-id}_{slug}/
├── README.md        # Specification: goals, requirements, non-goals
├── PLAN.md          # Implementation: step-by-step tasks with checkboxes
├── CHECKLIST.md     # Quality gates and completion criteria
└── output/          # Agent-generated artifacts
    ├── analysis.md  # Research findings
    ├── diff.patch   # Code changes
    └── ...
```

**Example:** For a task "Implement User Auth" in project "bigtoy":
```
/app/workspace/bigtoy/.agentrunner/tasks/t-1_implement-user-auth/
```

**Workflow:**
1. When a task is created, its documentation folder is initialized in the workspace
2. The agent is instructed to read `.agentrunner/tasks/{id}_{slug}/` for context
3. During execution, the agent reads the docs and writes artifacts to the folder
4. On completion, the folder serves as a version-controlled record of what was done

### 2.3 Container Strategy

Single Node.js container serving both API and static frontend. The container requires Claude Code CLI installed globally.

### 2.4 Volume Requirements

| Volume | Container Path | Purpose |
|--------|----------------|---------|
| Workspace | `/app/workspace` | User's project (includes `.agentrunner/` with board state and task docs) |

**Single Volume Design:** All state is stored inside the workspace at `.agentrunner/`. This eliminates the need for a separate data volume and makes projects fully portable.

**Multi-Project Usage:**
```bash
# Work on bigtoy - loads bigtoy's board and tasks
docker run -p 8000:8000 -v /Users/me/bigtoy:/app/workspace agentrunner

# Work on webapp - loads webapp's board and tasks
docker run -p 8000:8000 -v /Users/me/webapp:/app/workspace agentrunner
```

---

## 3. Data Schema

### 3.1 Board Structure (`{workspace}/.agentrunner/board.json`)

```json
{
  "meta": {
    "projectName": "bigtoy",
    "repoPath": "/app/workspace",
    "createdAt": "2024-05-20T10:00:00Z"
  },
  "tasks": [
    {
      "id": "t-1",
      "title": "Implement User Auth",
      "status": "todo",
      "priority": "high",
      "context": "Add JWT-based authentication with login/register endpoints.",
      "docsPath": ".agentrunner/tasks/t-1_implement-user-auth",
      "agentLogs": [],
      "pid": null
    }
  ]
}
```

> **Note:** Both `board.json` and task documentation folders are stored inside the workspace at `.agentrunner/`. The full path for the board would be `{workspace}/.agentrunner/board.json` and for task docs `{workspace}/.agentrunner/tasks/t-1_implement-user-auth/`

### 3.2 TypeScript Types

```typescript
type TaskStatus = 'todo' | 'running' | 'review' | 'done';
type TaskPriority = 'low' | 'medium' | 'high';

interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  context: string;
  docsPath: string;
  agentLogs: string[];
  pid: number | null;
}

interface BoardMeta {
  projectName: string;
  repoPath: string;
  createdAt: string;
}

interface Board {
  meta: BoardMeta;
  tasks: Task[];
}
```

### 3.3 Task Documentation Files

Each task's `docsPath` folder contains:

| File | Purpose |
|------|---------|
| `README.md` | Task specification (goals, requirements, non-goals) |
| `PLAN.md` | Implementation plan with checkboxes for each step |
| `CHECKLIST.md` | Quality gates and completion criteria |
| `output/` | Directory for agent-generated artifacts |

### 3.4 Field Definitions

#### Meta Object

| Field | Type | Description |
|-------|------|-------------|
| `projectName` | string | Display name for the project |
| `repoPath` | string | Path to mounted workspace (always `/app/workspace`) |
| `createdAt` | ISO 8601 | Board creation timestamp |

#### Task Object

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier (format: `t-{n}`) |
| `title` | string | Task title (used as prompt prefix) |
| `status` | enum | One of: `todo`, `running`, `review`, `done` |
| `priority` | enum | One of: `low`, `medium`, `high` |
| `context` | string | Detailed prompt/instructions for Claude |
| `docsPath` | string | Path to task documentation folder relative to workspace (format: `.agentrunner/tasks/{id}_{slug}`) |
| `agentLogs` | string[] | Last 50 lines of execution output |
| `pid` | number \| null | Process ID when running, null otherwise |

---

## 4. Functional Requirements

### 4.1 Frontend Features (Web UI)

#### Kanban Board
- Four-column layout: Todo, Running, Review, Done
- Drag-and-drop task movement between columns
- Visual status indicators

#### Task Creator
- **Inputs:**
  - Title (required): Short description of the task
  - Context/Prompt (required): Detailed instructions for Claude
  - Priority (optional): Low, Medium, High

#### Execution Controls
| Control | Location | Action |
|---------|----------|--------|
| Run Agent | Tasks in `todo` column | Starts agent execution |
| Stop Agent | Tasks in `running` column | Terminates running process |

#### Live Terminal View
- Expandable panel or modal per running task
- Real-time stdout/stderr streaming via xterm.js
- Critical for observing agent state and permission requests

### 4.2 Backend Features (Agent Runner Service)

#### Process Management

**Run Agent Flow:**
1. Check concurrency limit (max 1 agent for v1)
2. Update task status to `running`
3. Spawn child process using Node.js `child_process.spawn()`
4. Execute Claude CLI in `/app/workspace` with task context
5. Stream logs via WebSocket to frontend
6. On exit code 0: update status to `review`
7. On error/termination: update status to `todo` with error log

**Command Template:**
```bash
claude --print "First, read the task context from {docsPath}/ (README.md, PLAN.md, CHECKLIST.md). Then execute: {task_title}. Write any outputs to {docsPath}/output/"
```

**Example:**
```bash
claude --print "First, read the task context from .agentrunner/tasks/t-1_implement-user-auth/ (README.md, PLAN.md, CHECKLIST.md). Then execute: Implement User Auth. Write any outputs to .agentrunner/tasks/t-1_implement-user-auth/output/"
```

This ensures the agent:
1. Reads existing context and progress from the documentation folder
2. Understands the task scope, plan, and what's already been done
3. Writes artifacts and updates to the designated output folder

#### Process Store
- Track active process by task ID
- Store `ChildProcess` reference for termination
- Clean up on process exit

---

## 5. API Specification

### 5.1 REST Endpoints

| Method | Path | Description | Request Body | Response |
|--------|------|-------------|--------------|----------|
| GET | `/api/board` | Get full board state | - | `Board` |
| POST | `/api/tasks` | Create task | `{title, context, priority}` | `Task` |
| PUT | `/api/tasks/:id` | Update task | `Partial<Task>` | `Task` |
| DELETE | `/api/tasks/:id` | Delete task | - | 204 |
| POST | `/api/tasks/:id/run` | Start agent | - | `{status, pid}` |
| POST | `/api/tasks/:id/stop` | Stop agent | - | `{status}` |

### 5.2 WebSocket Endpoints

| Path | Purpose | Message Format |
|------|---------|----------------|
| `/ws/logs/:taskId` | Stream agent output | `{type: "stdout" \| "stderr", data: string}` |

### 5.3 Static Files

| Path | Serves |
|------|--------|
| `/` | `src/client/index.html` |
| `/static/*` | Static assets (CSS, JS if separated) |

---

## 6. UI/UX Design Guidelines

### 6.1 Visual Style

| Aspect | Guideline |
|--------|-----------|
| Theme | Dark mode "Mission Control" aesthetic |
| Background | `#0d1117` (GitHub dark) |
| Card Background | `#161b22` |
| Accent | `#58a6ff` (blue), `#3fb950` (green), `#f85149` (red) |
| Typography | Monospace for logs, system font for UI |

### 6.2 Card Design

```
┌─────────────────────────────────┐
│ [HIGH] Fix Navbar Issue         │  ← Header: Title + Priority Badge
├─────────────────────────────────┤
│ The navbar overlaps the hero    │  ← Body: Context snippet
│ image on mobile screens...      │
├─────────────────────────────────┤
│                        [▶ Run]  │  ← Footer: Action button
└─────────────────────────────────┘
```

**Status Badge Colors:**
| Status | Color |
|--------|-------|
| todo | `#8b949e` (gray) |
| running | `#58a6ff` (blue, animated pulse) |
| review | `#d29922` (yellow) |
| done | `#3fb950` (green) |

**Priority Badge Colors:**
| Priority | Color |
|----------|-------|
| low | `#8b949e` |
| medium | `#d29922` |
| high | `#f85149` |

### 6.3 Terminal Panel

- Fixed bottom drawer, 300px height
- Dark background (`#0d1117`)
- Green text for stdout, red for stderr
- Auto-scroll with pause on manual scroll

---

## 7. Docker Specification

### 7.1 Dockerfile

```dockerfile
FROM node:20-slim

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy built application
COPY dist/ ./dist/
COPY src/client/ ./src/client/

# Expose port
EXPOSE 8000

# Set environment defaults
ENV PORT=8000
ENV WORKSPACE_PATH=/app/workspace

# Run the server
CMD ["node", "dist/server/index.js"]
```

### 7.2 Docker Compose (Optional)

```yaml
version: '3.8'
services:
  agentrunner:
    build: .
    ports:
      - "8000:8000"
    volumes:
      - /path/to/your/project:/app/workspace  # Single volume - all state in .agentrunner/
    environment:
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
```

> **Note:** Only one volume mount is required. The board state and task documentation are stored inside the workspace at `.agentrunner/`.

---

## 8. Development Roadmap

### Phase 1: Project Foundation
- [x] Initialize TypeScript project
- [ ] Configure Fastify server with static file serving
- [ ] Set up development scripts (dev, build, start)
- [ ] Create type definitions

### Phase 2: Data Layer
- [ ] Implement JSON file store service
- [ ] Board CRUD operations
- [ ] Task CRUD operations

### Phase 3: Agent Runner
- [ ] Process spawning with `child_process`
- [ ] stdout/stderr capture
- [ ] Process lifecycle management (start/stop)
- [ ] Concurrency control

### Phase 4: Real-time Communication
- [ ] WebSocket server setup
- [ ] Log streaming to connected clients
- [ ] Connection management per task

### Phase 5: Frontend
- [ ] HTML structure with Kanban layout
- [ ] CSS styling (dark theme)
- [ ] Task CRUD UI
- [ ] Drag-and-drop functionality
- [ ] xterm.js terminal integration
- [ ] WebSocket client for live logs

### Phase 6: Docker & Deployment
- [ ] Dockerfile creation
- [ ] Build optimization
- [ ] Documentation

---

## 9. Constraints & Limitations (v1)

| Constraint | Rationale |
|------------|-----------|
| Single agent concurrency | Prevents resource conflicts and simplifies state management |
| Single project per instance | Focused scope, clearer mental model |
| No task dependencies | Simplicity for v1, can add workflows in v2 |
| 50-line log limit per task | Memory conservation |
| No authentication | Local-only deployment assumption |

---

## 10. Future Considerations (v2+)

- Multi-agent concurrency with queue management
- Task dependencies and workflows
- Multiple project support
- Agent conversation history persistence
- Git integration (auto-commit, branch per task)
- Custom agent configurations
- Cloud deployment option with authentication
- React frontend migration for complex interactions
