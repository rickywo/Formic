# Phase 11: Auto-Queue System

## Overview

The Auto-Queue System introduces a new "queued" status/swimlane that enables automated task execution without manual intervention. Tasks placed in the queue are automatically picked up and executed by the system based on priority and FIFO ordering. Each task executes on its own isolated git branch, enabling parallel development workflows while giving users full control over code review and merge timing.

This feature transforms Formic from a manually-triggered task runner into a semi-autonomous development pipeline where users can queue up multiple tasks and let the system process them automatically.

## Goals

- Enable hands-off task execution by automatically triggering queued tasks
- Support parallel task execution with configurable concurrency limits
- Isolate each task's changes on a dedicated git branch to prevent conflicts during execution
- Provide visibility into branch status (ahead/behind main, merge conflicts)
- Simplify conflict resolution by enabling one-click creation of conflict resolution tasks
- Maintain backward compatibility with manual task triggering via the TODO column

## Key Capabilities

- **New "Queued" Swimlane**: A dedicated column for tasks awaiting automatic execution
- **Priority-Based Ordering**: Tasks execute in order of priority (high > medium > low), with FIFO ordering within the same priority level
- **Configurable Concurrency**: System-wide setting for maximum concurrent task executions (default: 1)
- **Git Branch Isolation**: Each task automatically creates and executes on a branch named `formic/t-{id}_{slug}`
- **Per-Task Base Branch**: Tasks branch from `main` by default, but users can configure a different base branch per task
- **Branch Status Indicators**: Visual indicators showing if a branch is ahead, behind, has conflicts, or is merged
- **Branch Name in Task Details**: Task card modal displays the associated branch name for easy reference
- **One-Click Conflict Resolution**: Button to create a new task pre-filled with context for resolving merge conflicts between branches
- **Manual Trigger Preserved**: TODO column retains existing behavior where users manually click "Run" to execute

## Non-Goals

- **Auto-merge to main**: The system will not automatically merge completed task branches; users retain full control over merging
- **Dependency management between tasks**: Tasks execute independently; no mechanism for declaring "Task B depends on Task A"
- **Conflict prevention**: The system does not analyze tasks to predict or prevent conflicts; conflicts are resolved after execution
- **Branch rebasing**: Automatic rebasing of task branches when main advances is out of scope
- **PR creation**: Automatic pull request creation is not included in this phase

## Requirements

### Functional Requirements

- New task status `queued` added to the status workflow
- Background scheduler/processor that monitors the queue and triggers execution
- Git integration to create, checkout, and track branches within the workspace
- Task schema extended with `branch`, `branchStatus`, `baseBranch`, and `createdAt` fields
- UI updated with new "Queued" column between TODO and RUNNING
- Task detail modal shows branch name and branch status
- "Create Conflict Resolution Task" action available for tasks with conflict status
- Configuration option for `maxConcurrentTasks` (environment variable or config file)

### Technical Requirements

- Queue processor must handle system restarts gracefully (persist queue state)
- Branch operations must validate workspace has no uncommitted changes before switching
- Branch status detection must work with standard git commands
- Concurrency control must prevent race conditions when multiple tasks complete simultaneously
- UI must reflect real-time status updates via existing WebSocket infrastructure

### User Experience Requirements

- Clear visual distinction between QUEUED (auto) and TODO (manual) columns
- Intuitive drag-and-drop to move tasks between TODO and QUEUED
- Branch status visible at a glance on task cards in REVIEW column
- Conflict resolution task creation requires minimal clicks (ideally one)
- Configuration of max concurrent tasks should not require code changes
