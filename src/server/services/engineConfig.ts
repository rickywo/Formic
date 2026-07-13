/**
 * Engine Config Singleton
 * Provides synchronous access to engine settings loaded from configStore.
 * Call refreshEngineConfig() at the start of each top-level operation
 * (workflow execution, queue poll tick, watchdog scan) to pick up config changes.
 */
import { loadConfig } from './configStore.js';
import type { AgentType, StepModelConfig } from '../../types/index.js';

export interface EngineConfig {
  agentType: AgentType;
  maxConcurrentTasks: number;
  leaseDurationMs: number;
  watchdogIntervalMs: number;
  maxYieldCount: number;
  queuePollIntervalMs: number;
  maxExecuteIterations: number;
  stepTimeoutMs: number;
  maxExecutionRetries: number;
  stepModels: Partial<Record<AgentType, StepModelConfig>>;
}

export const engineConfig: EngineConfig = {
  agentType: normalizeAgentType(process.env.AGENT_TYPE) ?? 'claude',
  maxConcurrentTasks: 1,
  leaseDurationMs: 300000,
  watchdogIntervalMs: 30000,
  maxYieldCount: 50,
  queuePollIntervalMs: 5000,
  maxExecuteIterations: 5,
  stepTimeoutMs: 6000000,
  maxExecutionRetries: 3,
  stepModels: {},
};

/** Normalize a user or environment supplied provider name. */
export function normalizeAgentType(value: unknown): AgentType | null {
  if (typeof value !== 'string') return null;
  const agentType = value.toLowerCase();
  return agentType === 'claude' || agentType === 'copilot' || agentType === 'opencode'
    ? agentType
    : null;
}

export async function refreshEngineConfig(): Promise<void> {
  const config = await loadConfig();
  const s = config.settings;
  engineConfig.agentType = normalizeAgentType(s.agentType)
    ?? normalizeAgentType(process.env.AGENT_TYPE)
    ?? 'claude';
  engineConfig.maxConcurrentTasks = s.maxConcurrentSessions ?? 1;
  engineConfig.leaseDurationMs = s.leaseDurationMs ?? 300000;
  engineConfig.watchdogIntervalMs = s.watchdogIntervalMs ?? 30000;
  engineConfig.maxYieldCount = s.maxYieldCount ?? 50;
  engineConfig.queuePollIntervalMs = s.queuePollIntervalMs ?? 5000;
  engineConfig.maxExecuteIterations = s.maxExecuteIterations ?? 5;
  engineConfig.stepTimeoutMs = s.stepTimeoutMs ?? 6000000;
  engineConfig.maxExecutionRetries = s.maxExecutionRetries ?? 3;
  engineConfig.stepModels = s.stepModels ?? {};
}
