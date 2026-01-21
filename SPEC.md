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

### 2.6 Project Bootstrap & Development Guidelines

When AgentRunner is first launched against a new project workspace, it performs an automatic bootstrap process to establish AI development guidelines.

**Purpose:**
1. **Consistency**: Ensures Claude follows project-specific coding standards
2. **Context**: Provides architectural patterns and constraints upfront
3. **Quality**: Establishes testing requirements and forbidden practices

**Bootstrap Detection:**
The system checks for `kanban-development-guideline.md` in the workspace root:
- If **missing**: Creates a bootstrap task automatically
- If **present**: Skips bootstrap, loads existing guidelines

**Bootstrap Task:**
When triggered, the system creates a special task with ID `t-bootstrap` that:
1. Reads the template from `templates/development-guideline.md`
2. Audits the repository structure, dependencies, and patterns
3. Generates `kanban-development-guideline.md` in the workspace root

**Bootstrap Prompt:**
```
You are a Senior Engineer contributing to this repository. Your task is to audit this codebase and create a development guideline document.

1. First, explore the repository structure using file listing and reading
2. Identify the tech stack, frameworks, and core libraries
3. Analyze the architectural patterns and folder structure
4. Review existing tests to understand the testing strategy
5. Check for linting/formatting configurations
6. Look for existing coding conventions in the codebase

Using the template at templates/development-guideline.md, create a comprehensive
kanban-development-guideline.md file in the project root with:

## 🛠️ Tech Stack & Core Libraries
[List the discovered frameworks and libraries. Be version-specific if possible.]

## 🏗️ Architectural Patterns
[Describe the folder structure and design patterns observed in the audit.]

## 🧪 Testing Strategy
[Define the testing framework and requirements discovered.]

## 🎨 Coding Standards
- **Naming:** [Insert observed naming convention]
- **Typing:** [Strict vs Loose typing rules]
- **Formatting:** [Reference linter rules]

## 🚫 Explicit Anti-Patterns
[List patterns to avoid based on the codebase analysis]

## 🧠 Behavioral Rules
- **Context First:** Always read related files before suggesting changes.
- **Concise:** Focus on implementation details relevant to this architecture.

Save the completed guidelines to: kanban-development-guideline.md
```

**File Locations:**
```
agentrunner/
├── templates/
│   └── development-guideline.md    # Template for guidelines

{workspace}/
├── kanban-development-guideline.md # Generated guidelines (in project root)
└── .agentrunner/
    └── tasks/
        └── t-bootstrap_setup-guidelines/
```

**Workflow:**
```
┌─────────────────────────────────────────────────────────────┐
│  User starts AgentRunner with workspace                      │
│                     ↓                                        │
│  System checks: kanban-development-guideline.md exists?      │
│                     ↓                                        │
│         ┌─── NO ───┴─── YES ───┐                            │
│         ↓                      ↓                             │
│  Create bootstrap task    Load existing                      │
│  (t-bootstrap)            guidelines                         │
│         ↓                      ↓                             │
│  Agent audits repo        Ready for                          │
│  & generates guidelines   user tasks                         │
│         ↓                                                    │
│  Guidelines saved to                                         │
│  workspace root                                              │
└─────────────────────────────────────────────────────────────┘
```

### 2.7 Skill-Based Task Documentation Workflow

AgentRunner implements a structured 3-step workflow for task execution, ensuring comprehensive documentation before any implementation begins.

**Workflow Overview:**
```
┌─────────────────────────────────────────────────────────────────┐
│  User creates task with title + context (prompt)                │
│                         ↓                                       │
│  Load kanban-development-guideline.md from workspace root       │
│  (Guidelines are injected into EVERY workflow step prompt)      │
│                         ↓                                       │
│  Step 1: BRIEF - Generate README.md                             │
│  • Uses /brief skill with task context + guidelines             │
│  • Output: .agentrunner/tasks/{id}_{slug}/README.md             │
│                         ↓                                       │
│  Step 2: PLAN - Generate PLAN.md + CHECKLIST.md                 │
│  • Uses /plan skill reading the generated README.md + guidelines│
│  • Output: .agentrunner/tasks/{id}_{slug}/PLAN.md               │
│  • Output: .agentrunner/tasks/{id}_{slug}/CHECKLIST.md          │
│                         ↓                                       │
│  Step 3: EXECUTE - Run the actual task                          │
│  • Agent receives full context + guidelines in prompt           │
│  • Agent implements the task following the plan                 │
│  • Output: .agentrunner/tasks/{id}_{slug}/output/               │
└─────────────────────────────────────────────────────────────────┘
```

**Project Guidelines Injection:**

The `kanban-development-guideline.md` file (generated by bootstrap) is automatically loaded and injected into every workflow step prompt:

```typescript
// In workflow.ts and runner.ts
async function loadProjectGuidelines(): Promise<string> {
  const guidelinePath = path.join(WORKSPACE_PATH, 'kanban-development-guideline.md');
  if (!existsSync(guidelinePath)) return '';

  const content = await readFile(guidelinePath, 'utf-8');
  return `
## Project Development Guidelines
The following guidelines MUST be followed for all code changes in this project:

${content}

---
END OF GUIDELINES
`;
}
```

This ensures:
- Claude receives project-specific rules in every prompt (not relying on file discovery)
- All generated documentation follows project coding standards
- All code changes comply with project-specific architectural patterns
- Consistent behavior across all workflow steps (brief, plan, execute)

**Bundled Skills:**

Skills are stored in the AgentRunner project and copied to the workspace's `.agentrunner/skills/` directory during workspace initialization (same timing as bootstrap detection):

```
agentrunner/
├── skills/
│   ├── brief/
│   │   └── SKILL.md         # README.md generator
│   └── plan/
│       └── SKILL.md         # PLAN.md + CHECKLIST.md generator

{workspace}/
└── .agentrunner/
    └── skills/              # Copied from agentrunner during init
        ├── brief/
        │   └── SKILL.md
        └── plan/
            └── SKILL.md
```

**Skill Initialization Timing:**

Skills are copied during workspace initialization, which occurs on the first `GET /api/board` request:

```
┌─────────────────────────────────────────────────────────────┐
│  GET /api/board (first request)                             │
│                         ↓                                   │
│  1. Create .agentrunner/ directory (if not exists)          │
│                         ↓                                   │
│  2. Copy skills to .agentrunner/skills/ (if not exists)     │
│                         ↓                                   │
│  3. Check bootstrap required (kanban-development-guideline) │
│                         ↓                                   │
│  4. Create bootstrap task (if needed)                       │
│                         ↓                                   │
│  5. Return board (skills ready for any task workflow)       │
└─────────────────────────────────────────────────────────────┘
```

This ensures skills are available before any task can be executed, with no race conditions or added latency during task runs.

**Brief Skill Template (`skills/brief/SKILL.md`):**
```markdown
You are a senior Technical Project Manager. Generate a feature specification.

**Task:** $ARGUMENTS

**Output Location:** $TASK_DOCS_PATH/README.md

**Structure:**
- # [Feature Title]
- ## Overview: Brief introduction
- ## Goals: Primary objectives (bullet points)
- ## Key Capabilities: Main functionalities
- ## Non-Goals: Out of scope items
- ## Requirements: Technical and non-technical requirements

Focus on the 'what' and 'why', not the 'how'.
```

**Plan Skill Template (`skills/plan/SKILL.md`):**
```markdown
You are a senior Technical Project Manager. Generate implementation plans.

**Input:** Read $TASK_DOCS_PATH/README.md for feature specification

**Output Files:**
1. $TASK_DOCS_PATH/PLAN.md - Detailed implementation steps with checkboxes
2. $TASK_DOCS_PATH/CHECKLIST.md - Quality gates and completion criteria

**PLAN.md Structure:**
- Phase-based implementation steps
- TDD workflow (test first, implement, refactor)
- Checkbox items for tracking

**CHECKLIST.md Structure:**
- Pre-implementation gates
- Implementation verification
- Quality gates
- Documentation requirements
```

**Task Status Extended:**
```typescript
type TaskStatus = 'todo' | 'briefing' | 'planning' | 'running' | 'review' | 'done';
```

**Workflow Execution:**
1. User clicks "Run" on a task in `todo` status
2. Task moves to `briefing` status, `/brief` skill executes
3. On completion, task moves to `planning` status, `/plan` skill executes
4. On completion, task moves to `running` status, main execution begins
5. On completion, task moves to `review` status

**API Changes:**
```typescript
// New endpoint to trigger individual workflow steps
POST /api/tasks/:id/workflow/:step  // step: 'brief' | 'plan' | 'execute'

// Task response includes workflow state
interface Task {
  // ... existing fields
  workflowStep: 'pending' | 'brief' | 'plan' | 'execute' | 'complete';
  workflowLogs: {
    brief?: string[];
    plan?: string[];
    execute?: string[];
  };
}
```

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

### Phase 1: Project Foundation ✅
- [x] Initialize TypeScript project
- [x] Configure Fastify server with static file serving
- [x] Set up development scripts (dev, build, start)
- [x] Create type definitions

### Phase 2: Data Layer ✅
- [x] Implement JSON file store service
- [x] Board CRUD operations
- [x] Task CRUD operations
- [x] Task documentation folder management (docsPath)

### Phase 3: Agent Runner ✅
- [x] Process spawning with `child_process`
- [x] stdout/stderr capture
- [x] Process lifecycle management (start/stop)
- [x] Concurrency control
- [x] Graceful error handling (CLI not found, etc.)

### Phase 4: Real-time Communication ✅
- [x] WebSocket server setup
- [x] Log streaming to connected clients
- [x] Connection management per task

### Phase 5: Frontend ✅
- [x] HTML structure with Kanban layout
- [x] CSS styling (dark theme)
- [x] Task CRUD UI
- [x] Drag-and-drop functionality
- [x] xterm.js terminal integration
- [x] WebSocket client for live logs

### Phase 6: Docker & Deployment ✅
- [x] Dockerfile creation
- [x] Build optimization (.dockerignore, HEALTHCHECK, 358MB image)
- [x] Documentation updates
- [x] docker-compose.yml

### Phase 7: Project Bootstrap & Development Guidelines ✅
- [x] Create bootstrap detection service
- [x] Implement first-run detection logic
- [x] Create bootstrap task with preconfigured prompt
- [x] Copy development guideline template to workspace
- [x] Update store service to trigger bootstrap on first access
- [x] Add bootstrap status to board API response
- [x] Update frontend to show bootstrap task prominently
- [x] Add "Re-run Bootstrap" option in UI (via delete guidelines + restart)

### Phase 8: Skill-Based Task Documentation Workflow ✅
- [x] Create AgentRunner-specific `/brief` skill for README.md generation
- [x] Create AgentRunner-specific `/plan` skill for PLAN.md and CHECKLIST.md generation
- [x] Implement 3-step task execution workflow:
  - Step 1: Generate README.md using `/brief` skill
  - Step 2: Generate PLAN.md and CHECKLIST.md using `/plan` skill
  - Step 3: Execute task with full documentation context
- [x] Bundle skills in `skills/` directory within AgentRunner
- [x] Update runner service to orchestrate the 3-step workflow
- [x] Add workflow status indicators to frontend (Brief → Plan → Execute)
- [x] Allow manual trigger of individual workflow steps
- [x] Handle workflow interruption and stop

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
