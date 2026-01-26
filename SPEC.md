# Product Specification: Formic v0.5.0

## 1. Executive Summary

| Attribute | Value |
|-----------|-------|
| Product Name | Formic |
| Version | 0.5.0 |
| npm Package | `@rickywo/formic` |
| Type | Local-First Agent Orchestration & Execution Environment |
| Target Audience | Developers using AI coding agents for project development |
| Supported Agents | Claude Code CLI, GitHub Copilot CLI |
| Platform | PWA (Mobile, Tablet, Desktop) |
| Remote Access | Tailscale-compatible |

### Core Concept

A web-based "Mission Control" dashboard that sits on top of a local repository. Users define tasks via a Kanban interface, and the system spawns AI coding agent processes inside the repository to execute those tasks autonomously.

### Multi-Agent Support

Formic supports multiple AI coding agents through a unified abstraction layer:

| Agent | Command | Authentication | Skills Support |
|-------|---------|----------------|----------------|
| Claude Code CLI | `claude` | `ANTHROPIC_API_KEY` | `.claude/skills/` |
| GitHub Copilot CLI | `copilot` | GitHub OAuth | `.claude/skills/` |

Both agents support the same skill format (`SKILL.md` with YAML frontmatter), enabling seamless switching between agents without workflow changes.

### v0.5.0 New Features

| Feature | Description |
|---------|-------------|
| **npm Global Install** | Install via `npm install -g @rickywo/formic` for easy global access |
| **CLI Commands** | `formic init` initializes a project, `formic start` launches the server |
| **Portable Package** | Works in any project directory without cloning the repository |

### v0.4.0 Features

| Feature | Description |
|---------|-------------|
| **Multi-Workspace Support** | Switch between project repositories without restarting the server |
| **Multiple Task Creation** | AI Task Manager can create multiple tasks in a single response |
| **GitHub Copilot Integration** | Full AI Task Manager support for GitHub Copilot CLI |
| **Stall Detection** | Automatic task completion when stuck on manual testing subtasks |
| **Improved UI/UX** | Better workspace input visibility, fixed panel layouts |

### v0.3.0 Features

| Feature | Description |
|---------|-------------|
| **Progressive Web App (PWA)** | Full offline-capable PWA with mobile-first design, installable on any device |
| **AI Task Manager** | Conversational interface for task creation with deep codebase understanding |
| **Autonomous Queue Processing** | Continuous agent execution without manual triggers |
| **Remote Development** | Tailscale-compatible for secure remote access from anywhere |
| **Mobile-First UI** | Touch-optimized interface with responsive design |

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
| Agent | Claude Code CLI / GitHub Copilot CLI | Task execution (pluggable) |
| Deployment | Docker | Containerized environment |

### 2.2 Project Structure

**Formic Application:**
```
formic/
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
└── .formic/                 # Formic data (inside workspace)
    ├── board.json                # Project's board state
    └── tasks/
        └── t-1_implement-user-auth/
            ├── README.md         # Task specification (human-readable)
            ├── PLAN.md           # Implementation plan (human-readable)
            ├── subtasks.json     # Structured subtask list (agent source of truth)
            └── output/           # Agent output artifacts
```

> **Note:** All Formic state is stored inside the workspace. This makes each project self-contained and allows switching between projects by mounting different workspaces.

### 2.6 Task Documentation Folders

Task documentation is stored **inside the user's workspace** at `.formic/tasks/`. This allows the Claude agent to naturally discover and read the context files when exploring the codebase.

**Purpose:**

1. **Context Memory**: The agent reads README.md and PLAN.md for human-readable context, and subtasks.json for structured task tracking.

2. **Outcome Capture**: All artifacts produced by the agent (code snippets, analysis, logs) are stored in the `output/` subdirectory.

3. **Progress Tracking**: subtasks.json is updated by the agent as work progresses, providing structured visibility into completion status.

4. **Version Control**: Task documentation can be committed with the project, preserving history.

**Folder Structure:**
```
{workspace}/.formic/tasks/{task-id}_{slug}/
├── README.md        # Specification: goals, requirements, non-goals (human-readable)
├── PLAN.md          # Implementation: high-level steps overview (human-readable)
├── subtasks.json    # Structured subtask list (agent source of truth)
└── output/          # Agent-generated artifacts
    ├── analysis.md  # Research findings
    ├── diff.patch   # Code changes
    └── ...
```

**Example:** For a task "Implement User Auth" in project "bigtoy":
```
/app/workspace/bigtoy/.formic/tasks/t-1_implement-user-auth/
```

**Workflow:**
1. When a task is created, its documentation folder is initialized in the workspace
2. The agent is instructed to read `.formic/tasks/{id}_{slug}/` for context
3. During execution, the agent reads the docs and writes artifacts to the folder
4. On completion, the folder serves as a version-controlled record of what was done

### 2.7 Project Bootstrap & Development Guidelines

When Formic is first launched against a new project workspace, it performs an automatic bootstrap process to establish AI development guidelines.

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
formic/
├── templates/
│   └── development-guideline.md    # Template for guidelines

{workspace}/
├── kanban-development-guideline.md # Generated guidelines (in project root)
└── .formic/
    └── tasks/
        └── t-bootstrap_setup-guidelines/
```

**Workflow:**
```
┌─────────────────────────────────────────────────────────────┐
│  User starts Formic with workspace                      │
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

### 2.8 Skill-Based Task Documentation Workflow

Formic implements a structured 3-step workflow for task execution, ensuring comprehensive documentation before any implementation begins.

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
│  • Output: .formic/tasks/{id}_{slug}/README.md                  │
│                         ↓                                       │
│  Step 2: PLAN - Generate PLAN.md + subtasks.json                │
│  • Uses /plan skill reading the generated README.md + guidelines│
│  • Output: .formic/tasks/{id}_{slug}/PLAN.md (human-readable)   │
│  • Output: .formic/tasks/{id}_{slug}/subtasks.json (agent SOT)  │
│                         ↓                                       │
│  Step 3: EXECUTE - Iterative execution loop                     │
│  • Agent reads subtasks.json for remaining work                 │
│  • Agent implements subtasks, updates status in subtasks.json   │
│  • Loop continues until all subtasks complete (or max iterations)│
│  • Output: .formic/tasks/{id}_{slug}/output/                    │
│                         ↓                                       │
│  Task moves to REVIEW when all subtasks are complete            │
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

Skills are stored in the Formic project and copied to the workspace's `.claude/skills/` directory during workspace initialization (same timing as bootstrap detection):

```
formic/
├── skills/
│   ├── brief/
│   │   └── SKILL.md         # README.md generator
│   └── plan/
│       └── SKILL.md         # PLAN.md + subtasks.json generator

{workspace}/
└── .claude/
    └── commands/            # Copied from formic during init
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
│  1. Create .formic/ directory (if not exists)          │
│                         ↓                                   │
│  2. Copy skills to .formic/skills/ (if not exists)     │
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
1. $TASK_DOCS_PATH/PLAN.md - High-level implementation overview (human-readable)
2. $TASK_DOCS_PATH/subtasks.json - Structured subtask list (agent source of truth)

**PLAN.md Structure:**
- Phase-based implementation overview
- Key milestones and deliverables
- Human-readable summary

**subtasks.json Structure:**
{
  "version": "1.0",
  "taskId": "$TASK_ID",
  "title": "$TASK_TITLE",
  "subtasks": [
    {"id": "1", "content": "Specific actionable task", "status": "pending"},
    {"id": "2", "content": "Another actionable task", "status": "pending"}
  ]
}
```

**Task Status Extended:**
```typescript
type TaskStatus = 'todo' | 'briefing' | 'planning' | 'running' | 'review' | 'done';
type SubtaskStatus = 'pending' | 'in_progress' | 'completed';
```

**Workflow Execution:**
1. User clicks "Run" on a task in `todo` status
2. Task moves to `briefing` status, `/brief` skill executes
3. On completion, task moves to `planning` status, `/plan` skill executes
4. On completion, task moves to `running` status, iterative execution begins:
   - Agent reads subtasks.json for remaining work
   - Agent implements subtasks, updates status in subtasks.json
   - Loop continues until all subtasks complete (or max iterations reached)
5. When all subtasks complete, task moves to `review` status

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

### 2.9 Progressive Web App (PWA) Architecture

Formic is designed as a Progressive Web App, enabling installation on any device and providing a native-like experience.

**PWA Manifest Configuration:**
```json
{
  "name": "Formic - Agent Orchestration",
  "short_name": "Formic",
  "description": "Mission Control for AI coding agents",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#0d1117",
  "theme_color": "#58a6ff",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

**Service Worker Features:**
- Asset caching for offline-capable UI
- Background sync for task operations
- Push notification readiness (future)

**Mobile-First Design Principles:**
- Touch-optimized controls (minimum 44px tap targets)
- Responsive layout adapts to screen size
- Bottom navigation for thumb-friendly access
- Pull-to-refresh for board updates
- Swipe gestures for task management

**Remote Access via Tailscale:**

Formic is designed to work seamlessly with Tailscale for secure remote development:

```
┌─────────────────────────────────────────────────────────────┐
│  Mobile Device (PWA)                                        │
│  └── Tailscale VPN ──────────────────────┐                  │
│                                          ↓                  │
│                              Development Machine            │
│                              └── Formic Server (port 8000)  │
│                                  └── Claude Code / Copilot  │
└─────────────────────────────────────────────────────────────┘
```

Users can:
1. Install Tailscale on both mobile device and development machine
2. Access Formic via Tailscale IP (e.g., `http://100.x.x.x:8000`)
3. Create tasks, monitor progress, and review code from anywhere

### 2.10 AI Task Manager

The AI Task Manager provides a conversational interface for task creation, leveraging deep understanding of the repository context.

**Architecture:**
```
┌─────────────────────────────────────────────────────────────┐
│  User: "Add user profile editing"                           │
│                         ↓                                   │
│  AI Task Manager receives natural language request          │
│                         ↓                                   │
│  Analyzes repository:                                       │
│  • File structure and patterns                              │
│  • Existing components and services                         │
│  • Coding conventions (from development guidelines)         │
│  • Related existing functionality                           │
│                         ↓                                   │
│  Generates optimized task:                                  │
│  • Clear title                                              │
│  • Context-rich prompt with file references                 │
│  • Appropriate priority suggestion                          │
│                         ↓                                   │
│  Task created and queued for agent processing               │
└─────────────────────────────────────────────────────────────┘
```

**API Endpoint:**
```typescript
POST /api/chat
{
  "message": "Add user profile editing with avatar upload"
}

Response:
{
  "response": "I'll create a task for adding user profile editing...",
  "task": {
    "id": "t-15",
    "title": "Implement user profile editing with avatar upload",
    "context": "...(optimized prompt with codebase context)...",
    "priority": "medium"
  }
}
```

**Context Injection:**
The AI Task Manager automatically includes:
- Relevant file paths based on the request
- Existing patterns for similar functionality
- Project-specific guidelines from `kanban-development-guideline.md`
- API structure and data models

### 2.11 Autonomous Queue Processing

Tasks in the queue are processed automatically without manual intervention.

**Queue Processor Behavior:**
```typescript
// Configuration
QUEUE_ENABLED=true          // Enable/disable auto-processing
QUEUE_POLL_INTERVAL=5000    // Check queue every 5 seconds
MAX_CONCURRENT_TASKS=1      // Tasks running simultaneously

// Processing loop
┌─────────────────────────────────────────────────────────────┐
│  Queue Processor (background service)                       │
│                         ↓                                   │
│  Check: Any tasks in 'queued' status?                       │
│         ↓ YES                    ↓ NO                       │
│  Check: Running tasks < MAX_CONCURRENT?                     │
│         ↓ YES                    ↓ NO                       │
│  Dequeue highest priority task (FIFO within priority)       │
│         ↓                        Wait for slot              │
│  Start workflow: Brief → Plan → Execute                     │
│         ↓                                                   │
│  On completion: Move to 'review'                            │
│         ↓                                                   │
│  Loop continues...                                          │
└─────────────────────────────────────────────────────────────┘
```

**Priority Ordering:**
1. `high` priority tasks (oldest first)
2. `medium` priority tasks (oldest first)
3. `low` priority tasks (oldest first)

**WebSocket Notifications:**
The queue processor broadcasts status updates to all connected clients:
```typescript
// Board update notification
{ "type": "board_updated", "reason": "task_started", "taskId": "t-15" }
{ "type": "board_updated", "reason": "task_completed", "taskId": "t-15" }
```

### 2.12 Multi-Workspace Management

Formic v0.4.0 introduces the ability to switch between project workspaces without restarting the server.

**Architecture:**
```
┌─────────────────────────────────────────────────────────────┐
│  Workspace Switcher (UI Header)                             │
│                         ↓                                   │
│  POST /api/workspace/switch { path: "/path/to/project" }    │
│                         ↓                                   │
│  Validation:                                                │
│  • Path exists and is absolute                              │
│  • Directory is writable                                    │
│  • Create .formic/ if not present                           │
│                         ↓                                   │
│  Update runtime WORKSPACE_PATH                              │
│                         ↓                                   │
│  Broadcast workspace_changed to all WebSocket clients       │
│                         ↓                                   │
│  Clients reload board from new workspace                    │
└─────────────────────────────────────────────────────────────┘
```

**API Endpoints:**

| Endpoint | Description |
|----------|-------------|
| `POST /api/workspace/validate` | Validate a path before switching |
| `GET /api/workspace/info` | Get current workspace metadata |
| `POST /api/workspace/switch` | Switch to a different workspace |

**Workspace Info Response:**
```typescript
interface WorkspaceInfo {
  path: string;           // Absolute path to workspace
  projectName: string;    // Directory basename
  taskCounts: TaskCounts; // Tasks by status
  formicInitialized: boolean; // Has .formic/ directory
  lastActivity: string | null; // ISO timestamp
}
```

**WebSocket Notification:**
```typescript
// Broadcast to all clients on workspace change
{ "type": "workspace_changed", "path": "/new/workspace/path" }
```

### 2.13 CLI Interface

Formic v0.5.0 introduces a CLI for easy installation and usage via npm.

**Installation:**
```bash
npm install -g @rickywo/formic
```

**CLI Commands:**

| Command | Description |
|---------|-------------|
| `formic init` | Initialize Formic in the current directory (creates `.formic/`) |
| `formic start` | Start the Formic server on default port (8000) |
| `formic start --port <n>` | Start server on custom port |
| `formic --help` | Show help message |
| `formic --version` | Show version number |

**Architecture:**
```
┌─────────────────────────────────────────────────────────────┐
│  $ formic init                                              │
│                         ↓                                   │
│  Creates .formic/ directory with:                           │
│  ├── board.json (empty board)                               │
│  └── tasks/ (empty directory)                               │
│                                                             │
│  $ formic start                                             │
│                         ↓                                   │
│  1. Loads .env file from workspace (if exists)              │
│  2. Validates .formic/ directory exists                     │
│  3. Calls startServer({ port, workspacePath })              │
│  4. Server starts at http://localhost:8000                  │
└─────────────────────────────────────────────────────────────┘
```

**Environment Variables:**

The CLI automatically loads environment variables from a `.env` file in the workspace directory:

```bash
# .env file in your project
ANTHROPIC_API_KEY=your-api-key
AGENT_TYPE=claude
PORT=8000
```

**Programmatic Usage:**

The server can also be started programmatically:

```typescript
import { startServer } from '@rickywo/formic';

await startServer({
  port: 3000,
  host: '0.0.0.0',
  workspacePath: '/path/to/project'
});
```

### 2.14 Agent Abstraction Layer

Formic implements a pluggable agent system that supports multiple AI coding assistants through a unified interface.

**Agent Configuration:**

```typescript
interface AgentConfig {
  command: string;           // CLI command (e.g., 'claude', 'copilot')
  buildArgs: (prompt: string) => string[];  // Build CLI arguments
  skillsDir: string;         // Skills directory path
  envVars: Record<string, string>;  // Required environment variables
}

const AGENTS: Record<string, AgentConfig> = {
  claude: {
    command: 'claude',
    buildArgs: (prompt) => ['--print', '--dangerously-skip-permissions', prompt],
    skillsDir: '.claude/skills',
    envVars: { ANTHROPIC_API_KEY: '...' }
  },
  copilot: {
    command: 'copilot',
    buildArgs: (prompt) => ['--prompt', prompt, '--allow-all-tools'],
    skillsDir: '.claude/skills',
    envVars: {}  // Uses GitHub OAuth
  }
};
```

**Environment Variables:**

| Variable | Description | Default |
|----------|-------------|---------|
| `AGENT_COMMAND` | CLI command to execute | `claude` |
| `AGENT_TYPE` | Agent type for flag selection | `claude` |

**Skill Compatibility:**

Both agents support the same skill format (`.claude/skills/{skill-name}/SKILL.md`):

```yaml
---
name: plan
description: Generates implementation plan for a Formic task.
---

# Skill instructions here...
```

The `name` field is required for GitHub Copilot CLI compatibility. Both agents load skills from the `.claude/skills/` directory.

### 2.15 Container Strategy

Single Node.js container serving both API and static frontend. The container requires the configured agent CLI installed globally (Claude Code or GitHub Copilot CLI).

### 2.16 Volume Requirements

| Volume | Container Path | Purpose |
|--------|----------------|---------|
| Workspace | `/app/workspace` | User's project (includes `.formic/` with board state and task docs) |

**Single Volume Design:** All state is stored inside the workspace at `.formic/`. This eliminates the need for a separate data volume and makes projects fully portable.

**Multi-Project Usage:**
```bash
# Work on bigtoy - loads bigtoy's board and tasks
docker run -p 8000:8000 -v /Users/me/bigtoy:/app/workspace formic

# Work on webapp - loads webapp's board and tasks
docker run -p 8000:8000 -v /Users/me/webapp:/app/workspace formic
```

---

## 3. Data Schema

### 3.1 Board Structure (`{workspace}/.formic/board.json`)

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
      "docsPath": ".formic/tasks/t-1_implement-user-auth",
      "agentLogs": [],
      "pid": null
    }
  ]
}
```

> **Note:** Both `board.json` and task documentation folders are stored inside the workspace at `.formic/`. The full path for the board would be `{workspace}/.formic/board.json` and for task docs `{workspace}/.formic/tasks/t-1_implement-user-auth/`

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
| `README.md` | Task specification (goals, requirements, non-goals) - human-readable |
| `PLAN.md` | High-level implementation overview - human-readable |
| `subtasks.json` | Structured subtask list - agent source of truth |
| `output/` | Directory for agent-generated artifacts |

### 3.4 Subtasks Schema (`subtasks.json`)

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

| Field | Type | Description |
|-------|------|-------------|
| `version` | string | Schema version for future compatibility |
| `taskId` | string | Reference to parent task ID |
| `title` | string | Task title for context |
| `createdAt` | ISO 8601 | When subtasks were generated |
| `updatedAt` | ISO 8601 | Last modification timestamp |
| `subtasks` | array | List of subtask objects |
| `subtasks[].id` | string | Unique subtask identifier |
| `subtasks[].content` | string | Actionable description of the subtask |
| `subtasks[].status` | enum | One of: `pending`, `in_progress`, `completed` |
| `subtasks[].completedAt` | ISO 8601 | When subtask was completed (optional) |

### 3.5 Field Definitions

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
| `docsPath` | string | Path to task documentation folder relative to workspace (format: `.formic/tasks/{id}_{slug}`) |
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
claude --print "First, read the task context from .formic/tasks/t-1_implement-user-auth/ (README.md, PLAN.md, CHECKLIST.md). Then execute: Implement User Auth. Write any outputs to .formic/tasks/t-1_implement-user-auth/output/"
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

### 5.2 AI Task Manager Endpoint

| Method | Path | Description | Request Body | Response |
|--------|------|-------------|--------------|----------|
| POST | `/api/chat` | Create task via conversation | `{message: string}` | `{response: string, task?: Task}` |

**Request Example:**
```json
{
  "message": "Add a dark mode toggle to the settings page"
}
```

**Response Example:**
```json
{
  "response": "I'll create a task for adding a dark mode toggle to the settings page. Based on the codebase, I see you're using Tailwind CSS and have a Settings component at src/components/Settings.tsx.",
  "task": {
    "id": "t-16",
    "title": "Add dark mode toggle to settings page",
    "context": "Add a dark mode toggle switch to the Settings component...",
    "priority": "medium",
    "status": "queued"
  }
}
```

### 5.3 Workspace Endpoints

| Method | Path | Description | Request Body | Response |
|--------|------|-------------|--------------|----------|
| POST | `/api/workspace/validate` | Validate a workspace path | `{path: string}` | `WorkspaceValidation` |
| GET | `/api/workspace/info` | Get current workspace metadata | - | `WorkspaceInfo` |
| POST | `/api/workspace/switch` | Switch to a different workspace | `{path: string}` | `{success: boolean, workspace: {...}}` |

### 5.4 WebSocket Endpoints

| Path | Purpose | Message Format |
|------|---------|----------------|
| `/ws/logs/:taskId` | Stream agent output | `{type: "stdout" \| "stderr", data: string}` |
| `/ws/board` | Board update notifications | `{type: "board_updated", reason: string, taskId?: string}` |

### 5.5 Static Files

| Path | Serves |
|------|--------|
| `/` | `src/client/index.html` |
| `/static/*` | Static assets (CSS, JS if separated) |
| `/manifest.json` | PWA manifest |
| `/sw.js` | Service worker |
| `/icons/*` | PWA app icons |

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
  formic:
    build: .
    ports:
      - "8000:8000"
    volumes:
      - /path/to/your/project:/app/workspace  # Single volume - all state in .formic/
    environment:
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
```

> **Note:** Only one volume mount is required. The board state and task documentation are stored inside the workspace at `.formic/`.

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
- [x] Create Formic-specific `/brief` skill for README.md generation
- [x] Create Formic-specific `/plan` skill for PLAN.md and subtasks.json generation
- [x] Implement 3-step task execution workflow:
  - Step 1: Generate README.md using `/brief` skill
  - Step 2: Generate PLAN.md and subtasks.json using `/plan` skill
  - Step 3: Execute task with full documentation context
- [x] Bundle skills in `skills/` directory within Formic
- [x] Update runner service to orchestrate the 3-step workflow
- [x] Add workflow status indicators to frontend (Brief → Plan → Execute)
- [x] Allow manual trigger of individual workflow steps
- [x] Handle workflow interruption and stop

### Phase 9: Structured Subtask Management & Iterative Execution ✅
- [x] Replace CHECKLIST.md with subtasks.json as agent source of truth
- [x] Update `/plan` skill to generate PLAN.md (human-readable) + subtasks.json (structured)
- [x] Create `subtasks.ts` service for subtask management:
  - Parse and validate subtasks.json
  - Calculate completion percentage
  - Check if all subtasks are complete
- [x] Implement iterative execution loop (Ralph Wiggum style):
  - Agent reads subtasks.json for remaining work
  - Agent updates subtask status as it progresses
  - Loop continues until all subtasks complete or max iterations reached
  - Provide feedback on incomplete items between iterations
- [x] Add subtask API endpoints:
  - GET `/api/tasks/:id/subtasks` - Get subtasks
  - PUT `/api/tasks/:id/subtasks/:subtaskId` - Update subtask status
  - GET `/api/tasks/:id/subtasks/completion` - Get completion percentage
- [x] Update frontend to display subtask progress
- [x] Remove CHECKLIST.md template and related code

### Phase 10: Multi-Agent Support ✅
- [x] Create agent abstraction layer (`agentAdapter.ts`):
  - Define `AgentConfig` interface
  - Implement agent-specific CLI flag builders
  - Support Claude Code and GitHub Copilot CLI
- [x] Update skill files for cross-agent compatibility:
  - Add `name` field to SKILL.md frontmatter
  - Change skills directory from `.claude/commands/` to `.claude/skills/`
- [x] Update workflow services:
  - `workflow.ts`: Use agent adapter for process spawning
  - `runner.ts`: Use agent adapter for process spawning
- [x] Update path utilities:
  - `paths.ts`: Change to `.claude/skills/` directory
  - `skills.ts`: Update skill copying and discovery
- [x] Add environment variable support:
  - `AGENT_TYPE`: Select agent type (`claude` or `copilot`)
  - Document authentication requirements per agent
- [x] Update documentation:
  - README.md: Multi-agent setup instructions
  - SPEC.md: Agent abstraction architecture
- [x] Test with both agents:
  - Verify skill loading works with both CLIs
  - Verify workflow execution completes successfully
  - Verify output parsing is agent-agnostic

### Phase 11: Progressive Web App (PWA) ✅
- [x] Create PWA manifest (`manifest.json`)
- [x] Implement service worker for asset caching
- [x] Add mobile-first responsive design
- [x] Optimize touch interactions (44px+ tap targets)
- [x] Add app icons for all platforms (iOS, Android, desktop)
- [x] Implement pull-to-refresh for board updates
- [x] Add bottom navigation for mobile
- [x] Test installation on iOS, Android, and desktop

### Phase 12: AI Task Manager ✅
- [x] Create chat API endpoint (`POST /api/chat`)
- [x] Implement repository context analysis
- [x] Build prompt optimization engine
- [x] Create chat UI component (mobile-first)
- [x] Integrate with task creation flow
- [x] Add conversation history (session-based)
- [x] Test with various natural language inputs

### Phase 13: Autonomous Queue Processing ✅
- [x] Implement queue processor background service
- [x] Add priority-based task ordering
- [x] Create WebSocket notifications for queue events
- [x] Add queue position display on task cards
- [x] Implement automatic task pickup on completion
- [x] Add configuration options (poll interval, concurrency)
- [x] Test continuous processing workflow

### Phase 14: Remote Development Support ✅
- [x] Validate Tailscale compatibility
- [x] Add network-agnostic WebSocket connections
- [x] Optimize for high-latency connections
- [x] Document remote access setup
- [x] Test mobile-to-desktop workflow

### Phase 15: Multi-Workspace Management ✅
- [x] Create workspace routes (`/api/workspace/*`)
- [x] Implement path validation service
- [x] Add runtime workspace switching
- [x] Create WebSocket workspace_changed notification
- [x] Build workspace switcher UI component
- [x] Auto-initialize .formic/ for new workspaces
- [x] Display workspace info (task counts, last activity)
- [x] Test workspace switching without server restart

### Phase 16: AI Task Manager Improvements ✅
- [x] Support multiple task creation in single response
- [x] Fix GitHub Copilot CLI integration
- [x] Add output parser for Copilot XML filtering
- [x] Implement stall detection for manual testing subtasks
- [x] Add 'skipped' status for non-automatable subtasks
- [x] Improve UI visibility (workspace input, panel layouts)

### Phase 17: npm Package & CLI ✅
- [x] Create CLI entry point (`src/cli/index.ts`)
- [x] Implement `formic init` command to initialize projects
- [x] Implement `formic start` command to launch server
- [x] Add `--port` flag for custom port configuration
- [x] Export `startServer()` function for programmatic use
- [x] Centralize path resolution for global npm installs
- [x] Add `ServerOptions` type for CLI configuration
- [x] Prepare `package.json` for npm publishing:
  - Add `bin` entry for CLI command
  - Add `files` array for package contents
  - Remove `private: true` flag
  - Add npm metadata (keywords, repository, homepage)
- [x] Publish to npm as `@rickywo/formic`
- [x] Add MIT LICENSE file

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

## 10. Future Considerations (v1.0+)

- Task dependencies and workflows
- Multiple project support (project switcher)
- Agent conversation history persistence
- Git integration (auto-commit, branch per task)
- Custom agent configurations
- Cloud deployment option with authentication
- Push notifications for task completion
- Team collaboration (multiple users, permissions)
- Voice input for task creation
- Offline task queue (sync when online)
