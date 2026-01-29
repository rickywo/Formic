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
 * Assistant-specific configuration for read-only Task Manager mode
 */
export interface AssistantConfig {
  /** Output format flag (e.g., 'stream-json' for Claude) */
  outputFormat: string | null;
  /** List of read-only tools allowed for the assistant */
  readOnlyTools: string[];
  /** Whether the agent supports --continue for conversation context */
  supportsConversationContinue: boolean;
  /** Build CLI arguments for assistant (read-only) mode */
  buildAssistantArgs: (prompt: string, options?: { continue?: boolean }) => string[];
}

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
    buildArgs: (prompt: string) => ['-p', prompt, '--allow-all-tools', '-s'],
    skillsDir: '.claude/skills',
    envVars: {}, // Uses GitHub OAuth
  },
};

/**
 * Assistant-specific configurations for read-only Task Manager mode
 */
/**
 * MCP Playwright tools for screenshot capabilities in assistant mode
 */
const MCP_PLAYWRIGHT_TOOLS = [
  'mcp__playwright__browser_navigate',
  'mcp__playwright__browser_snapshot',
  'mcp__playwright__browser_take_screenshot',
  'mcp__playwright__browser_close',
];

/**
 * Base read-only tools available in assistant mode
 */
const BASE_READONLY_TOOLS = ['Read', 'Glob', 'Grep', 'LS', 'WebSearch', 'WebFetch'];

/**
 * All assistant tools (base read-only + MCP Playwright for screenshots)
 * Used by the desktop UI assistant which has MCP server configured
 */
const ASSISTANT_TOOLS = [...BASE_READONLY_TOOLS, ...MCP_PLAYWRIGHT_TOOLS];

/**
 * Messaging assistant tools (base read-only only, no MCP Playwright)
 * MCP tools are unreachable in the messaging subprocess context because
 * no MCP server configuration is injected into the spawned CLI process.
 */
const MESSAGING_ASSISTANT_TOOLS = [...BASE_READONLY_TOOLS];

const ASSISTANT_CONFIGS: Record<AgentType, AssistantConfig> = {
  claude: {
    outputFormat: 'stream-json',
    readOnlyTools: ASSISTANT_TOOLS,
    supportsConversationContinue: true,
    buildAssistantArgs: (prompt: string, options?: { continue?: boolean }) => {
      const args = [
        '--print',
        '--output-format', 'stream-json',
        '--verbose',
        '--allowedTools', ASSISTANT_TOOLS.join(','),
        '--dangerously-skip-permissions',
      ];
      if (options?.continue) {
        args.push('--continue');
      }
      args.push(prompt);
      return args;
    },
  },
  copilot: {
    outputFormat: null, // Copilot uses plain text output
    readOnlyTools: ASSISTANT_TOOLS,
    supportsConversationContinue: true, // Copilot supports --continue
    buildAssistantArgs: (prompt: string, options?: { continue?: boolean }) => {
      // Copilot CLI: use --available-tools to restrict to read-only tools
      // Use -s (silent) for cleaner output without stats
      const args = [
        '-p', prompt,
        '-s', // Silent mode - output only agent response
        '--available-tools', ASSISTANT_TOOLS.join(','),
      ];
      if (options?.continue) {
        args.push('--continue');
      }
      return args;
    },
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

/**
 * Get the assistant configuration for the configured agent type
 */
export function getAssistantConfig(): AssistantConfig {
  const agentType = getAgentType();
  return ASSISTANT_CONFIGS[agentType];
}

/**
 * Build CLI arguments for assistant (read-only) mode
 */
export function buildAssistantArgs(prompt: string, options?: { continue?: boolean }): string[] {
  return getAssistantConfig().buildAssistantArgs(prompt, options);
}

/**
 * Get the output format for the configured agent's assistant mode
 * Returns null if the agent uses plain text output
 */
export function getAssistantOutputFormat(): string | null {
  return getAssistantConfig().outputFormat;
}

/**
 * Check if the configured agent supports conversation continuation (--continue flag)
 */
export function supportsConversationContinue(): boolean {
  return getAssistantConfig().supportsConversationContinue;
}

/**
 * Get the list of read-only tools allowed for the assistant
 */
export function getAssistantReadOnlyTools(): string[] {
  return getAssistantConfig().readOnlyTools;
}

/**
 * Build CLI arguments for messaging assistant mode (no MCP Playwright tools).
 * The messaging subprocess cannot access MCP tools because no MCP server
 * configuration is injected into the spawned process.
 */
export function buildMessagingAssistantArgs(prompt: string, options?: { continue?: boolean }): string[] {
  const agentType = getAgentType();

  if (agentType === 'copilot') {
    const args = [
      '-p', prompt,
      '-s',
      '--available-tools', MESSAGING_ASSISTANT_TOOLS.join(','),
    ];
    if (options?.continue) {
      args.push('--continue');
    }
    return args;
  }

  // Default: claude
  const args = [
    '--print',
    '--output-format', 'stream-json',
    '--verbose',
    '--allowedTools', MESSAGING_ASSISTANT_TOOLS.join(','),
    '--dangerously-skip-permissions',
  ];
  if (options?.continue) {
    args.push('--continue');
  }
  args.push(prompt);
  return args;
}
