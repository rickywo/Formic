# Formic Per-Step Model Selection — Design & Implementation Plan

**Date:** 2026-07-11
**Audited version:** `main-opencode-integration` working tree (post t-13..t-17)
**Type-check status baseline:** `npx tsc --noEmit` expected clean before starting
**Scope:** `src/server/services/` (agentAdapter, engineConfig, configStore, workflow, runner, assistantManager, messagingAI), `src/server/routes/config.ts`, `src/types/index.ts`, `src/client/index.html`

> ⚠️ File/line references are accurate as of the working tree above and will drift as code changes.
> Re-verify each reference before editing.

---

## 1. Executive Summary

**Goal:** let the user pick which AI model each agent-driven stage uses, from dropdowns in the Settings panel. Example: Opus 4.8 for briefing/planning/architecting (reasoning-heavy), Sonnet 5 for executing (volume coding), and an independent choice for the chat assistant.

**Key design decision — key by workflow *step*, not task *status*.** Task statuses and agent invocations are not 1:1: the `declaring` and `architecting` states currently spawn their agent through `runWorkflowStep(taskId, 'execute', ...)` (the step label is reused), and background agent runs (reflection, tool-forge) happen *inside* the `running` status. The stable, unambiguous key is the **step being executed**, so the config is a `stepModels` map keyed by step name. Statuses map onto steps as shown in §2.

**Resolution order** for every agent spawn:

```
stepModels[<step>]  →  (unset/empty)  →  agent CLI default (no --model flag at all)
```

No global "default model" tier — the agent CLI's own default *is* the fallback, which keeps behavior identical to today when nothing is configured (zero-migration).

| # | Work item | Area | Effort |
|---|-----------|------|--------|
| 1 | Types + model catalog + `--model` arg plumbing in agentAdapter | Foundation | S |
| 2 | Config persistence: `stepModels` in ConfigSettings / configStore / engineConfig / config routes + `GET /api/models` | Config | S |
| 3 | Thread model through workflow spawn sites (incl. fixing the declare/architect step-label reuse) | Workflow | M |
| 4 | Assistant + messaging model selection | Assistant | S |
| 5 | Settings-panel dropdown UI + assistant panel selector | Client | M |
| 6 | Tests (unit + Python API) and docs | Verification | S |

Effort: **S** = < half day, **M** = half day to two days.

---

## 2. Which task states require an agent (the model-selection surface)

Derived from the actual spawn sites in the code — **verified, not assumed**:

| Task status | Workflow step | Agent spawned? | Spawn site | Model config key |
|-------------|---------------|----------------|------------|------------------|
| `todo` | — | No | — | — |
| `queued` | — | No | — | — |
| `briefing` | brief | **Yes** | `workflow.ts` `runWorkflowStep(taskId,'brief',…)` via `executeFullWorkflow` / `executeSingleStep` | `brief` |
| `planning` | plan | **Yes** | `workflow.ts` `runWorkflowStep(taskId,'plan',…)` via `executeFullWorkflow` / `executeSingleStep` | `plan` |
| `declaring` | declare | **Yes** | `workflow.ts` `executeDeclareAndAcquireLeases` → `runWorkflowStep(taskId,'execute',…)` ⚠ step label reused | `declare` |
| `running` | execute | **Yes** | `runWorkflowStep(taskId,'execute',…)` via `runExecuteIteration` / `executeQuickTask` / `executeSingleStep` | `execute` |
| `running` (post-iteration) | reflection / tool-forge | **Yes** (background) | `workflow.ts` `runAgentForOutput()` via `runReflectionStep` / `triggerToolForge` | inherits `execute` |
| `architecting` | architect | **Yes** | `workflow.ts` `executeGoalWorkflow` → `runWorkflowStep(taskId,'execute',…)` ⚠ step label reused | `architect` |
| `verifying` | verify | **No** — spawns `engineConfig.verifyCommand` (a shell command like `npm test`), not an agent | `executeVerifyStep` | — |
| `review` / `done` / `blocked` | — | No | — | — |

**Non-task agent surfaces** (also model-selectable):

| Surface | Spawn site | Model config key |
|---------|------------|------------------|
| Chat assistant (AI Assistant panel) | `assistantManager.ts` `processMessage()` → `buildAssistantArgs` | `assistant` |
| Messaging bots (Telegram/LINE) | `messagingAI.ts` (~93, ~590) → `buildMessagingAssistantArgs` | inherits `assistant` (see §3.4) |
| Legacy direct runner | `runner.ts` (~166) → `buildAgentArgs` | `execute` |

So the **six user-facing model keys** are: `brief`, `plan`, `declare`, `execute`, `architect`, `assistant`.
`verifying` deliberately has no key (no agent). Reflection/tool-forge/messaging deliberately inherit rather than adding dropdown noise; revisit only if users ask.

---

## 3. Design

### 3.1 Config schema

```ts
// src/types/index.ts
export const MODEL_STEPS = ['brief', 'plan', 'declare', 'execute', 'architect', 'assistant'] as const;
export type ModelStep = typeof MODEL_STEPS[number];

/** Model id per step. Empty string / missing key = use the agent CLI's default (no flag passed). */
export type StepModelConfig = Partial<Record<ModelStep, string>>;
```

`ConfigSettings` (same file, ~line 374) gains:

```ts
export interface ConfigSettings {
  // ... existing fields unchanged ...
  /** Per-step model overrides. Missing/empty = agent default. */
  stepModels?: StepModelConfig;
}
```

Persistence rides the existing `~/.formic/config.json` via `configStore.ts` — **no new storage mechanism**. Values are stored per-user, not per-workspace (model taste is a user preference; revisit if multi-user arrives).

**Important:** stored model ids are only meaningful for the currently selected `AGENT_TYPE`. Store the map **namespaced by agent type** so switching agents doesn't apply a Claude model id to opencode:

```ts
stepModels?: Partial<Record<AgentType, StepModelConfig>>;
```

This is the final shape. The UI reads/writes only the sub-map for the active agent.

### 3.2 Model catalog (what the dropdowns show)

Add to `src/server/services/agentAdapter.ts`:

```ts
export interface ModelOption { id: string; label: string; }

const MODEL_CATALOG: Record<AgentType, ModelOption[]> = {
  claude: [
    { id: '',                        label: 'Agent default' },
    { id: 'claude-opus-4-8',         label: 'Opus 4.8' },
    { id: 'claude-sonnet-5',         label: 'Sonnet 5' },
    { id: 'claude-fable-5',          label: 'Fable 5' },
    { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
  ],
  copilot: [
    { id: '', label: 'Agent default' },
    // [VERIFY against installed copilot CLI --help before shipping]
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
    { id: 'gpt-5',           label: 'GPT-5' },
  ],
  opencode: [
    { id: '', label: 'Agent default' },
    // opencode ids are provider/model format; seed from the configured provider.
    // [VERIFY: `opencode models` subcommand exists in v1.17.18 — if so, shell out
    //  and cache; otherwise ship this static seed list]
    { id: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5 (Anthropic)' },
    { id: 'anthropic/claude-opus-4-8', label: 'Claude Opus 4.8 (Anthropic)' },
  ],
};

export function getAvailableModels(): ModelOption[] {
  return MODEL_CATALOG[getAgentType()];
}
```

The client dropdown always appends a **"Custom…"** option that reveals a free-text input, because catalogs go stale and opencode's model space is provider-dependent. A typed custom id is stored exactly like a catalog id.

### 3.3 CLI flag mapping (all three agents support a model flag)

| Agent | Flag | Format | Notes |
|-------|------|--------|-------|
| claude | `--model <id>` | `claude-sonnet-5` or alias `sonnet` | inserted before the prompt |
| copilot | `--model <id>` | CLI-specific | [VERIFY flag name via `copilot --help`] |
| opencode | `--model <id>` (alias `-m`) | `provider/model` | confirmed in `opencode run --help` v1.17.18 |

⚠️ **opencode failure mode (observed live):** a bad model id produces `AI_APICallError: Model not found <id>` as a stream error — the run fails at the provider, not at CLI parse. And an id without a `/` would be split into `providerID=<id>, modelID=''` (this exact mechanism crashed the agent profiles in t-17). Mitigation: the server validates opencode ids match `/^[\w.-]+\/[\w.-]+$/` before passing the flag; invalid → log `[AgentAdapter]` warn and **omit the flag** (fall back to default) rather than crash the step.

### 3.4 Signature changes in `agentAdapter.ts`

The three arg builders gain an optional model:

```ts
// AgentConfig interface (~line 12)
buildArgs: (prompt: string, options?: { model?: string }) => string[];

// AssistantConfig interface (~line 32)
buildAssistantArgs: (prompt: string, options?: { continue?: boolean; model?: string }) => string[];

// exported wrappers (~197, ~253, ~284)
export function buildAgentArgs(prompt: string, options?: { model?: string }): string[]
export function buildAssistantArgs(prompt: string, options?: { continue?: boolean; model?: string }): string[]
export function buildMessagingAssistantArgs(prompt: string, options?: { continue?: boolean; model?: string }): string[]
```

Each per-agent implementation inserts `['--model', model]` (after validation, §3.3) when `options.model` is a non-empty string. All call sites that don't pass a model behave exactly as today — the parameter is optional end-to-end, so this refactor is non-breaking.

Add the resolution helper here too (single source of truth):

```ts
/** Resolve the configured model for a step under the active agent type. '' = default. */
export function getModelForStep(step: ModelStep): string {
  return engineConfig.stepModels[getAgentType()]?.[step] ?? '';
}
```

(`engineConfig` import is safe: engineConfig imports only configStore — no cycle.)

### 3.5 engineConfig plumbing

`src/server/services/engineConfig.ts` — add to `EngineConfig` interface and the singleton default:

```ts
stepModels: Partial<Record<AgentType, StepModelConfig>>;   // default {}
```

and in `refreshEngineConfig()`:

```ts
engineConfig.stepModels = s.stepModels ?? {};
```

`refreshEngineConfig()` is already called at the start of each top-level operation (workflow execution, queue poll, watchdog scan — see the file's header comment), so **model changes take effect on the next step spawn without a server restart**. The assistant path must call `refreshEngineConfig()` (or `loadConfig()`) before each spawn — verify `assistantManager.processMessage` does; add if missing.

---

## 4. Implementation Phases

Work the phases in order. Items within a phase are sequential (they share files).

```
Phase 1 — Foundation (agentAdapter + types)         [no behavior change]
Phase 2 — Config persistence + API                  [server-side complete]
Phase 3 — Workflow threading                        [task steps use models]
Phase 4 — Assistant & messaging                     [chat bot uses model]
Phase 5 — Client UI                                 [user-facing]
Phase 6 — Tests & docs
```

---

### Phase 1 — Types + agentAdapter foundation

**Files:** `src/types/index.ts`, `src/server/services/agentAdapter.ts`, `test/unit/agentAdapterOpencode.test.ts` (+ sibling claude/copilot test file if present)

1. `src/types/index.ts`: add `MODEL_STEPS`, `ModelStep`, `StepModelConfig` (§3.1); extend `ConfigSettings` with `stepModels?: Partial<Record<AgentType, StepModelConfig>>`. Import note: `AgentType` currently lives in `agentAdapter.ts` (line ~19) — **move the `AgentType` union into `src/types/index.ts`** and re-export from agentAdapter for backward compatibility, otherwise types/index.ts would import from a service (wrong direction).
2. `agentAdapter.ts`:
   - Widen the three builder signatures (§3.4). Update every per-agent implementation (`claude`/`copilot`/`opencode` × `buildArgs`/`buildAssistantArgs`/messaging branch) to insert the validated `--model` pair.
   - Flag placement: **before the prompt** for all agents (claude `--print --model X … prompt`; opencode `run --agent … --model X --format json prompt`).
   - Add `MODEL_CATALOG`, `ModelOption`, `getAvailableModels()`, `getModelForStep()` (§3.2, §3.4).
   - opencode id validation regex + `[AgentAdapter]`-prefixed warn-and-omit fallback (§3.3).
3. Unit tests: for each agent type × each builder, assert (a) no model option → args identical to today, (b) model option → `--model <id>` present in the right position, (c) opencode invalid id (no slash) → flag omitted + args otherwise intact.

**Acceptance:** `npx tsc --noEmit` clean; all existing + new unit tests pass; `buildAgentArgs('hi')` output unchanged vs. today for all three agents.

---

### Phase 2 — Config persistence + API

**Files:** `src/server/services/configStore.ts`, `src/server/services/engineConfig.ts`, `src/server/routes/config.ts`

1. `configStore.ts`: confirm `loadConfig()`/`saveConfig()` pass unknown settings through (they persist the whole `ConfigSettings` object — if there is a field whitelist or default-merge, add `stepModels: {}` to the defaults).
2. `engineConfig.ts`: add `stepModels` to interface, singleton default, and `refreshEngineConfig()` (§3.5).
3. `routes/config.ts`:
   - The existing `GET/PUT /api/config/settings/:key` route pair (~lines 71, 100) is keyed by `keyof ConfigSettings`, so `stepModels` works through it once the type exists. Add value validation in the PUT handler: when `key === 'stepModels'`, verify the value is an object whose top-level keys ∈ `{'claude','copilot','opencode'}` and nested keys ∈ `MODEL_STEPS`, values are strings; reject otherwise with 400 (`reply.status(400).send({ error: … })` per project error conventions).
   - Add `GET /api/models` → `{ agentType: getAgentType(), models: getAvailableModels() }`. Route file stays thin: it calls only agentAdapter functions (no business logic in routes, per project guidelines).
4. Config round-trip smoke: `PUT /api/config/settings/stepModels` with `{"claude":{"brief":"claude-opus-4-8"}}` → `GET` returns it → survives server restart (file-backed).

**Acceptance:** Python API test round-trips `stepModels`; invalid shapes get 400; `GET /api/models` returns the catalog for the active `AGENT_TYPE`; `npx tsc --noEmit` clean.

---

### Phase 3 — Workflow threading (the core change)

**Files:** `src/server/services/workflow.ts`, `src/server/services/runner.ts`

1. **Disambiguate the step label.** `runWorkflowStep(taskId, step: 'brief'|'plan'|'execute', prompt, onComplete)` (~line 523) is called with the literal `'execute'` by the declare path (`executeDeclareAndAcquireLeases`, ~439) and the architect path (`executeGoalWorkflow`, ~2117). The `step` param drives log labels and timeout messages, so rather than changing its semantics, add a **separate optional param** that defaults to the step:
   ```ts
   function runWorkflowStep(
     taskId: string,
     step: 'brief' | 'plan' | 'execute',
     prompt: string,
     onComplete: (success: boolean) => void,
     modelStep: ModelStep = step === 'brief' ? 'brief' : step === 'plan' ? 'plan' : 'execute'
   )
   ```
   Inside, replace `const agentArgs = buildAgentArgs(prompt);` (~533) with:
   ```ts
   const model = getModelForStep(modelStep);
   const agentArgs = buildAgentArgs(prompt, model ? { model } : undefined);
   ```
   Log the choice once per spawn: `console.warn(\`[Workflow] ${step} step for ${taskId} using model: ${model || '(agent default)'}\`)`.
2. **Update the call sites** (enclosing functions verified in this audit):
   | Call site (fn) | approx line | `modelStep` to pass |
   |---|---|---|
   | `executeDeclareAndAcquireLeases` | ~439 | `'declare'` |
   | `runExecuteIteration` | ~656 | `'execute'` (default, no change) |
   | `executeQuickTask` | ~1322 | `'execute'` (default) |
   | `executeSingleStep` | ~1516 | matches its `step` arg (default) |
   | `executeFullWorkflow` | ~1617 | matches its `step` arg (default) |
   | `executeGoalWorkflow` | ~2117 | `'architect'` |
3. **`runAgentForOutput(prompt)`** (~1053, used by `runReflectionStep` ~1113 and `triggerToolForge` ~1161): add optional `model` param; both callers pass `getModelForStep('execute')` (inheritance decision from §2).
4. **`runner.ts`** (~166-167): pass `getModelForStep('execute')` the same way. This is the legacy direct-run path; it counts as execution.
5. **Verify step untouched** — `executeVerifyStep` spawns `verifyCommand`, not an agent; explicitly out of scope (add a code comment saying why it has no model).

**Acceptance:** run a standard task with distinct models configured for brief/plan/declare/execute and confirm from the per-step `[Workflow] … using model:` log lines (and `claude --model` / `opencode --model` visible in `ps` output) that each stage used its configured model; a goal task's architect step uses the `architect` model; unset steps show `(agent default)` and pass no flag.

---

### Phase 4 — Assistant & messaging

**Files:** `src/server/services/assistantManager.ts`, `src/server/services/messagingAI.ts`

1. `assistantManager.ts` `processMessage()` (~580-599): before spawning, refresh config (`await refreshEngineConfig()` — note `processMessage` is currently sync; either make it async up the call chain or read via a cached-but-refreshed pattern like the workflow does at operation start — check the caller in `src/server/ws/assistant.ts` and pick the smaller change), then:
   ```ts
   const model = getModelForStep('assistant');
   const args = buildAssistantArgs(content, { continue: useContinue, ...(model ? { model } : {}) });
   ```
   ⚠️ **Session-consistency caveat:** with `--continue`, changing the model mid-conversation applies the new model to an existing session. All three CLIs tolerate this; surface it in the UI copy ("takes effect from your next message") rather than blocking it.
2. `messagingAI.ts` (~93, ~590): same pattern with `getModelForStep('assistant')` (messaging inherits assistant, §2). Both spawn sites.

**Acceptance:** set `assistant` model, send a chat message, confirm the spawn log line in `[AssistantManager] Args:` includes `--model <id>`; unset → no flag; Telegram/LINE path (if configured) picks up the same model.

---

### Phase 5 — Client UI

**Files:** `src/client/index.html` (Settings panel markup ~line 7599+, settings JS, assistant panel header)

1. **Settings panel — new "Agent Models" section** (below the existing Execution settings):
   - Six labeled dropdowns: Briefing, Planning, Declaring, Executing, Architecting, Chat Assistant. Labels use the user-facing stage names; the payload uses the step keys.
   - Populate options from `GET /api/models` on settings-panel open (not page load — cheap and always fresh). First option is always "Agent default".
   - Last option "Custom…" toggles a text input; its value is used as the model id verbatim.
   - A small caption under the section: "Models apply to the **<AgentDisplayName>** agent (`AGENT_TYPE=<type>`). Switching agent type keeps a separate model set."
2. **Persistence:** on change, read-modify-write the full map: `GET /api/config/settings/stepModels` → set `[agentType][step]` → `PUT`. (The agentType comes back from `GET /api/models`.) Debounce is unnecessary — these are discrete select changes.
3. **Assistant panel:** add a compact model select in the AI Assistant panel header bound to the same `assistant` key (same GET/PUT), so users can switch chat models without opening Settings. Show the "(takes effect from your next message)" hint on change.
4. **No new CSS frameworks** — reuse the existing settings-panel form styles (`.settings-*` classes, dark/light theme variables).

**Acceptance:** dropdowns render populated for the active agent; selections persist across reload and server restart; changing agent type (env) shows that agent's own saved selections; custom id entry works; Playwright E2E covers open-settings → select model → reload → selection retained.

---

### Phase 6 — Tests & docs

1. **Unit** (`test/unit/`, `npx tsx --test`): Phase 1 builder matrix (§Phase 1.3); `getModelForStep` resolution incl. namespacing by agent type and empty-map default.
2. **Python API** (`test/`): `stepModels` round-trip + 400 on bad shape; `GET /api/models` shape.
3. **E2E** (`e2e/`, Playwright): settings-panel flow (§Phase 5 acceptance).
4. **Docs:** README "Supported Agents" section gains a short "Per-step model selection" subsection; `.env.example` comment noting model config lives in Settings, not env.

---

## 5. Suggested Formic Task Batch

| Order | Title | Type | Priority | Depends on |
|-------|-------|------|----------|------------|
| 1 | Add per-step model types, catalog, and --model arg support to agentAdapter | standard | medium | — |
| 2 | Persist stepModels config and expose GET /api/models + settings validation | standard | medium | Task 1 |
| 3 | Thread per-step model selection through workflow, runner, and reflection spawns | standard | medium | Task 1, 2 |
| 4 | Apply assistant model selection to chat and messaging agent spawns | quick | medium | Task 1, 2 |
| 5 | Add Agent Models section to Settings panel and assistant-panel model selector | standard | medium | Task 2 (API) |
| 6 | Add model-selection E2E test and README/docs updates | quick | low | Task 3, 4, 5 |

**Concurrency guidance:** Tasks 1–2 both touch `agentAdapter.ts`/`types/index.ts` — run sequentially. Task 3 exclusively leases `workflow.ts` + `runner.ts`; Task 4 leases `assistantManager.ts` + `messagingAI.ts`; Task 5 leases `index.html` — 3, 4, 5 can run in parallel after 2 lands.

> ⚠️ Self-hosting reminder (see REMEDIATION_PLAN §3 Issue 12): Tasks 1–4 edit `src/server/**`. Run the server via `npm run build && npm start` (not `tsx watch`) while they execute.

---

## 6. Design Alternatives Considered (and rejected)

1. **Per-task model override** (a model field on each task): more flexible but multiplies UI surface and makes runs less reproducible; per-step covers the stated use case ("thinking steps on a big model, coding steps on a fast one"). Can be layered on later — the resolution chain gets one more tier (`task.modelOverride → stepModels[step] → default`) without reworking anything in this plan.
2. **Keying by task status instead of step:** rejected — `declaring`/`architecting` reuse the `'execute'` spawn label today, and reflection/tool-forge run *within* `running`; status is a UI concept, the step is the execution concept.
3. **Env vars (`FORMIC_MODEL_BRIEF=…`):** rejected as primary interface — user asked for dropdowns; env can't drive a per-agent-type namespace cleanly. The config file remains editable by hand for headless setups.
4. **A global default-model tier between step and CLI default:** rejected — it adds a concept the user didn't ask for; "Agent default" per dropdown is simpler to explain. Trivial to add later if requested.
5. **Live model catalogs from provider APIs:** rejected for now — network dependency and per-provider auth complexity; static catalog + Custom free-text is robust. Marked one [VERIFY] on `opencode models` as a cheap potential upgrade.

---

## 7. Verification Playbook (applies to every task)

1. `npx tsc --noEmit` — clean (strict mode).
2. `npm run build`.
3. `npx tsx --test test/unit/` — all suites pass.
4. `PORT=8010 npx tsx src/server/index.ts` + `python test/run_tests.py` (use `no_proxy='*'` if a sandbox proxy is configured; ensure no other formic instance shares `.formic/`).
5. UI phases: `npx playwright test`.
6. Guideline conformance: ESM `.js` import extensions, `node:` prefixes, no `any`, no new dependencies, `[ServiceName]` log prefixes, no empty catch blocks, routes delegate to services.
