# Lease & Concurrency Simulation Harness

`scripts/lease-concurrency-sim.sh` creates **real Formic tasks** via the REST
API whose only purpose is to exercise the file-lease and concurrency system —
not to implement any feature. It drives the actual `leaseManager.ts` /
`workflow.ts` / `watchdog.ts` code paths, so what you observe (yields, holds,
preemption, renewal, collisions) is the real system running under controlled
conditions, not a mock.

## How it works

Each scenario task's `context` instructs the executing agent to:
1. Declare a specific, pre-agreed set of exclusive/shared files — always a
   scratch fixture under `.formic/lease-sim/`, never real source.
2. Run a literal `sleep N` shell command, to hold the lease/running state
   long enough for another scenario task to collide with it.
3. Append exactly one marker line to its declared file — nothing else.

This gives deterministic-ish timing windows using the real workflow engine.

### Important caveat: LLM-driven, not 100% deterministic

The task `context` is only injected verbatim into the **brief** step. The
**plan**, **declare**, and **execute** steps all work from the artifacts
(`README.md` / `PLAN.md` / `subtasks.json`) the previous step produced, not
from the raw context directly (see `skillReader.ts` — only `skills/brief/SKILL.md`
contains a `$TASK_CONTEXT` placeholder). Despite very directive wording, the
agent could in principle declare a different file than intended.

The script accounts for this: after each declare step, it fetches
`GET /api/tasks/:id/declared-files` and prints a `WARN` (never aborts) if the
actual declaration diverged from the scenario's intent, so you always know
whether you're looking at the real scenario or a drifted one.

## Usage

```bash
# Run everything (setup + all 9 scenarios + notes)
./scripts/lease-concurrency-sim.sh

# List scenarios without running them
./scripts/lease-concurrency-sim.sh --list

# Run specific scenarios only
./scripts/lease-concurrency-sim.sh --only 1,5,8

# Just bump config and commit fixtures, run scenarios yourself later
./scripts/lease-concurrency-sim.sh --setup-only

# Restore config if a run was interrupted (Ctrl-C already triggers this too)
./scripts/lease-concurrency-sim.sh --restore-config

# Point at a non-default server
FORMIC_API=http://127.0.0.1:9888 ./scripts/lease-concurrency-sim.sh
```

Requires `curl`, `jq`, `git`, and a running Formic server. The script bumps
`maxConcurrentSessions` (to 6) and `watchdogIntervalMs` (to 8s) for the
duration of the run so scenarios can actually overlap and expiry/renewal is
observable quickly — the original values are backed up to
`/tmp/formic-lease-sim/config-backup.json` and restored automatically on exit
(including on Ctrl-C, via a trap).

**Cleanup is never automatic.** Created tasks are titled
`[LEASE-SIM <run-id>] ...` so they're easy to find and delete; the script
prints the exact `curl -X DELETE` and fixture-removal commands at the end.

## Scenario catalogue

| # | Scenario | What it proves |
|---|----------|-----------------|
| 1 | Exclusive/exclusive conflict | Second task yields at declare (status→queued, `yieldCount`++, `resumeFromStep=declare`) until the first releases, then retries and succeeds. |
| 2 | Shared/shared coexistence | Two tasks declaring the same file as `shared` never yield against each other — both reach `running` concurrently. |
| 3 | Cross-type conflicts (two sub-cases) | An exclusive holder blocks a shared requester, **and** a shared holder blocks an exclusive requester, on the same file. |
| 4 | Optimistic-concurrency collision | Two tasks both declare a file `shared`; a slow writer's post-execute hash check (`detectCollisions`) detects the fast writer changed the file first, populating `task.fileConflicts`. |
| 5 | Priority preemption | A high-priority requester triggers `preemptLease()` to tear down a low-priority holder (stop, revert, release, re-queue) instead of waiting. |
| 6 | Lease renewal | With a shortened `leaseDurationMs`, the watchdog renews (extends `expiresAt`) a lease whose task is still genuinely running, instead of tearing it down. |
| 7 | Fan-in wait (negative deadlock test) | A third task waiting on two independently-held files is a "star," not a cycle — `detectDeadlock()` must not misreport it. |
| 8 | Concurrency cap | `maxConcurrentSessions` limits how many fully independent (non-conflicting) tasks run in parallel at once. |
| 9 | Quick-task lease bypass | `type: "quick"` tasks skip declare entirely (`executeQuickTask()` never calls it) — they are **not** blocked by any exclusive lease, even on the same file. Documented behavior, not a bug. |

### Not automated (documented instead)

- **Zombie-lease cleanup via server crash/restart.** Requires killing/
  restarting the Formic *server process* itself (not just an agent CLI) while
  a task holds a lease, which is a deliberate action only you should trigger.
  The script prints a step-by-step manual runbook for it (queue a
  long-sleeping task → wait until it holds its lease → stop the server → hard
  restart → watch `restoreLeases()` / `recoverStuckTasks()` / the watchdog's
  `teardownTask(..., 'lease_expired')` path play out).

- **True circular (A-waits-on-B, B-waits-on-A) deadlocks.** By design, a task
  calls `acquireLeases()` only once per attempt; a successful holder never
  re-declares mid-execution, and a denied task holds nothing. That means the
  wait-for graph can only ever grow "waiter → holder" edges — a genuine
  2-cycle cannot form through ordinary queued tasks, no matter how you
  sequence them. This is a structural safety property of the all-or-nothing,
  single-shot declare model, not a gap in the harness. The cycle-detection
  algorithm itself is already covered at the unit level, where the cycle is
  constructed directly via `recordWait()`/`acquireLeases()`:
  - `test/unit/deadlockDetection.test.ts`
  - `test/test_deadlock_survivor.py`

  Scenario 7 (fan-in wait) is the closest live-system analog — proving the
  detector does *not* false-positive under ordinary multi-task contention.

## Inspecting results

```bash
# Live lease state
curl -s $FORMIC_API/api/leases | jq

# A specific task
curl -s $FORMIC_API/api/tasks/<id> | jq

# What it actually declared
curl -s $FORMIC_API/api/tasks/<id>/declared-files | jq
```

Or just open the board UI and filter for the run's `[LEASE-SIM <run-id>]`
title prefix.
