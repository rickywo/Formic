# Phase 5: Frontend

## Overview

Build a web-based "Mission Control" dashboard that provides a Kanban-style interface for managing AI agent tasks. The frontend connects to the existing backend API and WebSocket endpoints to display task states, allow user interactions, and stream real-time agent execution logs.

## Goals

- Provide a visual Kanban board with four columns: Todo, Running, Review, Done
- Enable users to create, edit, and delete tasks through the UI
- Allow task status changes via drag-and-drop between columns
- Display real-time agent output in an embedded terminal view
- Deliver a dark-themed "Mission Control" aesthetic that feels professional and focused

## Key Capabilities

- **Kanban Board Layout**: Four-column grid displaying tasks organized by status
- **Task Cards**: Visual cards showing title, priority badge, context snippet, and action buttons
- **Task Creator Modal**: Form for creating new tasks with title, context, and priority fields
- **Drag-and-Drop**: Move tasks between columns to update their status
- **Run/Stop Controls**: Buttons to start agent execution (todo) or stop running agents
- **Live Terminal Panel**: xterm.js-powered terminal showing real-time stdout/stderr streams
- **WebSocket Integration**: Client-side WebSocket connection for receiving live agent logs
- **Responsive Status Updates**: UI reflects task state changes (running pulse animation, status badges)

## Non-Goals

- User authentication or multi-user support
- Mobile-responsive design (desktop-first for v1)
- React or other framework migration (vanilla JS for simplicity)
- Persistent terminal history beyond current session
- Task filtering or search functionality
- Keyboard shortcuts

## Requirements

### Functional Requirements

- Display all tasks from `/api/board` endpoint on page load
- Render tasks in appropriate columns based on their `status` field
- Task cards must show: title, priority badge, truncated context, action button
- "New Task" button opens a modal with title, context (textarea), and priority dropdown
- Submitting the form calls `POST /api/tasks` and adds the new card to Todo column
- Clicking a task card opens an edit view or detail panel
- Delete button on cards calls `DELETE /api/tasks/:id` with confirmation
- Run button (on todo tasks) calls `POST /api/tasks/:id/run` and moves card to Running
- Stop button (on running tasks) calls `POST /api/tasks/:id/stop`
- Drag-and-drop between columns calls `PUT /api/tasks/:id` with new status
- Terminal panel connects to `ws://localhost:8000/ws/logs/:taskId` for running tasks
- Terminal displays stdout in green, stderr in red
- Terminal auto-scrolls but pauses on manual scroll

### Technical Requirements

- Single `index.html` file with embedded CSS and JavaScript
- No build step required (vanilla HTML/CSS/JS)
- xterm.js loaded via CDN for terminal rendering
- Fetch API for REST calls
- Native WebSocket API for real-time communication
- CSS custom properties for theming (easy dark mode colors)
- Semantic HTML structure for accessibility basics

### Visual Requirements

- Dark theme: Background `#0d1117`, Cards `#161b22`, Accents per status
- Priority badges: High (red), Medium (yellow), Low (gray)
- Status indicators: Todo (gray), Running (blue pulse), Review (yellow), Done (green)
- Monospace font for terminal, system font for UI
- Terminal panel: Fixed bottom drawer, ~300px height, collapsible
