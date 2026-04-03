# AI Development Guidelines

## 1. Project Overview
- **Type:** Local-first agent orchestration and execution environment for AI coding tasks
- **Core Stack:** Node.js ≥ 20, TypeScript 5.5 (strict), Fastify 4.26, Vanilla JS + Tailwind CSS, Python (testing)
- **Primary Goal:** AI-powered Kanban task manager where AI agents autonomously execute tasks — briefing, planning, coding, and committing — while humans review the results
- **Module System:** ES Modules (`"type": "module"` in package.json, `NodeNext` module resolution)
- **Package:** `@rickywo/formic` v0.7.4, published as an npm CLI (`formic` binary)

## 2. Architectural Patterns
- **Service-Oriented Server:** Business logic lives in `src/server/services/` (28 service files), HTTP routes in `src/server/routes/`, WebSocket handlers in `src/server/ws/`, utilities in `src/server/utils/`, and prompt templates in `src/server/templates/`
- **File Structure:**
  - `src/server/routes/` — Fastify route plugins (`tasks.ts`, `board.ts`, `assistant.ts`, `workspace.ts`, `config.ts`, `tools.ts`, `webhooks.ts`)
  - `src/server/services/` — Core business logic (`store.ts` for persistence, `workflow.ts` for task lifecycle, `runner.ts` for agent process spawning, `queueProcessor.ts` for queue management, `leaseManager.ts` for file concurrency)
  - `src/server/ws/` — WebSocket handlers (`logs.ts` for real-time log streaming, `assistant.ts` for interactive sessions)
  - `src/server/utils/` — Helpers (`banner.ts`, `slug.ts`, `gitUtils.ts`, `paths.ts`)
  - `src/server/templates/` — Prompt templates for task steps (`task-plan.ts`, `task-readme.ts`, `task-checklist.ts`)
  - `src/client/` — Vanilla JS single-page application with Tailwind CSS (single `index.html` with embedded JS, PWA support via `manifest.json` and `sw.js`)
  - `src/cli/` — CLI entry point (`index.ts` with `start` and `init` commands)
  - `src/types/` — Shared TypeScript type definitions (`index.ts`)
  - `skills/` — Agent skill prompts (`brief/`, `plan/`, `declare/`, `execute/`, `verify/`, `architect/`) each containing a `SKILL.md`
  - `templates/` — User-facing templates (e.g., `development-guideline.md`)
  - `test/` — Python-based integration and API test suites
- **Design Patterns:**
  - Fastify plugin-based route registration
  - Service-layer separation: routes call services, services manage state
  - WebSocket for real-time log streaming and interactive assistant sessions
  - File-based persistence (JSON board state, task docs in `.formic/tasks/`)
  - Lease-based concurrency for parallel task execution (exclusive and shared file leases)
  - Event-driven internal communication via `internalEvents.ts`

## 3. Coding Standards (Strict)
- **Language:** TypeScript with `strict: true` enabled — no implicit `any`, strict null checks, strict function types. Target ES2022.
- **Module System:** Pure ES Modules only. All imports must use `.js` file extensions (even for `.ts` source files). Use `node:` prefix for Node.js built-ins (e.g., `import path from 'node:path'`). No CommonJS `require()` calls.
- **Type Imports:** Use `import type` syntax for type-only imports (e.g., `import type { Board, Task } from '../../types/index.js'`)
- **Naming Conventions:**
  - Variables and functions: `camelCase` (e.g., `createTask`, `taskId`, `workspacePath`)
  - Types, interfaces, and classes: `PascalCase` (e.g., `Task`, `TaskStatus`, `FileLease`, `LeaseRequest`)
  - Constants: `SCREAMING_SNAKE_CASE` (e.g., `DEFAULT_PORT`, `MAX_HISTORY`, `TASK_CREATE_PATTERN`)
  - Files: `camelCase.ts` (e.g., `leaseManager.ts`, `queueProcessor.ts`, `configStore.ts`)
  - Route plugin functions: `camelCase` with descriptive suffix (e.g., `boardRoutes`, `taskRoutes`)
- **Error Handling:**
  - Wrap async operations in `try/catch` blocks
  - Tag log messages with service name prefix: `[Store]`, `[Runner]`, `[Workflow]`
  - Use type guards: `err instanceof Error ? err.message : 'Unknown error'`
  - HTTP errors: `reply.status(xxx).send({ error: 'message' })`
  - Use `console.warn` for non-critical recoverable errors; `console.error` for critical failures
  - Exit the process (`process.exit(1)`) only for unrecoverable startup errors (e.g., port in use)

## 4. Preferred Libraries & Tools
- **HTTP Framework:** Fastify ^4.26.0 (plugin-based route registration)
- **Static File Serving:** @fastify/static ^7.0.0
- **WebSocket:** @fastify/websocket ^9.0.0
- **Animations:** Framer Motion ^12.35.1 (client-side)
- **Dev Runner:** tsx ^4.7.0 (TypeScript execution with watch mode)
- **Type Checking:** TypeScript ^5.5.3 (`tsc` for compilation)
- **E2E Testing:** @playwright/test ^1.58.0 (Chromium-only, sequential, `./e2e` test dir)
- **Integration Testing:** Python `unittest` + `requests` (test suites in `test/`)
- **Frontend Styling:** Tailwind CSS (CDN-loaded), Inter font, dark theme with custom CSS variables
- **Frontend Terminal:** xterm.js 5.3 (CDN-loaded) for log streaming
- **Containerization:** Docker (node:20-slim base), Docker Compose for local deployment

## 5. Development Workflow (The "Plan-Act" Loop)
1. **Analysis:** Before writing code, examine the relevant files — check existing imports, types, and patterns in the target directory. Understand how the module fits into the service architecture.
2. **Thinking:** Outline the implementation steps. For new services, follow the existing pattern: export functions from service files, register routes via Fastify plugins, emit events via `internalEvents.ts` where needed.
3. **Execution:** Implement changes incrementally. Keep services focused on a single responsibility. Follow the ESM import conventions with `.js` extensions.
4. **Verification:**
   - Run `npm run build` (or `npx tsc --noEmit` for type-check only) to verify TypeScript compiles without errors
   - Run `python test/run_tests.py` against a running server to verify API correctness
   - Run `npx playwright test` for E2E UI tests (server must be started separately)
   - Only commit code after these checks pass

## 6. Build & Test Commands
- **Start Dev Server:** `npm run dev` — runs `tsx watch src/server/index.ts` with hot reload
- **Build Production:** `npm run build` — compiles TypeScript to `dist/` via `tsc`
- **Start Production:** `npm start` — runs `node dist/server/index.js`
- **Clean Build:** `npm run clean` — removes the `dist/` directory
- **Type Check Only:** `npx tsc --noEmit` — validates types without emitting files
- **Run API Tests:** `python test/run_tests.py` — baseline integration tests (server must be running)
- **Run AGI Tests:** `python test/run_tests.py --agi` — includes AGI evolution test suites
- **Run E2E Tests:** `npx playwright test` — Playwright UI tests against `http://localhost:8000`
- **Build Demo:** `npm run build:demo` — generates static demo build
- **Docker Build:** `docker compose up --build` — builds and starts containerized instance

## 7. Forbidden Practices 🛑
- **No `any` types** — TypeScript strict mode is enabled; use proper types, generics, or `unknown` with type guards instead
- **No CommonJS** — Never use `require()` or `module.exports`. This is a pure ESM project (`"type": "module"`)
- **No missing `.js` extensions** — All relative imports must include the `.js` extension (e.g., `import { store } from './store.js'`), even though source files are `.ts`
- **No `console.log` in production code** — Use `console.warn` (non-critical) or `console.error` (critical) with `[ServiceName]` prefix for operational logging
- **No new dependencies without approval** — Do not add packages to `package.json` without explicit permission; the project intentionally minimizes its dependency footprint
- **No removing `TODO:` or `FIXME:` comments** — These are tracked markers for future work; only the original author or an explicit task should remove them
- **No implicit error swallowing** — Every `catch` block must either log the error with a `[ServiceName]` prefix or re-throw it; empty catch blocks are forbidden
- **No modifying skill prompts without a dedicated task** — Files in `skills/` are carefully tuned agent prompts; changes require their own task with testing
- **No direct file mutations in route handlers** — Routes must delegate to services; route files should only handle HTTP request/response concerns
- **No synchronous file I/O** — Always use `fs/promises` async methods; synchronous `fs` calls block the event loop
