# Phase 3: Agent Runner - Checklist

## Pre-Implementation
- [x] Feature specification reviewed (README.md)
- [x] Technical approach defined (Node.js child_process)
- [x] Dependencies identified (none new required)
- [x] API contracts defined (run/stop endpoints)

## Implementation

### Process Spawning
- [x] `spawn()` used with Claude CLI command
- [x] Prompt includes task title, context, and docsPath
- [x] Working directory set to WORKSPACE_PATH
- [x] stdio configured as `['pipe', 'pipe', 'pipe']`
- [x] PID captured and returned on success
- [x] AGENT_COMMAND configurable via environment variable

### Stream Capture
- [x] stdout data events captured
- [x] stderr data events captured
- [x] Data converted from Buffer to string
- [x] Broadcasts include timestamp and type

### Log Buffering
- [x] In-memory buffer during execution
- [x] 50-line limit enforced (FIFO eviction)
- [x] Buffer persisted to task on exit
- [x] `appendTaskLogs()` integration working

### Lifecycle Management
- [x] Active processes tracked in Map
- [x] Task status updated to `running` on start
- [x] `close` event updates status based on exit code
- [x] `error` event resets status to `todo`
- [x] Process reference cleaned up on exit/error
- [x] `stopAgent()` sends SIGTERM
- [x] SIGKILL fallback after 5-second timeout

### Concurrency Control
- [x] `isAgentRunning()` function implemented
- [x] `getRunningTaskId()` function implemented
- [x] Concurrency check at start of `runAgent()`
- [x] 409 Conflict returned when agent running

### WebSocket Integration
- [x] Connection registration per task
- [x] Connection cleanup on disconnect
- [x] `broadcastToTask()` sends to all task connections
- [x] Ready state checked before sending

### API Routes
- [x] POST `/api/tasks/:id/run` implemented
- [x] POST `/api/tasks/:id/stop` implemented
- [x] Task validation (exists, correct status)
- [x] Appropriate error responses (404, 409, 500)

## Quality Gates

### Functional Tests
- [x] Agent starts via API call
- [x] Agent stops via API call
- [x] Concurrency guard blocks second agent
- [x] Status updates to `running` on start
- [x] Status updates to `todo` on stop/error
- [x] Status updates to `review` on successful completion (exit code 0)
- [x] Logs streamed via WebSocket in real-time
- [x] Logs persisted to task after execution

### Error Handling
- [x] Handles missing task (404)
- [x] Handles wrong task status (400)
- [x] Handles concurrent run attempt (409)
- [x] Handles Claude CLI not installed (ENOENT)
- [x] Handles spawn failure gracefully
- [x] Provides helpful error messages for common issues

### Code Quality
- [x] TypeScript types for all functions
- [x] Async/await used consistently
- [x] Error messages are descriptive
- [x] No memory leaks (process map cleanup)

## Manual Testing Scenarios

- [x] Create task → Run agent → Verify process starts
- [x] Run agent → Stop agent → Verify process terminates
- [x] Run agent → Try second run → Verify 409 response
- [x] Run agent → View logs in browser → Verify WebSocket streaming
- [x] Run agent → Let complete → Verify status becomes `review`
- [x] Run agent with missing CLI → Verify helpful error message

## Documentation
- [x] README.md specification complete
- [x] PLAN.md tracks implementation progress
- [x] CHECKLIST.md updated as items complete

---

**Phase 3 Status: COMPLETE**
