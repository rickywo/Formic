/**
 * Repro: Deadlock Survivor stale wait-state (t-152)
 *
 * Reproduces a suspected bug in `detectDeadlock()` (src/server/services/leaseManager.ts,
 * ~line 469-486): when a wait-for cycle is resolved, only the lowest-priority "victim"
 * task has its lease released (`releaseLeases`) and its `waitForMap` entry cleared
 * (`clearWait`). The other ("survivor") task(s) in the cycle keep their stale
 * `waitForMap` entry — nothing calls `clearWait()` for them — even though they were
 * part of the resolved cycle. That stale entry can later combine with an unrelated
 * new wait registration to form a "phantom" deadlock cycle the survivor never
 * actually participated in creating.
 *
 * This script drives the real, unmodified `leaseManager.ts` functions directly
 * (`acquireLeases`, `recordWait`, `clearWait`, `releaseLeases`, `detectDeadlock`,
 * `getAllLeases`, `getWaitForEntries`) — no reimplementation of lease logic.
 *
 * Run:
 *   npx tsx test/repro-deadlock-survivor.ts
 */

import {
  acquireLeases,
  recordWait,
  clearWait,
  releaseLeases,
  detectDeadlock,
  getAllLeases,
  getWaitForEntries,
} from '../src/server/services/leaseManager.js';
import { createTask, deleteTask } from '../src/server/services/store.js';

const LOG_PREFIX = '[LeaseManager]';

function dumpLeaseState(label: string): void {
  console.log(`${LOG_PREFIX} --- snapshot: ${label} ---`);
  console.log(`${LOG_PREFIX} leases:`, JSON.stringify(getAllLeases().map((l) => ({
    filePath: l.filePath,
    taskId: l.taskId,
    leaseType: l.leaseType,
  }))));
  console.log(`${LOG_PREFIX} waitForMap entries:`, JSON.stringify(getWaitForEntries()));
}

async function main(): Promise<number> {
  const suffix = Math.random().toString(36).slice(2, 10);
  const fileX = `src/deadlock-x-${suffix}.ts`;
  const fileY = `src/deadlock-y-${suffix}.ts`;

  console.log('='.repeat(70));
  console.log('DEADLOCK SURVIVOR REPRO — leaseManager.ts detectDeadlock()');
  console.log('='.repeat(70));

  // Task A: high priority, will end up the "survivor". Task B: low priority, the victim.
  const taskA = await createTask({ title: `Deadlock Survivor A ${suffix}`, context: 'repro t-152', priority: 'high' });
  const taskB = await createTask({ title: `Deadlock Survivor B ${suffix}`, context: 'repro t-152', priority: 'low' });

  // Step 1: A holds fileX, B holds fileY.
  acquireLeases({ taskId: taskA.id, exclusiveFiles: [fileX], sharedFiles: [] });
  acquireLeases({ taskId: taskB.id, exclusiveFiles: [fileY], sharedFiles: [] });

  // Step 2: A wants fileY (held by B) -> denied -> recordWait(A, Y).
  const attemptA = acquireLeases({ taskId: taskA.id, exclusiveFiles: [fileY], sharedFiles: [] });
  if (!attemptA.granted) recordWait(taskA.id, fileY);

  // Step 3: B wants fileX (held by A) -> denied -> recordWait(B, X). Cycle A<->B now exists.
  const attemptB = acquireLeases({ taskId: taskB.id, exclusiveFiles: [fileX], sharedFiles: [] });
  if (!attemptB.granted) recordWait(taskB.id, fileX);

  dumpLeaseState('before detectDeadlock() #1 (cycle A<->B formed)');

  // Step 4: Trigger the real detectDeadlock() code path (same one the watchdog calls).
  const cycle1 = await detectDeadlock();
  console.log(`${LOG_PREFIX} cycle1 detected:`, JSON.stringify(cycle1));

  dumpLeaseState('after detectDeadlock() #1 (cycle should be resolved)');

  const waitEntriesAfter1 = getWaitForEntries();
  const bClearedFrom1 = !waitEntriesAfter1.some((e) => e.taskId === taskB.id);
  const aStillWaitingAfter1 = waitEntriesAfter1.some((e) => e.taskId === taskA.id && e.filePath === fileY);

  console.log(`${LOG_PREFIX} Victim (B, low priority) waitForMap cleared: ${bClearedFrom1}`);
  console.log(`${LOG_PREFIX} Survivor (A, high priority) STILL has stale waitForMap entry for ${fileY}: ${aStillWaitingAfter1}`);

  // Step 5: Introduce an unrelated 3rd task C that reuses the now-free fileY, then
  // gets blocked on fileX (still held by A, the correct "winner" of cycle 1).
  const taskC = await createTask({ title: `Deadlock Survivor C ${suffix}`, context: 'repro t-152', priority: 'medium' });
  acquireLeases({ taskId: taskC.id, exclusiveFiles: [fileY], sharedFiles: [] });
  const attemptC = acquireLeases({ taskId: taskC.id, exclusiveFiles: [fileX], sharedFiles: [] });
  if (!attemptC.granted) recordWait(taskC.id, fileX);

  dumpLeaseState('before detectDeadlock() #2 (unrelated task C introduced)');

  // Step 6: Task A never re-registered a wait after step 2. If detectDeadlock() had
  // correctly cleared A's waitForMap entry when cycle 1 was resolved, no second cycle
  // involving A could form here. If A's stale entry survived, it collides with C's
  // fresh entry (C waits on X, held by A) to form a brand-new phantom cycle A -> C -> A.
  const cycle2 = await detectDeadlock();
  console.log(`${LOG_PREFIX} cycle2 detected:`, JSON.stringify(cycle2));

  dumpLeaseState('after detectDeadlock() #2');

  const survivorBugReproduced = Boolean(cycle2) && (cycle2 as string[][]).some((c) => c.includes(taskA.id));

  // Cleanup: release everything and remove the test tasks left behind.
  releaseLeases(taskA.id);
  releaseLeases(taskB.id);
  releaseLeases(taskC.id);
  clearWait(taskA.id);
  clearWait(taskB.id);
  clearWait(taskC.id);
  await deleteTask(taskA.id, false);
  await deleteTask(taskB.id, false);
  await deleteTask(taskC.id, false);

  console.log('='.repeat(70));
  console.log('RESULT');
  console.log('='.repeat(70));
  if (aStillWaitingAfter1 && survivorBugReproduced) {
    console.log('PASS (bug reproduced): survivor task A retained a stale waitForMap entry ' +
      'after detectDeadlock() resolved cycle 1, and that stale entry combined with an ' +
      'unrelated task C to form a phantom deadlock cycle: ' + JSON.stringify(cycle2));
    return 0;
  }
  console.log('FAIL (bug not reproduced): survivor task A\'s waitForMap entry was cleared, ' +
    'or no phantom cycle formed.');
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`${LOG_PREFIX} repro errored:`, err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
