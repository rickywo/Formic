# Formic v0.7.3 - Watchdog Fix & Demo Site

**The Local-First Agent Orchestration Environment**

*Vibe Coding with autonomous agents. Your repo, your rules, their labor.*

---

## Highlights

This release fixes a **critical race condition** where the watchdog service would kill actively-running tasks when their file leases expired, causing tasks to restart endlessly from the briefing stage. It also introduces a **GitHub Pages demo site**, enhanced board API, and structured status transition logging for better observability.

**Install / Update:**
```bash
npm install -g @rickywo/formic@0.7.3
```

---

## What's New

### Critical Bug Fix: Watchdog Lease Expiration Race Condition
- **Problem**: Tasks in `running` state were being killed and re-queued every ~5 minutes (matching the default lease duration). The watchdog assumed expired leases meant a stalled task, but long-running execute iterations simply outlasted the lease window.
- **Fix 1 — Watchdog guard** (`watchdog.ts`): Before re-queuing, the watchdog now checks if the task is in an active state (`running`, `briefing`, `planning`, etc.) AND has a live workflow process (`isWorkflowRunning`). If both are true, it **renews the leases** instead of killing the task.
- **Fix 2 — Periodic lease renewal** (`workflow.ts`): Added a `setInterval` timer that renews leases every 2 minutes throughout the entire iterative execution loop, not just at iteration boundaries. Cleaned up in a `finally` block.

### Queue Processor Fixes
- **Stale resumeFromStep prevention** (`queueProcessor.ts`): The queue processor now reloads the fresh task from the board immediately before routing, preventing stale `resumeFromStep` values from causing incorrect workflow restarts.
- **executeFromDeclare hardening** (`workflow.ts`): Re-reads persisted `resumeFromStep` after `saveBoard()` to ensure consistency. Added idempotency guard for `createSafePoint` and zombie lease detection to clean up orphaned leases from prior crashed runs.

### GitHub Pages Demo Site
- **Live demo** at [rickywo.github.io/Formic](https://rickywo.github.io/Formic/) — fully interactive board with mock backend, no server required.
- Demo banner updated with clickable **"View on GitHub"** link instead of "changes are local only" text.

### Structured Status Transition Logging
- Every task status change now logs a structured `[StatusTransition]` entry with `taskId`, `from → to`, `caller`, and ISO timestamp.
- Makes debugging workflow issues significantly easier — the exact caller that triggered each transition is recorded.

### Enhanced Board API
- Board endpoint now returns task counts and queue status metadata for dashboard integrations.

---

## Bug Fixes

| Issue | Fix | File(s) |
|-------|-----|---------|
| Running tasks killed by watchdog every ~5 min | Guard active tasks; renew leases instead of killing | `watchdog.ts`, `workflow.ts` |
| Periodic lease renewal missing during execution | Added 2-min interval timer in iterative loop | `workflow.ts` |
| Stale resumeFromStep causing wrong workflow route | Reload fresh task before dispatch | `queueProcessor.ts` |
| createSafePoint not idempotent | Added guard to prevent duplicate safe points | `workflow.ts` |
| Zombie leases from crashed tasks | Added detection and cleanup in executeFromDeclare | `workflow.ts` |

---

## Commits in this Release

- `7483b8a` feat: update demo mode message with GitHub link and remove pointer events
- `501829b` feat: enhance board API with task counts and queue status
- `751ae71` docs: add live demo section to README
- `f3d3ba0` fix(queueProcessor): reload fresh task before routing to prevent stale resumeFromStep
- `e337364` Fix executeFromDeclare: re-read persisted resumeFromStep after saveBoard
- `b59b938` Fix executeFromDeclare: guard createSafePoint for idempotency, add zombie lease detection
- `c33f5d6` feat: add structured task status transition logging with caller attribution
- `38bc633` Add GitHub Pages demo site with mock backend

---

## Files Changed

| File | Change |
|------|--------|
| `package.json` | Version bump to 0.7.3 |
| `src/server/services/watchdog.ts` | Guard active tasks from lease expiration kill; renew instead |
| `src/server/services/workflow.ts` | Periodic lease renewal timer; executeFromDeclare hardening |
| `src/server/services/queueProcessor.ts` | Reload fresh task before routing |
| `src/server/services/store.ts` | Status transition logging |
| `src/client/demo.html` | Demo banner with GitHub link |
| `README.md` | Live demo section |

---

## Quick Start

```bash
# Install globally
npm install -g @rickywo/formic

# In your project directory
cd your-project
formic init
formic start
```

Open `http://localhost:8000` and start creating tasks.

---

## What's Next

- [ ] Agent memory persistence across task sessions
- [ ] Parallel task execution with DAG scheduling
- [ ] Cloud deployment option
- [ ] Custom agent plugin system

---

## License

MIT License - Use it, fork it, ship it.

---

**Full Changelog**: https://github.com/rickywo/Formic/compare/v0.7.2...v0.7.3
