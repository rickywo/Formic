/**
 * Usage Service — Queries agent-specific usage/credit information
 *
 * Supports Claude (via `claude --usage` CLI) and GitHub Copilot (via GitHub API).
 * Caches results for 60 seconds to avoid excessive API calls.
 */

import { execFile } from 'node:child_process';
import { getAgentType } from './agentAdapter.js';
import type { UsageInfo, UsageStatus } from '../../types/index.js';

const CACHE_TTL_MS = 60_000;

let cachedUsage: UsageInfo | null = null;
let cacheTimestamp = 0;

function computeStatus(percentage: number): UsageStatus {
  const remaining = 100 - percentage;
  if (remaining > 50) return 'ok';
  if (remaining >= 10) return 'warning';
  return 'critical';
}

function unknownUsage(agent: string): UsageInfo {
  return {
    agent,
    used: 0,
    limit: 0,
    percentage: 0,
    label: 'Usage unavailable',
    status: 'unknown',
  };
}

function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

async function queryClaudeUsage(): Promise<UsageInfo> {
  return new Promise<UsageInfo>((resolve) => {
    execFile('claude', ['--usage'], { timeout: 10_000 }, (err, stdout, stderr) => {
      if (err) {
        console.warn(`[Usage] Failed to run 'claude --usage': ${err instanceof Error ? err.message : 'Unknown error'}`);
        if (stderr) {
          console.warn(`[Usage] stderr: ${stderr.trim()}`);
        }
        resolve(unknownUsage('claude'));
        return;
      }

      try {
        const output = stdout.trim();
        // Try to parse structured output — common patterns:
        // "Used: 1234 / 5000 credits" or "Usage: 45%" or JSON output
        let used = 0;
        let limit = 0;

        // Try JSON parse first
        try {
          const json = JSON.parse(output) as Record<string, unknown>;
          if (typeof json.used === 'number') used = json.used;
          if (typeof json.limit === 'number') limit = json.limit;
          if (typeof json.total === 'number') limit = json.total;
        } catch {
          // Try regex patterns for common CLI output formats
          const creditMatch = output.match(/(\d[\d,]*)\s*\/\s*(\d[\d,]*)/);
          if (creditMatch) {
            used = parseInt(creditMatch[1].replace(/,/g, ''), 10);
            limit = parseInt(creditMatch[2].replace(/,/g, ''), 10);
          } else {
            const percentMatch = output.match(/(\d+(?:\.\d+)?)\s*%/);
            if (percentMatch) {
              const pct = parseFloat(percentMatch[1]);
              used = Math.round(pct);
              limit = 100;
            }
          }
        }

        if (limit <= 0) {
          // Could not parse meaningful data
          console.warn(`[Usage] Could not parse claude --usage output: ${output.substring(0, 200)}`);
          resolve(unknownUsage('claude'));
          return;
        }

        const percentage = Math.min(100, Math.round((used / limit) * 100));
        const status = computeStatus(percentage);
        const label = limit === 100
          ? `${percentage}% used`
          : `${formatNumber(used)} / ${formatNumber(limit)} credits`;

        resolve({ agent: 'claude', used, limit, percentage, label, status });
      } catch (parseErr) {
        console.warn(`[Usage] Error parsing claude usage: ${parseErr instanceof Error ? parseErr.message : 'Unknown error'}`);
        resolve(unknownUsage('claude'));
      }
    });
  });
}

async function queryCopilotUsage(): Promise<UsageInfo> {
  try {
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (!token) {
      console.warn('[Usage] No GITHUB_TOKEN or GH_TOKEN set; cannot query Copilot usage');
      return unknownUsage('copilot');
    }

    const response = await fetch('https://api.github.com/copilot_billing/usage', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      console.warn(`[Usage] GitHub Copilot billing API returned ${response.status}`);
      return unknownUsage('copilot');
    }

    const data = await response.json() as Record<string, unknown>;
    let used = 0;
    let limit = 0;

    if (typeof data.used === 'number') used = data.used;
    if (typeof data.limit === 'number') limit = data.limit;
    if (typeof data.total === 'number') limit = data.total;

    if (limit <= 0) {
      // If API doesn't return structured limits, show as unknown
      console.warn('[Usage] Copilot billing response missing limit/total fields');
      return unknownUsage('copilot');
    }

    const percentage = Math.min(100, Math.round((used / limit) * 100));
    const status = computeStatus(percentage);
    const label = `${formatNumber(used)} / ${formatNumber(limit)} credits`;

    return { agent: 'copilot', used, limit, percentage, label, status };
  } catch (fetchErr) {
    console.warn(`[Usage] Error querying Copilot usage: ${fetchErr instanceof Error ? fetchErr.message : 'Unknown error'}`);
    return unknownUsage('copilot');
  }
}

/**
 * Get current agent usage information (cached for 60 seconds)
 */
export async function getUsageInfo(): Promise<UsageInfo> {
  const now = Date.now();
  if (cachedUsage && (now - cacheTimestamp) < CACHE_TTL_MS) {
    return cachedUsage;
  }

  const agentType = getAgentType();

  try {
    if (agentType === 'copilot') {
      cachedUsage = await queryCopilotUsage();
    } else if (agentType === 'opencode') {
      // TODO: opencode has no single unified quota (provider-dependent).
      // Investigate whether `opencode session list --format json` exposes
      // usage/session stats worth surfacing.
      cachedUsage = unknownUsage(agentType);
    } else {
      cachedUsage = await queryClaudeUsage();
    }
  } catch (err) {
    console.warn(`[Usage] Unexpected error: ${err instanceof Error ? err.message : 'Unknown error'}`);
    cachedUsage = unknownUsage(agentType);
  }

  cacheTimestamp = now;
  return cachedUsage;
}
