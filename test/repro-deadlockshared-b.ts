/**
 * DeadlockShared B repro harness (t-157).
 *
 * "B" half of a paired repro against `leaseManager.ts`'s deadlock detection,
 * companion to task `DeadlockShared A` (t-156). Reproduces a lease-stop
 * scenario in which two tasks each hold an exclusive lease and a shared
 * lease, then contend for each other's exclusive file, forming a genuine
 * A<->B wait-for cycle. Verifies `detectDeadlock()` resolves the cycle by
 * force-releasing the lower-priority victim's leases, and checks whether
 * `waitForMap` entries are cleared via `clearWait` for ALL cycle
 * participants (not just the victim).
 *
 * Coordination contract with `DeadlockShared A`:
 *   At the time this script was written, the companion task t-156
 *   "DeadlockShared A" had not yet produced a concrete script or shared file
 *   names (its README/PLAN were still template placeholders — see
 *   example/.formic/tasks/t-156_deadlockshared-a/README.md). To keep this
 *   repro runnable standalone (a hard requirement — see PLAN.md Phase 2/3),
 *   this script creates BOTH cycle participants itself: `taskA` plays the
 *   role that `DeadlockShared A` is expected to play, and `taskB` is this
 *   task's own role. If/when t-156 lands its own script, it should reuse the
 *   same deterministic shared file names declared below
 *   (SHARED_FILE_EXCLUSIVE_A, SHARED_FILE_EXCLUSIVE_B, SHARED_FILE_COMMON)
 *   so a genuine cross-task/cross-process cycle can be exercised too.
 *
 * This script drives the real, unmodified `leaseManager.ts` functions
 * directly (`acquireLeases`, `recordWait`, `clearWait`, `releaseLeases`,
 * `detectDeadlock`, `getAllLeases`, `getWaitForEntries`) — no reimplementation
 * of lease logic, no mocked lease store.
 *
 * Run:
 *   npx tsx test/repro-deadlockshared-b.ts
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

const LOG_PREFIX = '[DeadlockSharedB]';

// Deterministic shared file names (no random suffix) so a real companion
// `DeadlockShared A` script can target the same files and form a genuine
// cross-task cycle, per the coordination contract documented above.
const SHARED_FILE_EXCLUSIVE_A = 'src/deadlockshared-x.ts';
const SHARED_FILE_EXCLUSIVE_B = 'src/deadlockshared-y.ts';
const SHARED_FILE_COMMON = 'src/deadlockshared-common.ts';

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
  console.log('='.repeat(70));
  console.log('DEADLOCKSHARED B REPRO — leaseManager.ts detectDeadlock() (t-157)');
  console.log('='.repeat(70));

  // Task A: the companion role (higher priority, expected "survivor").
  // Task B: this task's own role (lower priority, expected "victim").
  const taskA = await createTask({ title: 'DeadlockShared A (companion role)', context: 'repro t-157', priority: 'high' });
  const taskB = await createTask({ title: 'DeadlockShared B', context: 'repro t-157', priority: 'low' });

  try {
    // Step 1: Task A acquires exclusive lease on X, plus a shared lease on the common file.
    const grantA = acquireLeases({
      taskId: taskA.id,
      exclusiveFiles: [SHARED_FILE_EXCLUSIVE_A],
      sharedFiles: [SHARED_FILE_COMMON],
    });
    // Step 2: Task B acquires exclusive lease on Y, plus a shared lease on the same common file.
    // Shared leases don't conflict with each other, so this must succeed even though A
    // already holds a shared lease on SHARED_FILE_COMMON.
    const grantB = acquireLeases({
      taskId: taskB.id,
      exclusiveFiles: [SHARED_FILE_EXCLUSIVE_B],
      sharedFiles: [SHARED_FILE_COMMON],
    });

    console.log(`${LOG_PREFIX} taskA granted:`, grantA.granted, ' taskB granted:', grantB.granted);
    if (!grantA.granted || !grantB.granted) {
      throw new Error('Initial exclusive+shared lease acquisition failed — cannot build repro cycle');
    }

    dumpLeaseState('after initial acquisition (A holds X excl + common shared; B holds Y excl + common shared)');

    // Step 3: Task B attempts to acquire A's exclusive file X -> denied -> recordWait(B, X).
    const attemptB = acquireLeases({ taskId: taskB.id, exclusiveFiles: [SHARED_FILE_EXCLUSIVE_A], sharedFiles: [] });
    if (!attemptB.granted) {
      recordWait(taskB.id, SHARED_FILE_EXCLUSIVE_A);
      console.log(`${LOG_PREFIX} taskB denied ${SHARED_FILE_EXCLUSIVE_A} (held by taskA) — recordWait(taskB, ${SHARED_FILE_EXCLUSIVE_A})`);
    }

    // Step 4: Task A attempts to acquire B's exclusive file Y -> denied -> recordWait(A, Y).
    // This closes the A<->B circular wait: A waits on B's file, B waits on A's file.
    const attemptA = acquireLeases({ taskId: taskA.id, exclusiveFiles: [SHARED_FILE_EXCLUSIVE_B], sharedFiles: [] });
    if (!attemptA.granted) {
      recordWait(taskA.id, SHARED_FILE_EXCLUSIVE_B);
      console.log(`${LOG_PREFIX} taskA denied ${SHARED_FILE_EXCLUSIVE_B} (held by taskB) — recordWait(taskA, ${SHARED_FILE_EXCLUSIVE_B}) [closes the cycle]`);
    }

    if (attemptA.granted || attemptB.granted) {
      throw new Error('Expected both cross-file exclusive acquisition attempts to be denied to form the A<->B cycle');
    }

    dumpLeaseState('before detectDeadlock() — A<->B cycle formed (both also hold shared lease on common file)');

    // Step 5: Trigger the real detectDeadlock() code path (same one the watchdog calls).
    const cycles = await detectDeadlock();
    console.log(`${LOG_PREFIX} cycles detected:`, JSON.stringify(cycles));

    dumpLeaseState('after detectDeadlock() — cycle should be resolved');

    const waitEntriesAfter = getWaitForEntries();
    const cycleDetected = Boolean(cycles) && (cycles as string[][]).some((c) => c.includes(taskA.id) && c.includes(taskB.id));

    // Per detectDeadlock()'s priority-based victim selection, taskB (priority
    // 'low') should be the victim and taskA (priority 'high') the survivor.
    const victimClearedFromWaitMap = !waitEntriesAfter.some((e) => e.taskId === taskB.id);
    const victimLeasesReleased = getAllLeases().every((l) => l.taskId !== taskB.id);
    const survivorStillHasStaleWait = waitEntriesAfter.some((e) => e.taskId === taskA.id && e.filePath === SHARED_FILE_EXCLUSIVE_B);
    const survivorSharedLeaseIntact = getAllLeases().some((l) => l.taskId === taskA.id && l.filePath === SHARED_FILE_COMMON && l.leaseType === 'shared');

    console.log(`${LOG_PREFIX} Cycle (A<->B) detected: ${cycleDetected}`);
    console.log(`${LOG_PREFIX} Victim (taskB, low priority) leases released: ${victimLeasesReleased}`);
    console.log(`${LOG_PREFIX} Victim (taskB) cleared from waitForMap: ${victimClearedFromWaitMap}`);
    console.log(`${LOG_PREFIX} Survivor (taskA, high priority) STILL has stale waitForMap entry for ${SHARED_FILE_EXCLUSIVE_B}: ${survivorStillHasStaleWait}`);
    console.log(`${LOG_PREFIX} Survivor (taskA) shared lease on common file left intact: ${survivorSharedLeaseIntact}`);

    console.log('='.repeat(70));
    console.log('RESULT');
    console.log('='.repeat(70));

    const reproduced = cycleDetected && victimLeasesReleased && victimClearedFromWaitMap;
    if (reproduced) {
      console.log(
        'PASS (repro reproduced): a genuine A<->B exclusive-lease wait-for cycle was formed ' +
        '(with both tasks also holding a shared lease on a common file), detectDeadlock() ' +
        'identified it, and force-released the lower-priority victim (taskB) via releaseLeases ' +
        '+ clearWait. Survivor (taskA) stale waitForMap entry still present: ' +
        `${survivorStillHasStaleWait} — this matches the known survivor-cleanup gap (see t-152 ` +
        'repro-deadlock-survivor.ts): only the victim\'s waitForMap entry is cleared by ' +
        'detectDeadlock(), not every cycle participant\'s.'
      );
    } else {
      console.log(
        'FAIL (repro not reproduced): the A<->B cycle was not detected/resolved as expected ' +
        '(cycleDetected=' + cycleDetected + ', victimLeasesReleased=' + victimLeasesReleased +
        ', victimClearedFromWaitMap=' + victimClearedFromWaitMap + ').'
      );
    }

    return reproduced ? 0 : 1;
  } finally {
    // Cleanup: release everything and remove the tasks created for this repro,
    // regardless of outcome, so repeated runs leave no stale leases or tasks.
    releaseLeases(taskA.id);
    releaseLeases(taskB.id);
    clearWait(taskA.id);
    clearWait(taskB.id);
    await deleteTask(taskA.id, false);
    await deleteTask(taskB.id, false);
    console.log(`${LOG_PREFIX} cleanup complete: released leases/waits and deleted taskA (${taskA.id}), taskB (${taskB.id})`);
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`${LOG_PREFIX} repro errored:`, err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
