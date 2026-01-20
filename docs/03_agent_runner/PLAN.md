# Phase 3: Agent Runner - Implementation Plan

## Status
**COMPLETE** - All functionality implemented, tested, and verified.

## Implementation Summary

Most of Phase 3 functionality has been implemented in `src/server/services/runner.ts`. This plan documents what exists and identifies any remaining work.

---

## Phase 3.1: Process Spawning (COMPLETE)

- [x] 3.1.1 Import `spawn` from `node:child_process`
- [x] 3.1.2 Create `runAgent()` function accepting taskId, title, context, docsPath
- [x] 3.1.3 Build prompt string with task context and docsPath references
- [x] 3.1.4 Spawn Claude CLI with `--print` flag and prompt
- [x] 3.1.5 Configure spawn options: `cwd: WORKSPACE_PATH`, `stdio: ['pipe', 'pipe', 'pipe']`
- [x] 3.1.6 Return PID on successful spawn
- [x] 3.1.7 Throw error if spawn fails (no PID)

**Implementation:** `src/server/services/runner.ts:53-71`

---

## Phase 3.2: Stream Capture (COMPLETE)

- [x] 3.2.1 Attach `data` event handler to `child.stdout`
- [x] 3.2.2 Attach `data` event handler to `child.stderr`
- [x] 3.2.3 Convert Buffer to string for each data chunk
- [x] 3.2.4 Split output into lines for log buffer
- [x] 3.2.5 Broadcast each chunk to connected WebSocket clients
- [x] 3.2.6 Include timestamp and stream type in broadcast message

**Implementation:** `src/server/services/runner.ts:80-113`

---

## Phase 3.3: Log Buffering (COMPLETE)

- [x] 3.3.1 Create in-memory log buffer array per execution
- [x] 3.3.2 Push new lines to buffer on stdout/stderr
- [x] 3.3.3 Enforce MAX_LOG_LINES (50) limit with FIFO eviction
- [x] 3.3.4 Persist buffer to task record on process exit
- [x] 3.3.5 Call `appendTaskLogs()` from store service

**Implementation:** `src/server/services/runner.ts:78-89, 101-106, 120`

---

## Phase 3.4: Process Lifecycle Management (COMPLETE)

- [x] 3.4.1 Store active process in `Map<string, ChildProcess>`
- [x] 3.4.2 Update task status to `running` with PID on spawn
- [x] 3.4.3 Handle `close` event - update status based on exit code
- [x] 3.4.4 Handle `error` event - reset status to `todo`, log error
- [x] 3.4.5 Remove process from map on exit/error
- [x] 3.4.6 Implement `stopAgent()` with SIGTERM
- [x] 3.4.7 Add 5-second timeout before SIGKILL fallback
- [x] 3.4.8 Broadcast exit/error messages to WebSocket clients

**Implementation:** `src/server/services/runner.ts:9-10, 73-76, 116-145, 150-167`

---

## Phase 3.5: Concurrency Control (COMPLETE)

- [x] 3.5.1 Implement `isAgentRunning()` check
- [x] 3.5.2 Implement `getRunningTaskId()` for conflict reporting
- [x] 3.5.3 Check concurrency at start of `runAgent()`
- [x] 3.5.4 Throw error if agent already running
- [x] 3.5.5 Route handler returns 409 Conflict with running task ID

**Implementation:** `src/server/services/runner.ts:15-22, 54-57` and `src/server/routes/tasks.ts:56-61`

---

## Phase 3.6: WebSocket Connection Management (COMPLETE)

- [x] 3.6.1 Create `Map<string, Set<WebSocket>>` for task connections
- [x] 3.6.2 Implement `registerConnection()` function
- [x] 3.6.3 Implement `unregisterConnection()` function
- [x] 3.6.4 Implement `broadcastToTask()` for targeted messaging
- [x] 3.6.5 Check `ws.readyState === 1` before sending
- [x] 3.6.6 Clean up empty connection sets

**Implementation:** `src/server/services/runner.ts:12-51`

---

## Phase 3.7: API Routes (COMPLETE)

- [x] 3.7.1 POST `/api/tasks/:id/run` - start agent execution
- [x] 3.7.2 Validate task exists and is in `todo` status
- [x] 3.7.3 Return 409 if agent already running
- [x] 3.7.4 Return 200 with `{status, pid}` on success
- [x] 3.7.5 POST `/api/tasks/:id/stop` - stop running agent
- [x] 3.7.6 Return 404 if no agent running for task
- [x] 3.7.7 Return 200 with `{status: "stopping"}` on success

**Implementation:** `src/server/routes/tasks.ts:51-92`

---

## Phase 3.8: Verification & Testing

- [x] 3.8.1 Manual test: Start agent via API
- [x] 3.8.2 Manual test: Verify stdout streaming to WebSocket
- [x] 3.8.3 Manual test: Stop agent via API
- [x] 3.8.4 Manual test: Verify status transitions (running → todo on stop)
- [x] 3.8.5 Manual test: Verify concurrency guard (409 on second run)
- [x] 3.8.6 Test: Agent completion (exit code 0 → review status)
- [x] 3.8.7 Test: Agent error handling (non-zero exit → todo status)
- [x] 3.8.8 Test: Claude CLI not found error handling

---

## Completed Enhancements

- [x] Graceful handling when Claude CLI is not installed (ENOENT error with helpful message)
- [x] AGENT_COMMAND environment variable for testing/customization
- [x] Proper error handler ordering to catch spawn failures

## Deferred to v2

- [ ] Agent execution timeout configuration
- [ ] Process resource monitoring
- [ ] Execution history beyond current log buffer
- [ ] Recovery if server restarts while agent is running
