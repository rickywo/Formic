# Formic v0.5.0 - npm Global Install & CLI

**The Local-First Agent Orchestration Environment**

*Vibe Coding with autonomous agents. Your repo, your rules, their labor.*

---

## Highlights

This release introduces **npm Global Install** — install Formic once and use it in any project directory. The new CLI provides `formic init` and `formic start` commands for quick setup without cloning the repository.

**Install now:**
```bash
npm install -g @rickywo/formic
```

---

## What's New

### npm Global Install
- **Published to npm** — Install globally with `npm install -g @rickywo/formic`
- **Package name** — `@rickywo/formic` (scoped package)
- **Works anywhere** — Run in any project directory without cloning

### CLI Commands
- **`formic init`** — Initialize Formic in the current directory (creates `.formic/` with board.json)
- **`formic start`** — Start the Formic server (default: port 8000)
- **`formic start --port <n>`** — Start on a custom port
- **`formic --help`** — Show help message with all commands
- **`formic --version`** — Show version number

### Server Improvements
- **Exported `startServer()` function** — Use Formic programmatically in your own scripts
- **`ServerOptions` type** — TypeScript interface for server configuration
- **Centralized path resolution** — Works correctly for both local dev and global npm installs
- **Auto .env loading** — CLI automatically loads environment variables from workspace `.env` file

### Package Updates
- **MIT LICENSE** — Added proper license file
- **npm metadata** — Added keywords, repository, homepage, and bugs URLs
- **`bin` entry** — Registered `formic` as global CLI command
- **`files` array** — Optimized package to include only necessary files

---

## Quick Start

### npm (Recommended)
```bash
# Install globally
npm install -g @rickywo/formic

# In your project directory
cd your-project
formic init
formic start
```

Open `http://localhost:8000` and start creating tasks.

### Docker
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

---

## CLI Reference

| Command | Description |
|---------|-------------|
| `formic init` | Initialize Formic in current directory |
| `formic start` | Start server on port 8000 |
| `formic start --port 3000` | Start server on custom port |
| `formic --help` | Show help message |
| `formic --version` | Show version (0.5.0) |

### Environment Variables

Create a `.env` file in your project directory:

```bash
ANTHROPIC_API_KEY=your-api-key
AGENT_TYPE=claude
PORT=8000
```

The CLI automatically loads these when starting the server.

---

## Programmatic Usage

```typescript
import { startServer } from '@rickywo/formic';

await startServer({
  port: 3000,
  host: '0.0.0.0',
  workspacePath: '/path/to/project'
});
```

---

## Features

### Core Functionality
- **npm Global Install** — Install once, use anywhere
- **CLI Commands** — `formic init` and `formic start`
- **Multi-Workspace** — Switch between projects without restarting
- **Kanban Board** — Drag-and-drop task management
- **Priority Queue** — Smart queueing with priority-based ordering
- **Live Terminal** — Real-time agent output via WebSocket
- **3-Step Workflow** — Automated Brief → Plan → Execute pipeline
- **AI Task Manager** — Chat with AI to create optimized tasks

### Multi-Agent Support
- **Claude Code CLI** — Default agent using Anthropic API
- **GitHub Copilot CLI** — Alternative agent using GitHub OAuth

### Mobile & PWA
- **Progressive Web App** — Install on any device
- **Mobile Board View** — Tactical layout for small screens
- **Remote Access** — Use with Tailscale for secure remote development

---

## Tech Stack

| Component | Technology |
|-----------|------------|
| Runtime | Node.js 20 + TypeScript |
| Server | Fastify |
| WebSocket | @fastify/websocket |
| Frontend | Vanilla JS + Tailwind CSS |
| Terminal | xterm.js |
| PWA | Service Worker + Web App Manifest |
| Package | npm (@rickywo/formic) |

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `8000` |
| `HOST` | Server hostname | `0.0.0.0` |
| `WORKSPACE_PATH` | Project directory | Current directory |
| `AGENT_TYPE` | Agent to use (`claude` or `copilot`) | `claude` |
| `ANTHROPIC_API_KEY` | Claude API key | Required for Claude |
| `QUEUE_ENABLED` | Enable/disable queue processor | `true` |
| `QUEUE_POLL_INTERVAL` | Queue polling interval (ms) | `5000` |
| `MAX_CONCURRENT_TASKS` | Max simultaneous running tasks | `1` |
| `MAX_EXECUTE_ITERATIONS` | Max execute loop iterations | `5` |
| `STEP_TIMEOUT_MS` | Timeout per workflow step (ms) | `600000` |

---

## Commits in this Release

- `64660b8` Merge pull request #2 - Update README and SPEC for v0.5.0 npm CLI release
- `158371b` Update README and SPEC for v0.5.0 npm CLI release
- `14477d0` Merge pull request #1 - Add CLI entry point and publish to npm
- `ae5fc47` Change package name to @rickywo/formic for npm publishing
- `ddb2908` Add LICENSE and update version badge to 0.5.0
- `8d24844` Add CLI entry point and prepare for npm publishing

---

## Files Changed

| File | Change |
|------|--------|
| `package.json` | Added bin, files, npm metadata; version 0.5.0 |
| `src/cli/index.ts` | New CLI entry point |
| `src/server/index.ts` | Export `startServer()` function |
| `src/server/utils/paths.ts` | Centralized path resolution |
| `src/types/index.ts` | Added `ServerOptions` interface |
| `LICENSE` | New MIT license file |
| `README.md` | Updated with npm install instructions |
| `SPEC.md` | Added CLI documentation |

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

**Full Changelog**: https://github.com/rickywo/Formic/compare/v0.4.0...v0.5.0
