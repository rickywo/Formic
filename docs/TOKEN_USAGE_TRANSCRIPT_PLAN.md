# Token Usage via Transcript Parsing — Implementation Plan

**Date:** 2026-07-13
**Audited version:** branch `main-token-usage` @ `2d638c3` (working tree: only `.gitignore` modified)
**Type-check status at audit:** `npx tsc --noEmit` clean; `npm test` 172/172 passing
**Scope of change:** new `src/server/services/transcriptUsage.ts`, `src/server/services/usageCollector.ts`, `src/server/services/usageStore.ts` (adapted from `main-usage-proxy`), `src/server/routes/usage.ts`, spawn/close sites in `runner.ts` / `workflow.ts`, `boardNotifier.ts`, `src/client/index.html`, types, `templates/pricing.json`, tests
**Supersedes:** `docs/TOKEN_USAGE_PROXY_PLAN.md` (branch `main-usage-proxy`) and board tasks **t-119 … t-123**

> ⚠️ File/line references are accurate as of the commit above and will drift as code changes.
> Re-verify each reference before editing. **No implementation may begin until this plan is approved.**

---

## 1. Executive Summary

Formic will attribute token usage to task cards by **parsing the transcript files
its agents already write locally** — the mechanism used by the token-monitor
project (`token-monitor/`, reviewed as reference) — instead of intercepting API
traffic through a loopback proxy. Claude Code writes one append-only JSONL
transcript per session at `~/.claude/projects/<escaped-cwd>/<sessionId>.jsonl`;
every assistant entry carries `message.model` and `message.usage`
(`input_tokens`, `output_tokens`, `cache_creation_input_tokens`,
`cache_read_input_tokens`). Because every Formic step prompt embeds
`$TASK_DOCS_PATH` (which contains the task ID), the **first user message of each
session identifies exactly which task and step it belongs to** — no proxy, no
env-var rewiring, no interception risk.

```
Task step spawn (runner.ts / workflow.ts, cwd = workspace)
  Claude Code writes ~/.claude/projects/<escaped-cwd>/<sessionId>.jsonl
        │
        ▼
usageCollector.ts (new service)
  - beginTaskRun(taskId, step) on spawn; endTaskRun(taskId) on close
  - setInterval polling while ≥1 task runs (NO chokidar — no new deps)
  - incremental JSONL reads per session file (byte offsets; logs are append-only)
  - attribution: first user line containing ".formic/tasks/<taskId>" (exact match);
    unmatched sessions (assistant chat, manual CLI use) are ignored
        │
        ▼
transcriptUsage.ts (new, pure functions)
  - defensive multi-key extraction (ported concept: token-monitor/src/shared/usage.js)
  - dedupe by sessionId + message.id (streamed entries repeat the same message)
        │
        ▼
usageStore.ts (adapted from main-usage-proxy branch)
  .formic/usage/events.ndjson (append-only) + pricing config
        │
        ▼
GET /api/usage/summary | /api/usage/tasks | /api/usage/task/:id   (Fastify)
  period windows (today / month / all-time), groupBy model|task|session,
  cache read/write splits — aggregate-on-read (ported: token-monitor docs/API.md)
        │
        ▼
boardNotifier.broadcastUsageUpdated() → WS 'usage-updated'
        │
        ▼
Kanban UI: per-card token/cost badges + usage dashboard panel (src/client/index.html)
```

### Why this replaces the proxy design

| | Proxy (t-119–t-123) | Transcript parsing (this plan) |
|---|---|---|
| Data source | Intercepted API traffic | Files agents already write |
| Failure blast radius | Proxy down ⇒ agent requests fail (fail-loud lifecycle needed) | Collector down ⇒ badges stale; agents unaffected |
| Agent coverage | Anthropic-API agents only (env rewiring per agent) | Any agent that writes local logs (Claude now; OpenCode feasible — Phase 6) |
| Extra runtime moving parts | Loopback HTTP server in request path | Background file scanner |
| Accuracy | Exact per request | Exact per message (dedupe by message id); identical totals |

---

## 2. Codebase Findings (pre-flight questions, verified)

| Anchor | Role |
|---|---|
| `src/server/services/runner.ts:239-243` | Quick-task/execute spawn: `spawn(agentCommand, agentArgs, { cwd: getWorkspacePath(), env: {...process.env} })` |
| `src/server/services/runner.ts:330-333` | Spawn confirmed → `activeProcesses.set` → status `running` (hook point for `beginTaskRun`) |
| `src/server/services/runner.ts:367-389` | `child.on('close')` handler (hook point for `endTaskRun`) |
| `src/server/services/workflow.ts:523-543` | `runWorkflowStep(taskId, step, …)` — brief/plan/execute spawns, same cwd |
| `src/server/services/workflow.ts:621+` | step close handler / `onComplete` (hook point for `endTaskRun`) |
| `src/server/services/skillReader.ts:57,130-135` | Skill prompts interpolate `$TASK_ID` and `$TASK_DOCS_PATH` (absolute path containing `.formic/tasks/<id>_slug`) |
| `src/server/services/workflow.ts:253-364` | Fallback prompts also embed `TASK_DOCS_PATH` / docsPath — **every** brief/plan/declare/execute/quick prompt carries the task ID |
| `src/server/services/workflow.ts:1107` | Reflection prompt does **NOT** embed taskId/docsPath (see flag F7) |
| `src/server/services/boardNotifier.ts:66-80` | `broadcastBoardUpdate()` pattern — typed JSON to `boardConnections`; new `broadcastUsageUpdated()` mirrors this |
| `src/server/services/internalEvents.ts` | Shared EventEmitter (`TASK_COMPLETED`, `LEASE_RELEASED`) — add `USAGE_UPDATED` to avoid circular imports |
| `src/server/routes/usage.ts` (14 lines) | Existing `GET /api/usage` = **account quota** (`claude --usage`), unrelated to per-task tokens. Keep; add subroutes (flag F2) |
| `src/server/services/usage.ts` | Account-quota service — do not touch |
| `src/server/utils/paths.ts:57,72` | `getWorkspacePath()`, `getFormicDir()` (`<workspace>/.formic`) |
| `src/client/index.html:9253` | `renderBoard()` — card DOM creation (badge insertion point) |
| `src/client/index.html:10641,11884` | WS message handlers for `board-updated` (add `usage-updated` case beside them) |
| `src/client/index.html:12043` | Existing account-quota widget fetching `/api/usage` — unrelated, leave intact |
| `~/.claude/projects/-Users-rickywo-WebstormProjects-Formic-0-9/<uuid>.jsonl` | Verified live: assistant entries have `sessionId`, `cwd`, `timestamp`, `requestId`, `message.model`, `message.usage.{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}` |
| Dir-name escaping | `/Users/rickywo/WebstormProjects/Formic-0.9` → `-Users-rickywo-WebstormProjects-Formic-0-9` (every non-alphanumeric char → `-`) |
| `~/.local/share/opencode/opencode.db` | OpenCode sessions now live in **SQLite**, not JSON files. token-monitor reads it via feature-detected `node:sqlite` (`token-monitor/src/shared/opencodeSession.js:11`) — see flag F4 |
| `main-usage-proxy` branch | +2516 lines landed (unmerged). Reusable: `src/server/services/usageStore.ts` (254 lines, transport-agnostic NDJSON store + pricing + aggregation), `templates/pricing.json`, `UsageEvent` types block, `test/unit/usageStore.test.ts`, dashboard UI diff in `index.html` (+116), `e2e/usage-dashboard.spec.ts`. NOT reusable: `src/server/proxy/*`, `agentEnv.ts`, banner/config proxy plumbing |

**Concepts ported from token-monitor** (grounded in its code, none of its code copied):
defensive multi-key extraction (`token-monitor/src/shared/usage.js:24-30` — accepts
`input`/`inputTokens`/`input_tokens`/…), dedupe-per-message, period windows with
`{key, endsAt}` (`collector.js:236`), aggregate-on-read wire contract
(`docs/API.md`), summary-numbers-only privacy principle.

---

## 3. Flags / Decisions (sign-off items)

| # | Flag | Recommendation |
|---|------|----------------|
| **F1** | **Superseded work**: t-119 (declaring), t-120–t-123 (queued) implement the proxy design; branch `main-usage-proxy` holds their output, unmerged. | Cancel/delete t-119–t-123 from the board (manual UI action or `DELETE /api/tasks/:id`). Keep `main-usage-proxy` as an unmerged **donor branch**; Phase 2 cherry-picks `usageStore.ts`, `pricing.json`, types, and store tests from it (`git show main-usage-proxy:<path>`). Do not merge it. |
| **F2** | Naming collision: `GET /api/usage` + `services/usage.ts` already exist (account quota, different feature). | Keep them untouched. New endpoints live under `/api/usage/summary`, `/api/usage/tasks`, `/api/usage/task/:id` in the same `routes/usage.ts` plugin. New services named `transcriptUsage.ts`, `usageCollector.ts`, `usageStore.ts` — no file collision. |
| **F3** | token-monitor uses chokidar; Formic forbids new deps without approval. | Poll with `setInterval` (default 15 s, `USAGE_SCAN_INTERVAL_MS` override) **only while ≥1 task is running**, plus a final scan on process close. Incremental byte-offset reads keep each tick cheap. No new dependency. |
| **F4** | OpenCode sessions are in SQLite (`opencode.db`); `node:sqlite` requires Node ≥22.5 but Formic `engines.node` is ≥20. | Defer to Phase 6 (optional): feature-detect `node:sqlite` exactly like `token-monitor/src/shared/opencodeSession.js` and degrade to "usage unavailable" on Node <22.5. No new dependency. Decide at Phase 6 time whether to ship it. |
| **F5** | Copilot agent writes no known local transcripts. | Out of scope — copilot tasks simply show no usage badge. Graceful absence, no error. |
| **F6** | The workspace transcript dir is shared with assistant chat, messaging, and the user's own manual `claude` sessions (verified: this session's transcript sits in the same dir). Time-window attribution alone would mis-attribute under `maxConcurrentTasks > 1`. | Attribution is **positive-match only**: a session is attributed iff its first user message contains `.formic/tasks/<taskId>`. Unmatched sessions are ignored. Never attribute by timing alone. |
| **F7** | The reflection prompt (`workflow.ts:1107`) contains only the task *title*, so reflection-step usage would be unattributed. | Add one line to the reflection prompt: `(Task ref: <docsPath>)` in Phase 3. One-line change; flagged because it touches a spawn prompt. |
| **F8** | Privacy: transcripts contain full prompts/outputs. | Store **numeric usage + ids only** (`UsageEvent`), never prompt text — same summary-only principle as token-monitor. |
| **F9** | Period "delta derivation" from token-monitor exists to avoid re-spawning tokscale. Formic reads its own NDJSON store directly. | Skip delta machinery. Aggregate-on-read over `events.ndjson` (single pass per request) is exact and fast at Formic's scale. Revisit only if the file exceeds ~50 MB. |

---

## 4. Phase Map & Order

| Phase | Delivers | First behavior change? |
|---|---|---|
| 1 | Pure transcript-extraction library + types + fixtures | No (dead code until Phase 3) |
| 2 | Usage store + pricing + aggregation API (adapted from donor branch) | Adds routes; no spawn-path change |
| 3 | Collector, task attribution, runner/workflow lifecycle hooks | **Yes — first change to live task execution paths** |
| 4 | WS push (`usage-updated`) server + client plumbing | Additive |
| 5 | Per-card badges + usage dashboard panel | UI only |
| 6 (optional) | OpenCode extraction via feature-detected `node:sqlite` | Additive, gated |

Run order is strict 1 → 2 → 3 → 4 → 5 (→ 6). Formic has **no dependency field**
— queue one task at a time, in ID order.

> ⚠️ **Self-hosting hazard (applies to Phases 2–4, 6):** these tasks edit
> `src/server/**`. Do not execute them with Formic running under `tsx watch` on
> this same repo (restart loop — REMEDIATION_PLAN Issue 12). Use a built server
> (`npm run build && npm start`) or a separate checkout.

---

## 5. Per-Phase Detail

### Phase 1 — Transcript extraction library (pure) + fixtures

**New file: `src/server/services/transcriptUsage.ts`**

```ts
import type { UsageEvent } from '../../types/index.js';

/** Claude Code project-dir name for a cwd: every non-alphanumeric char → '-' */
export function claudeProjectDirName(cwd: string): string;

/** Absolute transcript dir for a workspace: ~/.claude/projects/<escaped> */
export function claudeProjectDir(cwd: string, home?: string): string;

export interface TranscriptUsageRecord {
  sessionId: string;
  messageId: string | null;   // message.id — dedupe key
  requestId: string | null;
  model: string;
  timestamp: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

/**
 * Parse a chunk of JSONL transcript text. Defensive: tolerates unknown entry
 * types, missing fields, and multiple key spellings (input_tokens/inputTokens,
 * cache_creation_input_tokens/cacheCreationInputTokens, …) — ported concept
 * from token-monitor/src/shared/usage.js. Non-JSON lines are skipped silently.
 * `seen` dedupes streamed repeats: key = `${sessionId}:${messageId ?? requestId}`,
 * first occurrence wins.
 */
export function extractUsageRecords(
  jsonlChunk: string,
  sessionId: string,
  seen: Set<string>
): TranscriptUsageRecord[];

/**
 * Scan a transcript line for a Formic task marker. Returns the task ID if the
 * line is a user entry whose content contains `.formic/tasks/<taskId>` (matched
 * via /\.formic\/tasks\/(t-\d+)/), else null.
 */
export function extractTaskMarker(line: string): string | null;
```

**Modified file: `src/types/index.ts`** — append (re-verify no drift; adapt the
`UsageEvent` block from `git show main-usage-proxy:src/types/index.ts` replacing
proxy fields):

```ts
export type UsageSource = 'transcript';

export interface UsageEvent {
  id: string;                 // `${sessionId}:${messageId}`
  timestamp: string;          // from the transcript entry
  taskId: string;
  step: string;               // 'brief' | 'plan' | 'execute' | 'quick' | 'reflection'
  agentType: AgentType;
  source: UsageSource;
  sessionId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}
```

**New file: `test/fixtures/claude-transcript-basic.jsonl`** — 6–8 sanitized lines
copied from a real transcript (user line with task marker, two assistant lines
sharing one `message.id` (streamed repeat), one with cache hits, one `type:
"summary"` noise line, one malformed line).

**New file: `test/unit/transcriptUsage.test.ts`** — node:test suite covering:
dir-name escaping (incl. dots → dashes), extraction totals, dedupe on repeated
message.id, multi-key-spelling tolerance, marker extraction, malformed-line
resilience.

**Verification gate:** `npx tsc --noEmit` clean; `npm test` green including new
suite.

**Do NOT in this phase:** touch runner/workflow/routes/client; no file I/O in
`transcriptUsage.ts` beyond what tests inject (pure functions only).

---

### Phase 2 — Usage store, pricing config, aggregation API

**New file: `src/server/services/usageStore.ts`** — start from
`git show main-usage-proxy:src/server/services/usageStore.ts` (254 lines) and adapt:
- Keep: NDJSON append with `appendLock` serialization, `.formic/usage/events.ndjson`
  path via `getFormicDir()`, pricing load (`templates/pricing.json` seeded to
  `.formic/usage/pricing.json`), `GroupSummary` with `estCostUsd`/`costBasis`.
- Change: `isUsageEvent` validates the new transcript-shaped `UsageEvent`
  (drop `partial`/`latencyMs`/`agentId`; add `sessionId`/`step`/`source`).
- Add period windows (token-monitor concept): `computePeriodWindows(now)` →
  `{ today: {key, endsAt}, month: {key, endsAt} }` (local time); aggregation
  accepts `period: 'today' | 'month' | 'all'`.
- Exports: `appendUsageEvent(event)`, `readUsageEvents(filter)`,
  `summarizeUsage({period, groupBy: 'model'|'task'|'session'})`,
  `taskUsageTotals(): Promise<Record<string, GroupSummary>>`,
  `computePeriodWindows(now?: Date)`.

**New file: `templates/pricing.json`** — copy from
`git show main-usage-proxy:templates/pricing.json`; verify model ids against the
`MODEL_CATALOG` in `src/server/services/agentAdapter.ts:371-386`.

**Modified file: `src/server/routes/usage.ts`** (currently 14 lines — re-verify) —
keep `GET /api/usage` exactly as-is; register in the same plugin:
- `GET /api/usage/summary?period=today|month|all&groupBy=model|task|session` →
  `{ periodWindows, groups: Record<string, GroupSummary> }`
- `GET /api/usage/tasks` → `{ tasks: Record<taskId, GroupSummary> }` (board badges, one call)
- `GET /api/usage/task/:id` → totals + per-model + per-session breakdown
Routes delegate to `usageStore.ts` only — no fs in the route file.

**New file: `test/unit/usageStore.test.ts`** — adapt donor-branch test file to the
new event shape; add period-window boundary tests.

**New file: `test/test_usage_api.py`** — adapt from
`git show main-usage-proxy:test/test_usage_api.py`; register in `test/run_tests.py`.

**Verification gate:** `npx tsc --noEmit`; `npm test`; with a dev server running,
`python test/run_tests.py` passes and
`curl -s localhost:8000/api/usage/summary | jq .periodWindows` returns keys.

**Do NOT in this phase:** hook into runner/workflow; write any events from live
code (tests write fixtures); touch the client.

---

### Phase 3 — Collector, attribution, lifecycle wiring (first live-path change)

**New file: `src/server/services/usageCollector.ts`**

```ts
export function beginTaskRun(taskId: string, step: string): void;
export async function endTaskRun(taskId: string): Promise<void>;
export function stopUsageCollector(): void;   // for shutdown/tests
```

Internals (log prefix `[UsageCollector]`):
- Module state: `activeRuns: Map<taskId, {step, startedAt}>`;
  `sessions: Map<sessionId, {offset: number; taskId: string | null; markerChecked: boolean; seen: Set<string>}>`.
- `beginTaskRun` records the run and starts the shared `setInterval`
  (default 15 000 ms; `USAGE_SCAN_INTERVAL_MS` env override) if not running.
- Each tick: `readdir` the `claudeProjectDir(getWorkspacePath())`; for each
  `.jsonl` whose `mtimeMs ≥ min(startedAt) − 5000`, incremental-read from the
  stored byte offset (`fs.promises.open` + `read`); on first sight of a session,
  scan its opening user lines with `extractTaskMarker()` — attribute iff the
  marker matches an active (or recently ended) run's taskId; unmatched sessions
  are remembered as `taskId: null` and skipped thereafter (F6).
- Extracted records for attributed sessions → `UsageEvent`s (agentType from
  `getAgentType()`, step from the run) → `appendUsageEvent()`; then emit
  `internalEvents.emit(USAGE_UPDATED, { taskIds })`.
- `endTaskRun` performs one final scan for that task (agents flush on exit;
  a 2 s settle delay is acceptable), then drops the run; when `activeRuns` is
  empty, clear the interval.
- All fs errors caught and `console.warn`-logged; a missing transcript dir
  (copilot, F5) disables scanning silently for that tick.

**Modified file: `src/server/services/internalEvents.ts`** — add
`export const USAGE_UPDATED = 'usage-updated';`.

**Modified file: `src/server/services/runner.ts`** (re-verify lines):
- After `activeProcesses.set(taskId, child)` (~line 330): `beginTaskRun(taskId, task?.type === 'quick' ? 'quick' : 'execute');`
- In the `close` handler (~line 367), after `releaseLeases`: `await endTaskRun(taskId);`

**Modified file: `src/server/services/workflow.ts`** (re-verify lines):
- In `runWorkflowStep` after spawn (~line 543): `beginTaskRun(taskId, step);`
- In its close/`onComplete` path: `await endTaskRun(taskId);`
- Reflection prompt (~line 1107): append `\n(Task ref: ${task.docsPath})` so
  reflection sessions carry the marker (F7); wrap its run with
  `beginTaskRun(taskId, 'reflection')` / `endTaskRun`.

**New file: `test/unit/usageCollector.test.ts`** — temp-dir fixture emulating a
transcript dir (inject dir path + home via a seam, mirroring
`noDiffVerification.test.ts`'s temp-fixture pattern): attribution via marker,
ignoring unmatched sessions, incremental offset reads, dedupe across ticks.

**Verification gate:** `npx tsc --noEmit`; `npm test`; manual smoke: run one
quick task against a scratch workspace, then
`curl -s localhost:8000/api/usage/task/<id>` shows non-zero tokens and
`.formic/usage/events.ndjson` has events only for that task.

**Do NOT in this phase:** any client change; WS broadcasting (Phase 4 —
the internal event is emitted but nothing subscribes yet); OpenCode/SQLite.

---

### Phase 4 — Real-time push to the UI

**Modified file: `src/server/services/boardNotifier.ts`** — add
`broadcastUsageUpdated(taskIds: string[])` mirroring `broadcastBoardUpdate()`
(message `{ type: 'usage-updated', taskIds }`).

**Modified file:** the module that wires internal events to notifier (verify
where `TASK_COMPLETED` is subscribed — likely `queueProcessor.ts` or
`src/server/index.ts`) — subscribe `USAGE_UPDATED` → debounce 1 s →
`broadcastUsageUpdated`.

**Modified file: `src/client/index.html`** — in BOTH WS message handlers
(~lines 10641 and 11884 — re-verify): add
`else if (data.type === 'usage-updated') { refreshUsageBadges(data.taskIds); }`.
Add `refreshUsageBadges` stub that re-fetches `/api/usage/tasks` and updates a
client-side `taskUsageMap` (badge rendering itself lands in Phase 5; this phase
only proves the pipe with a `console.debug`).

**Verification gate:** `npx tsc --noEmit`; `npm test`; manual: run a quick task
with the board open — browser console logs a `usage-updated` frame within ~16 s
of agent activity.

**Do NOT in this phase:** badge/dashboard DOM work; new endpoints.

---

### Phase 5 — Kanban badges + usage dashboard panel

**Modified file: `src/client/index.html`** (all anchors re-verify):
- **Badges:** in `renderBoard()`'s card construction (~line 9253), render a
  compact badge (`⚡ 12.3k · $0.04`) from `taskUsageMap[task.id]`; tooltip shows
  input/output/cache-read/cache-write split and cache-hit % —
  `cacheRead / (input + cacheRead)`, token-monitor's cache-hit concept. No badge
  when the task has no usage (F5).
- **Dashboard panel:** a slide-over/panel modeled on the existing settings
  panel markup, opened from the header: period toggle (Today / Month / All),
  groupBy toggle (Model / Task / Session), table of `GroupSummary` rows with
  tokens, est. cost (`costBasis: 'ESTIMATED'` disclaimer), cache-hit %.
  Data from `/api/usage/summary`; refresh on `usage-updated`. Reuse layout ideas
  from the donor branch UI diff (`git show main-usage-proxy -- src/client/index.html`)
  where they fit — endpoints and field names differ.
- Wire `refreshUsageBadges` (Phase 4 stub) to actually re-render affected cards.

**New file: `e2e/usage-dashboard.spec.ts`** — adapt from
`git show main-usage-proxy:e2e/usage-dashboard.spec.ts`: seed
`.formic/usage/events.ndjson`, assert badge text and dashboard rows.

**Verification gate:** `npx tsc --noEmit`; `npm test`; `npx playwright test`
(server started separately) green including the new spec.

**Do NOT in this phase:** server-side changes beyond none; charting libraries
(tables only — a chart is a future task, F/new-dep rule).

---

### Phase 6 (OPTIONAL — decide at sign-off) — OpenCode usage via node:sqlite

**New file: `src/server/services/opencodeUsage.ts`** — feature-detect
`node:sqlite` in a try/catch exactly like
`token-monitor/src/shared/opencodeSession.js:11`; on Node <22.5 export
`isAvailable(): false` and the collector skips OpenCode silently. Read
`~/.local/share/opencode/opencode.db` **read-only**, map OpenCode session/message
usage rows to `UsageEvent`s; attribution marker: same `.formic/tasks/<id>` string
in the session's first user message text.

**Modified:** `usageCollector.ts` — when `getAgentType() === 'opencode'`, poll
`opencodeUsage.ts` instead of the Claude transcript dir.

**Verification gate:** unit tests with an in-memory/fixture DB; graceful no-op
verified under `node --version` < 22.5.

**Do NOT:** add `better-sqlite3` or any dependency; parse the DB by hand.

---

## 6. Suggested Formic Task Batch

| Order | Title | Type | Priority | Depends on | Exclusive files (main) |
|---|---|---|---|---|---|
| 1 | Add transcript usage extraction library with fixtures | standard | high | — | `src/server/services/transcriptUsage.ts`, `src/types/index.ts`, `test/unit/transcriptUsage.test.ts`, `test/fixtures/claude-transcript-basic.jsonl` |
| 2 | Add usage store, pricing config, and aggregation API | standard | high | 1 | `src/server/services/usageStore.ts`, `src/server/routes/usage.ts`, `templates/pricing.json`, `test/unit/usageStore.test.ts`, `test/test_usage_api.py` |
| 3 | Wire usage collector into runner and workflow lifecycles | standard | high | 2 | `src/server/services/usageCollector.ts`, `src/server/services/runner.ts`, `src/server/services/workflow.ts`, `src/server/services/internalEvents.ts`, `test/unit/usageCollector.test.ts` |
| 4 | Broadcast usage updates over WebSocket to the board | quick | medium | 3 | `src/server/services/boardNotifier.ts`, `src/client/index.html` |
| 5 | Render per-card token badges and usage dashboard panel | standard | medium | 4 | `src/client/index.html`, `e2e/usage-dashboard.spec.ts` |
| 6 | (Optional) Add OpenCode usage extraction via node:sqlite | standard | low | 3 | `src/server/services/opencodeUsage.ts`, `src/server/services/usageCollector.ts` |

Board housekeeping before queuing: **cancel/delete t-119–t-123** (F1).

---

## 7. Verification Playbook

Every phase: `npx tsc --noEmit` → clean; `npm test` → all green.
Server phases (2–4, 6): `python test/run_tests.py` against a running server.
UI phase (5): `npx playwright test`.
Guideline conformance on every diff: ESM imports with `.js` extensions; `node:`
prefixes; no `any` (use `unknown` + guards); `import type` for types; **no new
dependencies**; `[UsageCollector]`/`[UsageStore]`-prefixed `console.warn`/`error`;
no empty catch; `fs/promises` only; routes delegate to services.

---

## 8. Acceptance-Criteria Traceability

| Criterion | Proven by |
|---|---|
| Token usage attributed to the correct task, even with concurrent tasks | Phase 3 marker-based attribution (F6) + `usageCollector.test.ts` |
| Exact counts incl. cache read/write splits | Phase 1 extraction + dedupe tests against real-shape fixtures |
| Today / month / all-time periods with window keys | Phase 2 `computePeriodWindows` + boundary tests |
| Cost estimates per model | Phase 2 pricing config + `GroupSummary.estCostUsd` |
| Badges update in near-real-time while a task runs | Phase 3 interval scan + Phase 4 `usage-updated` push |
| Dashboard: breakdown by model/task/session + cache-hit % | Phase 5 panel + e2e spec |
| No prompt text ever persisted (privacy, F8) | `UsageEvent` shape (numbers + ids only) + store validation |
| Agents unaffected if tracking breaks | Collector is read-only/out-of-band; no spawn env changes |

---

## 9. Out of Scope

- Merging `main-usage-proxy` or any proxy/interception mechanism.
- tokscale, chokidar, Electron, hub/device sync, currency conversion, exports.
- Copilot usage (no local transcripts — graceful absence).
- Assistant-chat / messaging usage attribution (unmatched sessions ignored).
- Provider rate-limit windows ("AI Tool Limits") — existing `GET /api/usage`
  account-quota widget already covers the basic need.
- Historical backfill of tasks run before this feature lands.
- Charts/graphs (tables only in Phase 5).
