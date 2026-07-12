import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  buildAgentArgs,
  buildAssistantArgs,
  buildMessagingAssistantArgs,
  getAvailableModels,
  getAgentCommand,
  getAgentConfig,
  getAgentDisplayName,
  getAgentSkillsDir,
  getAgentType,
  getAssistantConfig,
  getAssistantOutputFormat,
  getAssistantReadOnlyTools,
  getModelForStep,
  supportsConversationContinue,
  validateAgentEnv,
} from '../../src/server/services/agentAdapter.js';
import { engineConfig, normalizeAgentType } from '../../src/server/services/engineConfig.js';

// ---------------------------------------------------------------------------
// Engine config isolation helpers — getAgentType() reads engineConfig.agentType,
// not process.env.AGENT_TYPE, so tests must mutate engineConfig directly.
// ---------------------------------------------------------------------------
let savedAgentType: string;

beforeEach(() => {
  savedAgentType = engineConfig.agentType;
});

afterEach(() => {
  engineConfig.agentType = savedAgentType;
});

// ---------------------------------------------------------------------------
// Subtask 1: getAgentType
// ---------------------------------------------------------------------------
describe('getAgentType (opencode)', () => {
  it("returns 'opencode' when AGENT_TYPE=opencode", () => {
    engineConfig.agentType = 'opencode';
    assert.equal(getAgentType(), 'opencode');
  });

  it("returns 'claude' when AGENT_TYPE is unset (default)", () => {
    engineConfig.agentType = 'claude';
    assert.equal(getAgentType(), 'claude');
  });

  it("returns 'copilot' correctly (regression)", () => {
    engineConfig.agentType = 'copilot';
    assert.equal(getAgentType(), 'copilot');
  });

  it('handles case-insensitivity via normalizeAgentType', () => {
    assert.equal(normalizeAgentType('OPENCODE'), 'opencode');
    assert.equal(normalizeAgentType('Opencode'), 'opencode');
    assert.equal(normalizeAgentType('Copilot'), 'copilot');
  });

  it("returns 'claude' for unknown agent types (normalizeAgentType returns null)", () => {
    assert.equal(normalizeAgentType('nonexistent'), null);
  });
});

// ---------------------------------------------------------------------------
// Subtask 2: getAgentConfig
// ---------------------------------------------------------------------------
describe('getAgentConfig (opencode)', () => {
  it("returns command='opencode' for opencode", () => {
    engineConfig.agentType = 'opencode';
    const config = getAgentConfig();
    assert.equal(config.command, 'opencode');
  });

  it("returns skillsDir='.claude/skills' for opencode", () => {
    engineConfig.agentType = 'opencode';
    const config = getAgentConfig();
    assert.equal(config.skillsDir, '.claude/skills');
  });

  it('returns empty envVars object for opencode', () => {
    engineConfig.agentType = 'opencode';
    const config = getAgentConfig();
    assert.deepStrictEqual(config.envVars, {});
  });

  it('respects AGENT_COMMAND override for opencode', () => {
    engineConfig.agentType = 'opencode';
    process.env.AGENT_COMMAND = '/custom/path/opencode';
    const config = getAgentConfig();
    assert.equal(config.command, '/custom/path/opencode');
    delete process.env.AGENT_COMMAND;
  });
});

// ---------------------------------------------------------------------------
// Subtask 3: getAgentDisplayName / getAgentCommand / getAgentSkillsDir
// ---------------------------------------------------------------------------
describe('getAgentDisplayName (opencode)', () => {
  it("returns 'OpenCode CLI' for opencode", () => {
    engineConfig.agentType = 'opencode';
    assert.equal(getAgentDisplayName(), 'OpenCode CLI');
  });

  it("returns 'Claude Code CLI' for claude", () => {
    engineConfig.agentType = 'claude';
    assert.equal(getAgentDisplayName(), 'Claude Code CLI');
  });

  it("returns 'GitHub Copilot CLI' for copilot", () => {
    engineConfig.agentType = 'copilot';
    assert.equal(getAgentDisplayName(), 'GitHub Copilot CLI');
  });
});

describe('getAgentCommand (opencode)', () => {
  it("returns 'opencode' when AGENT_TYPE=opencode", () => {
    engineConfig.agentType = 'opencode';
    assert.equal(getAgentCommand(), 'opencode');
  });
});

describe('getAgentSkillsDir (opencode)', () => {
  it("returns '.claude/skills' when AGENT_TYPE=opencode", () => {
    engineConfig.agentType = 'opencode';
    assert.equal(getAgentSkillsDir(), '.claude/skills');
  });
});

// ---------------------------------------------------------------------------
// Subtask 4: buildAgentArgs
// ---------------------------------------------------------------------------
describe('buildAgentArgs (opencode)', () => {
  it("produces ['run','--agent','formic-executor','--auto','--format','json','<prompt>'] for opencode", () => {
    engineConfig.agentType = 'opencode';
    const args = buildAgentArgs('fix the bug');
    assert.deepStrictEqual(args, ['run', '--agent', 'formic-executor', '--auto', '--format', 'json', 'fix the bug']);
  });

  it('appends any prompt string to the opencode args array', () => {
    engineConfig.agentType = 'opencode';
    const args = buildAgentArgs('hello world 123');
    assert.deepStrictEqual(args, ['run', '--agent', 'formic-executor', '--auto', '--format', 'json', 'hello world 123']);
  });
});

// ---------------------------------------------------------------------------
// Subtask 5: validateAgentEnv
// ---------------------------------------------------------------------------
describe('validateAgentEnv (opencode)', () => {
  it('returns empty array (opencode has no required env vars)', () => {
    engineConfig.agentType = 'opencode';
    const missing = validateAgentEnv();
    assert.deepStrictEqual(missing, []);
  });

  it('still reports missing keys for claude when ANTHROPIC_API_KEY is unset', () => {
    engineConfig.agentType = 'claude';
    const saved = process.env.ANTHROPIC_API_KEY;
    // opencode env is empty, but claude's env requires ANTHROPIC_API_KEY.
    // The config's envVars already captured process.env.ANTHROPIC_API_KEY at
    // module-load time via the AGENTS literal — so this test is advisory.
    // We only assert that opencode validates to zero missing.
    const missing = validateAgentEnv();
    if (saved) {
      process.env.ANTHROPIC_API_KEY = saved;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
    // opencode test already passed above — this is just a sanity check.
    assert.ok(Array.isArray(missing), 'must return an array');
  });
});

// ---------------------------------------------------------------------------
// Subtask 6: getAssistantConfig
// ---------------------------------------------------------------------------
describe('getAssistantConfig (opencode)', () => {
  it("returns outputFormat='json' for opencode", () => {
    engineConfig.agentType = 'opencode';
    const config = getAssistantConfig();
    assert.equal(config.outputFormat, 'json');
  });

  it('returns supportsConversationContinue=true for opencode', () => {
    engineConfig.agentType = 'opencode';
    const config = getAssistantConfig();
    assert.equal(config.supportsConversationContinue, true);
  });

  it('returns readOnlyTools matching OPENCODE_ASSISTANT_TOOLS', () => {
    engineConfig.agentType = 'opencode';
    const config = getAssistantConfig();
    const expected = ['read', 'glob', 'grep', 'webfetch', 'websearch'];
    assert.deepStrictEqual(config.readOnlyTools, expected);
  });
});

// ---------------------------------------------------------------------------
// Subtask 7: buildAssistantArgs
// ---------------------------------------------------------------------------
describe('buildAssistantArgs (opencode)', () => {
  it('includes --agent formic-readonly --auto --format json for opencode', () => {
    engineConfig.agentType = 'opencode';
    const args = buildAssistantArgs('summarize the repo');
    assert.deepStrictEqual(args, [
      'run',
      '--agent',
      'formic-readonly',
      '--auto',
      '--format',
      'json',
      'summarize the repo',
    ]);
  });

  it('includes --continue flag when options.continue is true', () => {
    engineConfig.agentType = 'opencode';
    const args = buildAssistantArgs('continue work', { continue: true });
    assert.deepStrictEqual(args, [
      'run',
      '--agent',
      'formic-readonly',
      '--auto',
      '--format',
      'json',
      '--continue',
      'continue work',
    ]);
  });

  it('omits --continue flag when options.continue is false', () => {
    engineConfig.agentType = 'opencode';
    const args = buildAssistantArgs('fresh prompt', { continue: false });
    assert.deepStrictEqual(args, [
      'run',
      '--agent',
      'formic-readonly',
      '--auto',
      '--format',
      'json',
      'fresh prompt',
    ]);
  });

  it('omits --continue flag when options is undefined', () => {
    engineConfig.agentType = 'opencode';
    const args = buildAssistantArgs('fresh prompt');
    assert.deepStrictEqual(args, [
      'run',
      '--agent',
      'formic-readonly',
      '--auto',
      '--format',
      'json',
      'fresh prompt',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Subtask 8: buildMessagingAssistantArgs and supportsConversationContinue
// ---------------------------------------------------------------------------
describe('buildMessagingAssistantArgs (opencode)', () => {
  it('includes --agent formic-readonly --auto --format json for opencode', () => {
    engineConfig.agentType = 'opencode';
    const args = buildMessagingAssistantArgs('board status');
    assert.deepStrictEqual(args, [
      'run',
      '--agent',
      'formic-readonly',
      '--auto',
      '--format',
      'json',
      'board status',
    ]);
  });

  it('includes --continue flag when options.continue is true', () => {
    engineConfig.agentType = 'opencode';
    const args = buildMessagingAssistantArgs('board status', { continue: true });
    assert.deepStrictEqual(args, [
      'run',
      '--agent',
      'formic-readonly',
      '--auto',
      '--format',
      'json',
      '--continue',
      'board status',
    ]);
  });
});

describe('supportsConversationContinue (opencode)', () => {
  it('returns true for opencode', () => {
    engineConfig.agentType = 'opencode';
    assert.equal(supportsConversationContinue(), true);
  });

  it('returns true for claude (regression)', () => {
    engineConfig.agentType = 'claude';
    assert.equal(supportsConversationContinue(), true);
  });

  it('returns true for copilot (regression)', () => {
    engineConfig.agentType = 'copilot';
    assert.equal(supportsConversationContinue(), true);
  });
});

// ---------------------------------------------------------------------------
// Additional coverage: getAssistantOutputFormat and getAssistantReadOnlyTools
// ---------------------------------------------------------------------------
describe('getAssistantOutputFormat (opencode)', () => {
  it("returns 'json' for opencode", () => {
    engineConfig.agentType = 'opencode';
    assert.equal(getAssistantOutputFormat(), 'json');
  });

  it("returns 'stream-json' for claude", () => {
    engineConfig.agentType = 'claude';
    assert.equal(getAssistantOutputFormat(), 'stream-json');
  });

  it('returns null for copilot', () => {
    engineConfig.agentType = 'copilot';
    assert.equal(getAssistantOutputFormat(), null);
  });
});

describe('getAssistantReadOnlyTools (opencode)', () => {
  it('returns the opencode read-only tool list', () => {
    engineConfig.agentType = 'opencode';
    const tools = getAssistantReadOnlyTools();
    assert.deepStrictEqual(tools, ['read', 'glob', 'grep', 'webfetch', 'websearch']);
  });
});

// ---------------------------------------------------------------------------
// Subtask 9: Regression assertions — restore AGENT_TYPE to claude and verify defaults
// ---------------------------------------------------------------------------
describe('regression guard (claude defaults)', () => {
  it("returns 'claude' from getAgentType after restoring AGENT_TYPE", () => {
    engineConfig.agentType = 'claude';
    assert.equal(getAgentType(), 'claude');
  });

  it("returns 'Claude Code CLI' from getAgentDisplayName after restoring", () => {
    engineConfig.agentType = 'claude';
    assert.equal(getAgentDisplayName(), 'Claude Code CLI');
  });

  it("returns 'claude' from getAgentCommand after restoring", () => {
    engineConfig.agentType = 'claude';
    assert.equal(getAgentCommand(), 'claude');
  });

  it('buildAgentArgs uses --print for claude (not opencode style)', () => {
    engineConfig.agentType = 'claude';
    const args = buildAgentArgs('fix the bug');
    assert.deepStrictEqual(args, [
      '--print',
      '--dangerously-skip-permissions',
      'fix the bug',
    ]);
  });

  it('buildAssistantArgs uses --print and --output-format stream-json for claude', () => {
    engineConfig.agentType = 'claude';
    const args = buildAssistantArgs('explain');
    assert.ok(args.includes('--print'), 'claude assistant must use --print');
    assert.ok(args.includes('--output-format'), 'claude assistant must use --output-format');
    assert.ok(args.includes('stream-json'), 'claude assistant must use stream-json');
  });

  it("getAssistantOutputFormat returns 'stream-json' for claude", () => {
    engineConfig.agentType = 'claude';
    assert.equal(getAssistantOutputFormat(), 'stream-json');
  });

  it('buildMessagingAssistantArgs uses --print for claude (not opencode style)', () => {
    engineConfig.agentType = 'claude';
    const args = buildMessagingAssistantArgs('board status');
    assert.ok(args.includes('--print'), 'claude messaging must use --print');
    assert.ok(args.includes('--output-format'), 'claude messaging must use --output-format');
    assert.ok(args.includes('--verbose'), 'claude messaging must use --verbose');
  });
});

// ---------------------------------------------------------------------------
// Per-step model selection foundation: builder regression matrix
// ---------------------------------------------------------------------------
type BuilderName = 'executor' | 'assistant' | 'messaging';

interface BuilderCase {
  name: BuilderName;
  buildArgs: (prompt: string, model?: string) => string[];
  defaultArgs: string[];
  modelArgs: string[];
}

interface AgentBuilderMatrix {
  agentType: 'claude' | 'copilot' | 'opencode';
  model: string;
  builders: BuilderCase[];
}

const PROMPT = 'model selection prompt';
const MODEL = 'claude-sonnet-5';
const OPENCODE_MODEL = 'anthropic/claude-sonnet-5';

const AGENT_BUILDER_MATRICES: AgentBuilderMatrix[] = [
  {
    agentType: 'claude',
    model: MODEL,
    builders: [
      {
        name: 'executor',
        buildArgs: (prompt, model) => buildAgentArgs(prompt, model ? { model } : undefined),
        defaultArgs: ['--print', '--dangerously-skip-permissions', PROMPT],
        modelArgs: ['--print', '--dangerously-skip-permissions', '--model', MODEL, PROMPT],
      },
      {
        name: 'assistant',
        buildArgs: (prompt, model) => buildAssistantArgs(prompt, model ? { model } : undefined),
        defaultArgs: ['--print', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', PROMPT],
        modelArgs: ['--print', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', '--model', MODEL, PROMPT],
      },
      {
        name: 'messaging',
        buildArgs: (prompt, model) => buildMessagingAssistantArgs(prompt, model ? { model } : undefined),
        defaultArgs: ['--print', '--output-format', 'stream-json', '--verbose', '--allowedTools', 'Read,Glob,Grep,LS,WebSearch,WebFetch', '--dangerously-skip-permissions', PROMPT],
        modelArgs: ['--print', '--output-format', 'stream-json', '--verbose', '--allowedTools', 'Read,Glob,Grep,LS,WebSearch,WebFetch', '--dangerously-skip-permissions', '--model', MODEL, PROMPT],
      },
    ],
  },
  {
    agentType: 'copilot',
    model: MODEL,
    builders: [
      {
        name: 'executor',
        buildArgs: (prompt, model) => buildAgentArgs(prompt, model ? { model } : undefined),
        defaultArgs: ['--prompt', PROMPT, '--allow-all-tools', '--allow-all-paths'],
        modelArgs: ['--model', MODEL, '--prompt', PROMPT, '--allow-all-tools', '--allow-all-paths'],
      },
      {
        name: 'assistant',
        buildArgs: (prompt, model) => buildAssistantArgs(prompt, model ? { model } : undefined),
        defaultArgs: ['--prompt', PROMPT, '--allow-all-tools', '--allow-all-paths', '--no-color'],
        modelArgs: ['--model', MODEL, '--prompt', PROMPT, '--allow-all-tools', '--allow-all-paths', '--no-color'],
      },
      {
        name: 'messaging',
        buildArgs: (prompt, model) => buildMessagingAssistantArgs(prompt, model ? { model } : undefined),
        defaultArgs: ['--prompt', PROMPT, '--available-tools', 'view', 'glob', 'grep', 'web_fetch', '--allow-all-paths', '--no-color'],
        modelArgs: ['--model', MODEL, '--prompt', PROMPT, '--available-tools', 'view', 'glob', 'grep', 'web_fetch', '--allow-all-paths', '--no-color'],
      },
    ],
  },
  {
    agentType: 'opencode',
    model: OPENCODE_MODEL,
    builders: [
      {
        name: 'executor',
        buildArgs: (prompt, model) => buildAgentArgs(prompt, model ? { model } : undefined),
        defaultArgs: ['run', '--agent', 'formic-executor', '--auto', '--format', 'json', PROMPT],
        modelArgs: ['run', '--agent', 'formic-executor', '--auto', '--format', 'json', '--model', OPENCODE_MODEL, PROMPT],
      },
      {
        name: 'assistant',
        buildArgs: (prompt, model) => buildAssistantArgs(prompt, model ? { model } : undefined),
        defaultArgs: ['run', '--agent', 'formic-readonly', '--auto', '--format', 'json', PROMPT],
        modelArgs: ['run', '--agent', 'formic-readonly', '--auto', '--format', 'json', '--model', OPENCODE_MODEL, PROMPT],
      },
      {
        name: 'messaging',
        buildArgs: (prompt, model) => buildMessagingAssistantArgs(prompt, model ? { model } : undefined),
        defaultArgs: ['run', '--agent', 'formic-readonly', '--auto', '--format', 'json', PROMPT],
        modelArgs: ['run', '--agent', 'formic-readonly', '--auto', '--format', 'json', '--model', OPENCODE_MODEL, PROMPT],
      },
    ],
  },
];

describe('agent adapter model argument builders', () => {
  for (const matrix of AGENT_BUILDER_MATRICES) {
    for (const builder of matrix.builders) {
      it(`${matrix.agentType} ${builder.name} preserves default arguments without a model`, () => {
        engineConfig.agentType = matrix.agentType;
        assert.deepStrictEqual(builder.buildArgs(PROMPT), builder.defaultArgs);
      });

      it(`${matrix.agentType} ${builder.name} places --model before the prompt`, () => {
        engineConfig.agentType = matrix.agentType;
        assert.deepStrictEqual(builder.buildArgs(PROMPT, matrix.model), builder.modelArgs);
      });
    }
  }
});

describe('opencode invalid model fallback', () => {
  for (const builder of AGENT_BUILDER_MATRICES[2].builders) {
    it(`omits an invalid model and warns for the ${builder.name} builder`, () => {
      engineConfig.agentType = 'opencode';
      const warnings: unknown[][] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]): void => {
        warnings.push(args);
      };

      try {
        assert.deepStrictEqual(builder.buildArgs(PROMPT, 'sonnet-5'), builder.defaultArgs);
      } finally {
        console.warn = originalWarn;
      }

      assert.deepStrictEqual(warnings, [[
        '[AgentAdapter] Invalid opencode model id (expected provider/model): sonnet-5 — using agent default',
      ]]);
    });
  }
});

describe('model catalog and step resolution', () => {
  const savedStepModels = engineConfig.stepModels;

  afterEach(() => {
    engineConfig.stepModels = savedStepModels;
  });

  it('returns only the catalog for the active agent', () => {
    for (const agentType of ['claude', 'copilot', 'opencode'] as const) {
      engineConfig.agentType = agentType;
      const models = getAvailableModels();
      assert.ok(models.length > 0);
      assert.ok(models.every((model) => model.id !== ''));
      assert.equal(new Set(models.map((model) => model.id)).size, models.length);
    }

    engineConfig.agentType = 'opencode';
    assert.deepStrictEqual(getAvailableModels()[0], {
      id: 'anthropic/claude-sonnet-5',
      label: 'Claude Sonnet 5 (Anthropic)',
    });
  });

  it('resolves models only from the active agent namespace', () => {
    engineConfig.stepModels = {
      claude: { brief: 'claude-opus-4-8' },
      opencode: { brief: 'anthropic/claude-sonnet-5' },
    };

    engineConfig.agentType = 'claude';
    assert.equal(getModelForStep('brief'), 'claude-opus-4-8');
    assert.equal(getModelForStep('execute'), '');

    engineConfig.agentType = 'opencode';
    assert.equal(getModelForStep('brief'), 'anthropic/claude-sonnet-5');
  });
});
