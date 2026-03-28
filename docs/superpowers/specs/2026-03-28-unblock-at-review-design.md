# Unblock Tasks at Review + Show Blocked in Queued Column

**Date:** 2026-03-28
**Status:** Approved

## Problem

Two issues with the current task blocking mechanism:

1. **Blocked tasks are invisible on the board.** The kanban columns (`todo`, `queued`, `running`, `verifying`, `review`, `done`) have no mapping for the `blocked` status in `getColumnForStatus()`. Blocked tasks exist in data but never render.

2. **Unblocking requires human approval, stalling the pipeline.** `unblockSiblingTasks()` only fires when a dependency reaches `done` (manually approved). The entire goal-task pipeline blocks waiting for a human to approve each dependency sequentially.

## Solution

Three surgical edits across two files.

### Change 1: Widen dependency resolution check

**File:** `src/server/services/store.ts` — `unblockSiblingTasks()` (line 278)

A dependency is considered resolved when it reaches `review` OR `done`.

**Before:**
```typescript
return dep !== undefined && dep.status === 'done';
```

**After:**
```typescript
return dep !== undefined && (dep.status === 'review' || dep.status === 'done');
```

### Change 2: Trigger unblocking on review transitions

`unblockSiblingTasks()` is called in two places, both gated to `status === 'done'`. Both must also trigger on `review`.

**Location A — `updateTask()` (line 219):**

Before:
```typescript
if (input.status === 'done' && previousStatus !== 'done' && task.parentGoalId) {
```

After:
```typescript
if ((input.status === 'done' || input.status === 'review') && input.status !== previousStatus && task.parentGoalId) {
```

Update the comment above to:
```
// Post-transition hook: unblock sibling tasks when status transitions to 'review' or 'done'.
```

**Location B — `updateTaskStatus()` (line 347):**

Before:
```typescript
if (status === 'done' && board.tasks[taskIndex].parentGoalId) {
```

After:
```typescript
if ((status === 'done' || status === 'review') && board.tasks[taskIndex].parentGoalId) {
```

Update the comment above to:
```
// Post-transition hook: unblock sibling tasks whose dependencies are now resolved (review or done)
```

### Change 3: Show blocked tasks in Queued column

**File:** `src/client/index.html` — `getColumnForStatus()` (line 8418)

Before:
```javascript
function getColumnForStatus(status) {
  if (status === 'briefing' || status === 'planning' || status === 'running' || status === 'architecting') {
    return 'running';
  }
  return status;
}
```

After:
```javascript
function getColumnForStatus(status) {
  if (status === 'briefing' || status === 'planning' || status === 'running' || status === 'architecting') {
    return 'running';
  }
  if (status === 'blocked') {
    return 'queued';
  }
  return status;
}
```

The existing `blocked-badge` CSS and rendering (line 8471) already handles the visual indicator.

Also apply the same change to `src/client/demo.html` (line 8442) to keep the demo in sync.

## What stays unchanged

- `blocked-badge` HTML/CSS rendering — already works
- Prioritizer dependency graph analysis — unaffected
- Task creation and goal decomposition logic — unchanged
- Lease-based concurrency — unaffected

## Acceptance Criteria

- [ ] Blocked tasks appear in the Queued column with a "Blocked" badge
- [ ] Tasks unblock when all dependencies reach `review` (not just `done`)
- [ ] Tasks also unblock when dependencies reach `done` (backward compatible)
- [ ] Unblocking triggers immediately on the review transition, not only on done
- [ ] No regressions in existing task lifecycle (standard, quick, goal workflows)
