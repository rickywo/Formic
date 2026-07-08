/**
 * Reproduction / regression fixture for lease preemption and deadlock resolution
 * stop-before-release sequencing (task t-5).
 *
 * preemptLease and detectDeadlock are not reachable via the REST API (they are
 * invoked from the workflow declare path and the watchdog respectively), so the
 * Python regression tests in test/test_concurrency_advanced.py spawn this script
 * with tsx against an isolated workspace and assert on its JSON output.
 *
 * Usage:
 *   WORKSPACE_PATH=/tmp/isolated npx tsx test/fixtures/lease_stop_repro.ts <scenario>
 *
 * Scenarios:
 *   preempt          — holder stoppable: preemption must stop the holder before release
 *   preempt-refuse   — holder cannot be stopped: preemption must be refused
 *   deadlock         — victim stoppable: resolution must stop the victim before release
 *   deadlock-refuse  — victim cannot be stopped: resolution must be skipped
 *
 * Prints a single JSON result object as the final stdout line.
 */

import {
  acquireLeases,
  preemptLease,
  detectDeadlock,
  getLeasesByTask,
  recordWait,
} from '../../src/server/services/leaseManager.js';
import { createTask, getTask, loadBoard, saveBoard } from '../../src/server/services/store.js';
import type { Task } from '../../src/types/index.js';

interface StopCall {
  taskId: string;
  leasesHeldAtCall: number;
}

type StopperFn = (taskId: string) => Promise<boolean>;

/**
 * Register a stub task stopper that records each stop request together with the
 * number of leases the target still held at the moment of the call.
 *
 * Uses a dynamic import with feature detection: registerTaskStopper does not
 * exist in pre-fix code, so this fixture still runs (and its assertions fail,
 * proving the regression) against the unfixed tree.
 */
async function registerStubStopper(succeed: boolean, calls: StopCall[]): Promise<boolean> {
  const events = (await import('../../src/server/services/internalEvents.js')) as Record<string, unknown>;
  const register = events.registerTaskStopper;
  if (typeof register !== 'function') {
    return false;
  }
  (register as (fn: StopperFn) => void)(async (taskId: string) => {
    calls.push({ taskId, leasesHeldAtCall: getLeasesByTask(taskId).length });
    return succeed;
  });
  return true;
}

/**
 * Simulate a task that is past planning: give it a resume marker so the tests
 * can verify re-queueing preserves resumeFromStep.
 */
async function setResumeMarker(taskId: string): Promise<void> {
  const board = await loadBoard();
  const task = board.tasks.find((t: Task) => t.id === taskId);
  if (task) {
    task.resumeFromStep = 'declare';
    await saveBoard(board);
  }
}

async function runPreempt(stopSucceeds: boolean): Promise<Record<string, unknown>> {
  const stopCalls: StopCall[] = [];
  const stopperRegistered = await registerStubStopper(stopSucceeds, stopCalls);

  const holder = await createTask({ title: 'Repro preempt holder', context: 'lease stop repro', priority: 'low', type: 'standard' });
  const requester = await createTask({ title: 'Repro preempt requester', context: 'lease stop repro', priority: 'high', type: 'standard' });
  await setResumeMarker(holder.id);

  const file = `src/repro-preempt-${Date.now()}.ts`;
  const acquired = acquireLeases({ taskId: holder.id, exclusiveFiles: [file], sharedFiles: [] });

  const preemptResult = await preemptLease(requester.id, file);

  const holderAfter = await getTask(holder.id);
  const holderCalls = stopCalls.filter(c => c.taskId === holder.id);
  return {
    scenario: stopSucceeds ? 'preempt' : 'preempt-refuse',
    stopperRegistered,
    leaseGranted: acquired.granted,
    preemptResult,
    stopperCalledForHolder: holderCalls.length > 0,
    holderHeldLeaseWhenStopped: holderCalls.some(c => c.leasesHeldAtCall > 0),
    holderLeasesAfter: getLeasesByTask(holder.id).length,
    holderStatusAfter: holderAfter?.status ?? 'missing',
    resumeFromStepAfter: holderAfter?.resumeFromStep ?? null,
  };
}

async function runDeadlock(stopSucceeds: boolean): Promise<Record<string, unknown>> {
  const stopCalls: StopCall[] = [];
  const stopperRegistered = await registerStubStopper(stopSucceeds, stopCalls);

  const victim = await createTask({ title: 'Repro deadlock victim', context: 'lease stop repro', priority: 'low', type: 'standard' });
  const survivor = await createTask({ title: 'Repro deadlock survivor', context: 'lease stop repro', priority: 'high', type: 'standard' });
  await setResumeMarker(victim.id);

  const fileX = `src/repro-deadlock-x-${Date.now()}.ts`;
  const fileY = `src/repro-deadlock-y-${Date.now()}.ts`;
  acquireLeases({ taskId: victim.id, exclusiveFiles: [fileX], sharedFiles: [] });
  acquireLeases({ taskId: survivor.id, exclusiveFiles: [fileY], sharedFiles: [] });

  // Cross-waits: victim waits on fileY (held by survivor), survivor waits on fileX (held by victim)
  recordWait(victim.id, fileY);
  recordWait(survivor.id, fileX);

  const cycles = await detectDeadlock();

  const victimAfter = await getTask(victim.id);
  const victimCalls = stopCalls.filter(c => c.taskId === victim.id);
  return {
    scenario: stopSucceeds ? 'deadlock' : 'deadlock-refuse',
    stopperRegistered,
    cyclesDetected: cycles ? cycles.length : 0,
    stopperCalledForVictim: victimCalls.length > 0,
    victimHeldLeaseWhenStopped: victimCalls.some(c => c.leasesHeldAtCall > 0),
    victimLeasesAfter: getLeasesByTask(victim.id).length,
    survivorLeasesAfter: getLeasesByTask(survivor.id).length,
    victimStatusAfter: victimAfter?.status ?? 'missing',
    resumeFromStepAfter: victimAfter?.resumeFromStep ?? null,
  };
}

async function main(): Promise<void> {
  if (!process.env.WORKSPACE_PATH || process.env.WORKSPACE_PATH === './workspace') {
    console.error('[Repro] Refusing to run: WORKSPACE_PATH must point to an isolated scratch directory');
    process.exit(2);
  }

  const scenario = process.argv[2];
  let result: Record<string, unknown>;
  switch (scenario) {
    case 'preempt':
      result = await runPreempt(true);
      break;
    case 'preempt-refuse':
      result = await runPreempt(false);
      break;
    case 'deadlock':
      result = await runDeadlock(true);
      break;
    case 'deadlock-refuse':
      result = await runDeadlock(false);
      break;
    default:
      console.error(`[Repro] Unknown scenario: ${scenario ?? '(none)'}`);
      process.exit(2);
      return;
  }

  console.log(JSON.stringify(result));
  process.exit(0);
}

main().catch(err => {
  console.error('[Repro] Failed:', err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
