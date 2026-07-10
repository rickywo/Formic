# Formic × OpenCode CLI — Integration Plan & Implementation Guide

**Date:** 2026-07-10
**Target version:** `main-opencode-integration`
**Type-check baseline:** `npx tsc --noEmit` passes cleanly
**Scope:** Add [opencode CLI](https://opencode.ai/docs/cli/) as a third pluggable agent backend alongside `claude` and `copilot`.
**Primary files:** `src/server/services/agentAdapter.ts`, `outputParser.ts`, `usage.ts`, `skills.ts`, `src/server/utils/banner.ts`, `src/server/index.ts`, `src/cli/index.ts`

> ⚠️ File/line references are accurate as of writing and will drift as code changes. Re-verify each reference before editing.
> ⚠️ OpenCode CLI flags evolve quickly. Every flag/behavior below marked **[VERIFY]** must be confirmed against the installed `opencode --help` and `opencode run --help` before shipping.

---

## 1. Executive Summary

Formic already has a clean **pluggable agent abstraction** (`agentAdapter.ts`) built around an `AgentType` union and per-agent config records. Two agents ship today: `claude` (Claude Code CLI, streaming JSON) and `copilot` (GitHub Copilot CLI, plain text). Adding **opencode** means extending that same abstraction — no new architectural surface, just a third entry in each dispatch table plus an output parser.

The work is **medium effort** and cleanly decomposable. The only genuinely new concerns are (a) opencode's output format for headless runs (plain text vs. `--format json`), (b) how opencode discovers Formic's **skills** (Formic relies on the agent auto-loading `.claude/skills/`; opencode uses a different discovery mechanism), and (c) opencode's **permission model** (`--auto` instead of `--dangerously-skip-permissions`).

| # | Work item | Area | Effort | Risk |
|---|-----------|------|--------|------|
| 1 | Add `opencode` to the `AgentType` union + `AGENTS` exec config | agentAdapter | S | Low |
| 2 | Add `opencode` assistant + messaging arg builders | agentAdapter | S | Low |
| 3 | Add an opencode output parser + wire `parseAgentOutput`/`usesJsonOutput` | outputParser | M | Med |
| 4 | Skills discovery: make Formic skills visible to opencode | skills, execute prompt | M | **High** |
| 5 | Auth / env validation for opencode providers | banner, agentAdapter | S | Med |
| 6 | Usage reporting for opencode (or graceful "unknown") | usage | S | Low |
| 7 | Surface `opencode` in banner, CLI help, docs, `.env.example` | index, cli, README | S | Low |
| 8 | Tests: unit (arg builders, parser) + integration smoke run | test/ | M | Med |

Effort: **S** = < half day, **M** = half day to two days.

**Bottom line:** items 1, 2, 6, 7 are mechanical table-extensions. Items 3 (parsing), 4 (skills), and 5 (auth) carry the real risk and deserve a spike before committing to flag choices.

---

## 2. How the Agent Abstraction Works Today

Understanding the existing extension points is the whole game. There are **exactly seven** places that branch on agent identity:

| # | File | Extension point | What it controls |
|---|------|-----------------|------------------|
| 1 | `services/agentAdapter.ts` | `AgentType` union + `AGENTS` record | CLI command, exec args, skills dir, required env |
| 2 | `services/agentAdapter.ts` | `ASSISTANT_CONFIGS` record | Read-only Task-Manager mode args + output format |
| 3 | `services/agentAdapter.ts` | `buildMessagingAssistantArgs()` | Telegram/messaging assistant args |
| 4 | `services/agentAdapter.ts` | `getAgentDisplayName()` | Human-readable name in UI/banner |
| 5 | `services/outputParser.ts` | `parseAgentOutput()` + `usesJsonOutput()` | Per-agent stdout interpretation |
| 6 | `services/usage.ts` | `getUsageInfo()` (line ~158) | Rate-limit / quota reporting |
| 7 | `utils/banner.ts` | startup env/health check (line ~113) | "API key configured?" preflight |

**Consumers (do not need editing — they call the adapter):** `workflow.ts:460,983` and `runner.ts:166` (task execution spawn), `assistantManager.ts:584` (assistant WS), `messagingAI.ts:589` (Telegram), `index.ts:201` (startup log), `cli/index.ts:96` (help text).

Agent selection is entirely env-driven:
- `AGENT_TYPE` — `'claude'` (default) or `'copilot'`; resolved in `getAgentType()` (`agentAdapter.ts:121-127`).
- `AGENT_COMMAND` — optional override of the binary name (`agentAdapter.ts:137`).

This means **adding opencode is additive**: extend the union and the four dispatch tables, add one parser, and the ~six consumer sites light up automatically.

---

## 3. OpenCode CLI Reference (as used by Formic)

From https://opencode.ai/docs/cli/ — **[VERIFY]** all flags against your installed version.

### Headless execution (the core need — replaces `claude --print`)
```bash
opencode run [message..]
```
Relevant flags:
- `--model / -m <provider/model>` — e.g. `anthropic/claude-3-5-sonnet`, `openai/gpt-4o`.
- `--format <json|default>` — `json` emits a structured result; `default` is formatted text.
- `--auto` — **auto-approve permissions not explicitly denied** (the opencode analog of `--dangerously-skip-permissions` / `--allow-all-tools`).
- `--agent <name>` — select a configured agent profile.
- `--continue` / `--session <id>` / `--fork` — session continuity (maps to Formic's `supportsConversationContinue`).
- `--dir <path>` — working directory (Formic instead spawns with `cwd`, so likely unnecessary).
- `-f / --file <path>` — attach files.

### Session & server
- `opencode session list [--format json]`, `opencode session delete <id>`
- `opencode serve --port N --hostname H` + `opencode run --attach <url>` (not needed for Formic's spawn-per-task model).

### Auth & config
- Providers authenticate via `opencode auth login` **or** provider env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …). There is **no single opencode-specific key**; the required key depends on `--model`.
- Config dir override: `OPENCODE_CONFIG_DIR`. Autoupdate off: `OPENCODE_DISABLE_AUTOUPDATE=1`.

### ⚠️ Two behaviors to confirm in a spike before coding
1. **Streaming vs. batch output.** Does `opencode run` stream tokens to stdout incrementally (good for Formic's live log tail), and does `--format json` emit **line-delimited** events or a **single terminal JSON object**? Formic's Claude path relies on line-delimited stream-json. If opencode only emits one JSON blob at the end, treat it like Copilot (plain-text streaming + no `usesJsonOutput`).
2. **Permission scope of `--auto`.** Confirm `--auto` actually allows `edit` + `bash` non-interactively without prompting. If it still prompts for some permission classes, you may need an opencode `permission` config file (`.opencode/`) or a purpose-built `--agent` profile with `--mode all`.

---

## 4. Recommended Implementation Order (Phases)

```
Phase 0 — Spike (½ day, do FIRST, throwaway)
  └─ Manually run: opencode run --auto --format json "edit README.md to add a line"
     in a scratch repo. Capture: exact stdout shape, whether it prompts,
     whether edits land, and how errors surface. Decide json-vs-text parsing.

Phase 1 — Core adapter wiring (mechanical, low risk)
  ├─ Item 1: AgentType union + AGENTS['opencode']
  ├─ Item 2: ASSISTANT_CONFIGS['opencode'] + buildMessagingAssistantArgs branch
  └─ Item 4 (display): getAgentDisplayName() case

Phase 2 — Output & telemetry
  ├─ Item 3: parseOpencodeOutput() + parseAgentOutput/usesJsonOutput wiring
  └─ Item 6: usage.ts opencode branch (or graceful unknown)

Phase 3 — Skills & auth (the hard part)
  ├─ Item 4: Skills discovery for opencode
  └─ Item 5: Env validation + banner health check

Phase 4 — Surface & docs (independent)
  └─ Item 7: banner, cli help, README, .env.example

Phase 5 — Tests
  └─ Item 8: unit + integration smoke
```

---

## 5. Work Item Details

---

### Item 1 — Extend the agent type and exec config 🟢

**File:** `src/server/services/agentAdapter.ts`

1. Widen the union (line ~19):
   ```ts
   export type AgentType = 'claude' | 'copilot' | 'opencode';
   ```
2. Add the exec config to `AGENTS` (after the `copilot` entry, ~line 51):
   ```ts
   opencode: {
     command: 'opencode',
     // `run` is the headless subcommand; --auto auto-approves permissions.
     // Prompt is passed positionally as the trailing message.
     buildArgs: (prompt: string) => ['run', '--auto', prompt],
     skillsDir: '.opencode/skills', // see Item 4 — confirm opencode's discovery path
     envVars: {}, // provider-dependent; validated separately (Item 5)
   },
   ```
   - **[VERIFY]** whether a `--print`-equivalent is needed to force non-interactive mode, and whether `--format` should be added here (execution path parses via `parseAgentOutput`, so match whatever Item 3 decides).
   - Keep `envVars` empty because the required key depends on the selected model; do real validation in Item 5 (`validateAgentEnv` iterates `envVars`, so an empty map = "no hard requirement").
3. Update `getAgentType()` (line ~121) to recognize the new value:
   ```ts
   export function getAgentType(): AgentType {
     const envType = process.env.AGENT_TYPE?.toLowerCase();
     if (envType === 'copilot') return 'copilot';
     if (envType === 'opencode') return 'opencode';
     return 'claude';
   }
   ```
4. Add the display name (`getAgentDisplayName()`, line ~169):
   ```ts
   case 'opencode':
     return 'OpenCode CLI';
   ```

**Acceptance:** `AGENT_TYPE=opencode npx tsx -e "import('./src/server/services/agentAdapter.js').then(m=>console.log(m.getAgentCommand(), m.buildAgentArgs('hi')))"` prints `opencode [ 'run', '--auto', 'hi' ]`.

---

### Item 2 — Assistant & messaging arg builders 🟢

**File:** `src/server/services/agentAdapter.ts`

1. Add an `opencode` entry to `ASSISTANT_CONFIGS` (read-only Task-Manager mode, ~line 76). Because the assistant must be **read-only**, do NOT pass `--auto`; instead rely on opencode's default prompt-on-write behavior, or better, a dedicated read-only agent profile:
   ```ts
   opencode: {
     // Use --format json only if the spike proved line-delimited streaming; else null.
     outputFormat: null,
     readOnlyTools: OPENCODE_ASSISTANT_TOOLS, // define analogous to COPILOT list
     supportsConversationContinue: true, // opencode run --continue exists
     buildAssistantArgs: (prompt: string, options?: { continue?: boolean }) => {
       const args = ['run'];
       if (options?.continue) args.push('--continue');
       // No --auto → assistant cannot mutate the workspace (read-only guarantee).
       args.push(prompt);
       return args;
     },
   },
   ```
   Define the tool lists near the Copilot ones (~line 72):
   ```ts
   const OPENCODE_READONLY_TOOLS = ['read', 'glob', 'grep', 'webfetch', 'websearch'];
   const OPENCODE_ASSISTANT_TOOLS = [...OPENCODE_READONLY_TOOLS];
   const OPENCODE_MESSAGING_TOOLS = [...OPENCODE_READONLY_TOOLS];
   ```
   - **[VERIFY]** opencode's actual read-only enforcement. Its permission classes (`bash, read, edit, glob, grep, webfetch, task, todowrite, websearch, lsp, skill`) suggest you can build a restricted `--agent` profile granting only read/glob/grep/webfetch/websearch. That is the robust way to guarantee the assistant cannot write — safer than relying on absence of `--auto`.
2. Add the `opencode` branch to `buildMessagingAssistantArgs()` (~line 240), mirroring the copilot branch but with opencode syntax:
   ```ts
   if (agentType === 'opencode') {
     const args = ['run'];
     if (options?.continue) args.push('--continue');
     args.push(prompt);
     return args;
   }
   ```

**Acceptance:** `buildAssistantArgs('hi', { continue: true })` under `AGENT_TYPE=opencode` returns `['run','--continue','hi']` (no `--auto`).

---

### Item 3 — OpenCode output parser 🟡

**File:** `src/server/services/outputParser.ts`

The decision hinges on the Phase 0 spike:

- **Case A — `opencode run` streams plain text** (most likely, mirrors Copilot). Write `parseOpencodeOutput(line)` modeled on `parseCopilotOutput` (`outputParser.ts:176-214`): strip ANSI, drop spinner lines, detect any status markers opencode prints, otherwise emit `{ type: 'text', content: line + '\n' }`.
- **Case B — `--format json` emits line-delimited events.** Write `parseOpencodeJson(line)` modeled on `parseClaudeStreamJson` (`outputParser.ts:70-163`), mapping opencode's event schema (**[VERIFY]** field names) onto Formic's `OutputParseResult` (`text` / `status` / `result` / `system`). Then set `usesJsonOutput` true for opencode and add `--format json` to the exec args in Item 1.

Wire both dispatchers:
```ts
// parseAgentOutput switch (line ~263)
case 'opencode':
  return parseOpencodeOutput(line); // or parseOpencodeJson in Case B

// usesJsonOutput (line ~281)
return type === 'claude' || type === 'opencode'; // Case B only
```

If opencode emits raw tool-call XML in text (like Copilot sometimes does), reuse `cleanAgentOutput()` — extend its pattern list only if needed.

**Recommendation:** start with **Case A (plain text)**. It's strictly simpler, always works, and can be upgraded to JSON later without touching any consumer. The live log tail and final `result` capture both degrade gracefully to text.

**Acceptance:** unit test feeds representative opencode stdout lines and asserts correct `OutputParseResult` types (text vs. status vs. result).

---

### Item 4 — Skills discovery (highest-risk item) 🔴

**Problem.** Formic's workflow steps (`brief`, `plan`, `declare`, `execute`, `verify`, `architect`) are **agent skills**. Today they live in the repo's `skills/` dir and are copied into the workspace `.claude/skills/` (`services/skills.ts:55-92`), where **both Claude Code and Copilot auto-discover them** (`agentAdapter.ts` sets `skillsDir: '.claude/skills'` for both). The execute/plan prompts assume the agent can invoke a skill by name.

OpenCode has its **own** skill/agent mechanism and config directory (`.opencode/`, `OPENCODE_CONFIG_DIR`). Dropping SKILL.md files into `.claude/skills/` will **not** make them visible to opencode. This is the one place the abstraction leaks.

**Options (pick during the spike):**
1. **Translate + copy to opencode's location.** Extend `services/skills.ts` so that when `getAgentType() === 'opencode'`, it also materializes the skills into opencode's discovery path (`.opencode/skills/` or whatever `opencode --help` documents — **[VERIFY]**), converting SKILL.md frontmatter to opencode's expected format if it differs. Add an agent-aware `getWorkspaceSkillsPath()` that returns the right dir per `getAgentSkillsDir()`.
2. **Inline the skill body into the prompt.** If opencode has no equivalent auto-discovery, change the workflow templates to **embed** the relevant SKILL.md content directly in the prompt string (Formic already reads skills via `skillReader.ts`). This avoids depending on any agent-side skill loader and is the most portable — but makes prompts larger. This is likely the **safest cross-agent approach** long-term.
3. **Use opencode `agent create`.** Pre-register each Formic skill as an opencode agent profile (`opencode agent create --description ... --mode all`) and invoke with `--agent <name>`. Heavier setup, but idiomatic to opencode.

**Recommendation:** **Option 2 (inline)** for correctness and portability, gated behind `getAgentType() === 'opencode'` so the claude/copilot paths are unchanged. Verify the execute skill flow (`skills/execute/SKILL.md`, `services/skillReader.ts`, workflow prompt assembly in `workflow.ts`) still produces a valid prompt.

**Acceptance:** an opencode execution run demonstrably follows the Formic workflow (produces README.md → PLAN.md → declared-files.json → implementation) in a scratch repo, proving the skill instructions reached the agent.

---

### Item 5 — Auth & env validation 🟡

**Files:** `src/server/services/agentAdapter.ts`, `src/server/utils/banner.ts`

OpenCode needs a **provider** credential that depends on the selected model — not a fixed key. `validateAgentEnv()` (`agentAdapter.ts:185`) iterates the config's `envVars`, so an empty map means "no hard requirement," which is acceptable but unhelpful. Improve the preflight:

1. In `banner.ts` (~line 113), add an `opencode` branch to the API-key health check:
   ```ts
   } else if (info.agentType === 'opencode') {
     // opencode authenticates per-provider; surface a soft check.
     const anyKey = Boolean(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY);
     results.push(anyKey
       ? { label: 'OpenCode provider key detected', ok: true }
       : { label: 'No provider key found — run `opencode auth login`', ok: true /* warn, not fatal */ });
   }
   ```
   Keep it non-fatal: opencode may already hold credentials via `opencode auth login` (stored in its own config), so a missing env var is not necessarily an error.
2. Optionally add a `command -v opencode` existence check to the banner (mirror the copilot `gh extension` hint at `banner.ts:108`) so a missing binary is reported clearly at startup.
3. Document `OPENCODE_DISABLE_AUTOUPDATE=1` as recommended for CI/headless stability (avoids the CLI blocking on self-update mid-run).

**Acceptance:** starting Formic with `AGENT_TYPE=opencode` and no key prints a clear, non-fatal hint; with a provider key it reports OK.

---

### Item 6 — Usage reporting 🟢

**File:** `src/server/services/usage.ts` (~line 158)

`getUsageInfo()` branches on agent type to query rate-limit/quota info. OpenCode has no single unified quota (it's provider-dependent). Add a graceful branch:
```ts
if (agentType === 'copilot') {
  cachedUsage = await queryCopilotUsage();
} else if (agentType === 'opencode') {
  cachedUsage = unknownUsage(agentType); // or parse `opencode` telemetry if available
} else {
  cachedUsage = await queryClaudeUsage();
}
```
`unknownUsage()` already exists (used in the catch). This keeps the UI functional without fabricating numbers. **[VERIFY]** whether `opencode` exposes any usage/session stats worth surfacing later.

**Acceptance:** UsageInfo endpoint returns a well-formed "unknown" payload under opencode, no crash.

---

### Item 7 — Surface opencode everywhere it's named 🟢

1. **`src/cli/index.ts:96`** — update the help text:
   ```
   AGENT_TYPE        Agent CLI type: 'claude', 'copilot', or 'opencode' (default: claude)
   ```
   Add an opencode auth hint near the `ANTHROPIC_API_KEY` line.
2. **`src/server/index.ts:201`** — the startup log already prints `getAgentType()`/`getAgentCommand()`/`getAgentDisplayName()`; no change needed (lights up automatically).
3. **`.env.example`** (if present) — document `AGENT_TYPE=opencode`, `AGENT_COMMAND=opencode`, and `OPENCODE_DISABLE_AUTOUPDATE=1`.
4. **`README.md`** — add opencode to the "Supported Agents" section with install (`npm i -g opencode-ai` **[VERIFY]** package name), auth (`opencode auth login`), and the `AGENT_TYPE=opencode` switch.

**Acceptance:** `formic --help` lists opencode; README documents the switch.

---

### Item 8 — Tests 🟡

1. **Unit (`test/unit/`, `node:test`, run `npx tsx --test`):**
   - `agentAdapter`: assert `buildAgentArgs`, `buildAssistantArgs` (with/without `continue`), and `buildMessagingAssistantArgs` produce the expected opencode arrays; assert `getAgentType()` resolves `'opencode'`; assert `getAgentDisplayName()` returns `'OpenCode CLI'`.
   - `outputParser`: feed sample opencode stdout, assert `OutputParseResult` classification; assert `usesJsonOutput('opencode')` matches the chosen strategy.
2. **Integration smoke (manual / scripted):** in a scratch git repo, `AGENT_TYPE=opencode` + a trivial quick task ("add a line to README") → task reaches `review` with the edit applied and logs streamed. This is the real proof the spawn/parse/skills chain works end-to-end.
3. **Regression guard:** run the existing suite with default `AGENT_TYPE` (claude) to confirm zero behavior change — the whole design goal is additive.

**Acceptance:** new unit tests pass; `npx tsc --noEmit` clean; claude-path suites unchanged.

---

## 6. Suggested Formic Task Batch

| Order | Title | Type | Priority | Depends on |
|-------|-------|------|----------|------------|
| 0 | Spike: characterize `opencode run` output, permissions, and skill discovery | quick | high | — |
| 1 | Add opencode to AgentType union and agent exec/assistant/messaging config | standard | high | Task 0 |
| 2 | Add opencode output parser and wire parseAgentOutput/usesJsonOutput | standard | high | Task 1 |
| 3 | Make Formic skills discoverable by opencode (inline or copy strategy) | standard | high | Task 0 |
| 4 | Add opencode auth/env validation + banner health check | quick | medium | Task 1 |
| 5 | Add opencode usage reporting branch (graceful unknown) | quick | low | Task 1 |
| 6 | Surface opencode in CLI help, banner, README, .env.example | quick | low | Task 1 |
| 7 | Add opencode unit tests + integration smoke run | standard | medium | Tasks 1–3 |

**Concurrency guidance:** Tasks 1, 4, 5 all edit `agentAdapter.ts`/adjacent — the lease system serializes them; queue in order. Task 2 edits `outputParser.ts` (independent of Task 4/5). Task 3 edits `skills.ts`/templates (independent). Task 0 is a manual spike, not a code task — do it before creating the rest so flag choices are settled.

> ⚠️ **Self-hosting warning (from the earlier remediation incident):** these tasks edit `src/server/**`. Do **not** execute them while the server runs under `npm run dev` (tsx watch) on this repo, or every agent edit restarts the server and re-dispatches the task in a loop. Run via `npm run build && npm start` (or a separate checkout) while executing these tasks.

---

## 7. Verification Playbook

1. **Type check:** `npx tsc --noEmit` — must be clean (strict mode).
2. **Build:** `npm run build`.
3. **Unit tests:** `npx tsx --test test/unit/` (existing tests must keep passing; add the opencode cases).
4. **Adapter smoke:** `AGENT_TYPE=opencode npx tsx -e "..."` to print resolved command/args (no server needed).
5. **End-to-end:** in a **scratch repo** (never Formic's own tree while watching), `AGENT_TYPE=opencode` + a trivial task → confirm the task completes and edits land.
6. **Regression:** default `AGENT_TYPE` (claude) suites unchanged — `python test/run_tests.py` (with `no_proxy='*'` if a sandbox proxy is configured).
7. **Self-hosting / watch-mode safety (do before executing any task that edits `src/server/**`):** confirm the server is **not** running under `npm run dev` (tsx watch) against this repo — use `npm run build && npm start` or a separate checkout. Verify the boot-time self-host watch-mode warning (Issue 12, `REMEDIATION_PLAN.md`) appears when the workspace is Formic's own tree. This prevents the agent-edit → restart → recovery → re-dispatch loop; the in-product guard (recovery cap + orphan SIGTERM) is a backstop, not a substitute for running in built mode.
8. **Guideline conformance:** ESM imports with `.js` extensions, `node:` prefixes, no `any`, no new runtime dependencies without approval, `[ServiceName]`-prefixed logging, no empty catch blocks.

---

## 8. Open Questions to Resolve in the Spike (Phase 0)

Answer these **before** writing code — each changes a flag or a whole item:

1. Does `opencode run` stream tokens to stdout, or buffer until completion? → decides Item 3 UX.
2. Is `--format json` line-delimited (like claude stream-json) or a single terminal object? → decides `usesJsonOutput` + parser shape.
3. Does `--auto` truly allow `edit`+`bash` non-interactively, or does it still prompt? → decides whether a custom `--agent`/permission profile is required.
4. What is opencode's skill/agent discovery path and format? → decides Item 4 strategy (inline vs. copy vs. `agent create`).
5. How does a read-only assistant mode get enforced (absence of `--auto`, or an explicit restricted agent)? → decides Item 2.
6. What is the exact npm package/binary name and minimum version? → decides README install docs.

---

## 9. Out of Scope

- Replacing claude/copilot — opencode is **additive**; defaults are unchanged.
- opencode `serve`/`--attach` client-server mode — Formic's spawn-per-task model doesn't need it.
- opencode session persistence beyond `--continue` (which Formic's assistant already models via `supportsConversationContinue`).
- Multi-agent-per-board (running different agents for different tasks simultaneously) — current selection is process-global via `AGENT_TYPE`; a per-task override would be a separate, larger design.
