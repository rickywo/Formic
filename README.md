<p align="center">
<img src="images/formic.png" alt="Formic logo" width="360">
</p>

<p align="center">
<a href="https://www.npmjs.com/package/@rickywo/formic"><img src="https://img.shields.io/badge/npm-v1.0.0-CB3837?style=flat-square&logo=npm" alt="npm v1.0.0"></a>
<img src="https://img.shields.io/badge/Node-20%2B-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js 20+">
<img src="https://img.shields.io/badge/Agents-Claude%20Code%20CLI%20%7C%20GitHub%20Copilot%20CLI-6f42c1?style=flat-square" alt="Supported agents">
<a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="MIT License"></a>
<a href="https://rickywo.github.io/Formic/"><img src="https://img.shields.io/badge/Live%20Demo-GitHub%20Pages-blue?style=flat-square&logo=github" alt="Live Demo"></a>
</p>

**Formic — AI-powered Kanban that turns goals into shipped features.**

<video src="video/formic-demo.mp4" width="100%" controls autoplay muted loop></video>

> 📺 [Watch the demo video](video/formic-demo.mp4) if the player above doesn't load.

## Requirements

- Node.js 20+ and npm
- A supported AI agent CLI: [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) or [GitHub Copilot CLI](https://docs.github.com/en/copilot/using-github-copilot/using-github-copilot-in-the-command-line)

## Getting Started

1. **Install** — `npm install -g @rickywo/formic`

2. **Start the server** — Run `PORT=8000 formic start`, then open [http://localhost:8000](http://localhost:8000).

3. **Add a workspace** — Open the workspace selector in the top-left and point it at your project repo directory.

4. **Brainstorm with the AI chatbot** — Click the AI Assistant panel and describe your idea. Formic's chatbot helps you refine requirements, explore the codebase, and shape a clear objective.

5. **Create a Goal task** — When you're ready, the chatbot crafts a Goal task for you. Goals are high-level objectives that the architect AI will decompose.

6. **Automatic decomposition** — Once queued, Formic's architect skill analyzes the goal and generates multiple child subtasks, each with its own context and scope.

7. **Queued & processed** — Child tasks are automatically queued and executed by AI agents (briefing → planning → declaring → running → verifying) with full concurrency and file-lease safety.

8. **Voilà — review your new feature!** — When tasks land in the Review column, inspect the changes and approve. Your feature is ready.

## License

[MIT](LICENSE)
