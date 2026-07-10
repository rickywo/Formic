# Formic Remediation Plan — Codebase Audit & Implementation Guide

**Date:** 2026-07-10
**Audited version:** `main` @ v0.8.0 (commit `fa2154c`)
**Type-check status:** `npx tsc --noEmit` passes cleanly
**Scope:** `src/server/services/` (leaseManager, workflow, store, runner, queueProcessor, watchdog), `src/server/routes/`, `src/server/index.ts`

> ⚠️ File/line references are accurate as of the commit above and will drift as code changes.
> Re-verify each reference before editing.

---

## 1. Executive Summary

The audit found **4 high-severity issues** (one security, one data-loss, two concurrency-correctness) and **5 medium-severity issues**, plus hygiene items. The codebase has a solid foundation — atomic board/lease persistence, `safeGit.ts` path-validated git execution, board corruption recovery, and validate-first lease acquisition are all in good shape — so this plan focuses on the remaining gaps.

| # | Issue | Severity | Area | Effort |
|---|-------|----------|------|--------|
| 1 | Unauthenticated API bound to `0.0.0.0` (network RCE surface) | 🔴 High | Security | S |
| 2 | Kill-switch `git reset --hard` wipes concurrent tasks' work | 🔴 High | Data loss | M |
| 3 | Lost-update race on board state (load→mutate→save without a mutex) | 🔴 High | State integrity | M |
| 4 | Lease preemption/deadlock resolution doesn't stop the holder process | 🔴 High | Concurrency | M |
| 5 | Capped-out tasks bounce in queue forever (code contradicts its own comment) | 🟡 Medium | Queue | S |
| 6 | Deadlock detection blind to shared holders and multi-file waits | 🟡 Medium | Concurrency | M |
| 7 | Task IDs are reused after deletion / board reset | 🟡 Medium | State integrity | S |
| 8 | `PUT /api/tasks/:id` mass assignment | 🟡 Medium | API | S |
| 9 | Lease lifecycle blind spots (silent expiry, unpersisted renewal, stale restart comment) | 🟡 Medium | Concurrency | S |
| 10 | `console.log` used in ~25 server files (violates project guidelines) | ⚪ Low | Hygiene | S |
| 11 | Spawn-failure placeholder marks task `running` with `pid: 0` | ⚪ Low | Robustness | S |
| 12 | Restart-driven dispatch loop: silent recovery re-queue + self-hosting watch-mode hazard | 🟡 Medium | Recovery / self-hosting | M |

Effort: **S** = < half day, **M** = half day to two days.

> **Issue 12 was observed as a live incident on 2026-07-10:** task t-1 (which edits `src/server/index.ts`) was dispatched
> 9 times in 7 minutes while Formic ran under `tsx watch` on its own repo. See §3 Issue 12 for the incident analysis.

### Implementation status (re-audit 2026-07-10, evening)

| Issue | Status | Evidence |
|-------|--------|----------|
| 1 (bind/auth) | ✅ Landed | `DEFAULT_HOST='127.0.0.1'`, `FORMIC_AUTH_TOKEN` guard + onRequest hook in `index.ts` |
| 2 (kill-switch rollback) | ✅ Landed | `checkoutFilesFromCommit()` in `safeGit.ts`, used at `workflow.ts` critic path |
| 3 (board mutex) | ✅ Landed | `withBoard<T>()` in `store.ts`, mutators converted |
| 4 (stop-before-release) | ❌ Outstanding | `yieldSignal` still written and never read; no teardown helper — **task created** |
| 5 (cap transitions) | ✅ Landed | `cap-exceeded:*` demotions incl. recoveries in `queueProcessor.ts`; counter resets in `queueTask()` |
| 6 (wait graph) | ❌ Outstanding | `waitForMap` still `Map<taskId, string>`; plus new survivor stale-wait bug (`test/repro-deadlock-survivor.ts`) — **task created** |
| 7 (task ID counter) | ✅ Landed | `board.meta.nextTaskId` + validation + seeding |
| 8 (PUT whitelist) | ✅ Landed | `UPDATABLE_TASK_FIELDS` + Fastify schema `additionalProperties:false` + 400 on unknown fields |
| 9 (lease lifecycle) | ❌ Outstanding | `cleanExpiredLeases` still silent; `renewLeases` unpersisted; stale recovery comment — **task created** |
| 10 (console.log) | ✅ Landed | 1 intentional remnant: `mcpScreenshot.ts` `SCREENSHOT_SUCCESS` protocol marker |
| 11 (spawn failure) | ✅ Landed | Spawn-confirm pattern in `runner.ts`; no `pid: 0` placeholder |
| 12 (recovery loop) | ✅ Landed | `recoveryCount` + `recovery.startup` transitions + orphan SIGTERM + self-host warning + README section |

Outstanding work = Phase 3 (Issues 4, 6, 9). Execute in that order — 6 depends on 4's teardown helper; all three share `leaseManager.ts`/`workflow.ts` so run sequentially, not in parallel.

---

## 2. Recommended Implementation Order (Phases)

Work the phases in order. Within a phase, items are independent and can be parallel Formic tasks — their file footprints do not overlap (relevant for lease-based concurrency).

```
Phase 1 — Stop the bleeding (independent, ship first)
  ├─ Issue 1: Bind to localhost + optional token auth
  └─ Issue 2: Scope kill-switch rollback to the task's own files

Phase 2 — State integrity foundation (Issue 3 first; Issue 7 builds on it)
  ├─ Issue 3: Board mutation mutex (withBoard)
  └─ Issue 7: Monotonic task ID counter

Phase 3 — Concurrency correctness (all touch leaseManager/workflow; do sequentially)
  ├─ Issue 4: Stop-before-release in preemption & deadlock resolution
  ├─ Issue 6: Multi-file, shared-aware wait graph
  └─ Issue 9: Lease lifecycle fixes (expiry events, renewal persistence, restart recovery)

Phase 4 — Queue & API hardening (independent)
  ├─ Issue 5: Cap-exceeded tasks transition out of the queue
  ├─ Issue 8: Field whitelist + status transition validation on PUT
  └─ Issue 12: Recovery accounting + orphan cleanup + self-hosting guard (after Issue 5)

Phase 5 — Hygiene (anytime, low risk)
  ├─ Issue 10: console.log sweep
  └─ Issue 11: Spawn-failure status fix
```

**Dependency notes:**
- Issue 3 (board mutex) is the foundation — Issues 5, 7, and 8 all touch board mutation paths and are simpler to write correctly once `withBoard()` exists. Do Issue 3 before them if possible.
- Issue 4 and Issue 6 both modify `leaseManager.ts` and `workflow.ts`. Run them as **sequential** tasks, not parallel, to avoid lease conflicts and merge pain.
- Issue 10 (console sweep) touches almost every file — do it **last** in any batch to avoid conflicting with every other task.

---

## 3. Issue Details & Solutions

---

### Issue 1 — Unauthenticated API bound to `0.0.0.0` 🔴

**Suggested Formic task:** `Fix: Restrict server binding to localhost and add token auth for network exposure` — priority `high`, type `standard`

#### Problem

`src/server/index.ts:45` sets `DEFAULT_HOST = '0.0.0.0'` and no route performs any authentication. Two endpoints make this a remote-code-execution surface for anyone on the same network:

- `POST /api/tasks` — creates a task whose context becomes an agent CLI prompt executed in the workspace (`runner.ts` / `workflow.ts` spawn the agent with attacker-controlled text).
- `POST /api/tools` — the "tool forging" endpoint registers arbitrary shell commands.

#### Solution design

1. Default to loopback; make network exposure an explicit opt-in that requires a token.
2. Enforce the token in a single Fastify `onRequest` hook so every route (and WebSocket upgrade) is covered — no per-route changes needed.

#### Implementation steps

1. **Change the default host** in `src/server/index.ts`:
   ```ts
   const DEFAULT_HOST = '127.0.0.1';
   ```
2. **Add token settings.** Read `FORMIC_AUTH_TOKEN` from env (and optionally from `~/.formic/config.json` via `configStore.ts`).
3. **Refuse unsafe exposure at startup.** In `startServer()`, after resolving `host`:
   ```ts
   const authToken = process.env.FORMIC_AUTH_TOKEN ?? '';
   const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
   if (!isLoopback && authToken.length === 0) {
     console.error('[Server] Refusing to bind to a non-loopback host without FORMIC_AUTH_TOKEN set');
     process.exit(1);
   }
   ```
4. **Add the auth hook** (register before routes, skip when bound to loopback so local UX is unchanged):
   ```ts
   if (!isLoopback) {
     fastify.addHook('onRequest', async (request, reply) => {
       const header = request.headers.authorization ?? '';
       if (header !== `Bearer ${authToken}`) {
         return reply.status(401).send({ error: 'Unauthorized' });
       }
     });
   }
   ```
   Note: `@fastify/websocket` upgrades pass through `onRequest`, so WS routes are covered by the same hook.
5. **Client:** if the UI must work remotely, store the token (e.g., prompt once, keep in `localStorage`) and send `Authorization` on `fetch` and as a `?token=` query param on WS connect (then also accept the query param in the hook for upgrade requests). If remote UI isn't a supported use case yet, skip this and document SSH tunneling instead.
6. **Docker:** `docker-compose.yml` publishes the port, so container deployments intentionally expose the API — document that `FORMIC_AUTH_TOKEN` is required there and inject it via compose `environment:`.
7. **Docs:** update `README.md` (breaking change: remote access now needs `HOST=0.0.0.0 FORMIC_AUTH_TOKEN=...`).

#### Acceptance criteria / verification

- [ ] Fresh start with no env vars binds to `127.0.0.1` (check the startup banner).
- [ ] `HOST=0.0.0.0 npm run dev` **without** a token exits with a clear error.
- [ ] With a token set, requests without `Authorization: Bearer <token>` get `401`; with it, `200`.
- [ ] Local (loopback) requests need no token; `python test/run_tests.py` still passes unchanged.
- [ ] `npx tsc --noEmit` passes.

---

### Issue 2 — Kill-switch `git reset --hard` destroys concurrent tasks' work 🔴

**Suggested Formic task:** `Fix: Scope kill-switch rollback to the failing task's declared files` — priority `high`, type `standard`

#### Problem

`workflow.ts:877` (`executeCriticAndRetry`): after 3 failed verifications the critic runs:

```ts
await execFileAsync('git', ['reset', '--hard', task.safePointCommit], { cwd: getWorkspacePath() });
```

This resets the **entire shared workspace** to the failing task's safe point. With `maxConcurrentTasks > 1`:

- Every other running task's uncommitted changes are destroyed.
- The branch pointer moves back **past any commits made after the safe point** — including other tasks' auto-save commits, which become orphaned.

#### Solution design

Replace the whole-workspace hard reset with a **file-scoped revert** limited to the failing task's declared exclusive files, using the already-safe `checkoutWorkspaceFiles()` from `src/server/utils/safeGit.ts` (the watchdog already uses this exact pattern at `watchdog.ts:64-73`). Never move the branch pointer.

#### Implementation steps

1. **Add a scoped revert helper** to `safeGit.ts` that checks files out *from a specific commit* (checkout-from-commit doesn't move HEAD, unlike `reset --hard`):
   ```ts
   /** Restore workspace files to their content at a given commit, without moving HEAD. */
   export async function checkoutFilesFromCommit(
     commit: string,
     filePaths: string[],
     workspacePath: string
   ): Promise<void> {
     const relativePaths = filePaths.map(filePath => {
       const relativePath = getSafeWorkspaceRelativePath(filePath, workspacePath);
       if (!relativePath) throw new Error(`Path is outside the workspace: ${filePath}`);
       return relativePath;
     });
     if (relativePaths.length === 0) return;
     await execFileAsync('git', ['checkout', commit, '--', ...relativePaths], { cwd: workspacePath });
   }
   ```
   Also validate `commit` against `/^[0-9a-f]{7,40}$/i` before use.
2. **Rewrite the kill-switch branch** in `executeCriticAndRetry` (`workflow.ts:872-902`):
   - Gather the file scope: `task.declaredFiles?.exclusive ?? []`. Files created by the task after the safe point will fail checkout-from-commit; catch per-file and `git rm`-equivalent is overkill — acceptable to log and leave them (they'll be flagged at review).
   - Replace `git reset --hard` with `checkoutFilesFromCommit(task.safePointCommit, exclusiveFiles, getWorkspacePath())`.
   - If the task has **no** `declaredFiles` (quick tasks skip declare), fall back to reverting nothing automatically. Instead, surface the safe-point hash in the kill-switch notification so a human can decide: `Workspace NOT auto-reverted (no declared files). Safe point: <hash>`.
3. **Guard the legacy path too:** search for any other `reset --hard` usage (`grep -rn "reset', '--hard\|reset --hard" src/`) and apply the same treatment. Check `src/server/utils/gitUtils.ts` in particular.
4. **Keep** the existing behavior of stopping the queue processor and broadcasting the kill switch — that part is correct.

#### Acceptance criteria / verification

- [ ] With two concurrent tasks (task A running, task B hitting the kill switch), task A's uncommitted changes survive B's rollback. (Manual test: `maxConcurrentSessions: 2`, seed B with a task that always fails verify.)
- [ ] `git log` after a kill-switch event shows no branch movement (compare `git rev-parse HEAD` before/after).
- [ ] Files B modified are restored to their safe-point content; files B created are reported but untouched.
- [ ] No remaining `reset --hard` against the shared workspace: `grep -rn "reset" src/ | grep -v node_modules` reviewed.
- [ ] `npx tsc --noEmit` passes; `python test/run_tests.py` passes.

---

### Issue 3 — Lost-update race on board state 🔴

**Suggested Formic task:** `Fix: Serialize board read-modify-write cycles with a mutation mutex` — priority `high`, type `standard`

#### Problem

Every mutator in `src/server/services/store.ts` (`createTask`, `updateTask`, `updateTaskStatus`, `appendTaskLogs`, `queueTask`, `deleteTask`, `recoverStuckTasks`, `unblockSiblingTasks`) follows the pattern:

```ts
const board = await loadBoard();   // 1. read snapshot
// ... mutate snapshot ...
await saveBoard(board);            // 2. write snapshot
```

The existing `saveLock` (store.ts:19) only serializes step 2. Two concurrent mutators both read the same snapshot; whichever saves second **silently erases** the first one's change. Concurrent mutators are the norm here: parallel workflows, the watchdog, the queue processor, WebSocket handlers, and HTTP routes all mutate the board. `workflow.ts` also does its own inline `loadBoard()`→`saveBoard()` in several places (e.g., lines 397-402, 863-869, 1726-1755, 1764-1768, 1796-1801), which race the same way.

This is the most likely root cause of historical board corruption/status-flapping incidents.

#### Solution design

Introduce a single **board mutation mutex** that serializes the *entire* read-modify-write cycle, and convert every mutator to go through it. Keep `saveBoard()` public API for the rare full-replace case (recovery), but make all incremental mutations use the new primitive.

#### Implementation steps

1. **Add the primitive** to `store.ts`:
   ```ts
   /** Serializes entire load→mutate→save cycles. All incremental board
    *  mutations MUST go through this to prevent lost updates. */
   let mutateLock: Promise<unknown> = Promise.resolve();

   export async function withBoard<T>(
     mutator: (board: Board) => T | Promise<T>
   ): Promise<T> {
     const run = async (): Promise<T> => {
       const board = await loadBoard();
       const result = await mutator(board);
       await saveBoard(board);
       return result;
     };
     const resultPromise = mutateLock.then(run, run);
     mutateLock = resultPromise.catch(() => {});
     return resultPromise;
   }
   ```
   Design choices to preserve:
   - The mutator receives the board and mutates it in place; `withBoard` always saves. If a mutator needs to abort without saving, have it throw a typed `AbortMutation` error that `withBoard` catches and swallows (add only if needed).
   - `saveBoard` keeps its own `saveLock` and validation — belt and braces.
2. **Convert `store.ts` mutators.** Each becomes a thin wrapper, e.g.:
   ```ts
   export async function updateTaskStatus(taskId: string, status: Task['status'], pid?: number | null, caller?: string): Promise<Task | null> {
     const updated = await withBoard(board => {
       const task = board.tasks.find(t => t.id === taskId);
       if (!task) return null;
       // ... existing mutation logic, unchanged ...
       return task;
     });
     // ... existing post-save side effects (logging, broadcast, unblockSiblingTasks) stay OUTSIDE withBoard ...
     return updated;
   }
   ```
   ⚠️ **Deadlock hazard:** side effects that themselves mutate the board (`appendTaskLogs`, `unblockSiblingTasks` → `queueTask`) must run **after** `withBoard` returns, never inside the mutator, or they will deadlock on the mutex. The current code already runs them after `saveBoard`, so keep that shape. Alternatively make the lock re-entrant — not worth the complexity.
3. **Convert the inline load/save sites in `workflow.ts`.** Grep for `loadBoard()` in `workflow.ts` and replace each load→mutate→save block with a `withBoard` call. Sites found in this audit: ~397 (declaredFiles), ~863 (retryCount), ~1726 (yieldCount/resumeFromStep), ~1764 (clear resumeFromStep), ~1796 (fileConflicts). Read-only `loadBoard()` calls can stay as-is.
4. **Guard against reintroduction.** Add a comment block on `saveBoard` stating that direct load→mutate→save is forbidden; optionally un-export `saveBoard` and expose `replaceBoard()` for the two legitimate full-replace callers (corruption recovery inside `loadBoard`, bootstrap).
5. **Unit test the race** (`test/unit/`, `node:test` style, run with `npx tsx --test`):
   ```ts
   // Fire 50 concurrent updateTask calls setting distinct fields / statuses on
   // distinct tasks; assert all 50 changes are present in the final board.
   ```
   Without the fix this test fails reliably; with it, it must pass.

#### Acceptance criteria / verification

- [ ] New concurrency unit test passes (and demonstrably fails when `withBoard` is bypassed).
- [ ] No remaining `loadBoard()` immediately followed by mutation + `saveBoard()` outside `withBoard` (manual grep review of `loadBoard(` call sites).
- [ ] `python test/run_tests.py` passes; `npx playwright test` passes (board CRUD unchanged externally).
- [ ] `npx tsc --noEmit` passes.

---

### Issue 4 — Preemption & deadlock resolution release leases without stopping the holder 🔴

**Suggested Formic task:** `Fix: Stop holder processes before force-releasing leases in preemption and deadlock resolution` — priority `high`, type `standard`

#### Problem

Three related defects in `src/server/services/leaseManager.ts`:

1. **Dead yield signal.** `preemptLease()` sets `holderLease.yieldSignal = true` (line 390), but **nothing in the codebase reads `yieldSignal`** (verified by grep — only the type definition and the write site exist). The "voluntary yield" poll only succeeds if the holder coincidentally finishes within 10 s.
2. **Force-release without stopping the process.** After the poll times out, `preemptLease` calls `releaseLeases(holderId)` (line 409) while the holder's agent process is still running and writing files. The preempting task then acquires the lease → **two agents writing the same files**.
3. **Deadlock victim keeps running.** `detectDeadlock()` (lines 482-484) releases the victim's leases and sets it to `queued` — but never stops its workflow process. The zombie keeps executing without lease protection, and the queue processor may dispatch a *second* instance of the same task.

The correct pattern already exists in the watchdog's expired-lease handler (`watchdog.ts:58-79`): **stop → revert → release → re-queue**.

#### Solution design

Extract the watchdog's stop→revert→release→requeue sequence into a shared helper and use it in all three force-teardown paths (watchdog expiry, preemption, deadlock resolution). Remove the dead `yieldSignal` mechanism.

#### Implementation steps

1. **Create the shared teardown helper.** Because `leaseManager.ts` must not import `workflow.ts` (circular import: workflow → leaseManager), use the existing decoupling pattern — either:
   - **(a) Callback registration** (matches the `registerActiveTaskPredicate` pattern this codebase has used before):
     ```ts
     // leaseManager.ts
     type TaskTeardownFn = (taskId: string, reason: string) => Promise<void>;
     let teardownTask: TaskTeardownFn | null = null;
     export function registerTaskTeardown(fn: TaskTeardownFn): void { teardownTask = fn; }
     ```
     `workflow.ts` (or a new small `taskTeardown.ts` service) registers the real implementation at startup.
   - **(b)** Put the helper in a new `src/server/services/taskTeardown.ts` that imports both `workflow.ts` and `leaseManager.ts`, and move `preemptLease`/`detectDeadlock`'s *resolution* halves there (detection stays in leaseManager, resolution moves up a layer). **Option (b) is cleaner** — detection and process control are different responsibilities.
2. **Implement the teardown** (mirrors `watchdog.ts:58-79`):
   ```ts
   export async function teardownTask(taskId: string, reason: string): Promise<void> {
     const stopped = await stopWorkflow(taskId);          // kills the step process, sets stoppedWorkflows
     if (!stopped) await stopAgent(taskId);               // legacy runner path
     const files = getLeasesByTask(taskId)
       .filter(l => l.leaseType === 'exclusive')
       .map(l => l.filePath);
     if (files.length > 0) {
       try { await checkoutWorkspaceFiles(files, getWorkspacePath()); }
       catch (err) { console.warn(`[Teardown] Failed to revert files for ${taskId}:`, err instanceof Error ? err.message : 'Unknown error'); }
     }
     releaseLeases(taskId);
     clearWait(taskId);
     await updateTaskStatus(taskId, 'queued', null, `teardown.${reason}`);
   }
   ```
3. **Fix `preemptLease`:** replace the `yieldSignal` write + 10 s poll + bare `releaseLeases(holderId)` with a call to the teardown helper. Keep the priority-rank guard (only preempt lower-priority holders). Decide the wait policy explicitly: either preempt immediately (simplest, recommended — the poll bought nothing since nobody reads the signal) or keep a short grace period implemented as "check again once after N seconds whether the holder finished on its own".
4. **Fix `detectDeadlock`:** replace `releaseLeases(victimId); clearWait(victimId); await updateTaskStatus(...)` with the teardown helper.
5. **Remove `yieldSignal`:** delete the field from `FileLease` in `src/types/index.ts:29` and the write in `preemptLease`. Grep to confirm zero remaining references.
6. **Refactor the watchdog** (`watchdog.ts:58-79`) to call the same helper so there is exactly one teardown code path.
7. **Tests** (`test/unit/`, plus extend `test/test_concurrency_daily.py` if the server-level harness supports it):
   - Preempting a low-priority holder stops its process before the high-priority task acquires the lease (assert via `isWorkflowRunning(holder) === false` before grant).
   - Deadlock resolution: after a cycle is resolved, the victim has no live process and no leases.

#### Acceptance criteria / verification

- [ ] `grep -rn "yieldSignal" src/` returns nothing.
- [ ] Preemption path: holder process is confirmed stopped (not just leases released) before the requester proceeds.
- [ ] Deadlock victim is stopped, its exclusive files reverted, and it is re-queued exactly once.
- [ ] Watchdog, preemption, and deadlock resolution all share one teardown implementation.
- [ ] `npx tsc --noEmit`, unit tests, and `python test/run_tests.py --agi` pass.

---

### Issue 5 — Capped-out tasks bounce in the queue forever 🟡

**Suggested Formic task:** `Fix: Transition tasks that exceed retry/yield caps out of the queue` — priority `medium`, type `quick`

#### Problem

`src/server/services/queueProcessor.ts:100-104`:

```ts
if ((nextTask.retryCount ?? 0) >= engineConfig.maxExecutionRetries) {
  console.warn(`[QueueProcessor] Task ${nextTask.id} exceeded max execution retries (...), skipping — set to todo to stop bouncing`);
  continue;   // ← the log says "set to todo" but the code only skips
}
```

The same pattern applies to the `maxYieldCount` check at lines 95-98. Result: a capped-out task stays `queued` forever, is re-inspected and re-logged every poll cycle (default every 5 s), and the user is never told the task gave up.

#### Solution design

When a cap is exceeded, transition the task to `todo`, record why, and notify the board — once, not every cycle.

#### Implementation steps

1. In both cap branches, replace `continue` with:
   ```ts
   console.warn(`[QueueProcessor] Task ${nextTask.id} exceeded max execution retries (${engineConfig.maxExecutionRetries}) — moving to todo`);
   try {
     await updateTask(nextTask.id, { yieldReason: `cap-exceeded:retries(${nextTask.retryCount})` });
     await updateTaskStatus(nextTask.id, 'todo', null, 'queueProcessor.retry_cap_exceeded');
     broadcastBoardUpdate();
   } catch (err) {
     console.warn('[QueueProcessor] Failed to demote capped task:', err instanceof Error ? err.message : 'Unknown error');
   }
   continue;
   ```
   (Equivalent block for the yield-cap branch with `cap-exceeded:yields(...)` and caller tag `queueProcessor.yield_cap_exceeded`.) Import `broadcastBoardUpdate` from `boardNotifier.js`.
2. **Reset counters on manual re-queue** so a human can retry a capped task: in `store.ts` `queueTask()`, clear `retryCount: null` and `yieldCount: 0` when transitioning `todo → queued`. Without this, a re-queued task is immediately demoted again.
3. **UI (optional but recommended):** the task card already carries `yieldReason` — verify `src/client/index.html` renders it on todo cards so the user sees *why* the task fell out of the queue.
4. **Unit test:** a queued task with `retryCount = maxExecutionRetries` is transitioned to `todo` on the next `processQueue()` and is not re-logged on subsequent cycles.

#### Acceptance criteria / verification

- [ ] Capped task moves to `todo` with a populated `yieldReason` within one poll cycle.
- [ ] Log message appears once per cap event, not once per poll.
- [ ] Dragging the task back to Queued gives it a fresh set of retries/yields.
- [ ] `npx tsc --noEmit` and `python test/run_tests.py` pass.

---

### Issue 6 — Deadlock detection blind to shared holders and multi-file waits 🟡

**Suggested Formic task:** `Fix: Extend deadlock wait-graph to multi-file waits and shared-lease holders` — priority `medium`, type `standard`

#### Problem

Two structural gaps in the wait-for graph (`src/server/services/leaseManager.ts`):

1. **Single-file waits.** `waitForMap` is `Map<taskId, string>` (line 26) and the only caller records just the *first* conflicting file: `recordWait(taskId, conflictingFiles[0])` (`workflow.ts:424-425`). A task blocked on files held by two different tasks contributes only one edge — cycles through the second edge are invisible.
2. **Exclusive-only holder resolution.** `detectDeadlock` resolves holders with `leaseStore.get(filePath)` (line 429), which only matches bare-key **exclusive** leases. Shared leases are stored under `` `${filePath}::${taskId}` `` keys and are never matched, so a cycle in which the blocking holder has a *shared* lease (task A wants exclusive on F; task B holds shared on F and waits on something A holds) is never detected. This is the known-failing scenario `test_shared_holder_cycle_detected` in `test/test_concurrency_daily.py`.

#### Solution design

- `waitForMap` becomes `Map<taskId, Set<string>>` (all files the task is blocked on).
- Holder resolution returns **all** holders of a file: the bare-key exclusive holder plus every `file::taskId` shared holder.
- The wait graph becomes `Map<taskId, Set<taskId>>` (multiple outgoing edges), and cycle detection switches from the functional-graph walk to a standard iterative DFS with a recursion stack (white/grey/black coloring).

#### Implementation steps

1. **Change the store and API:**
   ```ts
   const waitForMap = new Map<string, Set<string>>();

   export function recordWait(taskId: string, filePaths: string[]): void {
     waitForMap.set(taskId, new Set(filePaths));
   }
   ```
   Update the caller (`workflow.ts:424-425`) to pass the full `leaseResult.conflictingFiles` array. `clearWait` is unchanged.
2. **Add a holder-resolution helper:**
   ```ts
   function getFileHolders(filePath: string): Set<string> {
     const holders = new Set<string>();
     const exclusive = leaseStore.get(filePath);
     if (exclusive) holders.add(exclusive.taskId);
     for (const [key, lease] of leaseStore.entries()) {
       if (key.startsWith(`${filePath}::`)) holders.add(lease.taskId);
     }
     return holders;
   }
   ```
3. **Rebuild the graph in `detectDeadlock`:**
   ```ts
   const waitGraph = new Map<string, Set<string>>();
   for (const [waitingTaskId, filePaths] of waitForMap.entries()) {
     const edges = new Set<string>();
     for (const filePath of filePaths) {
       for (const holder of getFileHolders(filePath)) {
         if (holder !== waitingTaskId) edges.add(holder);
       }
     }
     if (edges.size > 0) waitGraph.set(waitingTaskId, edges);
   }
   ```
4. **Replace the cycle walk** with iterative DFS + recursion stack (the current walk assumes ≤ 1 outgoing edge per node and will miss cycles in the new multi-edge graph). Collect each distinct cycle once; dedupe by sorted-members key so one cycle isn't resolved twice.
5. **Victim resolution:** unchanged (lowest priority in the cycle) — but route it through the Issue 4 teardown helper. **Do this task after Issue 4.**
6. **Tests:**
   - Un-skip / make pass `test_shared_holder_cycle_detected` in `test/test_concurrency_daily.py`.
   - Unit tests for: 2-node cycle via shared holder, 3-node cycle where one edge is the task's *second* conflicting file, no-cycle configurations (assert `null`).

#### Acceptance criteria / verification

- [ ] `test_shared_holder_cycle_detected` passes (`python test/run_tests.py --agi`, with `no_proxy='*'` and a server running local code — see the test-harness note in §5).
- [ ] Multi-file wait cycle (edge via `conflictingFiles[1]`) is detected in a unit test.
- [ ] Exactly one victim per distinct cycle is re-queued.
- [ ] `npx tsc --noEmit` and existing unit tests pass.

---

### Issue 7 — Task IDs are reused after deletion / board reset 🟡

**Suggested Formic task:** `Fix: Use a persistent monotonic counter for task ID generation` — priority `medium`, type `quick`

#### Problem

`store.ts:288-294` derives the next ID from the current max:

```ts
const maxId = board.tasks.reduce((max, task) => { ... }, 0);
const taskId = `t-${maxId + 1}`;
```

Delete the highest-numbered task (or reset the board) and the next created task **reuses that ID**. Task docs folders (`.formic/tasks/t-N-slug/`), preserved-history folders, log files, `fixForTaskId`, and `parentGoalId`/`childTaskIds` references are all keyed by ID — collisions across "board epochs" cause cross-contaminated docs and broken references (this failure mode has been observed in practice on this project).

#### Solution design

Persist a monotonic counter in `board.meta.nextTaskId` that only ever increases. Seed it from `max(existing) + 1` on first use for backward compatibility with existing boards.

#### Implementation steps

1. **Type:** add `nextTaskId?: number` to the board `meta` type in `src/types/index.ts`.
2. **Generation** (inside `createTask`, which after Issue 3 runs inside `withBoard` so the increment is race-free):
   ```ts
   const seeded = board.meta.nextTaskId ?? board.tasks.reduce((max, t) => {
     const num = parseInt(t.id.replace('t-', ''), 10);
     return Number.isFinite(num) && num > max ? num : max;
   }, 0) + 1;
   const taskId = `t-${seeded}`;
   board.meta.nextTaskId = seeded + 1;
   ```
3. **Never decrease it:** `deleteTask` must not touch the counter. Board recovery (`loadBoard` backup-restore path) keeps whatever counter the restored board has; the seeding fallback covers backups that predate the field.
4. **Validation:** extend `validateBoard` to accept `nextTaskId` as `number | undefined` (reject non-numeric values).
5. **Bootstrap task:** `bootstrap.ts` uses a fixed `BOOTSTRAP_TASK_ID` — confirm it doesn't collide with the `t-N` scheme (it uses a distinct slug-style ID; if it's `t-0`-style, exclude it from seeding).
6. **Unit test:** create t-1..t-3, delete t-3, create again → new task is `t-4`, and `.formic/tasks/` contains no reused folder name.

#### Acceptance criteria / verification

- [ ] Create→delete→create never yields a duplicate ID.
- [ ] Existing boards without `nextTaskId` keep working (seeding path covered by a test).
- [ ] `validateBoard` accepts old and new board shapes.
- [ ] `npx tsc --noEmit` and `python test/run_tests.py` pass.

---

### Issue 8 — `PUT /api/tasks/:id` mass assignment 🟡

**Suggested Formic task:** `Fix: Whitelist updatable fields and validate status transitions on task update` — priority `medium`, type `standard`

#### Problem

`routes/tasks.ts:62-71` passes `request.body` straight into `updateTask()`, which spreads it into the stored task (`store.ts:343-347`). Consequences:

- Clients can overwrite internal fields: `id`, `pid`, `agentLogs`, `retryCount`, `yieldCount`, `workflowStep`, `safePointCommit`, `declaredFiles`, `createdAt`, timestamps.
- Overwriting `id` creates duplicate/orphaned IDs that break every ID-keyed subsystem.
- A `status` change (e.g., `running → done`) is applied **without stopping the workflow process or releasing leases** — the agent keeps running against a task the board says is finished.

#### Solution design

Whitelist user-updatable fields at the route boundary; validate status values against `VALID_TASK_STATUSES`; and route status changes through side-effect-aware logic (stop process / release leases when leaving an active state).

#### Implementation steps

1. **Whitelist at the route** (`routes/tasks.ts`):
   ```ts
   const UPDATABLE_FIELDS = ['title', 'context', 'priority', 'status', 'type'] as const;

   fastify.put<{ Params: { id: string }; Body: UpdateTaskInput }>('/api/tasks/:id', async (request, reply) => {
     const { id } = request.params;
     const input: UpdateTaskInput = {};
     for (const field of UPDATABLE_FIELDS) {
       if (request.body[field] !== undefined) (input as Record<string, unknown>)[field] = request.body[field];
     }
     // ... validation, then updateTask(id, input)
   });
   ```
2. **Validate values:** `status` ∈ `VALID_TASK_STATUSES`, `priority` ∈ `VALID_TASK_PRIORITIES`, `type` ∈ `{'standard','quick','goal'}` — return `400` with a specific message otherwise (both constants are already exported from `store.ts`).
3. **Handle active-state exits.** Before applying a status change away from an active state (`briefing|planning|declaring|running|architecting|verifying`):
   ```ts
   const current = await getTask(id);
   if (current && ACTIVE_STATUSES.has(current.status) && input.status && input.status !== current.status) {
     await stopWorkflow(id) || await stopAgent(id);
     releaseLeases(id);
   }
   ```
   (After Issue 4, call the shared teardown helper instead — without the re-queue step.)
4. **Fastify schema (recommended):** attach a JSON schema to the route so Fastify rejects unknown/invalid bodies before the handler runs — this is the idiomatic Fastify approach and self-documents the contract.
5. **Audit other write routes** for the same pattern: `POST /api/tasks` already destructures explicitly (fine); check `routes/board.ts`, `routes/config.ts`, subtask update at `routes/tasks.ts:384-385`.
6. **Tests:** extend the Python API suite — `PUT` with `{"id": "t-999", "pid": 12345, "agentLogs": []}` must not change those fields; `PUT {"status": "bogus"}` → 400; `PUT {"status": "done"}` on a running task stops it and releases its leases.

#### Acceptance criteria / verification

- [ ] Internal fields are immutable via the API (test asserts values unchanged).
- [ ] Invalid `status`/`priority`/`type` → `400` with a descriptive error.
- [ ] Forcing a running task to `done`/`todo` leaves no live process (`isWorkflowRunning` false) and no leases (`getLeasesByTask` empty).
- [ ] `python test/run_tests.py` (including new cases) and `npx tsc --noEmit` pass.

---

### Issue 9 — Lease lifecycle blind spots 🟡

**Suggested Formic task:** `Fix: Emit and persist lease expiry, persist renewals, and release stale leases on startup recovery` — priority `medium`, type `standard`

#### Problem

Three related gaps in `src/server/services/leaseManager.ts` / `store.ts`:

1. **Silent expiry.** `cleanExpiredLeases()` (lines 208-215) deletes leases with no `LEASE_RELEASED` event (waiting tasks aren't woken until the next poll) and no `persistLeases()` (so `leases.json` on disk claims leases that no longer exist — and a crash+restart would *restore* them via `restoreLeases()`).
2. **Unpersisted renewal.** `renewLeases()` (lines 141-158) extends expiry in memory only. After a restart, `restoreLeases()` loads the *stale, shorter* expiries from disk; a long-running recovered task can lose its leases early.
3. **Stale restart assumption.** `recoverStuckTasks()` (`store.ts:606-645`) still documents "In-memory leases are naturally cleared on server restart, so no explicit releaseLeases() is needed." That was true before `restoreLeases()` was added — now it's false: the watchdog restores non-expired leases for tasks that recovery just re-queued, and those stale leases block other tasks (and re-block the recovered task's own re-dispatch competitors) until expiry.

#### Implementation steps

1. **Expiry with side effects.** Rework `cleanExpiredLeases` to collect what it deletes and notify/persist once when anything was removed:
   ```ts
   function cleanExpiredLeases(): void {
     const now = Date.now();
     const releasedByTask = new Map<string, string[]>();
     for (const [key, lease] of leaseStore.entries()) {
       if (new Date(lease.expiresAt).getTime() <= now) {
         leaseStore.delete(key);
         const files = releasedByTask.get(lease.taskId) ?? [];
         if (lease.leaseType === 'exclusive') files.push(lease.filePath);
         releasedByTask.set(lease.taskId, files);
       }
     }
     if (releasedByTask.size > 0) {
       for (const [taskId, files] of releasedByTask.entries()) {
         internalEvents.emit(LEASE_RELEASED, taskId, files);
       }
       persistLeases().catch(e => console.warn('[LeaseManager] persist error:', e));
     }
   }
   ```
   Note: `cleanExpiredLeases` is called from hot read paths (`getAllLeases`, `isFileLeased`, `acquireLeases`) — the emit/persist block must only run when something was actually deleted, as above, to avoid write amplification.
   ⚠️ Coordination with the watchdog: the watchdog's `scanExpiredLeases` relies on `getExpiredLeases()` returning expired-but-present leases so it can stop/revert/re-queue the owner. Emitting `LEASE_RELEASED` here wakes waiters *before* the watchdog has reverted the holder's files. Decide the policy explicitly: either (a) keep silent deletion but call `persistLeases()` only (minimal fix — disk stays truthful, watchdog handles wake-ups), or (b) full emit as sketched, and make the watchdog's teardown tolerate already-cleaned leases. **Option (a) is the safe minimal change; document the choice in the code.**
2. **Persist renewals.** Add to `renewLeases` (after the loop, only when `renewed > 0`):
   ```ts
   persistLeases().catch(e => console.warn('[LeaseManager] persist error:', e));
   ```
   Renewals fire every 2 min per running task (`workflow.ts:622-626`) — with the atomic tmp+rename writer and the mutex this write volume is fine.
3. **Startup recovery releases stale leases.** In `recoverStuckTasks()` (or better: in the startup sequence right after `restoreLeases()` — check `src/server/index.ts` ordering), for every task that was re-queued, call `releaseLeases(taskId)` and fix the stale comment. Ensure ordering: `restoreLeases()` must run **before** `recoverStuckTasks()` for the release to see the restored leases — verify the actual startup order in `index.ts`/`watchdog.ts` (`restoreLeases` currently runs inside `startWatchdog`, which may race recovery; consider hoisting `restoreLeases()` into the startup sequence explicitly).
4. **Tests:** unit tests for expiry-persists-to-disk, renewal-persists-to-disk (read `leases.json` back), and recovery-releases-leases (seed `leases.json` with a lease for a `running` task, boot the recovery path, assert the lease is gone).

#### Acceptance criteria / verification

- [ ] After an in-memory expiry sweep, `leases.json` no longer lists the expired leases.
- [ ] After `renewLeases`, `leases.json` reflects the new `expiresAt`.
- [ ] Server restart with a stuck `running` task: task is re-queued **and** holds zero leases afterward.
- [ ] Watchdog expired-lease teardown behavior is unchanged (its Python suite still passes).
- [ ] `npx tsc --noEmit`, unit tests, `python test/run_tests.py --agi` pass.

---

### Issue 10 — `console.log` sweep ⚪

**Suggested Formic task:** `Refactor: Replace console.log with console.warn/error per logging guidelines` — priority `low`, type `quick`

#### Problem

The project guidelines forbid `console.log` in production code (use `console.warn` for non-critical, `console.error` for critical, always with a `[ServiceName]` prefix). ~25 server files currently violate this, including `leaseManager.ts`, `workflow.ts`, `queueProcessor.ts`, `runner.ts`, `store.ts` adjacents. Practical impact: log-level-based filtering in Docker/hosted setups can't separate operational noise from real warnings.

#### Implementation steps

1. Inventory: `grep -rn "console\.log" src/server --include="*.ts"`.
2. For each hit, classify: routine operational info → `console.warn`; genuine failure → `console.error`. Ensure every message has a `[ServiceName]` prefix while you're there.
3. Do **not** touch `src/client/` (browser console) or `src/cli/` banner output (user-facing CLI output is legitimately `console.log` — confirm with `banner.ts` conventions before changing CLI files).
4. Guard against regression: add a lint rule if ESLint is ever introduced; until then, add a check to the Python test suite or a simple CI grep:
   ```bash
   ! grep -rn "console\.log" src/server --include="*.ts"
   ```
5. Schedule this task **after** all other tasks in a batch — it touches nearly every file and will conflict with everything.

#### Acceptance criteria

- [ ] Zero `console.log` under `src/server/`.
- [ ] All messages carry a `[ServiceName]` prefix.
- [ ] `npx tsc --noEmit` and `python test/run_tests.py` pass.

---

### Issue 11 — Spawn-failure placeholder marks task `running` with `pid: 0` ⚪

**Suggested Formic task:** `Fix: Handle agent spawn failure without marking the task running` — priority `low`, type `quick`

#### Problem

`runner.ts:204-211`: when `spawn()` yields no PID, the code registers the dead child in `activeProcesses`, sets the task to `running` with `pid: 0`, and relies on the `error` event to clean up. If the error event is delayed or never fires, the task occupies a concurrency slot and shows as running until watchdog/startup recovery notices.

#### Implementation steps

1. Instead of optimistic `running`, wait for spawn confirmation using the `spawn` event:
   ```ts
   await new Promise<void>((resolve, reject) => {
     child.once('spawn', () => resolve());
     child.once('error', (err) => reject(err));
   });
   ```
   On rejection: don't add to `activeProcesses`, release leases, set status to `todo` with a descriptive broadcast (reuse the existing error-handler messaging), and return a failure result instead of `{ pid: 0 }` (adjust the caller in `routes/tasks.ts` to surface a 500 with the message).
2. Keep the existing `error` handler for post-spawn failures.
3. Test: point `agentAdapter` at a nonexistent command; `POST /api/tasks/:id/run` returns an error, task stays `todo`, no `activeProcesses` entry leaks.

#### Acceptance criteria

- [ ] Spawn failure never produces a `running` task or occupies a slot.
- [ ] The API caller receives an actionable error message.

---

### Issue 12 — Restart-driven dispatch loop (silent recovery re-queue + self-hosting hazard) 🟡

**Suggested Formic task:** `Fix: Add recovery accounting, orphan cleanup, and a self-hosting watch-mode guard to startup recovery` — priority `medium`, type `standard`
**Depends on:** Issue 5 (uses the cap-demotion path). Complements Issue 9 step 3 (recovery lease release).

#### Problem — live incident, 2026-07-10

Task t-1 ("restrict server binding") edits `src/server/index.ts` — the Formic server's own entry point — while the server ran under `npm run dev` (`tsx watch src/server/index.ts`) against its own repo. The resulting feedback loop dispatched the full workflow **9 times in 7 minutes**:

1. The agent edits `index.ts` → tsx watch restarts the server, killing/orphaning the running workflow mid-execute.
2. On boot, `recoverStuckTasks()` (`store.ts:620-645`) sees the task in an active state and re-queues it **silently** — it writes `task.status = 'queued'` directly, producing no `[StatusTransition]` log line and incrementing no counter.
3. The queue processor immediately re-dispatches → new declare → new execute → the agent edits `index.ts` again → restart → repeat forever.

Compounding defects observed in the incident:

- **No accounting:** `recoverStuckTasks` does not increment `retryCount`, so no cap (even after Issue 5) ever halts a recovery-driven loop. The dispatch-loop **fingerprint** in the logs is repeated `queued → briefing | caller=workflow.executeFullWorkflow.init` with *no preceding* `running → queued` transition.
- **Orphaned agents:** the agent CLI processes are children of the server; when tsx kills the server they are orphaned, not killed, and **keep editing files concurrently** with newly dispatched instances.
- **Lease pollution:** each generation's declare run re-acquires leases (same-task requests never conflict), and `restoreLeases()` resurrects prior generations' leases across restarts — `leases.json` accumulated overlapping same-task leases with mismatched types (`README.md` held both shared *and* exclusive, with different expiries).

#### Solution design

Make startup recovery observable, bounded, and side-effect-clean; kill orphans; and warn loudly on the self-hosting-with-watch configuration that triggers the loop.

#### Implementation steps

1. **Recovery accounting.** In `recoverStuckTasks()`:
   - Route the status change through `updateTaskStatus(task.id, 'queued', null, 'recovery.startup')` instead of a direct field write, so the `[StatusTransition]` log line and broadcast happen like every other transition. (After Issue 3, this runs inside the board mutex — call it *after* the scan loop collects IDs, not while holding a stale snapshot.)
   - Add a `recoveryCount` field to `Task` (`src/types/index.ts`; include `recoveryCount: null` in `createTask` defaults, mirror the `retryCount` pattern) and increment it per recovery.
2. **Bound the loop.** In the queue processor, alongside the Issue 5 cap checks, demote tasks whose `recoveryCount` exceeds a threshold (suggest `3`, or reuse `engineConfig.maxExecutionRetries`) to `todo` with `yieldReason: 'cap-exceeded:recoveries(N)'` — same demotion block as Issue 5, same counter-reset on manual re-queue in `queueTask()`.
3. **Orphan cleanup on recovery.** The board persists each active task's `pid`. Before re-queuing a recovered task, if `task.pid` is set, attempt best-effort termination:
   ```ts
   if (task.pid) {
     try { process.kill(task.pid, 'SIGTERM'); console.warn(`[Recovery] Sent SIGTERM to orphaned process ${task.pid} for task ${task.id}`); }
     catch { /* ESRCH — already gone; expected on clean restarts */ }
   }
   ```
   Note the PID-reuse caveat: on long gaps the PID may belong to an unrelated process. Acceptable for a local dev tool; mention it in the code comment. (Do **not** swallow silently — the empty catch above is the one documented exception; add the `// ESRCH` comment to satisfy the no-empty-catch rule.)
4. **Release recovered tasks' restored leases** — this is Issue 9 step 3; if Issue 9 ships first, just verify ordering (`restoreLeases()` before `recoverStuckTasks()`); if not, implement it here.
5. **Self-hosting watch-mode guard.** At startup, if the resolved `workspacePath` equals the Formic package's own root (compare `path.resolve(workspacePath)` against the project root already computed in `resolveClientPath()`), log a prominent warning:
   ```
   [Server] ⚠ Workspace is Formic's own source tree. Do NOT run the server in watch mode
   (npm run dev) while executing tasks that modify src/server/** — every agent edit will
   restart the server and re-dispatch the task in a loop. Use `npm run build && npm start`
   or a separate checkout.
   ```
   Optionally strengthen: when self-hosted **and** a dispatched task's `declaredFiles` include `src/server/` paths, require an explicit `FORMIC_ALLOW_SELF_EDIT=1` to dispatch, otherwise demote to `todo` with a clear `yieldReason`. Keep this behind discussion — the warning alone may be enough for a single-user tool.
6. **Docs:** add a "Self-hosting Formic on its own repo" section to `README.md` covering the build-then-run requirement and the orphan/loop symptoms.
7. **Tests:**
   - Unit: a board with a `running` task + live dummy child process → recovery re-queues it, logs a `[StatusTransition]`, increments `recoveryCount`, and the dummy process receives SIGTERM.
   - Unit: task with `recoveryCount = 3` in `queued` → demoted to `todo` on next poll with the cap reason.
   - Manual: reproduce the incident shape (watch mode + task editing `src/server/index.ts`) and confirm the loop now halts by the cap within ~3 restarts and the warning appears at boot.

#### Acceptance criteria / verification

- [ ] Every recovery re-queue produces a `[StatusTransition] ... | caller=recovery.startup` log line (no more silent `queued` regressions).
- [ ] A task recovered more than the threshold lands in `todo` with a visible `yieldReason` instead of looping.
- [ ] Recovered tasks' orphaned PIDs receive SIGTERM; recovered tasks hold zero leases after startup.
- [ ] Self-hosted startup prints the watch-mode warning.
- [ ] `npx tsc --noEmit`, unit tests, and `python test/run_tests.py` pass.

---

## 4. Suggested Formic Task Batch

Copy-paste inventory for creating the tasks (details/context: reference the relevant section of this document in each task's context, or paste the section body in):

| Order | Title | Type | Priority | Depends on |
|-------|-------|------|----------|------------|
| 1 | Fix: Restrict server binding to localhost and add token auth for network exposure | standard | high | — |
| 2 | Fix: Scope kill-switch rollback to the failing task's declared files | standard | high | — |
| 3 | Fix: Serialize board read-modify-write cycles with a mutation mutex | standard | high | — |
| 4 | Fix: Stop holder processes before force-releasing leases in preemption and deadlock resolution | standard | high | — |
| 5 | Fix: Extend deadlock wait-graph to multi-file waits and shared-lease holders | standard | medium | Task 4 |
| 6 | Fix: Emit and persist lease expiry, persist renewals, and release stale leases on startup recovery | standard | medium | Task 4 (shares files) |
| 7 | Fix: Use a persistent monotonic counter for task ID generation | quick | medium | Task 3 (ideally) |
| 8 | Fix: Whitelist updatable fields and validate status transitions on task update | standard | medium | Task 4 (teardown helper) |
| 9 | Fix: Transition tasks that exceed retry/yield caps out of the queue | quick | medium | — |
| 10 | Fix: Handle agent spawn failure without marking the task running | quick | low | — |
| 11 | Fix: Add recovery accounting, orphan cleanup, and a self-hosting watch-mode guard to startup recovery | standard | medium | Task 9 (Issue 5), Task 6 (Issue 9) |
| 12 | Refactor: Replace console.log with console.warn/error per logging guidelines | quick | low | run last |

**Concurrency guidance for Formic execution:** Tasks 4, 5, 6, and 8 all declare `src/server/services/leaseManager.ts` and/or `src/server/services/workflow.ts` exclusively — the lease system will serialize them, but queue them in the listed order so the teardown helper (Task 4) exists before its consumers. Task 12 (console sweep) conflicts with everything; queue it alone at the end.

> ⚠️ **Self-hosting warning (learned from the 2026-07-10 incident):** several of these tasks edit `src/server/**` — the running Formic server's own source. Do **not** execute them while the server runs under `npm run dev` (tsx watch) on this repo, or every agent edit will restart the server and re-dispatch the task in a loop (see Issue 12). Run the server via `npm run build && npm start` (or a globally installed build pointed at this workspace) while these tasks execute.

---

## 5. Verification Playbook (applies to every task)

1. **Type check:** `npx tsc --noEmit` — must be clean (strict mode).
2. **Build:** `npm run build`.
3. **Unit tests:** `npx tsx --test test/unit/` (existing ~170 tests must keep passing).
4. **API tests:** start a server running the **local** code — `PORT=8010 npx tsx src/server/index.ts` — then `python test/run_tests.py` (add `--agi` for the concurrency suites).
   - ⚠️ Test-harness gotchas learned on this project: run the Python suites with `no_proxy='*'` if a sandbox proxy is configured (it breaks `requests`), and make sure no globally installed `formic` binary is running on port 8000 sharing the same `.formic/` directory — the old build clobbers `leases.json` during persistence tests.
5. **E2E (UI-affecting changes only):** `npx playwright test` against `http://localhost:8000`.
6. **Guideline conformance:** ESM imports with `.js` extensions, `node:` prefixes, no `any`, no new dependencies, `[ServiceName]`-prefixed logging, no empty catch blocks.

---

## 6. Out of Scope / Known Non-Issues

Verified healthy during the audit — do not "fix" these:

- `saveBoard` atomic write (tmp + rename), validation-before-write, and rolling backup (`store.ts:232-272`).
- `persistLeases` atomic write with async mutex (`leaseManager.ts:312-329`).
- `safeGit.ts` — path traversal validation and `execFile` (no shell) for git operations.
- `acquireLeases` validate-first, all-or-nothing grant (`leaseManager.ts:39-110`).
- Board corruption recovery chain: archive corrupted file → restore backup → fresh board (`store.ts:104-164`).
- Watchdog active-task guard: renews instead of killing live workflows (`watchdog.ts:46-56`).
- Queue processor `inFlightTasks` cross-cycle re-admission guard and exponential yield backoff.
