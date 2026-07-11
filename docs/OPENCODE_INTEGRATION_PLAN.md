# Formic × OpenCode CLI — Integration Plan & Implementation Guide

**Date:** 2026-07-10
**Target version:** `main-opencode-integration`
**Type-check baseline:** `npx tsc --noEmit` passes cleanly
**Scope:** Add [opencode CLI](https://opencode.ai/docs/cli/) as a third pluggable agent backend alongside `claude` and `copilot`.
**Primary files:** `src/server/services/agentAdapter.ts`, `outputParser.ts`, `usage.ts`, `skills.ts`, `src/server/utils/banner.ts`, `src/server/index.ts`, `src/cli/index.ts`

> ⚠️ File/line references are accurate as of writing and will drift as code changes. Re-verify each reference before editing.
> ✅ **Phase 0 spike completed 2026-07-10** against installed `opencode` v1.17.18 (Homebrew `anomalyco/tap/opencode`, npm package `opencode-ai`). All `[VERIFY]` tags below have been resolved — see [§10 Spike Findings](#10-spike-findings-phase-0--completed-2026-07-10) for full evidence and captured stdout samples.

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

✅ **Verified 2026-07-10** against installed `opencode` v1.17.18 (`opencode --help` / `opencode run --help`). Supersedes https://opencode.ai/docs/cli/ where they differ — the installed binary is the source of truth.

### Headless execution (the core need — replaces `claude --print`)
```bash
opencode run [message..]
```
Relevant flags (confirmed present in `opencode run --help`):
- `-m, --model <provider/model>` — e.g. `anthropic/claude-sonnet-4-6`, `openai/gpt-4o`.
- `--format <default|json>` — `json` emits **line-delimited raw JSON events** to stdout (one JSON object per line); `default` is human-formatted text. Default value is `default`. ✅ confirmed line-delimited, see §10.2.
- `--auto` — **auto-approve permissions not explicitly denied** (dangerous!) — the opencode analog of `--dangerously-skip-permissions`. Default `false`. ✅ confirmed it truly bypasses prompts for both `edit` and `bash`, see §10.3.
- `--agent <name>` — select a configured agent profile (built-in: `build`, `plan`, `general`, `explore`; or a custom `.opencode/agent/<name>.md`). This is the mechanism for read-only enforcement — see §10.5.
- `-c, --continue` / `-s, --session <id>` / `--fork` — session continuity (maps to Formic's `supportsConversationContinue`).
- `--dir <path>` — working directory (Formic instead spawns with `cwd`, so unnecessary).
- `-f, --file <path>` — attach files.
- `--command <cmd>` — run a named opencode command instead of a free-text message (not needed for Formic).
- `--title <string>` — session title (defaults to a truncated prompt).
- `-i, --interactive` — split-footer interactive mode (not applicable to Formic's headless spawn).
- `--attach <url>` / `--port` / `-p/--password` / `-u/--username` — remote-server attach mode, not needed for Formic's spawn-per-task model.
- `--variant <string>` — provider-specific reasoning effort (e.g. `high`, `max`, `minimal`).
- `--thinking` — show thinking blocks in output.

Not present in the installed CLI (do not reference in code): there is no standalone `--print` flag — `opencode run` is headless by default; the plain positional `message` is the prompt.

### Session & server
- `opencode session list [--format json]`, `opencode session delete <id>` — present under `opencode session`.
- `opencode serve --port N --hostname H` + `opencode run --attach <url>` (not needed for Formic's spawn-per-task model).

### Auth & config
- Providers authenticate via `opencode auth login` (aliased as `opencode providers`) **or** provider env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …). There is **no single opencode-specific key**; the required key depends on `--model`.
- Config dir override: `OPENCODE_CONFIG_DIR`. Autoupdate off: `OPENCODE_DISABLE_AUTOUPDATE=1`. ✅ both env vars confirmed present in the installed binary (`strings` scan of the compiled CLI).
- Project config file: `./opencode.json`, `./opencode.jsonc`, or `.opencode/opencode.json` (opencode walks up from cwd to the worktree root). Global: `~/.config/opencode/opencode.json`.

### ✅ Behaviors confirmed in the Phase 0 spike (2026-07-10) — see §10 for full evidence
1. **Streaming vs. batch output — CONFIRMED incremental/chunked**, not buffered until process exit. `--format json` emits **line-delimited events**, directly analogous to Claude's stream-json. Recommendation: **Case B (JSON)**, not Case A — see §10.2 and the updated Item 3 recommendation.
2. **Permission scope of `--auto` — CONFIRMED** it allows both `edit` and `bash` non-interactively with zero prompts. **However**, the *absence* of `--auto` does **not** fail fast — the process reads files fine but **hangs indefinitely** the moment the model attempts a write, since there is no TTY to prompt and no fallback deny. Do not rely on omitting `--auto` for read-only enforcement (see §10.5); use a restricted `--agent` profile instead.

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
     // `run` is the headless subcommand (no separate --print flag exists).
     // --auto auto-approves permissions; --format json for line-delimited parsing (Item 3, Case B).
     // Prompt is passed positionally as the trailing message.
     buildArgs: (prompt: string) => ['run', '--auto', '--format', 'json', prompt],
     skillsDir: '.claude/skills', // ✅ confirmed — opencode auto-discovers this path already; see Item 4
     envVars: {}, // provider-dependent; validated separately (Item 5)
   },
   ```
   - ✅ **Resolved:** no `--print`-equivalent is needed — `opencode run` is headless by default. `--format json` should be added to `buildArgs` because the spike confirmed line-delimited JSON output (Item 3, Case B) — matches Formic's Claude-path parsing model most closely.
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

1. Add an `opencode` entry to `ASSISTANT_CONFIGS` (read-only Task-Manager mode, ~line 76).

   ⚠️ **Do NOT rely on omitting `--auto` for read-only enforcement** — the spike confirmed this is unsafe: without `--auto`, opencode reads files fine but **hangs indefinitely** the instant the model attempts a write, because there is no TTY to answer the permission prompt and no timeout/deny fallback (see §10.5). A hung child process is worse than a denied one for a WS-backed assistant session — it leaks a process and blocks that session forever.

   Use a **dedicated restricted `--agent` profile** instead (create via `opencode agent create --path .opencode/agent --description "..." --mode primary --permissions read,glob,grep,webfetch,websearch` once during workspace setup, or ship a static `.opencode/agent/formic-readonly.md` template). With `edit`/`bash`/`task`/`todowrite` denied in the agent's `permission:` frontmatter, it is then **safe to also pass `--auto`** — `--auto` only auto-approves what isn't explicitly denied, and the deny rules win, so the model gets a clean, fast, in-band refusal (confirmed: the model self-reports "I can't modify files in this read-only environment" and exits 0 — no hang, no external process needed to enforce it):
   ```ts
   opencode: {
     outputFormat: 'json', // ✅ confirmed line-delimited — see Item 3, Case B
     readOnlyTools: OPENCODE_ASSISTANT_TOOLS, // define analogous to COPILOT list
     supportsConversationContinue: true, // opencode run --continue exists
     buildAssistantArgs: (prompt: string, options?: { continue?: boolean }) => {
       const args = ['run', '--agent', 'formic-readonly', '--auto', '--format', 'json'];
       if (options?.continue) args.push('--continue');
       args.push(prompt);
       return args;
     },
   },
   ```
   Define the tool lists near the Copilot ones (~line 72), matching the agent's `--permissions` list:
   ```ts
   const OPENCODE_READONLY_TOOLS = ['read', 'glob', 'grep', 'webfetch', 'websearch'];
   const OPENCODE_ASSISTANT_TOOLS = [...OPENCODE_READONLY_TOOLS];
   const OPENCODE_MESSAGING_TOOLS = [...OPENCODE_READONLY_TOOLS];
   ```
   The `.opencode/agent/formic-readonly.md` template (checked into the repo, materialized into the workspace alongside the `.claude/skills/` copy — see Item 4):
   ```markdown
   ---
   description: Formic read-only Task Manager assistant — answers questions, never edits.
   mode: primary
   permission:
     edit: deny
     bash: deny
     task: deny
     todowrite: deny
   ---
   You are Formic's read-only assistant. Answer questions about the codebase.
   Never edit files or run write commands.
   ```
   - ✅ **Resolved:** opencode's actual read-only enforcement is a restricted `--agent` profile with `permission: { edit: deny, bash: deny, task: deny, todowrite: deny }`. Confirmed via spike: `opencode run --agent readonly --auto --format json "<edit attempt>"` exits 0, leaves the file untouched, and the model reports the refusal in the `text` event — no hang.
2. Add the `opencode` branch to `buildMessagingAssistantArgs()` (~line 240), mirroring the copilot branch but with opencode syntax:
   ```ts
   if (agentType === 'opencode') {
     const args = ['run', '--agent', 'formic-readonly', '--auto', '--format', 'json'];
     if (options?.continue) args.push('--continue');
     args.push(prompt);
     return args;
   }
   ```

**Acceptance:** `buildAssistantArgs('hi', { continue: true })` under `AGENT_TYPE=opencode` returns `['run','--agent','formic-readonly','--auto','--format','json','--continue','hi']`.

---

### Item 3 — OpenCode output parser 🟡

**File:** `src/server/services/outputParser.ts`

✅ **Resolved by the Phase 0 spike — Case B confirmed.** `opencode run --format json` emits **line-delimited JSON**, one object per line, directly analogous to Claude's stream-json. Full captured samples are in §10.2; the schema below is drawn straight from a real run.

**Confirmed event schema** (top-level fields on every line): `type`, `timestamp` (epoch ms), `sessionID`, `part`. The top-level `type` is one of `step_start` / `text` / `tool_use` / `step_finish` (note: underscore, not the hyphenated `part.type` values `step-start` / `text` / `tool` / `step-finish` nested one level down — both are present and redundant, prefer the top-level `type` field for the switch). Mapping onto Formic's `OutputParseResult`:

| opencode `type` | opencode `part` shape | → `OutputParseResult` |
|---|---|---|
| `step_start` | `{ type: 'step-start', messageID, sessionID }` | `{ type: 'status', content: '' }` (or drop — purely structural) |
| `text` | `{ type: 'text', text, time: {start,end} }` | `{ type: 'text', content: part.text }` |
| `tool_use` | `{ type: 'tool', tool: 'read'\|'apply_patch'\|'bash'\|…, callID, state: { status: 'completed', input, output, title } }` | `{ type: 'status', content: part.state.title }` — the `output`/`metadata.diff` fields are useful for a richer status line (e.g. surfacing the unified diff for `apply_patch`) |
| `step_finish` | `{ type: 'step-finish', reason: 'tool-calls'\|'stop', tokens: {total,input,output,...}, cost }` | `{ type: 'status', content: '' }` on `reason: 'tool-calls'`; treat the **last** `step_finish` with `reason: 'stop'` as the terminal event — concatenate the `text` events since the last `tool_use` as the `result` |

Write `parseOpencodeJson(line)` modeled on `parseClaudeStreamJson` (`outputParser.ts:70-163`), switching on the top-level `type`. Sample lines are pasted in full in §10.2 for unit-test fixtures.

Wire both dispatchers:
```ts
// parseAgentOutput switch (line ~263)
case 'opencode':
  return parseOpencodeJson(line);

// usesJsonOutput (line ~281)
return type === 'claude' || type === 'opencode';
```

**Recommendation (revised from the original plan):** use **Case B (JSON)**, not Case A. The original plan defaulted to plain text on the assumption that JSON might be a single terminal blob requiring a bigger parser investment; the spike disproved that — it's already line-delimited and the event types (`step_start`/`text`/`tool_use`/`step_finish`) map cleanly onto Formic's existing Claude-parser shape with less guesswork than scraping ANSI-formatted plain text would require. `--format json` should be added to `buildArgs` in Item 1.

**Acceptance:** unit test feeds the captured lines from §10.2 and asserts correct `OutputParseResult` types (text vs. status vs. result), plus `usesJsonOutput('opencode') === true`.

---

### Item 4 — Skills discovery ✅ (spike downgraded this from 🔴 highest-risk to 🟢 near-zero-work)

**Problem (as originally framed).** Formic's workflow steps (`brief`, `plan`, `declare`, `execute`, `verify`, `architect`) are **agent skills**. Today they live in the repo's `skills/` dir and are copied into the workspace `.claude/skills/` (`services/skills.ts:55-92`), where **both Claude Code and Copilot auto-discover them** (`agentAdapter.ts` sets `skillsDir: '.claude/skills'` for both). The execute/plan prompts assume the agent can invoke a skill by name.

**✅ Spike finding: opencode already scans `.claude/skills/**/SKILL.md` natively — no new code path needed.** This was verified two ways (full evidence in §10.4):

1. **Source-level:** the compiled CLI's skill-discovery routine walks **up from `cwd` to the worktree root** looking for a `.claude/` (and separately `.agents/`) directory at each level, and — independent of that — also scans `~/.claude/skills/**/SKILL.md` and `~/.agents/skills/**/SKILL.md` at the **global/home** scope. The exact pattern matched is `skills/**/SKILL.md` under either directory, `scope: "project"` for the walked-up one and `scope: "global"` for the home one.
2. **Empirically:** a `SKILL.md` dropped at `<scratch-repo>/.claude/skills/spiketest/SKILL.md` (the same relative path Formic's `services/skills.ts` already materializes for Claude/Copilot) was picked up and listed by `opencode debug skill` with `"location": "/private/tmp/opencode-spike/.claude/skills/spiketest/SKILL.md"` alongside opencode's own built-in skills — **zero opencode-specific configuration was added**.

opencode also has its *own* native skill locations for skills authored specifically for opencode (`.opencode/skill(s)/<name>/SKILL.md` project-scope, `~/.config/opencode/skill(s)/<name>/SKILL.md` global-scope, plus arbitrary paths/URLs via the `skills.paths`/`skills.urls` config keys) — but Formic doesn't need any of that, because the `.claude/skills/` external-scan path is a first-class, intentionally-supported feature (confirmed by the escape hatches `OPENCODE_DISABLE_EXTERNAL_SKILLS=1` / `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1`, which exist specifically to let a user *opt out* of this behavior).

The `SKILL.md` **format is identical** too: YAML frontmatter with required `name` + `description`, markdown body as the skill content — no translation needed. Formic's existing files parse as-is.

**Revised options:**
1. **Do nothing (recommended).** `services/skills.ts` already copies to `<workspace>/.claude/skills/`. opencode auto-discovers that exact path with the exact SKILL.md format. `skillsDir: '.claude/skills'` (Item 1) is correct for opencode too — **identical to claude/copilot**, not a distinct `.opencode/skills` path as the original plan assumed. The only residual risk is opencode's `--auto` model *choosing* not to invoke a listed skill (a prompt-engineering/model-behavior question, not a discovery problem) — validate this in the Item 8 integration smoke test.
2. **Inline the skill body into the prompt** — no longer needed as a discovery workaround, but keep in your back pocket if the Item 8 smoke test shows the model isn't reliably invoking skills by name (a model-following-instructions issue, not a file-visibility issue).
3. **`opencode agent create`** — not needed for skills; this is opencode's mechanism for defining *agents* (used instead for the read-only assistant profile in Item 2/Item 5, not for the workflow skills).

**Acceptance:** an opencode execution run demonstrably follows the Formic workflow (produces README.md → PLAN.md → declared-files.json → implementation) in a scratch repo — same as before, but now expected to pass with **no changes to `services/skills.ts`** beyond adding `opencode` to whatever type union gates the existing copy step.

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
`unknownUsage()` already exists (used in the catch). This keeps the UI functional without fabricating numbers. ✅ **Resolved:** `opencode stats` (per-session token/cost) and `opencode export <sessionID>` exist and could be parsed later, and each `step_finish` JSON event already carries per-step `tokens: {total,input,output,reasoning,cache}` and `cost` (see §10.2 samples) — so a future enhancement could sum these across the streamed events instead of shelling out to `opencode stats`. Not needed for Item 6 itself; `unknownUsage(agentType)` remains the correct scope for this ticket.

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
4. **`README.md`** — add opencode to the "Supported Agents" section with install, auth (`opencode auth login`), and the `AGENT_TYPE=opencode` switch. ✅ **Package name confirmed:** `npm install -g opencode-ai` (npm registry has no bare `opencode` package — that name 404s; `opencode-ai` is correct and matches the installed binary's own bundled `package.json` dependency naming convention `@opencode-ai/*`). Binary name after install is `opencode`. Minimum version: this plan was validated against **v1.17.18** — pin docs to `>= 1.17.0` pending a wider compatibility sweep.

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

✅ **All six resolved 2026-07-10.** Short answers below; full evidence in [§10 Spike Findings](#10-spike-findings-phase-0--completed-2026-07-10).

1. ~~Does `opencode run` stream tokens to stdout, or buffer until completion?~~ → **Streams incrementally** (chunked writes observed while the process was still running, not a single write at exit). See §10.2.
2. ~~Is `--format json` line-delimited (like claude stream-json) or a single terminal object?~~ → **Line-delimited**, one JSON object per line, directly analogous to Claude's stream-json. See §10.2.
3. ~~Does `--auto` truly allow `edit`+`bash` non-interactively, or does it still prompt?~~ → **Yes, both**, zero prompts. But its *absence* doesn't fail closed — it hangs forever on the first write attempt in a non-interactive shell. See §10.3.
4. ~~What is opencode's skill/agent discovery path and format?~~ → It **already scans `.claude/skills/**/SKILL.md`** (both project, walking up from cwd, and global, at `~/.claude/skills/`) — the exact path Formic already populates, in the exact SKILL.md format Formic already uses. No new code path needed. See §10.4.
5. ~~How does a read-only assistant mode get enforced?~~ → **Not** by omitting `--auto` (hangs). Use a restricted `--agent <name>` profile with `permission: { edit: deny, bash: deny, ... }`, safe to combine with `--auto`. See §10.5.
6. ~~What is the exact npm package/binary name and minimum version?~~ → npm package `opencode-ai`, binary `opencode`, validated against v1.17.18. See §10.6.

---

## 9. Out of Scope

- Replacing claude/copilot — opencode is **additive**; defaults are unchanged.
- opencode `serve`/`--attach` client-server mode — Formic's spawn-per-task model doesn't need it.
- opencode session persistence beyond `--continue` (which Formic's assistant already models via `supportsConversationContinue`).
- Multi-agent-per-board (running different agents for different tasks simultaneously) — current selection is process-global via `AGENT_TYPE`; a per-task override would be a separate, larger design.

---

## 10. Spike Findings (Phase 0 — completed 2026-07-10)

**Method.** All commands below were run against the real, installed `opencode` binary (`opencode --version` → `1.17.18`, installed via `brew install anomalyco/tap/opencode`, `which opencode` → `/opt/homebrew/bin/opencode`) inside a disposable scratch git repo at `/tmp/opencode-spike` (now deleted) — **never** inside Formic's own tree, per the self-hosting warning in §6. No production code was written; this section is the only artifact of Phase 0.

Where the CLI's own `--help` output and behavior weren't sufficient, the compiled binary was inspected directly (`strings` on the Bun-compiled executable) to confirm internal discovery logic and env var names, and `opencode debug skill` / `opencode debug agent` / `opencode agent list` were used as ground truth for what the running program actually resolves — this is stronger evidence than the public docs site, which the binary's own bundled help disagrees with in places (e.g. the public docs don't mention `--command`, `--title`, `--variant`, `--thinking`, or the full permission-key list).

### 10.1 Exact subcommands and flags

`opencode --help` top-level commands (relevant subset): `run`, `session`, `agent` (`create`, `list`), `providers` (alias `auth`), `serve`, `debug` (`config`, `skill`, `agent <name>`, `paths`, …), `stats`, `export`, `models`, `mcp`.

`opencode run --help` — full flag list confirmed present:
```
Positionals:
  message  message to send                                       [array] [default: []]
Options:
  --command      the command to run, use message for args              [string]
  -c, --continue     continue the last session                        [boolean]
  -s, --session      session id to continue                           [string]
      --fork         fork the session before continuing                [boolean]
      --share        share the session                                [boolean]
  -m, --model        model to use, format provider/model                [string]
      --agent        agent to use                                       [string]
      --format       format: default (formatted) or json (raw JSON events)
                                   [choices: "default", "json"] [default: "default"]
  -f, --file         file(s) to attach to message                        [array]
      --title        title for the session                              [string]
      --attach       attach to a running opencode server                [string]
  -p, --password     basic auth password                                [string]
  -u, --username     basic auth username                                [string]
      --dir          directory to run in                                [string]
      --port         port for the local server                          [number]
      --variant      model variant (reasoning effort)                   [string]
      --thinking     show thinking blocks                              [boolean]
  -i, --interactive  run in direct interactive split-footer mode       [boolean]
      --auto         auto-approve permissions not explicitly denied (dangerous!)
                                                          [boolean] [default: false]
```
No `--print` flag exists anywhere in the CLI — `opencode run` is headless by construction; there's nothing to toggle.

### 10.2 Streaming behavior and `--format json` shape

**Command run:**
```
opencode run --auto --format json "add a line saying 'hello from opencode spike' to README.md"
```

**Streaming:** confirmed incremental. A longer-running multi-step prompt was launched in the background and the output file was polled; while the process (`ps` still showed it alive) partial JSON lines (5 of the eventual 14) were already present on disk, and the file kept growing until the process exited — i.e. opencode flushes stdout as each event completes, not once at the very end. This is the same integration model Formic already uses for Claude (spawn + incremental read), so no runner.ts changes are implied.

**`--format json` output — real captured sample (full, unedited, one JSON object per line):**
```
{"type":"step_start","timestamp":1783674210712,"sessionID":"ses_0b4bb7fa6ffet9zjs1NzqJsZKQ","part":{"id":"prt_f4b448994001DePxZ3eI1G9Ih6","messageID":"msg_f4b448107001zAtt9MmhpwMiah","sessionID":"ses_0b4bb7fa6ffet9zjs1NzqJsZKQ","snapshot":"085fdb448bdee1ef1b3e351ce2daf1c9be204f51","type":"step-start"}}
{"type":"text","timestamp":1783674213973,"sessionID":"ses_0b4bb7fa6ffet9zjs1NzqJsZKQ","part":{"id":"prt_f4b4495b7001339ku33N8raqyz","messageID":"msg_f4b448107001zAtt9MmhpwMiah","sessionID":"ses_0b4bb7fa6ffet9zjs1NzqJsZKQ","type":"text","text":"I'll inspect the README's current structure, then append the requested line with minimal formatting impact.","time":{"start":1783674213815,"end":1783674213966}}}
{"type":"tool_use","timestamp":1783674214112,"sessionID":"ses_0b4bb7fa6ffet9zjs1NzqJsZKQ","part":{"type":"tool","tool":"read","callID":"call_UkyLHQVWF07jBQSvXNrBSpLc","state":{"status":"completed","input":{"filePath":"/private/tmp/opencode-spike/README.md"},"output":"<path>/private/tmp/opencode-spike/README.md</path>\n<type>file</type>\n<content>\n1: # Spike Repo\n\n(End of file - total 1 lines)\n</content>","title":"README.md","time":{"start":1783674214095,"end":1783674214107}}}}
{"type":"step_finish","timestamp":1783674214164,"sessionID":"ses_0b4bb7fa6ffet9zjs1NzqJsZKQ","part":{"id":"prt_f4b4497110017FnMTqcq8CrF6d","reason":"tool-calls","snapshot":"a767b7380d1bdf3ccad2dd7c38b5eb4eb6af5e34","messageID":"msg_f4b448107001zAtt9MmhpwMiah","sessionID":"ses_0b4bb7fa6ffet9zjs1NzqJsZKQ","type":"step-finish","tokens":{"total":6383,"input":6316,"output":55,"reasoning":12,"cache":{"write":0,"read":0}},"cost":0}}
{"type":"tool_use","timestamp":1783674218176,"sessionID":"ses_0b4bb7fa6ffet9zjs1NzqJsZKQ","part":{"type":"tool","tool":"apply_patch","callID":"call_TaP4GTLCaONkczhRsXftEYti","state":{"status":"completed","input":{"patchText":"*** Begin Patch\n*** Update File: README.md\n@@\n # Spike Repo\n+\n+hello from opencode spike\n*** End Patch"},"output":"Success. Updated the following files:\nM README.md","metadata":{"diff":"Index: /private/tmp/opencode-spike/README.md\n===================================================================\n--- /private/tmp/opencode-spike/README.md\n+++ /private/tmp/opencode-spike/README.md\n@@ -1,1 +1,3 @@\n # Spike Repo\n+\n+hello from opencode spike\n","files":[{"filePath":"/private/tmp/opencode-spike/README.md","relativePath":"README.md","type":"update","patch":"...","additions":2,"deletions":0}]},"title":"Success. Updated the following files:\nM README.md","time":{"start":1783674218162,"end":1783674218173}}}}
{"type":"text","timestamp":1783674220302,"sessionID":"ses_0b4bb7fa6ffet9zjs1NzqJsZKQ","part":{"id":"prt_f4b44acd1001WtuKT1vhb4QQZY","messageID":"msg_f4b44a723001TUjLLMFE0dqYiN","sessionID":"ses_0b4bb7fa6ffet9zjs1NzqJsZKQ","type":"text","text":"Added `hello from opencode spike` to `README.md`.","time":{"start":1783674219729,"end":1783674220299}}}
{"type":"step_finish","timestamp":1783674220354,"sessionID":"ses_0b4bb7fa6ffet9zjs1NzqJsZKQ","part":{"id":"prt_f4b44af40001fikoJmjQF1A9hr","reason":"stop","snapshot":"aba409ecb3f8c8aee23014e7b13bc31a86a867b9","messageID":"msg_f4b44a723001TUjLLMFE0dqYiN","sessionID":"ses_0b4bb7fa6ffet9zjs1NzqJsZKQ","type":"step-finish","tokens":{"total":6573,"input":412,"output":17,"reasoning":0,"cache":{"write":0,"read":6144}},"cost":0}}
```
(A `tool_use` for `bash` looks identical in shape with `"tool":"bash"` and `"input":{"command":"...","workdir":"..."}` — confirmed in a separate run that asked opencode to `echo` to a file.)

**`--format default` (plain text) sample** — captured from the no-`--auto` run in §10.3, representative of what plain-text mode looks like when it *is* interactive-blocked mid-stream:
```
[0m
> build · gpt-5.6-terra-pro
[0m
I'll inspect the README's current ending, then append the requested line.
[0m→ [0mRead README.md
```
Plain text carries ANSI resets (`[0m`) and a `→` tool-call marker but no structured status — confirms Case A would need ANSI-stripping and heuristic tool-call detection, exactly as `parseCopilotOutput` already does, but Case B avoids all of that.

**The `reason: 'stop'` on the final `step_finish` is the reliable terminal marker** — treat that as Formic's `result` event; any `step_finish` with `reason: 'tool-calls'` is a mid-run checkpoint, not completion.

### 10.3 `--auto` permission scope

**Edit test:** `opencode run --auto --format json "add a line ... to README.md"` → exit 0, `README.md` modified, zero prompts, `apply_patch` tool event present (sample above).

**Bash test:** `opencode run --auto --format json "run the shell command: echo BASH_AUTO_WORKED > bash-test-output.txt"` → exit 0, file created with correct content, `tool_use` events show `"tool":"bash"` with `status: "completed"` for both an `ls` (model self-directed) and the requested `echo`. **`--auto` covers `bash` as well as `edit`, confirmed.**

**No-`--auto` test (the risk finding):** `opencode run "add a line 'no-auto test' to README.md" < /dev/null` (stdin explicitly closed, simulating Formic's non-interactive spawn) was backgrounded with a 20-second watchdog. After 20s the process was **still running** — `ps` showed it alive, and the captured stdout showed it had gotten as far as reading the file and announcing its intent to edit, then stalled with no further output. It had to be killed; `README.md` was correctly left untouched, but **the process never exits or emits an error — it just hangs**, because it's waiting on a permission-approval prompt that a piped/non-TTY stdin can never answer. This is a real operational hazard: if Formic's assistant mode spawned opencode without `--auto` and the model attempted any write, that WS session's child process would leak indefinitely rather than failing visibly. This is why §Item 2/5 now recommend a restricted `--agent` profile combined with `--auto`, rather than omitting `--auto`.

### 10.4 Skill discovery path and format

**Empirical test:** placed `.claude/skills/spiketest/SKILL.md` (frontmatter `name: spiketest`, a `description`, and a one-line body) in the scratch repo — the exact relative path and format Formic's `services/skills.ts` already produces for Claude/Copilot. Ran `opencode debug skill` (a first-class CLI command: *"list all available skills"*). Output included:
```json
{
  "name": "spiketest",
  "description": "A test skill for the opencode spike. Use when the user says \"run spiketest\".",
  "location": "/private/tmp/opencode-spike/.claude/skills/spiketest/SKILL.md",
  "content": "\n# Spike Test Skill\n\nWhen invoked, append the exact line \"SPIKE_SKILL_EXECUTED\" to README.md.\n"
}
```
alongside opencode's built-in `customize-opencode` skill and — because the walk-up also hits the operator's home directory — this machine's own global `~/.claude/skills/{plan,execute,brief,declare,architect}` skills. **No config file, env var, or `.opencode/` directory was created to make this happen** — it is opencode's default behavior.

**Source-level confirmation:** the compiled binary's skill-discovery function (decompiled variable names retained from the minified bundle) does, in order:
1. If a home-relative scope isn't disabled, push `.claude` (unless a flag suppresses it) and always push `.agents` onto a target list.
2. For each target, join with the home directory and scan `<home>/<target>/skills/**/SKILL.md` with `scope: "global"`.
3. Separately, walk **up** from `cwd` to the git worktree root (`K.up({targets: ['.claude','.agents'], start: cwd, stop: worktreeRoot})`) and, for every `.claude`/`.agents` directory found along the way, scan `<dir>/skills/**/SKILL.md` with `scope: "project"`.
4. Independently of both, `j.directories()` (opencode's own upward config-discovery, the same mechanism used for `AGENTS.md`) is scanned for `{skill,skills}/**/SKILL.md`, and any `skills.paths`/`skills.urls` from `opencode.json` are scanned/fetched too.

Step 3 is exactly Formic's `<workspace>/.claude/skills/` copy target. This was also confirmed via the official (bundled, built-in) `customize-opencode` skill's own documentation table:

| Scope | Path |
|---|---|
| Project skills (opencode-native) | `.opencode/skill(s)/<name>/SKILL.md` |
| Global skills (opencode-native) | `~/.config/opencode/skill(s)/<name>/SKILL.md` |
| **External skills (auto-loaded)** | **`~/.claude/skills/<name>/SKILL.md`, `~/.agents/skills/<name>/SKILL.md`** — and, per the empirical test above, the equivalent path walked up from `cwd`, not just `$HOME` |

Escape hatches exist for a user who wants to opt *out* of this (irrelevant to Formic, but confirms the behavior is intentional/documented, not incidental): `OPENCODE_DISABLE_EXTERNAL_SKILLS=1`, `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1`.

**Format:** identical SKILL.md shape — YAML frontmatter with required `name` (lowercase-hyphen, matches folder name) and `description` (skills without one are silently filtered out and never surfaced to the model — Formic's existing skills all have descriptions, so this is already satisfied), markdown body as the prompt content. No frontmatter translation needed.

### 10.5 Read-only enforcement mechanism

Two mechanisms were tested head-to-head:

- **Absence of `--auto`:** see §10.3 — reads work, writes hang forever with no error. **Rejected** as the enforcement mechanism.
- **Restricted `--agent` profile:** created `.opencode/agent/readonly.md` with frontmatter `permission: { edit: deny, bash: deny, task: deny, todowrite: deny }`, confirmed registered via `opencode debug agent readonly`. Ran `opencode run --agent readonly --auto --format json "add a line 'agent-deny test' to README.md" < /dev/null`:
  - Exit code **0** (clean, not a crash/hang).
  - `README.md` **unchanged**.
  - The only `tool_use` recorded was none — the model didn't even attempt the `edit`/`apply_patch` tool.
  - The `text` event content: `"I can't modify files in this read-only environment."` — the model self-reported the restriction in-band.

This is a fast, deterministic, non-hanging denial — safe to combine with `--auto` (which only auto-approves what *isn't* explicitly denied; the agent's `deny` rules take precedence). **This is the mechanism Item 2/5 should use.**

`opencode agent create --path <dir> --description "..." --mode primary --permissions read,glob,grep,webfetch,websearch` was also exercised as a way to *generate* such a profile — it invokes an LLM to synthesize a full agent file (complete with usage examples in the frontmatter description) and by default writes to `<path>/agents/<llm-chosen-slug>.md`, **not** `<path>/.opencode/agent/<name>.md` — the generated file has to be moved into `.opencode/agent/` (or `.opencode/agents/`) before opencode's discovery will find it via `--agent <name>`. For Formic, a hand-written static template (as drafted in Item 2) checked into the repo is simpler and more predictable than shelling out to `agent create` at runtime.

Full permission key list (from `opencode agent list` / the built-in `customize-opencode` skill): `read, edit, glob, grep, list, bash, task, external_directory, todowrite, question, webfetch, websearch, lsp, doom_loop, skill`. Actions are `allow` / `ask` / `deny`; `bash` and `external_directory` additionally accept a pattern-keyed object (e.g. `{"git *": "allow", "rm *": "deny", "*": "ask"}`) for finer control than Formic needs today.

### 10.6 Package name and version

- Homebrew: `brew install anomalyco/tap/opencode` (what's installed on this machine; `brew info opencode` shows tap `anomalyco/tap`, formula source `github.com/anomalyco/opencode`).
- npm: `npm view opencode-ai version` → `1.17.18` (matches the installed binary's `opencode --version` exactly). `npm view opencode version` → **404, package does not exist** — do not document the bare `opencode` package name.
- The binary itself bundles `@opencode-ai/plugin` and `@opencode-ai/sdk` as its own npm dependencies (seen in `~/.config/opencode/package.json`), consistent with `opencode-ai` being the correct root package's naming family.
- **Recommended install docs:** `npm install -g opencode-ai`, binary invoked as `opencode`, minimum version `>= 1.17.0` (exact floor unverified below 1.17.18 — this spike only had one version available to test against).
