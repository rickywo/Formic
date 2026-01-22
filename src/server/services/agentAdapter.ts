/**
 * Agent Adapter - Pluggable agent abstraction layer
 *
 * Supports multiple AI coding agents (Claude Code CLI, GitHub Copilot CLI)
 * through a unified interface. All agent-specific logic is contained here.
 */

export interface AgentConfig {
  /** CLI command (e.g., 'claude', 'copilot') */
  command: string;
  /** Build CLI arguments for execution */
  buildArgs: (prompt: string) => string[];
  /** Path to skills directory */
  skillsDir: string;
  /** Required environment variables */
  envVars: Record<string, string | undefined>;
}

export type AgentType = 'claude' | 'copilot';

/**
 * Agent configurations for supported agents
 */
const AGENTS: Record<AgentType, AgentConfig> = {
  claude: {
    command: 'claude',
    buildArgs: (prompt: string) => ['--print', '--dangerously-skip-permissions', prompt],
    skillsDir: '.claude/skills',
    envVars: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY },
  },
  copilot: {
    command: 'copilot',
    // --allow-all-paths required for autonomous execution (--add-dir has subdirectory bugs)
    // See: https://github.com/github/copilot-cli/issues/261
    buildArgs: (prompt: string) => ['--prompt', prompt, '--allow-all-tools', '--allow-all-paths'],
    skillsDir: '.claude/skills',
    envVars: {}, // Uses GitHub OAuth
  },
};

/**
 * Get the configured agent type from environment
 * Defaults to 'claude' if not specified or invalid
 */
export function getAgentType(): AgentType {
  const envType = process.env.AGENT_TYPE?.toLowerCase();
  if (envType === 'copilot') {
    return 'copilot';
  }
  return 'claude';
}

/**
 * Get the agent configuration for the configured agent type
 */
export function getAgentConfig(): AgentConfig {
  const agentType = getAgentType();
  const config = AGENTS[agentType];

  // Override command if AGENT_COMMAND is set
  const command = process.env.AGENT_COMMAND || config.command;

  return {
    ...config,
    command,
  };
}

/**
 * Get the CLI command for the configured agent
 */
export function getAgentCommand(): string {
  return getAgentConfig().command;
}

/**
 * Build CLI arguments for the configured agent
 */
export function buildAgentArgs(prompt: string): string[] {
  return getAgentConfig().buildArgs(prompt);
}

/**
 * Get the skills directory path for the configured agent
 */
export function getAgentSkillsDir(): string {
  return getAgentConfig().skillsDir;
}

/**
 * Get a human-readable name for the configured agent
 */
export function getAgentDisplayName(): string {
  const agentType = getAgentType();
  switch (agentType) {
    case 'claude':
      return 'Claude Code CLI';
    case 'copilot':
      return 'GitHub Copilot CLI';
    default:
      return agentType;
  }
}

/**
 * Validate that required environment variables are set for the agent
 * Returns an array of missing variable names, or empty array if all set
 */
export function validateAgentEnv(): string[] {
  const config = getAgentConfig();
  const missing: string[] = [];

  for (const [key, value] of Object.entries(config.envVars)) {
    if (value === undefined && !process.env[key]) {
      missing.push(key);
    }
  }

  return missing;
}
