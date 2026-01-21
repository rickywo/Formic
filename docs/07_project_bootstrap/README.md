# Phase 7: Project Bootstrap & Development Guidelines

## Status
**COMPLETE** - Bootstrap feature implemented and tested.

## Overview

Implement an automatic bootstrap system that detects first-time project setup and generates AI development guidelines specific to the workspace codebase. When Formic starts against a new project, it creates a special bootstrap task that audits the repository and produces a `kanban-development-guideline.md` file containing project-specific coding standards, architectural patterns, and behavioral rules for Claude to follow.

## Goals

- Automatically detect when a project workspace lacks AI development guidelines
- Create a bootstrap task that audits the codebase structure, dependencies, and patterns
- Generate a comprehensive `kanban-development-guideline.md` in the workspace root
- Ensure Claude follows project-specific standards for all subsequent tasks
- Provide a consistent onboarding experience for every new project

## Key Capabilities

- First-run detection by checking for `kanban-development-guideline.md` in workspace root
- Automatic creation of a special bootstrap task (`t-bootstrap`) on first access
- Codebase audit covering tech stack, architectural patterns, testing strategies, and coding conventions
- Template-based guideline generation using `templates/development-guideline.md`
- Bootstrap status visibility in the board API response
- Re-bootstrap capability by deleting the guidelines file and restarting

## Non-Goals

- Interactive configuration wizard for guidelines
- Multiple guideline profiles per project
- Automatic guideline updates when dependencies change
- Integration with external linting/formatting tools for rule extraction
- Version control or history of guideline changes
- Guidelines enforcement or validation during task execution

## Requirements

- Bootstrap detection must occur on first `GET /api/board` request
- Bootstrap task must have reserved ID `t-bootstrap` with slug `setup-guidelines`
- Template file `templates/development-guideline.md` must be bundled with the application
- Generated `kanban-development-guideline.md` must be placed in workspace root (not `.formic/`)
- Bootstrap task prompt must instruct Claude to:
  - Explore repository structure and identify tech stack
  - Analyze architectural patterns and folder organization
  - Review testing frameworks and strategies
  - Check linting/formatting configurations
  - Document coding conventions and anti-patterns
- Board API response must include `bootstrapRequired: boolean` flag
- Frontend must visually distinguish the bootstrap task from regular tasks
- Bootstrap task must be deletable like any other task (for re-bootstrap flow)
