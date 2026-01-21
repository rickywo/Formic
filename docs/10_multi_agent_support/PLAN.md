# Phase 10: Multi-Agent Support - Implementation Plan

## Status
**COMPLETE** - All tasks implemented and tested.

## Overview

This plan implements a pluggable agent abstraction layer that allows Formic to work with both Claude Code CLI and GitHub Copilot CLI. The implementation isolates all agent-specific logic into a single adapter module, requiring minimal changes to existing service code.

## Phase 1: Agent Adapter Foundation

- [x] 1.1 Create `src/server/services/agentAdapter.ts` with `AgentConfig` interface and `AgentType` type
- [x] 1.2 Implement Claude agent configuration with `--print --dangerously-skip-permissions` flags
- [x] 1.3 Implement Copilot agent configuration with `--prompt` and `--allow-all-tools` flags
- [x] 1.4 Add `getAgentConfig()` function that reads `AGENT_TYPE` from environment (default: 'claude')
- [x] 1.5 Add `buildAgentArgs()` helper function that returns CLI arguments array for a given prompt
- [x] 1.6 Add `getAgentCommand()` helper function that returns the CLI command from `AGENT_COMMAND` env var

## Phase 2: Skills Directory Migration

- [x] 2.1 Rename `getClaudeCommandsDir()` to `getSkillsDir()` in `src/server/utils/paths.ts`
- [x] 2.2 Update path from `.claude/commands` to `.claude/skills` in `paths.ts`
- [x] 2.3 Update all references in `src/server/services/skills.ts` to use new function name
- [x] 2.4 Add `name` field to `skills/brief/SKILL.md` frontmatter (value: 'brief')
- [x] 2.5 Add `name` field to `skills/plan/SKILL.md` frontmatter (value: 'plan')
- [x] 2.6 Update log messages in `skills.ts` to reference `.claude/skills/` instead of `.claude/commands/`

## Phase 3: Service Layer Integration

- [x] 3.1 Import `getAgentConfig` and `buildAgentArgs` in `src/server/services/runner.ts`
- [x] 3.2 Replace hardcoded `spawn(AGENT_COMMAND, ['--print', '--dangerously-skip-permissions', prompt])` with `spawn(config.command, config.buildArgs(prompt))` in `runner.ts`
- [x] 3.3 Import `getAgentConfig` and `buildAgentArgs` in `src/server/services/workflow.ts`
- [x] 3.4 Replace hardcoded Claude CLI invocation in `runWorkflowStep()` function with agent adapter
- [x] 3.5 Update error messages to reference the configured agent command instead of hardcoded 'claude'

## Phase 4: Environment Configuration

- [x] 4.1 Update `src/server/index.ts` to log selected agent type on startup
- [x] 4.2 Add agent configuration validation on startup (check if command exists in PATH)
- [x] 4.3 Add helpful error message when agent CLI is not installed

## Phase 5: Testing & Verification

- [x] 5.1 Test with `AGENT_TYPE=claude` to verify Claude Code CLI still works
- [x] 5.2 Test with `AGENT_TYPE=copilot` to verify GitHub Copilot CLI argument building
- [x] 5.3 Verify skills are copied to `.claude/skills/` directory
- [x] 5.4 Verify existing workflow (brief → plan → execute) functions with both agents
- [x] 5.5 Test error handling when selected agent is not installed

## Key Files to Modify

| File | Changes | Status |
|------|---------|--------|
| `src/server/services/agentAdapter.ts` | **NEW** - Agent abstraction layer | ✅ |
| `src/server/utils/paths.ts` | Rename function, update path | ✅ |
| `src/server/services/skills.ts` | Update function references | ✅ |
| `src/server/services/runner.ts` | Use agent adapter | ✅ |
| `src/server/services/workflow.ts` | Use agent adapter | ✅ |
| `skills/brief/SKILL.md` | Add `name` field | ✅ |
| `skills/plan/SKILL.md` | Add `name` field | ✅ |

## Success Criteria

- [x] Agent adapter module cleanly separates agent-specific logic
- [x] `AGENT_TYPE=claude` produces same behavior as current implementation
- [x] `AGENT_TYPE=copilot` produces correct Copilot CLI arguments
- [x] Skills directory changed to `.claude/skills/` for cross-agent compatibility
- [x] Skill files have `name` field required by Copilot
- [x] No breaking changes to existing API endpoints or WebSocket interface
