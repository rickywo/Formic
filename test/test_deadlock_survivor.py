#!/usr/bin/env python3
"""
Deadlock Survivor Repro for Formic.

Reproduces a suspected bug in `leaseManager.ts`'s `detectDeadlock()`: when a
wait-for cycle is resolved, only the *victim* task (lowest priority in the
cycle) has its lease released and its `waitForMap` entry cleared via
`clearWait()`. The other ("winning") task in the cycle is left with a stale
entry in `waitForMap` — nothing ever calls `clearWait()` for it and nothing
automatically retries its blocked acquisition. That stale entry can then
combine with a completely unrelated, later wait-for registration to form a
brand-new "phantom" deadlock cycle that the surviving task never actually
took part in creating.

This script does NOT modify `leaseManager.ts`, `queueProcessor.ts`, or the
watchdog. `detectDeadlock()`/`recordWait()`/`clearWait()` are internal
functions with no HTTP route (only `acquireLeases`/`releaseLeases`/
`renewLeases` are exposed via `/api/tasks/:id/lease/*`), so per the task's
own allowance ("otherwise a standalone script under test/ with equivalent
clarity is acceptable") this repro drives the real, unmodified
`leaseManager.ts` and `store.ts` implementations directly in-process via a
short TypeScript driver executed with `tsx`, rather than importing internals
into Python or re-implementing the logic. Task creation, priority lookup,
and status transitions still go through the real `store.ts` functions used
by the production server.

Usage:
    python test/test_deadlock_survivor.py

    Optional:
        WORKSPACE_PATH=./example   # workspace whose .formic/board.json is used (default)
        REPEAT=3                   # number of consecutive runs to verify determinism
"""

import json
import os
import subprocess
import sys
import tempfile
import textwrap

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORKSPACE_PATH = os.environ.get('WORKSPACE_PATH', './example')

# TypeScript driver: imports the *unmodified* leaseManager.ts / store.ts directly
# (via tsx, which resolves the NodeNext `.js` specifiers back to `.ts` sources)
# and drives a deterministic two-then-three-task scenario.
DRIVER_TS = textwrap.dedent(r"""
    import path from 'node:path';
    import { pathToFileURL } from 'node:url';

    const ROOT = process.env.FORMIC_ROOT;
    const storeUrl = pathToFileURL(path.join(ROOT, 'src/server/services/store.ts')).href;
    const leaseUrl = pathToFileURL(path.join(ROOT, 'src/server/services/leaseManager.ts')).href;

    const store = await import(storeUrl);
    const lease = await import(leaseUrl);

    const { createTask, getTask, deleteTask } = store;
    const { acquireLeases, recordWait, clearWait, releaseLeases, detectDeadlock, getAllLeases } = lease;

    const suffix = process.env.REPRO_SUFFIX;
    const fileX = `src/deadlock-x-${suffix}.ts`;
    const fileY = `src/deadlock-y-${suffix}.ts`;

    function leaseSnapshot() {
      return getAllLeases().map(l => ({ filePath: l.filePath, taskId: l.taskId, leaseType: l.leaseType }));
    }

    async function statusOf(taskId) {
      const t = await getTask(taskId);
      return t ? t.status : null;
    }

    const taskA = await createTask({ title: `Deadlock Survivor A ${suffix}`, context: 'repro t-150', priority: 'high' });
    const taskB = await createTask({ title: `Deadlock Survivor B ${suffix}`, context: 'repro t-150', priority: 'low' });

    // Step 1: A (high) holds X. B (low) holds Y.
    const grantA = acquireLeases({ taskId: taskA.id, exclusiveFiles: [fileX], sharedFiles: [] });
    const grantB = acquireLeases({ taskId: taskB.id, exclusiveFiles: [fileY], sharedFiles: [] });

    // Step 2: A wants Y (held by B) -> denied -> recordWait(A, Y).
    const attemptA = acquireLeases({ taskId: taskA.id, exclusiveFiles: [fileY], sharedFiles: [] });
    if (!attemptA.granted) recordWait(taskA.id, fileY);

    // Step 3: B wants X (held by A) -> denied -> recordWait(B, X). Cycle A<->B now exists.
    const attemptB = acquireLeases({ taskId: taskB.id, exclusiveFiles: [fileX], sharedFiles: [] });
    if (!attemptB.granted) recordWait(taskB.id, fileX);

    const before1 = {
      leases: leaseSnapshot(),
      taskAStatus: await statusOf(taskA.id),
      taskBStatus: await statusOf(taskB.id),
    };

    // Step 4: Trigger the real detectDeadlock() code path (same one the watchdog calls).
    const cycle1 = await detectDeadlock();
    await new Promise(r => setTimeout(r, 100));

    const after1 = {
      leases: leaseSnapshot(),
      taskAStatus: await statusOf(taskA.id),
      taskBStatus: await statusOf(taskB.id),
    };

    // Step 5: Introduce an unrelated 3rd task C that simply reuses the now-free file Y,
    // then gets blocked on X (still held by A, the expected/correct "winner" of cycle 1).
    const taskC = await createTask({ title: `Deadlock Survivor C ${suffix}`, context: 'repro t-150', priority: 'medium' });
    const grantC = acquireLeases({ taskId: taskC.id, exclusiveFiles: [fileY], sharedFiles: [] });
    const attemptC = acquireLeases({ taskId: taskC.id, exclusiveFiles: [fileX], sharedFiles: [] });
    if (!attemptC.granted) recordWait(taskC.id, fileX);

    // Step 6: Task A NEVER re-registers a wait after step 2. If detectDeadlock() correctly
    // cleared A's waitForMap entry when cycle 1 was resolved, no second cycle involving A
    // can possibly form here (A already holds X and never asked for anything since).
    // If A's stale entry (A waits on Y) survived, it now collides with C's fresh entry
    // (C waits on X, held by A) to form a brand-new phantom cycle: A -> C -> A.
    const cycle2 = await detectDeadlock();
    await new Promise(r => setTimeout(r, 100));

    const after2 = {
      leases: leaseSnapshot(),
      taskAStatus: await statusOf(taskA.id),
      taskBStatus: await statusOf(taskB.id),
      taskCStatus: await statusOf(taskC.id),
    };

    // Cleanup: release everything and remove test tasks so the workspace is left clean.
    releaseLeases(taskA.id);
    releaseLeases(taskB.id);
    releaseLeases(taskC.id);
    clearWait(taskA.id);
    clearWait(taskB.id);
    clearWait(taskC.id);
    await deleteTask(taskA.id, false);
    await deleteTask(taskB.id, false);
    await deleteTask(taskC.id, false);

    console.log(JSON.stringify({
      taskAId: taskA.id,
      taskBId: taskB.id,
      taskCId: taskC.id,
      fileX,
      fileY,
      grantA, grantB, attemptA, attemptB, grantC, attemptC,
      before1, cycle1, after1,
      cycle2, after2,
    }));
""")


def run_repro(suffix):
    """Runs the TS driver once via tsx and returns the parsed JSON result."""
    with tempfile.NamedTemporaryFile(mode='w', suffix='.mts', delete=False) as f:
        f.write(DRIVER_TS)
        driver_path = f.name

    try:
        env = os.environ.copy()
        env['FORMIC_ROOT'] = REPO_ROOT
        env['WORKSPACE_PATH'] = WORKSPACE_PATH
        env['REPRO_SUFFIX'] = suffix

        result = subprocess.run(
            ['npx', 'tsx', driver_path],
            cwd=REPO_ROOT,
            env=env,
            capture_output=True,
            text=True,
            timeout=60,
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"tsx driver failed (exit {result.returncode})\n"
                f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
            )

        # The driver prints a single JSON line as its last line of stdout.
        last_line = result.stdout.strip().splitlines()[-1]
        return json.loads(last_line)
    finally:
        os.unlink(driver_path)


def analyze(data, run_num):
    """Prints before/after state and asserts the survivor condition. Returns True if the
    expected survivor behavior (the bug) was reproduced, False otherwise."""
    task_a, task_b, task_c = data['taskAId'], data['taskBId'], data['taskCId']
    file_x, file_y = data['fileX'], data['fileY']
    cycle1, cycle2 = data['cycle1'], data['cycle2']
    before1, after1, after2 = data['before1'], data['after1'], data['after2']

    print(f"\n--- Run {run_num}: before cycle-1 resolution ---")
    print(f"  Task A (high, holds {file_x}): {task_a}, status={before1['taskAStatus']}")
    print(f"  Task B (low,  holds {file_y}): {task_b}, status={before1['taskBStatus']}")
    print(f"  Leases: {before1['leases']}")

    print(f"--- Run {run_num}: cycle formed & resolved (detectDeadlock #1) ---")
    print(f"  Cycle detected: {cycle1}")
    ok = True

    if not cycle1 or not any(set(c) == {task_a, task_b} for c in cycle1):
        print(f"  ✗ Expected a 2-task cycle [{task_a}, {task_b}], got {cycle1}")
        ok = False
    else:
        print(f"  ✓ Wait-for cycle formed as expected: {task_a} (high) <-> {task_b} (low)")

    print(f"--- Run {run_num}: after cycle-1 resolution ---")
    print(f"  Task A status: {after1['taskAStatus']} (expected: unchanged, still holds {file_x})")
    print(f"  Task B status: {after1['taskBStatus']} (expected: 'queued' — victim requeued)")
    print(f"  Leases: {after1['leases']}")

    if after1['taskBStatus'] != 'queued':
        print(f"  ✗ Expected victim {task_b} (low priority) to be requeued to 'queued', got {after1['taskBStatus']}")
        ok = False
    else:
        print(f"  ✓ Victim {task_b} correctly released and requeued (status=queued)")

    b_still_holds_y = any(l['taskId'] == task_b for l in after1['leases'])
    if b_still_holds_y:
        print(f"  ✗ Victim {task_b} still holds a lease after resolution: {after1['leases']}")
        ok = False
    else:
        print(f"  ✓ Victim {task_b}'s lease was released")

    print(f"--- Run {run_num}: unrelated task C introduced, reuses freed file {file_y} ---")
    print(f"  Task C (medium): {task_c}")
    print(f"  detectDeadlock() #2 result: {cycle2}")

    survivor_detected = bool(cycle2) and any(task_a in c for c in cycle2)
    if survivor_detected:
        print(f"  ⚠ SURVIVOR DETECTED: task {task_a} still holds lease on {file_x}, "
              f"status={after2['taskAStatus']!r}, and its stale waitForMap entry from "
              f"cycle 1 (never cleared by detectDeadlock's resolution of task {task_b}) "
              f"combined with unrelated task {task_c}'s fresh wait to form a phantom "
              f"deadlock cycle: {cycle2}")
        print(f"  This confirms the bug: detectDeadlock() only calls clearWait() on the "
              f"victim ({task_b}); the surviving task ({task_a}) keeps a stale waitForMap "
              f"entry indefinitely, with nothing to clear or retry it, until it coincidentally "
              f"collides with a future unrelated task.")
    else:
        print(f"  ✓ No phantom cycle involving {task_a} — waitForMap was correctly cleared "
              f"for the surviving task. (Bug not reproduced this run.)")

    return ok, survivor_detected


def main():
    repeat = int(os.environ.get('REPEAT', '3'))
    print("=" * 70)
    print("DEADLOCK SURVIVOR REPRO — leaseManager.ts detectDeadlock()")
    print("=" * 70)

    all_ok = True
    survivor_runs = 0

    for i in range(1, repeat + 1):
        import uuid
        suffix = uuid.uuid4().hex[:8]
        try:
            data = run_repro(suffix)
        except Exception as e:
            print(f"\n✗ Run {i} errored: {e}")
            all_ok = False
            continue

        ok, survivor = analyze(data, i)
        all_ok = all_ok and ok
        if survivor:
            survivor_runs += 1

    print("\n" + "=" * 70)
    print("SUMMARY")
    print("=" * 70)
    print(f"  Runs executed: {repeat}")
    print(f"  Runs where cycle 1 formed & resolved as expected: {'yes' if all_ok else 'no'}")
    print(f"  Runs where the survivor (phantom cycle) bug reproduced: {survivor_runs}/{repeat}")

    if survivor_runs == repeat:
        print("  ⚠ Survivor bug reproduced CONSISTENTLY across all runs.")
    elif survivor_runs > 0:
        print("  ⚠ Survivor bug reproduced INTERMITTENTLY — investigate nondeterminism.")
    else:
        print("  ✓ Survivor bug did NOT reproduce in this run of leaseManager.ts.")
    print("=" * 70)

    # This script's purpose is to reproduce and document the bug, not to enforce a fix.
    # Exit 0 as long as the setup (cycle formation + expected victim resolution) behaved
    # as designed; the survivor count above is the documented finding for the fix task.
    return 0 if all_ok else 1


if __name__ == '__main__':
    sys.exit(main())
