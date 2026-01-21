# Phase 10: Multi-Agent Support

## Overview

Implement a pluggable agent abstraction layer that allows users to switch between Claude Code CLI and GitHub Copilot CLI as the underlying AI coding agent. This enables Formic to serve users regardless of which AI coding assistant they have access to, expanding the product's addressable market while maintaining the same workflow experience.

## Goals

- Allow users to choose between Claude Code CLI and GitHub Copilot CLI without code changes
- Provide a unified interface for agent execution regardless of the underlying CLI tool
- Maintain full workflow compatibility (brief → plan → execute) with both agents
- Enable environment-based agent selection via `AGENT_TYPE` configuration
- Ensure bundled skills work with both agents through compatible skill format

## Key Capabilities

- **Agent Configuration Interface**: TypeScript interface defining how each agent CLI is invoked, including command, arguments, and environment variables
- **Environment-Based Selection**: Users set `AGENT_TYPE=claude` or `AGENT_TYPE=copilot` to switch agents
- **Unified Skills Directory**: Both agents use `.claude/skills/` directory for skill definitions (compatible format)
- **CLI Argument Abstraction**: Each agent defines its own argument builder for non-interactive execution mode
- **Transparent Workflow Execution**: Brief, plan, and execute steps work identically regardless of selected agent
- **Graceful Fallback**: Clear error messages when selected agent is not installed or configured

## Non-Goals

- Supporting agents beyond Claude Code CLI and GitHub Copilot CLI in this phase
- Runtime agent switching (agent selection is at startup via environment variable)
- Agent-specific skill syntax (skills must work with both agents)
- Performance benchmarking or comparison between agents
- Agent capability feature flags (both agents assumed to have equivalent capabilities)
- Custom agent plugin system for third-party agents

## Requirements

### Functional Requirements

1. **Agent Adapter Module**
   - Create `agentAdapter.ts` with `AgentConfig` interface
   - Implement configuration objects for Claude and Copilot agents
   - Provide `getAgentConfig()` function that reads `AGENT_TYPE` environment variable
   - Export `buildAgentCommand()` function for constructing CLI invocations

2. **CLI Argument Mapping**
   - Claude Code: `claude --print --dangerously-skip-permissions <prompt>`
   - GitHub Copilot: `copilot --prompt <prompt> --allow-all-tools`
   - Both must support skill invocation syntax

3. **Skills Compatibility**
   - Rename skills directory from `.claude/commands/` to `.claude/skills/`
   - Add `name` field to skill frontmatter (required by Copilot, optional for Claude)
   - Update skill copying logic in `skills.ts` to use new directory path

4. **Service Layer Updates**
   - Update `runner.ts` to use agent adapter instead of hardcoded Claude commands
   - Update `workflow.ts` to use agent adapter for all workflow steps
   - Update `paths.ts` to reference `.claude/skills/` directory

5. **Environment Configuration**
   - `AGENT_COMMAND`: The CLI command to execute (default: `claude`)
   - `AGENT_TYPE`: The agent type for flag selection (default: `claude`)
   - Document required environment variables for each agent type

### Technical Requirements

- Agent adapter must be a pure function with no side effects for testability
- All agent-specific logic must be contained within `agentAdapter.ts`
- Existing tests must pass with both agent configurations
- No breaking changes to the board API or WebSocket interface
- Skills must validate successfully with both Claude and Copilot CLI tools

### Schema Requirements

```typescript
interface AgentConfig {
  command: string;                              // CLI command (e.g., 'claude', 'copilot')
  buildArgs: (prompt: string) => string[];      // Build CLI arguments for execution
  skillsDir: string;                            // Path to skills directory
  envVars: Record<string, string | undefined>;  // Required environment variables
}

type AgentType = 'claude' | 'copilot';

const AGENTS: Record<AgentType, AgentConfig> = {
  claude: {
    command: 'claude',
    buildArgs: (prompt) => ['--print', '--dangerously-skip-permissions', prompt],
    skillsDir: '.claude/skills',
    envVars: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }
  },
  copilot: {
    command: 'copilot',
    buildArgs: (prompt) => ['--prompt', prompt, '--allow-all-tools'],
    skillsDir: '.claude/skills',
    envVars: {}  // Uses GitHub OAuth
  }
};
```
