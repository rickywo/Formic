/**
 * Agent Adapter - Pluggable agent abstraction layer
 *
 * Supports multiple AI coding agents (Claude Code CLI, GitHub Copilot CLI)
 * through a unified interface. All agent-specific logic is contained here.
 */
import { engineConfig } from './engineConfig.js';
import type { AgentType, ModelStep } from '../../types/index.js';

export type { AgentType };

export interface AgentConfig {
  /** CLI command (e.g., 'claude', 'copilot') */
  command: string;
  /** Build CLI arguments for execution */
  buildArgs: (prompt: string, options?: { model?: string }) => string[];
  /** Path to skills directory */
  skillsDir: string;
  /** Required environment variables */
  envVars: Record<string, string | undefined>;
}

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
  buildAssistantArgs: (prompt: string, options?: { continue?: boolean; model?: string }) => string[];
}

/**
 * Agent configurations for supported agents
 */
const AGENTS: Record<AgentType, AgentConfig> = {
  claude: {
    command: 'claude',
    buildArgs: (prompt: string, options?: { model?: string }) => {
      const args = ['--print', '--dangerously-skip-permissions'];
      if (options?.model) {
        args.push('--model', options.model);
      }
      args.push(prompt);
      return args;
    },
    skillsDir: '.claude/skills',
    envVars: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY },
  },
  copilot: {
    command: 'copilot',
    buildArgs: (prompt: string, options?: { model?: string }) => {
      const args = options?.model ? ['--model', options.model] : [];
      args.push('--prompt', prompt, '--allow-all-tools', '--allow-all-paths');
      return args;
    },
    skillsDir: '.claude/skills',
    envVars: {}, // Uses GitHub OAuth
  },
  opencode: {
    command: 'opencode',
    // --agent formic-executor routes execution through the dedicated write-capable
    // agent profile (materialized to .opencode/agent/formic-executor.md at startup),
    // overriding any read-only persona from repo-root AGENTS.md/CLAUDE.md.
    buildArgs: (prompt: string, options?: { model?: string }) => {
      const args = ['run', '--agent', 'formic-executor', '--auto', '--format', 'json'];
      addOpenCodeModelArg(args, options?.model);
      args.push(prompt);
      return args;
    },
    // opencode natively scans .claude/skills/**/SKILL.md with the same frontmatter/body
    // parsing as Claude/Copilot (spike-confirmed) — do NOT add a parallel .opencode/skills
    // materialization step, it would be redundant.
    skillsDir: '.claude/skills',
    envVars: {}, // provider-dependent; validated per selected provider elsewhere
  },
};

/**
 * Assistant-specific configurations for read-only Task Manager mode
 */
/**
 * Claude Code tool names (PascalCase)
 */
const CLAUDE_READONLY_TOOLS = ['Read', 'Glob', 'Grep', 'LS', 'WebSearch', 'WebFetch'];
const CLAUDE_MCP_PLAYWRIGHT_TOOLS = [
  'mcp__playwright__browser_navigate',
  'mcp__playwright__browser_snapshot',
  'mcp__playwright__browser_take_screenshot',
  'mcp__playwright__browser_close',
];
const CLAUDE_ASSISTANT_TOOLS = [...CLAUDE_READONLY_TOOLS, ...CLAUDE_MCP_PLAYWRIGHT_TOOLS];
const CLAUDE_MESSAGING_TOOLS = [...CLAUDE_READONLY_TOOLS];

/**
 * GitHub Copilot CLI tool names (snake_case)
 */
const COPILOT_READONLY_TOOLS = ['view', 'glob', 'grep', 'web_fetch'];
const COPILOT_ASSISTANT_TOOLS = [...COPILOT_READONLY_TOOLS];
const COPILOT_MESSAGING_TOOLS = [...COPILOT_READONLY_TOOLS];

/**
 * OpenCode CLI tool names (snake_case)
 */
const OPENCODE_READONLY_TOOLS = ['read', 'glob', 'grep', 'webfetch', 'websearch'];
const OPENCODE_ASSISTANT_TOOLS = [...OPENCODE_READONLY_TOOLS];
const OPENCODE_MESSAGING_TOOLS = [...OPENCODE_READONLY_TOOLS];

const ASSISTANT_CONFIGS: Record<AgentType, AssistantConfig> = {
  claude: {
    outputFormat: 'stream-json',
    readOnlyTools: CLAUDE_ASSISTANT_TOOLS,
    supportsConversationContinue: true,
    buildAssistantArgs: (prompt: string, options?: { continue?: boolean; model?: string }) => {
      // No --allowedTools flag: inherits ALL tools from host MCP configuration
      const args = [
        '--print',
        '--output-format', 'stream-json',
        '--verbose',
        '--dangerously-skip-permissions',
      ];
      if (options?.continue) {
        args.push('--continue');
      }
      if (options?.model) {
        args.push('--model', options.model);
      }
      args.push(prompt);
      return args;
    },
  },
  copilot: {
    outputFormat: null, // Copilot uses plain text output
    readOnlyTools: COPILOT_ASSISTANT_TOOLS,
    supportsConversationContinue: true, // Copilot supports --continue
    buildAssistantArgs: (prompt: string, options?: { continue?: boolean; model?: string }) => {
      // Full MCP tool passthrough: --allow-all-tools inherits all host MCP tools
      // --no-color removes ANSI escape codes; --silent removed to preserve stderr status output
      const args = [
        '--allow-all-tools',
        '--allow-all-paths',
        '--no-color',
      ];
      if (options?.continue) {
        args.push('--continue');
      }
      if (options?.model) {
        args.unshift('--model', options.model);
      }
      args.splice(options?.model ? 2 : 0, 0, '--prompt', prompt);
      return args;
    },
  },
  opencode: {
    outputFormat: 'json',
    readOnlyTools: OPENCODE_ASSISTANT_TOOLS,
    supportsConversationContinue: true,
    buildAssistantArgs: (prompt: string, options?: { continue?: boolean; model?: string }) => {
      // Restricted `formic-readonly` agent profile grants only read/glob/grep/webfetch/websearch;
      // omitting --auto is unsafe (spike-confirmed: hangs indefinitely on a write attempt).
      const args = [
        'run',
        '--agent', 'formic-readonly',
        '--auto',
        '--format', 'json',
      ];
      if (options?.continue) {
        args.push('--continue');
      }
      addOpenCodeModelArg(args, options?.model);
      args.push(prompt);
      return args;
    },
  },
};

/**
 * Get the configured agent type. engineConfig is refreshed at top-level operation
 * boundaries so this remains synchronous for command construction.
 */
export function getAgentType(): AgentType {
  return engineConfig.agentType;
}

/**
 * Get the agent configuration for the configured agent type
 */
export function getAgentConfig(agentType = getAgentType()): AgentConfig {
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
export function getAgentCommand(agentType = getAgentType()): string {
  return getAgentConfig(agentType).command;
}

/**
 * Build CLI arguments for the configured agent
 */
export function buildAgentArgs(prompt: string, options?: { model?: string; agentType?: AgentType }): string[] {
  return getAgentConfig(options?.agentType).buildArgs(prompt, options);
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
export function getAgentDisplayName(agentType = getAgentType()): string {
  switch (agentType) {
    case 'claude':
      return 'Claude Code CLI';
    case 'copilot':
      return 'GitHub Copilot CLI';
    case 'opencode':
      return 'OpenCode CLI';
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
export function getAssistantConfig(agentType = getAgentType()): AssistantConfig {
  return ASSISTANT_CONFIGS[agentType];
}

/**
 * Build CLI arguments for assistant (read-only) mode
 */
export function buildAssistantArgs(prompt: string, options?: { continue?: boolean; model?: string; agentType?: AgentType }): string[] {
  return getAssistantConfig(options?.agentType).buildAssistantArgs(prompt, options);
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
export function supportsConversationContinue(agentType = getAgentType()): boolean {
  return getAssistantConfig(agentType).supportsConversationContinue;
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
export function buildMessagingAssistantArgs(prompt: string, options?: { continue?: boolean; model?: string; agentType?: AgentType }): string[] {
  const agentType = options?.agentType ?? getAgentType();

  if (agentType === 'copilot') {
    const args = [
      '--available-tools', ...COPILOT_MESSAGING_TOOLS,
      '--allow-all-paths',
      '--no-color',
    ];
    if (options?.continue) {
      args.push('--continue');
    }
    if (options?.model) {
      args.unshift('--model', options.model);
    }
    args.splice(options?.model ? 2 : 0, 0, '--prompt', prompt);
    return args;
  }

  if (agentType === 'opencode') {
    const args = [
      'run',
      '--agent', 'formic-readonly',
      '--auto',
      '--format', 'json',
    ];
    if (options?.continue) {
      args.push('--continue');
    }
    addOpenCodeModelArg(args, options?.model);
    args.push(prompt);
    return args;
  }

  // Default: claude
  const args = [
    '--print',
    '--output-format', 'stream-json',
    '--verbose',
    '--allowedTools', CLAUDE_MESSAGING_TOOLS.join(','),
    '--dangerously-skip-permissions',
  ];
  if (options?.continue) {
    args.push('--continue');
  }
  if (options?.model) {
    args.push('--model', options.model);
  }
  args.push(prompt);
  return args;
}

const OPENCODE_MODEL_ID_PATTERN = /^[\w.-]+\/[\w.-]+$/;

function addOpenCodeModelArg(args: string[], model: string | undefined): void {
  if (!model) {
    return;
  }

  if (!OPENCODE_MODEL_ID_PATTERN.test(model)) {
    console.warn(`[AgentAdapter] Invalid opencode model id (expected provider/model): ${model} — using agent default`);
    return;
  }

  args.push('--model', model);
}

export interface ModelOption {
  id: string;
  label: string;
}

const MODEL_CATALOG: Record<AgentType, ModelOption[]> = {
  claude: [
    { id: '', label: 'Agent default' },
    { id: 'claude-opus-4-8', label: 'Opus 4.8' },
    { id: 'claude-sonnet-5', label: 'Sonnet 5' },
    { id: 'claude-fable-5', label: 'Fable 5' },
    { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
  ],
  copilot: [
    { id: '', label: 'Agent default' },
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
    { id: 'gpt-5', label: 'GPT-5' },
  ],
  opencode: [
    { id: '', label: 'Agent default' },
    { id: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5 (Anthropic)' },
    { id: 'anthropic/claude-opus-4-8', label: 'Claude Opus 4.8 (Anthropic)' },
  ],
};

export function getAvailableModels(): ModelOption[] {
  return MODEL_CATALOG[getAgentType()];
}

/** Resolve the configured model for a step under the active agent type. '' = default. */
export function getModelForStep(step: ModelStep): string {
  return engineConfig.stepModels[getAgentType()]?.[step] ?? '';
}
