<p align="center">
  <img src="images/formic.png" alt="Formic Logo" width="400">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@rickywo/formic"><img src="https://img.shields.io/npm/v/@rickywo/formic?style=flat-square&logo=npm&color=CB3837" alt="npm"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/PWA-Ready-5A0FC8?style=flat-square&logo=pwa" alt="PWA Ready">
  <img src="https://img.shields.io/badge/Built%20with-Claude-blueviolet?style=flat-square" alt="Built with Claude">
</p>

Get a fully automated, local-first AI coding agent in less than 30 seconds (seriously).

Formic is a zero-config **Command Center** that sits natively on top of your codebase. It drives the official [`@anthropic-ai/claude-code`](https://docs.anthropic.com/en/docs/claude-code) or [GitHub Copilot CLI](https://githubnext.com/projects/copilot-cli/) directly on your local machine, giving you an automated task queue, a mobile UI, and Telegram/LINE integration.

Stop copy-pasting code. Define the task, queue it up, and let the agent do the labor.

---

## Quick Start

You don't need to clone this repository. Just open your terminal in any project folder and run:

```bash
npx formic@latest start
```

This automatically launches the Formic backend and opens the dashboard at `http://localhost:8000`.

<!-- TODO: Add GIF showing npx start -->

### Requirements

- **Node.js 20+**
- The official **Claude Code CLI** OR **GitHub Copilot CLI** authenticated on your machine

No Docker or complex setup required. Formic uses your native environment.

### Global Install (Optional)

```bash
npm install -g @rickywo/formic

cd your-project
formic start
```

| Command | Description |
|---------|-------------|
| `formic start` | Start the Formic server (default: port 8000) |
| `formic start --port 3000` | Start on a custom port |
| `formic --help` | Show help and available commands |

---

## Why Formic?

- **Native Local Execution** — Runs directly in your environment. No Docker containers or volume mounts. Instant access to your local git, linters, and compilers.

- **Immune to API Bans** — Drives the official CLIs locally. Your code never leaves your machine, and your access won't get revoked.

- **Automated Task Queue** — Stack 10 tasks in the board. The agent runs them sequentially without human intervention.

- **Mobile Tactical View** — Connect via your phone (PWA). Add tasks and watch terminal logs stream live while away from your desk.

- **Text Your Codebase** — Natively integrates with Telegram and LINE. Text your repo to queue up a refactor while at the gym.

- **Multi-Workspace** — Manage your frontend, backend, and mobile repositories from a single dashboard.

---

## How It Works

```
You: "Add dark mode"
      ↓
Formic: Queue task → Generate spec (README.md) → Create plan (PLAN.md + subtasks.json)
      ↓
Agent: Implements all subtasks autonomously
      ↓
You: Review, approve, ship
```

1. **Create a task** — Describe what you want in plain English
2. **Run or Queue** — Click **Run** for immediate execution, or **Queue** to add to the priority queue
3. **Review & ship** — Agent moves completed work to Review for your approval

No prompt engineering. No context management. No babysitting.

---

## Features

| Feature | Description |
|---------|-------------|
| **Kanban Board** | Drag-and-drop task management across todo, queued, running, review, done |
| **Priority Queue** | High → medium → low ordering with configurable concurrency |
| **AI Task Manager** | Chat with AI to create tasks — it understands your codebase |
| **Live Terminal** | Real-time agent output streaming via WebSocket |
| **Auto-Documentation** | Every task gets README.md, PLAN.md, and structured subtasks |
| **Quick Tasks** | Skip brief/plan steps for simple one-off tasks |
| **PWA Ready** | Install on any device — mobile, tablet, desktop |
| **Multi-Agent** | Switch between Claude Code CLI and GitHub Copilot CLI |
| **Messaging Integration** | Create and manage tasks from Telegram or LINE |
| **Multi-Workspace** | Switch between projects without restarting |
| **Theme Support** | Dark, light, and auto modes |
| **Remote Access** | Use with Tailscale for secure remote development |

---

## Supported Agents

| Agent | Command | Auth |
|-------|---------|------|
| **Claude Code CLI** | `claude` | `ANTHROPIC_API_KEY` |
| **GitHub Copilot CLI** | `copilot` | GitHub OAuth |

```bash
# Claude (default)
export AGENT_TYPE=claude

# GitHub Copilot
export AGENT_TYPE=copilot
```

---

## Texting Your Repo

Want to dispatch agents from your phone using Telegram or LINE?

1. Open the Formic Dashboard settings
2. Paste your Telegram Bot Token (or LINE credentials)
3. Formic automatically handles the local webhook tunneling

You can now text tasks directly to your codebase.

> For secure mobile browser access without exposing ports, we recommend running Formic over [Tailscale](https://tailscale.com).

See the full setup guide: [Messaging Integration Guide](docs/MESSAGING_INTEGRATION_GUIDE.md)

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `8000` |
| `HOST` | Server hostname | `0.0.0.0` |
| `WORKSPACE_PATH` | Project directory | `./workspace` |
| `AGENT_TYPE` | Agent to use (`claude` or `copilot`) | `claude` |
| `AGENT_COMMAND` | Override agent CLI command | (derived from AGENT_TYPE) |
| `QUEUE_POLL_INTERVAL` | Queue polling interval (ms) | `5000` |
| `MAX_CONCURRENT_TASKS` | Max simultaneous running tasks | `1` |
| `MAX_EXECUTE_ITERATIONS` | Max execute loop iterations | `5` |
| `STEP_TIMEOUT_MS` | Timeout per workflow step (ms) | `600000` |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot API token | (disabled) |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE channel access token | (disabled) |
| `LINE_CHANNEL_SECRET` | LINE channel secret | (disabled) |

---

## Documentation

| Document | Description |
|----------|-------------|
| [Messaging Integration Guide](docs/MESSAGING_INTEGRATION_GUIDE.md) | Set up Telegram and LINE bot integration |
| [NPM Publish Guide](docs/NPM_PUBLISH_GUIDE.md) | Publishing Formic to npm |
| [API Specification](SPEC.md) | Full REST API reference |
| [Explanation](EXPLANATION.md) | In-depth architecture and design overview |
| [Test Suite](test/README.md) | Running the E2E and API test suites |

### Phase Documentation (Internal)

| Phase | Description |
|-------|-------------|
| [01 — Project Foundation](docs/01_project_foundation/README.md) | Initial project setup and structure |
| [02 — Data Layer](docs/02_data_layer/README.md) | Board and task persistence |
| [03 — Agent Runner](docs/03_agent_runner/README.md) | Agent execution and process management |
| [04 — Frontend](docs/04_frontend/README.md) | Dashboard UI and client |
| [05 — Docker Deployment](docs/05_docker_deployment/README.md) | Container deployment setup |
| [07 — Project Bootstrap](docs/07_project_bootstrap/README.md) | Auto-generated project guidelines |
| [08 — Skill Workflow](docs/08_skill_workflow/README.md) | Skill prompt system |
| [09 — Subtask Management](docs/09_subtask_management/README.md) | Subtask tracking and completion |
| [10 — Multi-Agent Support](docs/10_multi_agent_support/README.md) | Claude and Copilot CLI support |
| [11 — Chat Agent Context](docs/11_chat_agent_context/README.md) | AI Task Manager chat context |

---

## Contributing

Formic is built with the "Vibe Coding" philosophy. In fact, v0.6 was built autonomously by the Formic v0.5 agent!

```bash
# Clone
git clone https://github.com/rickywo/formic.git
cd formic

# Install
npm install

# Start dev server (auto-resolves workspace from ~/.formic/config.json)
npm run dev
```

---

## License

[MIT](LICENSE)

---

<p align="center">
  <strong>Formic</strong> — Let the agents do the work.
</p>
