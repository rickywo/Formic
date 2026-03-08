<p align="center">
<img src="images/formic.png" alt="Formic logo" width="360">
</p>

<p align="center">
<a href="https://www.npmjs.com/package/@rickywo/formic"><img src="https://img.shields.io/npm/v/@rickywo/formic?style=flat-square&logo=npm&color=CB3837" alt="npm"></a>
<img src="https://img.shields.io/badge/Node-20%2B-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js 20+">
<img src="https://img.shields.io/badge/Agents-Claude%20Code%20CLI%20%7C%20GitHub%20Copilot%20CLI-6f42c1?style=flat-square" alt="Supported agents">
<a href="https://www.google.com/search?q=LICENSE"><img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="MIT License"></a>
</p>

# Formic - AGI-First Kanban for Autonomous Software Engineering

Formic turns your repository into a self-organizing AI software team. Goals become decomposed task graphs (DAGs), agents coordinate through file leases, and a persistent memory system ensures your team learns from every mistake.

Formic is a local-first operating system for AI agents. It orchestrates Claude Code CLI or GitHub Copilot CLI on your machine, providing the management layer required for truly autonomous development.

## 🚀 Why Formic?

Most AI coding tools stop at conversation. Formic builds the infrastructure for autonomy:

- **🧠 Goal-Driven Architecture**: High-level objectives are automatically decomposed into dependency-aware task graphs.
- **⚡ Industrial Concurrency**: Safely run multiple agents in parallel with an exclusive/shared file lease system.
- **♻️ Self-Healing Loops**: Built-in verifier and critic loops that automatically detect errors and create high-priority fix tasks.
- **💾 Persistent Memory**: A reflection system that captures "lessons learned," ensuring agents don't fall into the same pitfall twice.

```
Goal task     -> architect -> child tasks (queued + blocked DAG)
Standard task -> brief -> plan -> declare -> execute -> verify -> review
Quick task    -> execute -> verify -> review
```

## Key Features

### 🎯 Objective-Based Planning (DAG)

Switch to **Objective Mode** to input high-level goals. Formic's **architect skill** breaks goals into 3-8 child tasks, detecting dependencies using Kahn’s Algorithm. Prerequisite tasks are queued immediately, while dependent tasks remain blocked until their parents reach `done`.

### ⚡ Parallel Agent Orchestration

Formic optimizes your compute. Agents perform a **declare** step to identify file needs, then acquire exclusive or shared leases.

- **Conflict Management**: Shared files use optimistic collision detection via `git hash-object`.
- **Preemption**: High-priority tasks can preempt low-priority resource holders.
- **Deadlock Prevention**: Automated cycle detection in the wait-for graph ensures the queue never stalls.

### 🛡️ Bulletproof Self-Healing

Formic prioritizes project integrity.

- **Safety Net**: Creates a git safe-point commit before every execution.
- **Verifier & Critic**: When `VERIFY_COMMAND` is set, Formic runs a closed-loop verification. If tests fail, it auto-creates a "Fix" task with high priority.
- **Emergency Stop**: After repeated failures, Formic resets the workspace to the safe-point and pauses the queue for human intervention.

### 🧠 Long-Term Memory & Tool Forging

Formic evolves with your project.

- **The Hippocampus**: After every task, the agent reflects on the experience. Lessons are stored in `.formic/memory.json` and automatically injected into the context of relevant future tasks.
- **Tool Building**: Agents can "forge" their own scripts in `.formic/tools/` to automate repetitive project-specific actions, which are then made available to the entire team.

## Quick Start

### 1. Requirements

- Node.js 20+ and Git
- Claude Code CLI (authenticated) or GitHub Copilot CLI

### 2. Installation

```bash
git clone https://github.com/rickywo/Formic.git
cd Formic
npm install

# Setup your agent (Claude is recommended for AGI features)
export AGENT_TYPE=claude
export ANTHROPIC_API_KEY=your_api_key

npm run dev

# Or one liner
WORKSPACE_PATH={path_to_your_working_folder} AGENT_TYPE=copilot  PORT=8000 npm run dev
```

### 3. Your First Goal

1. Open http://localhost:8000.
2. Click the 🎯 **Create New Task** button.
3. Enter a goal: "Implement a dark mode toggle that persists to local storage."
4. Watch Formic decompose the goal, queue tasks, and start executing in parallel.

## 🛠 Configuration

| Variable | Description | Default |
| --- | --- | --- |
| `AGENT_TYPE` | `claude` or `copilot` | `claude` |
| `MAX_CONCURRENT_TASKS` | Max parallel agent slots | `1` |
| `VERIFY_COMMAND` | Command run after execution (e.g., `npm test`) | unset |
| `LEASE_DURATION_MS` | Watchdog timeout for stuck agents | `300000` |

## Visualizing the AGI in Action

### Demo — Full Workflow

Goal creation → architect decomposition → lease-aware parallel execution → verification → self-healing recovery.

![Formic demo: goal creation, DAG decomposition, parallel execution, self-healing](images/formic-demo.gif)

---

### Kanban Board

Tasks organized across TODO, QUEUED, RUNNING, VERIFYING, REVIEW and DONE. Each card shows its type, priority, and current workflow step at a glance.

![Formic kanban board with tasks in TODO and other columns](images/screenshots/screenshot-01-kanban-board.png)

### Goal Decomposition — DAG in Action

A high-level goal is submitted and the architect skill decomposes it into child tasks. The goal card moves to Review while its children are queued across the board — dependency-blocked tasks stay blocked until their prerequisites are done.

![Goal task decomposed into child tasks with GOAL badge in Review column](images/screenshots/screenshot-02-goal-decomposition.png)

### Parallel Agent Execution

Four tasks running simultaneously, each showing its current workflow stage badge (EXECUTING, BRIEFING). The status bar confirms 4 running in parallel, with a QUICK task already done.

![Formic kanban showing 4 agents running in parallel with workflow stage badges](images/screenshots/screenshot-03-parallel-execution.png)

### Self-Healing Loop — Verifier & Critic

When verification fails, Formic auto-generates a `[Fix]` QUICK HIGH task in TODO — with the exact failure context pre-filled — and re-queues the original task. The board keeps moving without human intervention.

![Self-healing: auto-generated Fix task in TODO alongside re-queued original task](images/screenshots/screenshot-04-self-healing.png)

## Contributing

Formic is built for developers who want AI agents to behave like a coordinated software team. If you're improving the platform, prioritize implementation-backed features over roadmap language.

## License

[MIT](LICENSE)
