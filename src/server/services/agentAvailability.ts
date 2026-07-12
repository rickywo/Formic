import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentAvailability, AgentType } from '../../types/index.js';
import { getAgentDisplayName } from './agentAdapter.js';

const execFileAsync = promisify(execFile);
const CACHE_TTL_MS = 60_000;
let cachedAgents: AgentAvailability[] | null = null;
let cachedAt = 0;

interface AgentProbe {
  type: AgentType;
  command: string;
  args: string[];
  fallback?: { command: string; args: string[] };
  hint: string;
}

const PROBES: AgentProbe[] = [
  { type: 'claude', command: 'claude', args: ['--version'], hint: 'Install: npm install -g @anthropic-ai/claude-code' },
  { type: 'copilot', command: 'gh', args: ['copilot', '--version'], fallback: { command: 'copilot', args: ['--version'] }, hint: 'Install: gh extension install github/gh-copilot' },
  { type: 'opencode', command: 'opencode', args: ['--version'], hint: 'Install: npm install -g opencode-ai' },
];

async function probe(command: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(command, args, { timeout: 5000 });
    return stdout.trim().split('\n')[0]?.trim() || null;
  } catch {
    return null;
  }
}

/** Detect supported CLI providers asynchronously, caching the result for one minute. */
export async function detectAgents(force = false): Promise<AgentAvailability[]> {
  if (!force && cachedAgents && Date.now() - cachedAt < CACHE_TTL_MS) return cachedAgents;
  const agents = await Promise.all(PROBES.map(async ({ type, command, args, fallback, hint }) => {
    let version = await probe(command, args);
    if (!version && fallback) version = await probe(fallback.command, fallback.args);
    if (type === 'copilot' && version) version = version.replace(/^GitHub Copilot CLI\s*/i, '');
    return version
      ? { type, displayName: getAgentDisplayName(type), installed: true, version }
      : { type, displayName: getAgentDisplayName(type), installed: false, hint };
  }));
  cachedAgents = agents;
  cachedAt = Date.now();
  return agents;
}
