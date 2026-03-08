# 🐜 Formic AGI Evolution Roadmap

> **Ultimate Goal:** Evolve Formic from a "human-micromanaged task board" into a "goal-driven, self-healing, parallel-operating AGI development team."
>
> **Core Strategy:** Continue using CLI (Claude Code) as the hands and feet, leveraging the Node.js/Fastify backend as the brain for orchestration, error prevention, and concurrency control.

---

## Current Development Status (v0.6.2)

| Component | Status | Completion | Notes |
|-----------|--------|------------|-------|
| Goal Decomposition (Architect) | ✅ Complete | 100% | Full DAG architect implementation with depends_on, Kahn's cycle detection, blocked scheduling |
| Lease Management (Lease) | ✅ Complete | 80% | File-level concurrency working correctly, no folder-level locking |
| Declaration Step (Declare) | ✅ Complete | 100% | Fully functional file declaration skill |
| Watchdog | ✅ Complete | 90% | Monitors leases, cleans up stale processes, re-queues tasks |
| Concurrent Execution | ✅ Complete | 75% | Parallel tasks operational, no priority-aware lock management |
| Collision Detection | ✅ Complete | 85% | Optimistic concurrency for shared files via git hash |
| Queue Prioritization (Prioritizer) | ✅ Complete | 100% | Four-tier scoring (fix bonus + BFS transitive unblocking + manual priority + FIFO age) integrated into queueProcessor |
| Verification (QA) | ✅ Complete | 100% | Safety Net + Verifier + Critic + Kill Switch fully implemented |
| Memory System | ✅ Partially Implemented | ~50% | memory.ts fully implemented (CRUD + reflection); getRelevantMemories() defined but not yet injected into runner.ts |
| Dependency Graph (DAG) | ✅ Complete | 100% | dependsOn/dependsOnResolved fields, automatic unblocking, dependency-resolved WebSocket events all implemented |
| Verification Agent (Verifier) | ✅ Complete | 100% | executeVerifyStep() + Critic retry loop + Kill Switch fully implemented |

### Existing Foundations

- **Goal Task Type** (`type: 'goal'`): Architect skill can decompose high-level goals into 3-8 subtasks
- **Architect Workflow** (`executeGoalWorkflow()`): Parses `architect-output.json`, creates tasks with parent-child relationships
- **Lease Manager** (`leaseManager.ts`): Exclusive/shared file leases, atomic acquisition, git hash collision detection
- **Declaration Skill** (Declare Skill): Analyzes plans and outputs `declared-files.json`
- **Watchdog** (`watchdog.ts`): 30-second polling, cleans up expired leases, reverts uncommitted changes
- **Yield Mechanism** (Yield): Yields tasks when leases are unavailable, up to 50 retries
- **Iterative Execution**: Up to 5 iterations per task with stall detection
- **Safe Point Commits** (`gitUtils.ts → createSafePoint()`): Automatic `git add . && git commit --allow-empty` before task execution, SHA stored in `task.safePointCommit`
- **Verifier** (`executeVerifyStep()`): Runs `VERIFY_COMMAND` after execution; success → review, failure → triggers Critic
- **Critic & Kill Switch** (`executeCriticAndRetry()`): Automatically creates fix tasks (type:quick, priority:high); after 3 failures → git reset + pause queue + notify
- **Fix Task Priority Queuing** (`getQueuedTasks()` 3-tier sort): Tasks with fixForTaskId always queued first
- **Dependency-Aware Queue Prioritization** (`prioritizer.ts`): Four-tier scoring algorithm auto-reorders queued tasks: fix tasks > tasks that unblock the most blocked tasks > manual priority > FIFO
- **DAG Dependencies** (`dependsOn`/`dependsOnResolved`/`blocked`): Architect output includes depends_on, Kahn's cycle detection, blocked tasks auto-unblock
- **Objective Input UI** (Objective mode): Dedicated 🎯 Objective input mode in the frontend, automatically sets type:'goal'
- **Stuck Task Recovery** (`recoverStuckTasks()`): Automatically re-queues tasks stuck in executing states on server restart

---

## 🟢 Phase 1: Self-Healing QA Loop

**Goal:** Ensure that even when AI-written code breaks, it can fix itself. This is the cornerstone of moving toward AGI and the most critical first step.

### Step 1.1: Pre-Task Auto-Save (The Safety Net)

**Status:** ✅ Complete — createSafePoint() fully implemented in gitUtils.ts, called before spawn in both workflow.ts and runner.ts.

**Implementation:**
- Before calling `spawn('claude')` in `runner.ts`, execute `git add .` + `git commit -m "auto-save: before task [ID]"`
- Record the commit SHA in the task object (`task.safePointCommit`)
- This SHA serves as the clean rollback target for any failure scenario

**Files Involved:**
- `src/server/services/runner.ts` — Add pre-execution git commit
- `src/types/index.ts` — Add `safePointCommit?: string`

### Step 1.2: Verifier Mechanism (The Verifier)

**Status:** ✅ Complete — executeVerifyStep() fully implemented in workflow.ts; verifying status added to TaskStatus; Verifying board column added to frontend.

**Implementation:**
- Add `'verifying'` to the `TaskStatus` union type
- After execution, transition to `verifying` state instead of directly to `review`
- Automatically run configurable verification commands (e.g., `npm run build`, `npm test`)
- Parse exit code and stdout/stderr
- Success → transition to `review`; Failure → trigger Critic (Step 1.3)
- Can be skipped via `SKIP_VERIFY=true` environment variable (for development)

**Files Involved:**
- `src/types/index.ts` — Add `verifying` status, `verifyCommand?: string`
- `src/server/services/workflow.ts` — Add `executeVerifyStep()`
- `src/server/services/store.ts` — Board-level verification configuration
- `src/client/index.html` — Add Verifying board column

### Step 1.3: Critic and Retry Loop (The Critic)

**Status:** ✅ Complete — executeCriticAndRetry() fully implemented in workflow.ts, including Kill Switch mechanism (git reset + queue pause + WebSocket + Telegram/LINE notifications).

**Implementation:**
- On verification failure, capture the error log (last 100 lines of stderr)
- Automatically create a fix task: `"Fix: [Original Title] — [Error Summary]"`, `type: 'quick'`, `priority: 'high'`
- Link to the original task via the `fixForTaskId` field
- Jump to the front of the queue (priority override)
- Track `retryCount` on the original task

**Kill Switch (Emergency Stop):**
- If `retryCount >= 3`, execute `git reset --hard <safePointCommit>`
- Pause the queue processor
- Send notifications via WebSocket + Telegram/LINE
- Requires human intervention to resume

**Files Involved:**
- `src/types/index.ts` — Add `retryCount`, `fixForTaskId`, `safePointCommit`
- `src/server/services/workflow.ts` — Critic logic after verification failure
- `src/server/services/queueProcessor.ts` — Priority override for fix tasks, pause mechanism
- `src/server/services/boardNotifier.ts` — Kill Switch notifications

---

## 🟡 Phase 2: DAG-Aware Architect

**Goal:** The architect should not only decompose tasks but also define dependency relationships between them, paving the way for parallel processing.

### Step 2.1: High-Level Goal Input (Objective Input)

**Status:** ✅ Complete — 🎯 Objective mode button and dedicated input UI fully implemented in index.html frontend.

**Implementation:**
- Add an "Objective" input mode in the frontend (large text area), distinct from regular task creation
- Automatically set `type: 'goal'` on creation
- Display a visual indicator showing this will trigger architect decomposition

**Files Involved:**
- `src/client/index.html` — Objective input UI
- `src/client/app.js` — Goal task creation handler

### Step 2.2: DAG-Aware Prompts

**Status:** ✅ Complete — skills/architect/SKILL.md updated with task_id/depends_on fields; workflow.ts includes detectDAGCycle() (Kahn's Algorithm) with flat fallback on cycle detection.

**Implementation:**
- Update `skills/architect/SKILL.md` prompt to require output containing a `depends_on` field:
  ```json
  [
    {
      "task_id": "setup-stripe",
      "title": "Set up Stripe SDK and configuration",
      "context": "...",
      "priority": "high",
      "depends_on": []
    },
    {
      "task_id": "checkout-api",
      "title": "Implement checkout API endpoints",
      "context": "...",
      "priority": "high",
      "depends_on": ["setup-stripe"]
    }
  ]
  ```
- Validate for circular dependencies using topological sort (Kahn's Algorithm)
- If a cycle is detected, fall back to flat mode and log a warning

**Files Involved:**
- `skills/architect/SKILL.md` — Update prompt
- `src/server/services/workflow.ts` — Parse `depends_on`, DAG validation

### Step 2.3: DAG Generation and Scheduling

**Status:** ✅ Complete — dependsOn/dependsOnResolved/blocked fully implemented in types/store/workflow/boardNotifier; unblockSiblingTasks() automatically triggered on task completion; dependency-resolved WebSocket event broadcast complete.

**Implementation:**
- Add `dependsOn: string[]` field and `blocked` status to tasks
- When creating subtasks, map the architect's temporary `task_id` (e.g., `"setup-stripe"`) to the actual Formic ID (e.g., `"t-52"`)
- Tasks with no dependencies → `queued` (READY)
- Tasks with unmet dependencies → `blocked`
- Queue processor skips tasks in `blocked` status

**Unblocking Logic:**
- When a task completes (`done`), scan all `blocked` tasks under the same `parentGoalId`
- If all `dependsOn` items for a task are `done`, transition it from `blocked` → `queued`
- Broadcast `DEPENDENCY_RESOLVED` event via WebSocket

**Files Involved:**
- `src/types/index.ts` — Add `dependsOn`, `blocked` status
- `src/server/services/store.ts` — Dependency unblocking logic on task completion
- `src/server/services/queueProcessor.ts` — Skip blocked tasks
- `src/server/services/boardNotifier.ts` — Dependency resolved events
- `src/client/index.html` — Blocked indicators, dependency visualization

---

## 🟠 Phase 3: Industrial-Grade Concurrency

**Goal:** Safe parallel agent execution, preventing deadlocks and optimizing resource utilization.

### Step 3.1: Enhanced Lease System

**Status:** ✅ Complete — `leaseManager.ts` fully implements priority preemption (`preemptLease()`), deadlock detection (`detectDeadlock()` based on wait-for graph + Kahn's cycle resolution), and disk persistence (`persistLeases()` / `.formic/leases.json`). Implemented by task t-53.

**Completed:**
- ~~Add lease priority: high-priority tasks can preempt resource holders with lower priority (graceful termination)~~ ✅
- ~~Add deadlock detection: if Task A holds file X and waits for Y, while Task B holds Y and waits for X~~ ✅
- ~~Persist leases to disk to prevent loss on server restart~~ ✅

**Files Involved:**
- `src/server/services/leaseManager.ts` — Priority preemption, cycle detection
- `src/server/services/watchdog.ts` — Deadlock scanning

### Step 3.2: Smart Worker Pool with Yield Mechanism

**Status:** ✅ Complete — `queueProcessor.ts` implements `yieldReason` persistence (via `updateTask()`), exponential backoff constants (`YIELD_BACKOFF_INITIAL_MS`, `YIELD_BACKOFF_MULTIPLIER`, `YIELD_BACKOFF_MAX_MS`), and `yieldUntil` mapping. `src/types/index.ts` includes `yieldReason?: string`. Implemented by task t-54.

**Completed:**
- ~~Worker immediately picks up the next READY non-conflicting task after yielding (partially implemented)~~ ✅
- ~~Record yield reason for debugging (`yieldReason`)~~ ✅
- ~~Implement exponential backoff strategy: yield count affects re-queue delay~~ ✅

**Files Involved:**
- `src/server/services/queueProcessor.ts` — Smart task selection, backoff strategy
- `src/types/index.ts` — `yieldReason?: string`

### Step 3.3: Event-Driven State Broadcasting

**Status:** ✅ Complete — `internalEvents.ts` exports `TASK_COMPLETED` and `LEASE_RELEASED` constants along with `EventEmitter`. `queueProcessor.ts` subscribes via `internalEvents.on(TASK_COMPLETED, wakeQueueProcessor)` and `internalEvents.on(LEASE_RELEASED, wakeQueueProcessor)`. `workflow.ts` emits `TASK_COMPLETED` on all task completion paths, and `leaseManager.ts` emits `LEASE_RELEASED` on lease release. Implemented by task t-55.

**Completed:**
- ~~Broadcast dependency-resolved events~~ ✅ Already implemented in boardNotifier.ts
- ~~Fine-grained TASK_COMPLETED and LEASE_RELEASED events~~ ✅
- ~~Workers subscribe to relevant events instead of continuous polling~~ ✅
- ~~Reduced dependency on `QUEUE_POLL_INTERVAL`, enabling faster reaction times~~ ✅

**Files Involved:**
- `src/server/services/boardNotifier.ts` — Event types and subscription mechanism
- `src/server/services/queueProcessor.ts` — Event-driven wake-up

### Step 3.4: Dependency-Aware Queue Prioritizer

**Status:** ✅ Complete — `src/server/services/prioritizer.ts` implements a four-tier scoring algorithm, automatically reordering the queue before task selection in `queueProcessor.ts`'s `processQueue()`. Implemented by task t-68.

**Completed:**
- ~~Four-tier scoring algorithm: fix task bonus (+1000), transitive unblock score (+100 per blocked task), manual priority (high=+30, medium=+20, low=+10), FIFO age bonus (+min(ageMs/1000, 10))~~ ✅
- ~~`buildReverseDepGraph(allTasks)` — Builds reverse dependency graph from all tasks (`Map<taskId, Set<dependentId>>`)~~ ✅
- ~~`countTransitivelyUnblocked(taskId, reverseGraph, allTasks)` — Uses BFS to count blocked tasks that would be transitively unblocked by completing this task~~ ✅
- ~~`prioritizeQueue(tasks, allTasks)` — Reorders queued tasks by score descending, returns new array (does not mutate original)~~ ✅
- ~~`getQueueAnalysis(tasks, allTasks)` — Returns observability data (per-task score breakdown) without modifying the queue~~ ✅
- ~~Integration into `queueProcessor.ts`'s `processQueue()` — Calls `prioritizeQueue()` before task selection~~ ✅

**Files Involved:**
- `src/server/services/prioritizer.ts` — Four-tier scoring engine, reverse dependency graph, BFS transitive unblocking calculation
- `src/server/services/queueProcessor.ts` — Integration of `prioritizeQueue()` within `processQueue()`

---

## ✅ Phase 4: Memory & Self-Evolution

> **✅ Phase 4 Fully Complete (2026-03-07)**
>
> **Key Implementation Files:**
> - `src/server/services/memory.ts` — Relevance scoring (tag overlap + file path matching + recency weighting)
> - `src/server/services/runner.ts` — Memory and tool context injection into agent prompts
> - `src/server/services/tools.ts` — New tool forging service (`listTools()`, `addTool()`, `validateTool()`, `incrementUsage()`)
> - `src/server/routes/tools.ts` — REST endpoints `GET /api/tools` and `POST /api/tools`
> - `src/types/index.ts` — New `Tool` and `ToolStore` type definitions

**Goal:** The system has memory and never falls into the same pitfalls twice; the system writes its own tools for its own use.

### Step 4.1: Memory Storage (The Hippocampus)

**Status:** ✅ Complete — `src/server/services/memory.ts` fully implements `loadMemoryStore()`, `saveMemoryStore()`, `addMemory()`, `getMemories()`, `getRelevantMemories()`. `src/types/index.ts` includes `MemoryEntry` interface and `MemoryStore` type. Implemented by task t-56.

**Completed:**
- ~~Create `.formic/memory.json` memory store~~ ✅
- ~~Run a "reflection prompt" after task completion (`done`) and parse output into memory entries~~ ✅
- ~~Memory CRUD service (`addMemory`, `getMemories`, `getRelevantMemories`)~~ ✅
- ~~`MemoryEntry` and `MemoryStore` type definitions~~ ✅

### Step 4.2: Context Injection

**Status:** ✅ Complete — Relevance scoring implemented in `getRelevantMemories()` (tag overlap + file path matching + recency weighting); top-5 memories injected as a `## Past Experience` section into the agent prompt in `runner.ts`.

**Completed:**
- ~~Before executing a new task, query `memory.json` for entries relevant to the current task (based on tag/file matching)~~ ✅
- ~~Append relevant memories to the agent prompt as "past experience"~~ ✅
- ~~Rank by relevance (tag overlap + recency)~~ ✅

**Files Involved:**
- `src/server/services/memory.ts` — `getRelevantMemories(task)` function
- `src/server/services/runner.ts` — Inject memories into agent prompt

### Step 4.3: Tool Forging

**Status:** ✅ Complete — New `src/server/services/tools.ts` service (`listTools()`, `addTool()`, `validateTool()`, `incrementUsage()`); REST API at `GET/POST /api/tools`; available tools injected as `## Available Tools` section in agent prompt; manifests persisted in `.formic/tools/tools.json`.

**Completed:**
- ~~Grant agents write access to the `.formic/tools/` directory~~ ✅
- ~~Each tool is a script (bash/node) plus a manifest file~~ ✅
- ~~Agents can invoke these self-built tools in subsequent tasks~~ ✅
- ~~Track usage statistics to identify the most valuable tools~~ ✅

**Files Involved:**
- `src/server/services/tools.ts` — New service: tool management
- `src/server/routes/tools.ts` — REST endpoints `GET /api/tools` and `POST /api/tools`
- `src/types/index.ts` — Tool type definitions
- `skills/execute/SKILL.md` — Inform agents of available tools list

---

## Priority and Dependency Diagram

```
Phase 1 (Self-Healing Loop) ──────────────────────────────────────┐
  Step 1.1 (Auto-Save) ──→ Step 1.2 (Verifier) ──→ Step 1.3 (Critic)
                                                                   │
Phase 2 (DAG Architect) ──────────────────────────────────────────┤
  Step 2.1 (Objective Input) ──→ Step 2.2 (DAG Prompts) ──→ Step 2.3 (DAG Scheduling)
                                                                   │
Phase 3 (Industrial Concurrency) ──────────────────── depends on Phase 2
  Step 3.1 (Lease++) ──→ Step 3.2 (Smart Yield) ──→ Step 3.3 (Event Broadcast) ──→ Step 3.4 (Dep Priority)
                                                                   │
Phase 4 (Memory & Evolution) ──────────────────────── depends on Phase 1
  Step 4.1 (Memory Store) ──→ Step 4.2 (Context Injection) ──→ Step 4.3 (Tool Forging)
```

**Recommended Order:** Phase 1 → Phase 2 → Phase 3 → Phase 4

Phase 1 is the **most fundamental safeguard** — without self-healing capability, scaling up concurrency only accelerates code collapse. Phase 2 enables intelligent parallelism. Phase 3 strengthens system stability. Phase 4 makes the system truly intelligent.

---

## 🧪 Testing Strategy & Evaluation Framework

Each phase requires corresponding tests to verify that the AGI mechanisms are functioning correctly after implementation.

### Phase 1 Tests: QA Loop Verification

**Test File:** `test/test_qa_loop.py`

| Test Case | Verification |
|-----------|-------------|
| Auto-Save Test | A `auto-save: before task [ID]` git commit is created before task execution |
| Verifier Success | Execute a task in a project with successful build → confirm task transitions to `review` |
| Verifier Failure | Execute a task that introduces a syntax error → confirm Critic is triggered and auto-creates a `priority: high` fix task |
| Critic Retry | Simulate 3 consecutive failures → confirm `git reset --hard` is executed, queue is paused, notifications are sent |
| Kill Switch Recovery | After Kill Switch triggers → confirm workspace reverts to safe point commit and queue is paused |

### Phase 2 Tests: DAG Scheduling Verification

**Test File:** `test/test_dag_scheduling.py`

| Test Case | Verification |
|-----------|-------------|
| DAG Output | Submit a goal with clear dependencies → confirm architect output contains valid `depends_on` |
| Cycle Detection | Manually inject circular dependencies → confirm system detects and degrades gracefully |
| Sequential Blocking | Create A→B→C dependency chain → confirm B only starts after A completes, C only starts after B completes |
| Parallel Independence | Create A, B (no dependencies) and C (depends on A+B) → confirm A and B execute in parallel, C waits |
| Unblock Cascade | Complete task A → confirm all tasks that only depend on A transition from `blocked` to `queued` |

### Phase 3 Tests: Concurrency Stress Tests

**Test File:** `test/test_concurrency_advanced.py`

| Test Case | Verification |
|-----------|-------------|
| Lease Priority | High-priority task requests a file held by a low-priority task → verify preemption behavior |
| Deadlock Detection | Two tasks each need exclusive files held by the other → verify detection and resolution |
| Yield Backoff | Task yields multiple times → verify retry interval increases |
| 100-Task Stress | Queue 100 tasks with mixed dependencies and shared files → zero deadlocks, zero data corruption |

**Test File:** `test/test_prioritizer.py`

| Test Case | Verification |
|-----------|-------------|
| Fix Task Bonus | Task with `fixForTaskId` scores +1000 ahead, sorted first |
| Transitive Unblocking | Task that unblocks N blocked tasks upon completion scores N × 100 |
| Manual Priority | high=+30, medium=+20, low=+10 reflected in final ordering |
| Age Bonus | Oldest task scores +10 (capped), newest scores +0 |
| Queue Analysis | `getQueueAnalysis()` returns per-task score breakdown without modifying queue order |

### Phase 4 Tests: Memory System Verification

**Test File:** `test/test_memory.py`

| Test Case | Verification |
|-----------|-------------|
| Memory Creation | Complete a task → confirm `.formic/memory.json` has a new reflection entry |
| Memory Injection | Create a task touching files referenced in existing memory entries → confirm memories appear in agent prompt |
| Tool Forging | Agent creates a tool in `.formic/tools/` → confirm manifest is valid and tool is available to subsequent tasks |

### Integration Tests

**Test File:** `test/test_agi_integration.py`

| Test Case | Verification |
|-----------|-------------|
| End-to-End Goal | Submit goal → architect decomposes → tasks execute with QA → all complete → memories saved |
| Failure Recovery | Submit goal → subtask fails → Critic creates fix → fix succeeds → goal completes |
| Concurrent Goals | Submit two goals simultaneously → no resource conflicts, both complete |

### Automated Evaluation Metrics

**Metrics Collector:** `test/agi_metrics.py`

| Metric | Target | Calculation |
|--------|--------|-------------|
| Self-Healing Rate | ≥ 80% | Percentage of failed tasks that auto-recover within 3 retries |
| DAG Accuracy | ≥ 90% | Percentage of decompositions where the architect correctly identifies dependencies |
| Deadlock Rate | 0 | Number of deadlocks per 100 tasks |
| Memory Utilization | ≥ 50% reduction | Reduction rate of repetitive errors after memory injection |
| Avg Completion Time | Continuous tracking | Average task completion time before and after each phase implementation |
