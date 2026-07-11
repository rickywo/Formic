<p align="center">
<img src="images/formic.png" alt="Formic logo" width="360">
</p>

<p align="center">
<a href="https://www.npmjs.com/package/@rickywo/formic"><img src="https://img.shields.io/badge/npm-v0.8.0-CB3837?style=flat-square&logo=npm" alt="npm v0.8.0"></a>
<img src="https://img.shields.io/badge/Node-20%2B-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js 20+">
<img src="https://img.shields.io/badge/Agents-Claude%20Code%20%7C%20Copilot%20%7C%20OpenCode-6f42c1?style=flat-square" alt="Supported agents">
<a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="MIT License"></a>
<a href="https://rickywo.github.io/Formic/"><img src="https://img.shields.io/badge/Live%20Demo-GitHub%20Pages-blue?style=flat-square&logo=github" alt="Live Demo"></a>
</p>

**Formic — AI-powered task manager that turns goals into shipped code. Orchestrates Claude Code, Copilot CLI, and OpenCode with structured planning, parallel execution, and human review. 🐜**

<video src="https://github.com/user-attachments/assets/909773e7-d356-4485-a020-9505ff3d85ae" width="100%" controls autoplay muted loop></video>

> 📺 [Watch the demo video](video/formic-demo.mp4) if the player above doesn't load.

## Why Formic?

AI coding agents are powerful but chaotic. Without structure, they skip planning, overwrite each other's files, and lose context mid-task. Formic adds a **tech-lead layer** — every task goes through briefing, planning, and review before code ships.

- 🏗️ **Structured pipeline** — Brief → Plan → Declare → Execute → Review
- 🔀 **Parallel execution** — multiple agents work simultaneously with file-lease concurrency
- 🎯 **Goal decomposition** — describe a high-level objective, the architect AI breaks it into subtasks
- 🛡️ **Crash-resilient** — atomic saves, rolling backups, auto-recovery from corruption
- 🖥️ **100% local** — your code never leaves your machine

## Requirements

- Node.js 20+ and npm
- A supported AI agent CLI:
  - [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) — `npm install -g @anthropic-ai/claude-code`
  - [GitHub Copilot CLI](https://docs.github.com/en/copilot/using-github-copilot/using-github-copilot-in-the-command-line) — `gh extension install github/gh-copilot`
  - [OpenCode CLI](https://github.com/opencode-ai/opencode) — `npm install -g opencode`

## Getting Started

1. **Install** — `npm install -g @rickywo/formic`

2. **Start the server** — Run `PORT=8000 formic start`, then open [http://localhost:8000](http://localhost:8000).

3. **Add a workspace** — Open the workspace selector in the top-left and point it at your project repo directory.

## Supported Agents

Formic supports three AI agent backends. Switch between them from the **Kanban header** via the provider dropdown — no server restart needed. The dropdown shows which CLIs are installed and their versions.

| Agent | `AGENT_TYPE` | Auth |
|-------|-------------|------|
| Claude Code CLI | `claude` (default) | `ANTHROPIC_API_KEY` env var |
| GitHub Copilot CLI | `copilot` | `gh auth login` (GitHub OAuth) |
| OpenCode CLI | `opencode` | `opencode auth login` or provider key |

**Precedence:** UI selection > `AGENT_TYPE` env var > `claude` (default). The env var acts as a headless/startup fallback.

**OpenCode notes:**
- Install: `npm install -g opencode`
- Auth: `opencode auth login` (supports Anthropic, OpenAI, and other providers)
- Set `OPENCODE_DISABLE_AUTOUPDATE=1` in your `.env` for headless/CI stability
- ⚠️ Formic runs opencode with `--auto` (auto-approves permissions). Only run on trusted, isolated workspaces.

### Per-step model selection

Choose a model for each workflow stage and the chat assistant in **Settings → Agent Models**.
Selections are stored separately for each agent type.
**Agent default** uses the CLI's own default model.
For OpenCode, enter model IDs in `provider/model` format.

## Network Exposure & Security

By default, Formic binds to `127.0.0.1` (loopback only) and requires no authentication for local use. **Breaking change:** if you need to expose the server on your network (e.g. `HOST=0.0.0.0`), you must also set `FORMIC_AUTH_TOKEN` to a shared secret:

```
HOST=0.0.0.0 FORMIC_AUTH_TOKEN=your-secret-token formic start
```

Without a token, starting on a non-loopback host will exit immediately with an error — the API (`POST /api/tasks`, `POST /api/tools`) can execute arbitrary code in your workspace, so it must never be reachable without authentication. When a token is configured, every HTTP request and WebSocket connection must set the `Authorization` header to `Bearer`, followed by a space and the token value, or the server responds with `401 Unauthorized`.

**Recommended for remote access:** rather than exposing the port directly, use an SSH tunnel (e.g. `ssh -L 8000:localhost:8000 user@host`) and keep the server bound to loopback.

## Self-hosting Formic on its own repo

If you use Formic to develop Formic itself (workspace = the Formic repo), **do not run the server under `tsx watch` / `npm run dev`** while executing tasks that modify files under `src/server/**`. The agent's edits trigger a watch-mode restart, which recovers and re-dispatches the task on boot, creating an infinite dispatch loop. Symptoms include:

- The same task cycles through queued → briefing → running repeatedly in rapid succession
- Multiple orphaned agent CLI processes editing files concurrently
- Agent logs show repeated `queued → briefing` transitions with no preceding `running → queued`

**Instead**, build first and run the production server:

```bash
npm run build && npm start
```

Or use a separate checkout of the Formic repo as your workspace, leaving your development checkout untouched by agent edits. Formic detects self-hosting at startup and prints a warning.

## How It Works

1. **Brainstorm** — Chat with the AI Assistant to refine your idea and explore the codebase.
2. **Create a Goal** — The assistant crafts a structured task with clear requirements.
3. **Automatic decomposition** — The architect AI breaks the goal into 3–8 child subtasks.
4. **Parallel execution** — Agents execute tasks concurrently with file-lease safety (briefing → planning → declaring → running → verifying).
5. **Review & approve** — When tasks land in the Review column, inspect the changes and approve. Your feature is ready.

## What's New in v0.8.0

- 🛡️ **Crash-resilient board** — atomic saves with rolling backups and auto-recovery
- ⚡ **Smart stage skipping** — detects existing artifacts and resumes where it left off
- 📊 **Usage meter** — track agent credit consumption in real-time
- 🔄 **Resume from any step** — re-run tasks without restarting from scratch
- 🪵 **Full log replay** — reconnect and see complete task history

## License

[MIT](LICENSE)
