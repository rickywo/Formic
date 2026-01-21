# Phase 9: Structured Subtask Management & Iterative Execution

## Overview

Implement a JSON-based subtask management system that replaces markdown checkboxes with structured data, enabling programmatic tracking and verification of task completion. The execute step will use an iterative loop (inspired by the Ralph Wiggum approach) that continues until all subtasks are verified complete, ensuring tasks only move to "review" when implementation is truly finished.

## Goals

- Replace scattered markdown checkboxes (CHECKLIST.md) with a centralized `subtasks.json` file as the agent's source of truth
- Enable the agent to programmatically read, update, and track subtask progress during execution
- Implement iterative execution that verifies completion before moving tasks to review
- Provide clear visibility into task progress through structured subtask data
- Maintain human-readable documentation (README.md, PLAN.md) while using JSON for machine interaction

## Key Capabilities

- **Structured Subtask Storage**: JSON-based subtasks.json file with defined schema for status tracking
- **Completion Verification**: Automatic checking of subtask completion percentage before state transitions
- **Iterative Execution Loop**: Agent continues working until all subtasks are complete (or max iterations reached)
- **Subtask CRUD Operations**: API endpoints for reading and updating individual subtask status
- **Progress Visibility**: Real-time completion percentage and status for each subtask
- **Dynamic Subtask Discovery**: Agent can add new subtasks discovered during implementation

## Non-Goals

- Complex dependency management between subtasks (v1 uses simple linear ordering)
- Parallel subtask execution (single agent concurrency maintained)
- Subtask time estimation or scheduling
- Automatic rollback of completed subtasks on failure
- UI for manual subtask editing (API-only for v1)
- Nested subtasks or hierarchical task structures

## Requirements

### Functional Requirements

1. **subtasks.json Generation**
   - The `/plan` skill must generate subtasks.json alongside PLAN.md
   - Schema must include: version, taskId, title, timestamps, and subtasks array
   - Each subtask must have: id, content, status (pending/in_progress/completed)

2. **Subtask Service**
   - Parse and validate subtasks.json files
   - Calculate completion percentage
   - Check if all subtasks are complete
   - Update individual subtask status with timestamp

3. **Iterative Execution**
   - Execute step runs in a loop checking subtasks.json after each iteration
   - Provide context to agent about incomplete subtasks between iterations
   - Configurable maximum iterations (default: 5) as safety limit
   - Only transition to "review" when 100% subtasks complete

4. **API Endpoints**
   - GET `/api/tasks/:id/subtasks` - Retrieve all subtasks for a task
   - PUT `/api/tasks/:id/subtasks/:subtaskId` - Update subtask status
   - GET `/api/tasks/:id/subtasks/completion` - Get completion stats

### Technical Requirements

- Remove CHECKLIST.md generation from taskDocs.ts templates
- Update `/plan` skill to generate subtasks.json
- Add `$TASK_ID` variable substitution in skill reader
- Create new `subtasks.ts` service module
- Modify `workflow.ts` to implement iterative execution loop
- Update TypeScript types for subtask schema

### Schema Requirements

```typescript
interface Subtask {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  completedAt?: string; // ISO 8601 timestamp
}

interface SubtasksFile {
  version: string;
  taskId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  subtasks: Subtask[];
}
```
