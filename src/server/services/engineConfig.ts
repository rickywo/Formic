/**
 * Engine Config Singleton
 * Provides synchronous access to engine settings loaded from configStore.
 * Call refreshEngineConfig() at the start of each top-level operation
 * (workflow execution, queue poll tick, watchdog scan) to pick up config changes.
 */
import { loadConfig } from './configStore.js';

export interface EngineConfig {
  maxConcurrentTasks: number;
  verifyCommand: string;
  skipVerify: boolean;
  leaseDurationMs: number;
  watchdogIntervalMs: number;
  maxYieldCount: number;
  queuePollIntervalMs: number;
  maxExecuteIterations: number;
  stepTimeoutMs: number;
  maxExecutionRetries: number;
}

export const engineConfig: EngineConfig = {
  maxConcurrentTasks: 1,
  verifyCommand: '',
  skipVerify: false,
  leaseDurationMs: 300000,
  watchdogIntervalMs: 30000,
  maxYieldCount: 50,
  queuePollIntervalMs: 5000,
  maxExecuteIterations: 5,
  stepTimeoutMs: 6000000,
  maxExecutionRetries: 3,
};

/**
 * Read the live leaseDurationMs value directly from the persisted config,
 * bypassing the in-memory engineConfig singleton. Callers that need the
 * currently-configured duration (not the possibly-stale startup default)
 * should await this instead of reading engineConfig.leaseDurationMs.
 */
export async function getLiveLeaseDurationMs(): Promise<number> {
  const config = await loadConfig();
  return config.settings.leaseDurationMs ?? 300000;
}

export async function refreshEngineConfig(): Promise<void> {
  const config = await loadConfig();
  const s = config.settings;
  engineConfig.maxConcurrentTasks = s.maxConcurrentSessions ?? 1;
  engineConfig.verifyCommand = s.verifyCommand ?? '';
  engineConfig.skipVerify = s.skipVerify ?? false;
  engineConfig.leaseDurationMs = s.leaseDurationMs ?? 300000;
  engineConfig.watchdogIntervalMs = s.watchdogIntervalMs ?? 30000;
  engineConfig.maxYieldCount = s.maxYieldCount ?? 50;
  engineConfig.queuePollIntervalMs = s.queuePollIntervalMs ?? 5000;
  engineConfig.maxExecuteIterations = s.maxExecuteIterations ?? 5;
  engineConfig.stepTimeoutMs = s.stepTimeoutMs ?? 6000000;
  engineConfig.maxExecutionRetries = s.maxExecutionRetries ?? 3;
}
