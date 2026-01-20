# Phase 3: Agent Runner

## Overview

Implement robust agent execution capabilities that spawn Claude CLI processes, capture their output streams, and manage the full process lifecycle. This phase ensures the core "Run Agent" functionality works reliably with proper error handling and concurrency control.

## Goals

- Enable users to execute Claude CLI agents against their workspace
- Capture and stream stdout/stderr in real-time to connected clients
- Provide reliable process lifecycle management (start, monitor, stop)
- Enforce single-agent concurrency to prevent resource conflicts
- Handle edge cases gracefully (crashes, timeouts, manual termination)

## Key Capabilities

- **Process Spawning**: Use Node.js `child_process.spawn()` to execute Claude CLI with task context
- **Stream Capture**: Pipe stdout/stderr to WebSocket for real-time visibility
- **Lifecycle Management**: Track running processes, handle termination signals (SIGTERM/SIGKILL)
- **Status Updates**: Automatically transition task status based on process exit code
- **Concurrency Guard**: Prevent multiple agents from running simultaneously
- **Log Buffering**: Maintain last 50 lines of output per task for persistence

## Non-Goals

- Multi-agent concurrency (v2 feature)
- Agent queue management
- Process resource limits (CPU/memory)
- Agent conversation history persistence
- Custom agent configurations or prompts beyond task context

## Requirements

### Functional Requirements

- Agent spawns in workspace directory with read/write access
- Task context (title, context, docsPath) passed to Claude CLI as prompt
- Process PID stored in task record while running
- WebSocket broadcasts stdout/stderr to all connected clients for that task
- On successful exit (code 0): task status → `review`
- On error/termination: task status → `todo` with error logged
- Stop endpoint sends SIGTERM, followed by SIGKILL after 5-second timeout
- Only one agent can run at a time; concurrent run requests return 409 Conflict

### Technical Requirements

- Use `child_process.spawn()` with `stdio: ['pipe', 'pipe', 'pipe']`
- Store active process reference in memory map keyed by task ID
- Clean up process reference on exit/error events
- Broadcast log messages include timestamp and stream type (stdout/stderr)
- Log buffer limited to 50 lines, oldest entries evicted on overflow

### Command Template

```bash
claude --print "First, read the task context from {docsPath}/ (README.md, PLAN.md, CHECKLIST.md). Then execute: {task_title}. Context: {task_context}. Write any outputs to {docsPath}/output/"
```

### API Contracts

| Endpoint | Success Response | Error Response |
|----------|------------------|----------------|
| `POST /api/tasks/:id/run` | `200 {status: "running", pid: number}` | `409 {error: "An agent is already running"}` |
| `POST /api/tasks/:id/stop` | `200 {status: "stopping"}` | `404 {error: "No running agent found"}` |

### WebSocket Message Format

```typescript
interface LogMessage {
  type: 'stdout' | 'stderr' | 'exit' | 'error';
  data: string;
  timestamp: string; // ISO 8601
}
```
