<p align="center">
<img src="images/formic.png" alt="Formic logo" width="360">
</p>

<p align="center">
<a href="https://www.npmjs.com/package/@rickywo/formic"><img src="https://img.shields.io/badge/npm-v0.8.0-CB3837?style=flat-square&logo=npm" alt="npm v0.8.0"></a>
<img src="https://img.shields.io/badge/Node-20%2B-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js 20+">
<img src="https://img.shields.io/badge/Agents-Claude%20Code%20CLI%20%7C%20GitHub%20Copilot%20CLI-6f42c1?style=flat-square" alt="Supported agents">
<a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="MIT License"></a>
<a href="https://rickywo.github.io/Formic/"><img src="https://img.shields.io/badge/Live%20Demo-GitHub%20Pages-blue?style=flat-square&logo=github" alt="Live Demo"></a>
</p>

**Formic — AI-powered task manager that turns goals into shipped code. Orchestrates Claude Code & Copilot CLI with structured planning, parallel execution, and human review. 🐜**

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
- A supported AI agent CLI: [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) or [GitHub Copilot CLI](https://docs.github.com/en/copilot/using-github-copilot/using-github-copilot-in-the-command-line)

## Getting Started

1. **Install** — `npm install -g @rickywo/formic`

2. **Start the server** — Run `PORT=8000 formic start`, then open [http://localhost:8000](http://localhost:8000).

3. **Add a workspace** — Open the workspace selector in the top-left and point it at your project repo directory.

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
