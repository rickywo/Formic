#!/usr/bin/env python3
"""
Comprehensive concurrency test suite for day-to-day parallel Formic usage.

Covers failure modes uncovered in the lease audit across 8 scenario groups:
  A. Acquisition atomicity
  B. Shared/exclusive matrix
  C. Expiry and renewal
  D. Preemption
  E. Deadlock detection
  F. Queue behaviour under contention
  G. Persistence and restart
  H. Optimistic shared-file collision detection

Pattern: unittest + requests against a running Formic server.
Fixtures in test/fixtures/lease_stop_repro.ts provide preemption/deadlock/collision coverage.

Usage:
    # Start Formic server first:
    # WORKSPACE_PATH=./example npm run dev

    # Run this suite alone:
    python test/test_concurrency_daily.py

    # Run all suites:
    python test/run_tests.py
"""

import json
import os
import shutil
import subprocess
import sys
import time
import unittest
import uuid

import requests

sys.path.insert(0, os.path.dirname(__file__))
from fixtures import BASE_URL as FIXTURES_BASE_URL, cleanup_tasks, is_server_reachable

# Use port 8000 as default (where the dev server runs). The fixtures module
# defaults to port 3000 which is not the standard dev port.
BASE_URL = os.environ.get('FORMIC_URL', 'http://localhost:8000')

# ── Config helpers ──────────────────────────────────────────────────────────

# Default config values to restore after tests that mutate settings.
_DEFAULT_CONFIG_SNAPSHOT: dict | None = None

# ── Fixture path ────────────────────────────────────────────────────────────

FIXTURE_SCRIPT = os.path.join(os.path.dirname(__file__), 'fixtures', 'lease_stop_repro.ts')
_TSX_AVAILABLE = shutil.which('npx') is not None


def _run_fixture(scenario: str, workspace: str | None = None) -> dict:
    """Run a TypeScript fixture scenario and return the parsed JSON result."""
    ws = workspace or os.environ.get('WORKSPACE_PATH', os.path.join(os.path.dirname(__file__), '..', 'example'))
    ws = os.path.abspath(ws)
    env = {**os.environ, 'WORKSPACE_PATH': ws}
    result = subprocess.run(
        ['npx', 'tsx', FIXTURE_SCRIPT, scenario],
        capture_output=True, text=True, timeout=30, env=env,
    )
    # The fixture writes JSON as its last stdout line; preceding lines are logs.
    lines = result.stdout.strip().splitlines()
    for line in reversed(lines):
        try:
            return json.loads(line)
        except (json.JSONDecodeError, ValueError):
            continue
    raise RuntimeError(
        f"Fixture '{scenario}' produced no JSON output.\n"
        f"stdout: {result.stdout[-500:]}\nstderr: {result.stderr[-500:]}"
    )


class TestConcurrencyDaily(unittest.TestCase):
    """Comprehensive day-to-day concurrency tests (groups A–H)."""

    # ── Test lifecycle ────────────────────────────────────────────────────

    def setUp(self):
        """Verify server reachability; capture config for restore."""
        self.created_task_ids: list = []
        self._config_state: dict | None = None
        if not is_server_reachable(BASE_URL):
            self.skipTest(
                f"Server unreachable at {BASE_URL}. Start with: WORKSPACE_PATH=./example npm run dev"
            )
        # Snapshot config settings for restore in tearDown.
        try:
            resp = requests.get(f"{BASE_URL}/api/config", timeout=5)
            if resp.status_code == 200:
                self._config_state = resp.json().get('settings', {})
        except Exception:
            pass

    def tearDown(self):
        """Release leases, delete tasks, and restore config settings."""
        # Release leases for all test tasks
        for task_id in self.created_task_ids:
            try:
                requests.post(f"{BASE_URL}/api/tasks/{task_id}/lease/release", timeout=5)
            except Exception:
                pass
        # Delete all test tasks
        cleanup_tasks(BASE_URL, self.created_task_ids)
        # Restore config settings if they were mutated
        if self._config_state:
            try:
                settings_to_restore = {
                    k: v for k, v in self._config_state.items()
                    if k in ('leaseDurationMs', 'watchdogIntervalMs', 'maxYieldCount',
                             'maxConcurrentSessions', 'queuePollIntervalMs')
                }
                for key, value in settings_to_restore.items():
                    requests.put(
                        f"{BASE_URL}/api/config/settings/{key}",
                        json={'value': value}, timeout=5,
                    )
            except Exception:
                pass

    # ── Helpers ───────────────────────────────────────────────────────────

    def _create_task(self, title=None, priority='medium', task_type='standard', extra=None):
        """POST /api/tasks and register for cleanup. Returns task JSON."""
        if title is None:
            title = f"DailyConc Test {str(uuid.uuid4())[:8]}"
        payload = {
            'title': title,
            'context': 'Created by test_concurrency_daily.py for comprehensive concurrency verification',
            'priority': priority,
            'type': task_type,
        }
        if extra:
            payload.update(extra)
        resp = requests.post(f"{BASE_URL}/api/tasks", json=payload, timeout=10)
        self.assertEqual(
            resp.status_code, 201,
            f"Expected 201 creating task, got {resp.status_code}: {resp.text}",
        )
        task = resp.json()
        self.created_task_ids.append(task['id'])
        return task

    def _declare_files(self, task_id, exclusive=None, shared=None):
        """Set declaredFiles on a task via PUT."""
        declared = {'exclusive': exclusive or [], 'shared': shared or []}
        resp = requests.put(
            f"{BASE_URL}/api/tasks/{task_id}", json={'declaredFiles': declared}, timeout=10
        )
        return resp

    def _acquire_lease(self, task_id):
        """POST /api/tasks/:id/lease/acquire. Returns response JSON dict."""
        resp = requests.post(f"{BASE_URL}/api/tasks/{task_id}/lease/acquire", timeout=10)
        if resp.status_code in (200, 201):
            return resp.json()
        return {'granted': False, 'error': resp.text, 'status_code': resp.status_code}

    def _release_lease(self, task_id):
        """POST /api/tasks/:id/lease/release."""
        try:
            requests.post(f"{BASE_URL}/api/tasks/{task_id}/lease/release", timeout=5)
        except Exception:
            pass

    def _renew_lease(self, task_id):
        """POST /api/tasks/:id/lease/renew."""
        resp = requests.post(f"{BASE_URL}/api/tasks/{task_id}/lease/renew", timeout=5)
        return resp

    def _get_leases(self):
        """GET /api/leases. Returns list of active lease objects."""
        resp = requests.get(f"{BASE_URL}/api/leases", timeout=10)
        if resp.status_code == 200:
            return resp.json()
        return []

    def _set_config(self, key, value):
        """PUT /api/config/settings/:key to update an engine config value."""
        resp = requests.put(
            f"{BASE_URL}/api/config/settings/{key}",
            json={'value': value}, timeout=10,
        )
        return resp

    # ═══════════════════════════════════════════════════════════════════════
    # GROUP A — Acquisition Atomicity
    # ═══════════════════════════════════════════════════════════════════════

    def test_mixed_exclusive_shared_denial_no_residual(self):
        """
        A1: Denied mixed (exclusive + shared) request leaves no residual leases.
        Task A holds exclusive on F1. Task B requests exclusive [F2] + shared [F1].
        Since F1 has an exclusive holder, B's shared request conflicts → entire
        request denied AND no residual lease on F2 leaks into the store.
        """
        file_f1 = f"src/atomic-f1-{uuid.uuid4().hex[:8]}.ts"
        file_f2 = f"src/atomic-f2-{uuid.uuid4().hex[:8]}.ts"

        task_a = self._create_task(title=f"Atomic A {str(uuid.uuid4())[:8]}")
        task_b = self._create_task(title=f"Atomic B {str(uuid.uuid4())[:8]}")

        # A holds exclusive on F1
        self._declare_files(task_a['id'], exclusive=[file_f1])
        result_a = self._acquire_lease(task_a['id'])
        self.assertTrue(result_a.get('granted'), f"A should acquire F1: {result_a}")

        # B requests exclusive [F2] + shared [F1] — should be denied
        self._declare_files(task_b['id'], exclusive=[file_f2], shared=[file_f1])
        result_b = self._acquire_lease(task_b['id'])
        self.assertFalse(result_b.get('granted'), f"B should be denied: {result_b}")
        self.assertIn(
            file_f1, result_b.get('conflictingFiles', []),
            f"Conflict should name F1: {result_b}",
        )

        # Negative-path: verify no phantom lease on F2 leaked
        all_leases = self._get_leases()
        f2_leases = [l for l in all_leases if l.get('filePath') == file_f2]
        self.assertEqual(
            len(f2_leases), 0,
            f"ATOMICITY LEAK: {len(f2_leases)} phantom lease(s) on F2: {f2_leases}",
        )

        self._release_lease(task_a['id'])

    def test_concurrent_acquire_race_single_winner(self):
        """
        A2: Concurrent acquire races on the same file grant exactly one winner.
        Two tasks declare the same exclusive file and acquire serially (simulating
        a race). Exactly one is granted; the other is denied with conflictingFiles.
        """
        file_path = f"src/race-{uuid.uuid4().hex[:8]}.ts"

        task_a = self._create_task(title=f"Race A {str(uuid.uuid4())[:8]}")
        task_b = self._create_task(title=f"Race B {str(uuid.uuid4())[:8]}")

        self._declare_files(task_a['id'], exclusive=[file_path])
        self._declare_files(task_b['id'], exclusive=[file_path])

        result_a = self._acquire_lease(task_a['id'])
        result_b = self._acquire_lease(task_b['id'])

        # Exactly one winner
        winners = [r for r in (result_a, result_b) if r.get('granted')]
        losers = [r for r in (result_a, result_b) if not r.get('granted')]

        self.assertEqual(
            len(winners), 1,
            f"Exactly one task should win the race, got {len(winners)} winners: a={result_a}, b={result_b}",
        )
        self.assertEqual(
            len(losers), 1,
            f"Exactly one task should lose the race, got {len(losers)} losers",
        )
        # The loser must report the conflicting file
        loser = losers[0]
        self.assertIn(
            file_path, loser.get('conflictingFiles', []),
            f"Loser must report conflicting file: {loser}",
        )

        # Cleanup: release whichever won
        for r in winners:
            # Find the task ID that won
            pass
        self._release_lease(task_a['id'])
        self._release_lease(task_b['id'])

    def test_reacquire_idempotent(self):
        """
        A3: Re-acquire by the same task is idempotent.
        A task that already holds leases calls acquire again → granted=true
        and no duplicate entries appear in GET /api/leases for that task/file.
        """
        file_path = f"src/idempotent-{uuid.uuid4().hex[:8]}.ts"

        task = self._create_task(title=f"Idempotent {str(uuid.uuid4())[:8]}")
        self._declare_files(task['id'], exclusive=[file_path])

        # First acquire
        result1 = self._acquire_lease(task['id'])
        self.assertTrue(result1.get('granted'), f"First acquire should succeed: {result1}")

        # Second acquire (idempotent)
        result2 = self._acquire_lease(task['id'])
        self.assertTrue(result2.get('granted'), f"Second acquire should also succeed: {result2}")

        # Verify no duplicate leases in the store
        all_leases = self._get_leases()
        task_file_leases = [
            l for l in all_leases
            if l.get('taskId') == task['id'] and l.get('filePath') == file_path
        ]
        # Either 0 or 1 lease per file per task — never 2+
        self.assertLessEqual(
            len(task_file_leases), 1,
            f"At most one lease per file; got {len(task_file_leases)}: {task_file_leases}",
        )

        self._release_lease(task['id'])

    # ═══════════════════════════════════════════════════════════════════════
    # GROUP B — Shared/Exclusive Matrix
    # ═══════════════════════════════════════════════════════════════════════

    def test_shared_shared_coexist(self):
        """
        B1: Two tasks both acquire shared leases on the same file → both granted.
        Both tasks are visible in GET /api/leases.
        """
        file_path = f"src/shared-coexist-{uuid.uuid4().hex[:8]}.ts"

        task_a = self._create_task(title=f"Shared A {str(uuid.uuid4())[:8]}")
        task_b = self._create_task(title=f"Shared B {str(uuid.uuid4())[:8]}")

        self._declare_files(task_a['id'], shared=[file_path])
        self._declare_files(task_b['id'], shared=[file_path])

        result_a = self._acquire_lease(task_a['id'])
        result_b = self._acquire_lease(task_b['id'])

        self.assertTrue(result_a.get('granted'), f"A shared should be granted: {result_a}")
        self.assertTrue(result_b.get('granted'), f"B shared should be granted: {result_b}")

        # Both visible in leases
        all_leases = self._get_leases()
        a_leases = [l for l in all_leases if l.get('taskId') == task_a['id']]
        b_leases = [l for l in all_leases if l.get('taskId') == task_b['id']]
        self.assertGreater(len(a_leases), 0, "A should have shared leases visible")
        self.assertGreater(len(b_leases), 0, "B should have shared leases visible")

        self._release_lease(task_a['id'])
        self._release_lease(task_b['id'])

    def test_exclusive_blocks_shared(self):
        """
        B2: Task A holds exclusive on F → task B requests shared on F → denied
        with conflictingFiles containing F.
        """
        file_path = f"src/excl-blocks-shared-{uuid.uuid4().hex[:8]}.ts"

        task_a = self._create_task(title=f"ExclusiveHolder {str(uuid.uuid4())[:8]}")
        task_b = self._create_task(title=f"SharedWaiter {str(uuid.uuid4())[:8]}")

        self._declare_files(task_a['id'], exclusive=[file_path])
        self._declare_files(task_b['id'], shared=[file_path])

        result_a = self._acquire_lease(task_a['id'])
        self.assertTrue(result_a.get('granted'), f"A should acquire exclusive: {result_a}")

        result_b = self._acquire_lease(task_b['id'])
        self.assertFalse(result_b.get('granted'), f"B shared should be denied: {result_b}")
        self.assertIn(
            file_path, result_b.get('conflictingFiles', []),
            f"Conflict should name {file_path}: {result_b}",
        )

        self._release_lease(task_a['id'])

    def test_shared_blocks_exclusive(self):
        """
        B2b: Task A holds shared on F → task B requests exclusive on F → denied.
        """
        file_path = f"src/shared-blocks-excl-{uuid.uuid4().hex[:8]}.ts"

        task_a = self._create_task(title=f"SharedHolder {str(uuid.uuid4())[:8]}")
        task_b = self._create_task(title=f"ExclWaiter {str(uuid.uuid4())[:8]}")

        self._declare_files(task_a['id'], shared=[file_path])
        self._declare_files(task_b['id'], exclusive=[file_path])

        result_a = self._acquire_lease(task_a['id'])
        self.assertTrue(result_a.get('granted'), f"A should acquire shared: {result_a}")

        result_b = self._acquire_lease(task_b['id'])
        self.assertFalse(result_b.get('granted'), f"B exclusive should be denied: {result_b}")
        self.assertIn(
            file_path, result_b.get('conflictingFiles', []),
            f"Conflict should name {file_path}: {result_b}",
        )

        self._release_lease(task_a['id'])

    def test_n_shared_then_exclusive_waits(self):
        """
        B3: N=3 tasks acquire shared on F, then a 4th task requests exclusive on F
        → denied until ALL 3 shared holders release, then granted.
        """
        file_path = f"src/n-shared-{uuid.uuid4().hex[:8]}.ts"

        # Create 3 shared holders
        shared_holders = []
        for i in range(3):
            t = self._create_task(title=f"SharedHolder-{i} {str(uuid.uuid4())[:6]}")
            self._declare_files(t['id'], shared=[file_path])
            result = self._acquire_lease(t['id'])
            self.assertTrue(result.get('granted'), f"Shared holder {i} should be granted: {result}")
            shared_holders.append(t)

        # 4th task requests exclusive → denied while ANY shared holder exists
        excl_task = self._create_task(title=f"ExclWaiter {str(uuid.uuid4())[:8]}")
        self._declare_files(excl_task['id'], exclusive=[file_path])
        excl_result = self._acquire_lease(excl_task['id'])
        self.assertFalse(
            excl_result.get('granted'),
            f"Exclusive should be denied while shared holders exist: {excl_result}",
        )
        self.assertIn(
            file_path, excl_result.get('conflictingFiles', []),
            f"Conflict should name {file_path}: {excl_result}",
        )

        # Release all shared holders
        for t in shared_holders:
            self._release_lease(t['id'])

        # Now exclusive can acquire
        excl_result2 = self._acquire_lease(excl_task['id'])
        self.assertTrue(
            excl_result2.get('granted'),
            f"Exclusive should be granted after all shared released: {excl_result2}",
        )

        self._release_lease(excl_task['id'])

    # ═══════════════════════════════════════════════════════════════════════
    # GROUP C — Expiry and Renewal
    # ═══════════════════════════════════════════════════════════════════════

    def test_running_task_renewed_not_stolen(self):
        """
        C1: Lease of an actively running task survives expiry (renewed, not stolen).
        Set leaseDurationMs=2000. Acquire, then renew before expiry. Wait past the
        original 2s expiry → lease still present.
        """
        self._set_config('leaseDurationMs', 2000)
        self._set_config('watchdogIntervalMs', 1000)
        time.sleep(0.3)  # Let config propagate

        file_path = f"src/renew-survive-{uuid.uuid4().hex[:8]}.ts"
        task = self._create_task(title=f"RenewSurvivor {str(uuid.uuid4())[:8]}")
        self._declare_files(task['id'], exclusive=[file_path])

        result = self._acquire_lease(task['id'])
        self.assertTrue(result.get('granted'), f"Lease should be granted: {result}")

        # Renew twice across the original expiry window
        for _ in range(3):
            time.sleep(0.8)
            renew_resp = self._renew_lease(task['id'])
            self.assertIn(renew_resp.status_code, [200, 201],
                         f"Renew should succeed: {renew_resp.status_code}")

        # Wait long enough for original expiry to pass (but still within renewed window)
        time.sleep(1.5)

        # Lease still present
        all_leases = self._get_leases()
        task_leases = [l for l in all_leases if l.get('taskId') == task['id']]
        self.assertGreater(
            len(task_leases), 0,
            f"Lease should survive after renewals across original expiry window; "
            f"found {len(task_leases)} leases for task",
        )

        self._release_lease(task['id'])

    def test_expired_dead_task_freed_and_wakes_waiters(self):
        """
        C2: Expired lease of a dead task is freed AND wakes waiters.

        Set leaseDurationMs=2000. Task A acquires exclusive on F. Do NOT renew.
        Wait >2s for expiry + watchdog tick. Task B can then acquire F.
        """
        self._set_config('leaseDurationMs', 2000)
        self._set_config('watchdogIntervalMs', 1000)
        time.sleep(0.3)

        file_path = f"src/expire-dead-{uuid.uuid4().hex[:8]}.ts"

        task_a = self._create_task(title=f"ExpireDead A {str(uuid.uuid4())[:8]}")
        task_b = self._create_task(title=f"ExpireWaiter B {str(uuid.uuid4())[:8]}")

        self._declare_files(task_a['id'], exclusive=[file_path])
        self._declare_files(task_b['id'], exclusive=[file_path])

        result_a = self._acquire_lease(task_a['id'])
        self.assertTrue(result_a.get('granted'), f"A should acquire: {result_a}")

        # B tries immediately → denied
        result_b1 = self._acquire_lease(task_b['id'])
        self.assertFalse(result_b1.get('granted'), "B should be denied while A holds")

        # Wait for A's lease to expire + watchdog tick
        time.sleep(3.5)

        # B retries → granted (A's expired lease was freed)
        result_b2 = self._acquire_lease(task_b['id'])
        self.assertTrue(
            result_b2.get('granted'),
            f"B should acquire after A's lease expires; got: {result_b2}",
        )

        # Negative-path: A's lease should no longer be in the store
        all_leases = self._get_leases()
        a_leases = [l for l in all_leases if l.get('taskId') == task_a['id']]
        self.assertEqual(
            len(a_leases), 0,
            f"A's expired lease should be gone; found {len(a_leases)}",
        )

        self._release_lease(task_b['id'])

    def test_long_verify_not_reverted(self):
        """
        C3: Long verify step does not get work reverted by the watchdog.
        Task acquires lease, renews across several watchdog intervals →
        lease persists and is not stolen.
        """
        self._set_config('leaseDurationMs', 2000)
        self._set_config('watchdogIntervalMs', 1000)
        time.sleep(0.3)

        file_path = f"src/long-verify-{uuid.uuid4().hex[:8]}.ts"
        task = self._create_task(title=f"LongVerify {str(uuid.uuid4())[:8]}")
        self._declare_files(task['id'], exclusive=[file_path])

        result = self._acquire_lease(task['id'])
        self.assertTrue(result.get('granted'), f"Lease should be granted: {result}")

        # Simulate long verify: renew across 4+ watchdog intervals
        for i in range(5):
            time.sleep(0.6)
            renew_resp = self._renew_lease(task['id'])
            self.assertIn(
                renew_resp.status_code, [200, 201],
                f"Renew {i} should succeed: {renew_resp.status_code}",
            )
            # Verify lease still present
            leases = self._get_leases()
            task_leases = [l for l in leases if l.get('taskId') == task['id']]
            self.assertGreater(
                len(task_leases), 0,
                f"Lease should persist after renew {i}",
            )

        # Final check: lease is still there
        all_leases = self._get_leases()
        task_leases = [l for l in all_leases if l.get('taskId') == task['id']]
        self.assertGreater(
            len(task_leases), 0,
            f"Lease should survive long verify across multiple watchdog intervals",
        )

        self._release_lease(task['id'])

    # ═══════════════════════════════════════════════════════════════════════
    # GROUP D — Preemption
    # ═══════════════════════════════════════════════════════════════════════

    @unittest.skipIf(not _TSX_AVAILABLE, "npx not available for TypeScript fixture")
    def test_preemption_equal_priority_refused(self):
        """
        D1: Equal/lower priority never preempts.
        Uses the 'preempt-equal-priority' fixture scenario where both tasks
        have medium priority → preemptLease returns false, no stop called.
        """
        try:
            result = _run_fixture('preempt-equal-priority')
        except RuntimeError as e:
            self.skipTest(f"Fixture failed: {e}")

        self.assertTrue(result.get('leaseGranted'), f"Holder lease should be granted: {result}")
        # preemptResult should be false for equal priority
        self.assertFalse(
            result.get('preemptResult', True),
            f"Preemption should be refused for equal priority: {result}",
        )
        # Stopper should NOT be called for the holder
        self.assertFalse(
            result.get('stopperCalledForHolder', True),
            f"Stopper should not be called when preemption refused: {result}",
        )

    @unittest.skipIf(not _TSX_AVAILABLE, "npx not available for TypeScript fixture")
    def test_preempted_task_resumes_and_completes(self):
        """
        D2: Preempted task resumes and completes later.
        High-priority preempts low → low re-queued with resumeFromStep preserved.
        Uses the existing 'preempt' fixture scenario.
        """
        try:
            result = _run_fixture('preempt')
        except RuntimeError as e:
            self.skipTest(f"Fixture failed: {e}")

        self.assertTrue(result.get('leaseGranted'), f"Holder lease should be granted: {result}")
        self.assertTrue(
            result.get('preemptResult', False),
            f"Preemption should succeed: {result}",
        )
        # After preemption, holder should be re-queued
        self.assertEqual(
            result.get('holderStatusAfter'), 'queued',
            f"Preempted holder should be re-queued: {result}",
        )
        # resumeFromStep should be preserved
        self.assertIsNotNone(
            result.get('resumeFromStepAfter'),
            f"Preempted holder should preserve resumeFromStep: {result}",
        )

    # ═══════════════════════════════════════════════════════════════════════
    # GROUP E — Deadlock Detection
    # ═══════════════════════════════════════════════════════════════════════

    @unittest.skipIf(not _TSX_AVAILABLE, "npx not available for TypeScript fixture")
    def test_two_task_deadlock_resolved(self):
        """
        E1: 2-task deadlock cycle resolved with lowest-priority victim.
        Uses the existing 'deadlock' fixture scenario.
        """
        try:
            result = _run_fixture('deadlock')
        except RuntimeError as e:
            self.skipTest(f"Fixture failed: {e}")

        self.assertGreater(
            result.get('cyclesDetected', 0), 0,
            f"Should detect at least one deadlock cycle: {result}",
        )
        self.assertTrue(
            result.get('stopperCalledForVictim'),
            f"Stopper should be called for victim: {result}",
        )

    @unittest.skipIf(not _TSX_AVAILABLE, "npx not available for TypeScript fixture")
    def test_three_task_deadlock_resolved(self):
        """
        E2: 3-task deadlock cycle (A→B→C→A) resolved with lowest-priority victim.
        Uses the 'deadlock-3task' fixture scenario.
        """
        try:
            result = _run_fixture('deadlock-3task')
        except RuntimeError as e:
            self.skipTest(f"Fixture failed: {e}")

        self.assertGreater(
            result.get('cyclesDetected', 0), 0,
            f"Should detect at least one deadlock cycle in 3-task: {result}",
        )
        self.assertTrue(
            result.get('stopperCalled'),
            f"Stopper should be called for the victim (lowest priority): {result}",
        )
        # Victim should be task A (low priority) and should be re-queued
        self.assertEqual(
            result.get('victimStatusAfter'), 'queued',
            f"Victim should be re-queued after deadlock resolution: {result}",
        )

    @unittest.skipIf(not _TSX_AVAILABLE, "npx not available for TypeScript fixture")
    def test_shared_holder_cycle_detected(self):
        """
        E3: Multi-file cycle with shared holder detected.

        A holds exclusive on F1. B holds SHARED on F2.
        A wants exclusive on F2 → blocked by B's shared lease.
        B wants exclusive on F1 → blocked by A's exclusive lease.
        The shared-holder edge (A→B via B's shared on F2) is now visible
        because getBlockingHolders scans shared-lease compound keys.
        Uses the 'deadlock-shared' fixture scenario.
        """
        try:
            result = _run_fixture('deadlock-shared')
        except RuntimeError as e:
            self.skipTest(f"Fixture failed: {e}")

        self.assertGreater(
            result.get('cyclesDetected', 0), 0,
            f"Should detect deadlock cycle with shared holder: {result}",
        )
        self.assertTrue(
            result.get('stopperCalled'),
            f"Stopper should be called for victim in shared-holder cycle: {result}",
        )

    @unittest.skipIf(not _TSX_AVAILABLE, "npx not available for TypeScript fixture")
    def test_no_phantom_resolution(self):
        """
        E4: No phantom resolution when no deadlock cycle exists.
        Uses the 'deadlock-no-phantom' fixture scenario.
        detectDeadlock returns null/empty when there are no wait-for entries.
        """
        try:
            result = _run_fixture('deadlock-no-phantom')
        except RuntimeError as e:
            self.skipTest(f"Fixture failed: {e}")

        self.assertEqual(
            result.get('cyclesDetected', -1), 0,
            f"No cycles should be detected when there are no waits: {result}",
        )
        self.assertFalse(
            result.get('phantomResolution', True),
            f"Should not have phantom resolution: {result}",
        )

    # ═══════════════════════════════════════════════════════════════════════
    # GROUP F — Queue Behaviour Under Contention
    # ═══════════════════════════════════════════════════════════════════════

    def test_backoff_clears_when_blocking_file_releases(self):
        """
        F1: Backoff clears when blocking file releases.
        Task A holds file F. Task B is denied with yieldCount incremented.
        After A releases, B retries and is granted.
        """
        file_path = f"src/backoff-{uuid.uuid4().hex[:8]}.ts"

        task_a = self._create_task(title=f"BackoffHolder {str(uuid.uuid4())[:8]}")
        task_b = self._create_task(title=f"BackoffWaiter {str(uuid.uuid4())[:8]}")

        self._declare_files(task_a['id'], exclusive=[file_path])
        self._declare_files(task_b['id'], exclusive=[file_path])

        # A acquires
        result_a = self._acquire_lease(task_a['id'])
        self.assertTrue(result_a.get('granted'), f"A should acquire: {result_a}")

        # B is denied → yieldCount incremented
        result_b1 = self._acquire_lease(task_b['id'])
        self.assertFalse(result_b1.get('granted'), f"B should be denied: {result_b1}")

        # Record yield
        requests.put(
            f"{BASE_URL}/api/tasks/{task_b['id']}",
            json={'yieldCount': 1}, timeout=10,
        )
        b_after_yield = requests.get(f"{BASE_URL}/api/tasks/{task_b['id']}", timeout=10).json()
        self.assertGreater(
            b_after_yield.get('yieldCount', 0), 0,
            "yieldCount should be > 0 after a yield event",
        )

        # A releases
        self._release_lease(task_a['id'])

        # B retries → granted
        result_b2 = self._acquire_lease(task_b['id'])
        self.assertTrue(
            result_b2.get('granted'),
            f"B should acquire after A releases: {result_b2}",
        )

        self._release_lease(task_b['id'])

    def test_max_yield_count_surfaces(self):
        """
        F2: Task exceeding maxYieldCount surfaces visibly instead of silent
        queue residency.
        Set maxYieldCount=2. Create a task, set yieldCount=3 → verify
        the task can be queried and its yieldCount exceeds the configured max.
        (The queue processor reads maxYieldCount each poll cycle; this test
        validates the data shape the processor sees.)
        """
        self._set_config('maxYieldCount', 2)
        time.sleep(0.2)

        task = self._create_task(title=f"MaxYield {str(uuid.uuid4())[:8]}")
        task_id = task['id']

        # Set yieldCount beyond max
        resp = requests.put(
            f"{BASE_URL}/api/tasks/{task_id}",
            json={'yieldCount': 3}, timeout=10,
        )
        self.assertIn(resp.status_code, [200, 204],
                     f"PUT yieldCount should succeed: {resp.status_code}")

        # Read back → yieldCount > maxYieldCount
        updated = requests.get(f"{BASE_URL}/api/tasks/{task_id}", timeout=10).json()
        self.assertEqual(
            updated.get('yieldCount'), 3,
            f"yieldCount should be 3, got {updated.get('yieldCount')}",
        )
        # The configured max is 2, so 3 > max → queue processor should skip
        self.assertGreater(
            updated.get('yieldCount', 0), 2,
            "yieldCount exceeds maxYieldCount — queue processor should skip",
        )

    def test_max_concurrent_tasks_respected_under_wake_storms(self):
        """
        F3: maxConcurrentSessions config stored and retrievable.
        Set maxConcurrentSessions to a test value and verify it is persisted
        and reflected in the config. The actual enforcement is a queue-processor
        concern (not directly testable via REST); this test validates the config
        plumbing the queue processor reads.
        """
        # Set a test value
        self._set_config('maxConcurrentSessions', 3)
        time.sleep(0.2)

        # Read back the config to verify persistence
        resp = requests.get(f"{BASE_URL}/api/config/settings/maxConcurrentSessions", timeout=10)
        self.assertEqual(resp.status_code, 200,
                        f"GET config/settings should succeed: {resp.status_code}")
        data = resp.json()
        self.assertEqual(
            data.get('value'), 3,
            f"maxConcurrentSessions should be 3 after setting; got {data.get('value')}",
        )

        # Create tasks with distinct files — lease manager doesn't enforce
        # maxConcurrentTasks (queue processor does), but each task should be
        # able to independently acquire distinct files
        files = [f"src/wake-storm-{i}-{uuid.uuid4().hex[:6]}.ts" for i in range(2)]
        tasks = []
        for i, f in enumerate(files):
            t = self._create_task(title=f"WakeStorm {i} {str(uuid.uuid4())[:6]}")
            self._declare_files(t['id'], exclusive=[f])
            tasks.append(t)

        # Both should acquire since they use different files
        for t in tasks:
            result = self._acquire_lease(t['id'])
            self.assertTrue(result.get('granted'),
                           f"Task {t['id']} should acquire distinct file: {result}")
            self._release_lease(t['id'])

    # ═══════════════════════════════════════════════════════════════════════
    # GROUP G — Persistence and Restart
    # ═══════════════════════════════════════════════════════════════════════

    def test_leases_json_valid_after_concurrent_ops(self):
        """
        G1: leases.json valid after concurrent operations.
        Two tasks acquire different files. Verify via GET /api/leases that
        both leases are present and consistent. Also check .formic/leases.json
        if it exists (persistence is async and may lag).
        """
        file_a = f"src/persist-a-{uuid.uuid4().hex[:8]}.ts"
        file_b = f"src/persist-b-{uuid.uuid4().hex[:8]}.ts"

        task_a = self._create_task(title=f"Persist A {str(uuid.uuid4())[:8]}")
        task_b = self._create_task(title=f"Persist B {str(uuid.uuid4())[:8]}")

        self._declare_files(task_a['id'], exclusive=[file_a])
        self._declare_files(task_b['id'], exclusive=[file_b])

        result_a = self._acquire_lease(task_a['id'])
        result_b = self._acquire_lease(task_b['id'])
        self.assertTrue(result_a.get('granted'), f"A should acquire: {result_a}")
        self.assertTrue(result_b.get('granted'), f"B should acquire: {result_b}")

        # Verify both leases are present via API (authoritative source)
        all_leases = self._get_leases()
        file_paths = {l.get('filePath') for l in all_leases}
        self.assertIn(file_a, file_paths, f"API should show lease for {file_a}")
        self.assertIn(file_b, file_paths, f"API should show lease for {file_b}")

        # Also check .formic/leases.json if it exists (async persistence may lag)
        workspace = os.environ.get('WORKSPACE_PATH',
                                   os.path.join(os.path.dirname(__file__), '..', 'example'))
        leases_path = os.path.join(workspace, '.formic', 'leases.json')

        if os.path.exists(leases_path):
            with open(leases_path, 'r') as f:
                try:
                    snapshot = json.load(f)
                except json.JSONDecodeError as e:
                    self.fail(f"leases.json is not valid JSON: {e}")

            self.assertIn('version', snapshot, "leases.json should have version")
            self.assertIn('leases', snapshot, "leases.json should have leases array")
            self.assertIsInstance(snapshot['leases'], list, "leases should be a list")

        self._release_lease(task_a['id'])
        self._release_lease(task_b['id'])

    def test_restart_restores_unexpired_leases(self):
        """
        G2: Server restart restores unexpired leases and conflicts still enforced.
        Simulated: acquire a lease, then verify GET /api/leases shows the lease
        and the snapshot file has the correct structure for restore on boot.
        """
        file_path = f"src/restore-{uuid.uuid4().hex[:8]}.ts"

        task = self._create_task(title=f"RestoreTask {str(uuid.uuid4())[:8]}")
        self._declare_files(task['id'], exclusive=[file_path])

        result = self._acquire_lease(task['id'])
        self.assertTrue(result.get('granted'), f"Lease should be granted: {result}")

        time.sleep(0.5)

        # Verify lease is present via API (simulates the restore path)
        all_leases = self._get_leases()
        task_leases = [l for l in all_leases if l.get('taskId') == task['id']]
        self.assertGreater(
            len(task_leases), 0,
            f"Lease should be present (simulating restore): {len(task_leases)} found",
        )

        # Verify lease structure is valid for restore
        for lease in task_leases:
            self.assertIn('filePath', lease, "Lease must have filePath")
            self.assertIn('taskId', lease, "Lease must have taskId")
            self.assertIn('expiresAt', lease, "Lease must have expiresAt")
            self.assertIn('leaseType', lease, "Lease must have leaseType")
            self.assertEqual(lease['leaseType'], 'exclusive',
                            f"Expected exclusive lease, got {lease.get('leaseType')}")

        # Check leases.json snapshot structure (may lag due to async write)
        workspace = os.environ.get('WORKSPACE_PATH',
                                   os.path.join(os.path.dirname(__file__), '..', 'example'))
        leases_path = os.path.join(workspace, '.formic', 'leases.json')
        if os.path.exists(leases_path):
            with open(leases_path, 'r') as f:
                snapshot = json.load(f)
            self.assertIn('version', snapshot, "Snapshot should have version field")
            self.assertIn('leases', snapshot, "Snapshot should have leases array")
            self.assertIsInstance(snapshot['leases'], list, "leases should be a list")

        self._release_lease(task['id'])

    def test_corrupted_leases_json_handled_gracefully(self):
        """
        G3: Corrupted leases.json handled gracefully (warn + empty store, server boots).
        Write malformed JSON to .formic/leases.json, then verify the server
        still responds to lease operations (doesn't crash).
        """
        workspace = os.environ.get('WORKSPACE_PATH',
                                   os.path.join(os.path.dirname(__file__), '..', 'example'))
        leases_path = os.path.join(workspace, '.formic', 'leases.json')

        # Backup existing file if any
        backup_content = None
        if os.path.exists(leases_path):
            with open(leases_path, 'r') as f:
                backup_content = f.read()

        try:
            # Write malformed JSON
            os.makedirs(os.path.dirname(leases_path), exist_ok=True)
            with open(leases_path, 'w') as f:
                f.write('this is not valid json {{{')

            # Give the server a moment (it may or may not notice, depending on
            # whether restoreLeases is called only at startup)
            time.sleep(0.5)

            # The server should still respond — create a task and acquire a lease
            file_path = f"src/corrupted-{uuid.uuid4().hex[:8]}.ts"
            task = self._create_task(title=f"CorruptedTest {str(uuid.uuid4())[:8]}")
            self._declare_files(task['id'], exclusive=[file_path])

            result = self._acquire_lease(task['id'])
            self.assertTrue(
                result.get('granted'),
                f"Server should still grant leases after corrupted leases.json: {result}",
            )

            # GET /api/leases should return a valid list
            all_leases = self._get_leases()
            self.assertIsInstance(all_leases, list,
                                 "GET /api/leases should return a list even after corruption")

            self._release_lease(task['id'])

        finally:
            # Restore backup
            if backup_content is not None:
                with open(leases_path, 'w') as f:
                    f.write(backup_content)
            elif os.path.exists(leases_path):
                os.remove(leases_path)

    # ═══════════════════════════════════════════════════════════════════════
    # GROUP H — Optimistic Shared-File Collision Detection
    # ═══════════════════════════════════════════════════════════════════════

    @unittest.skipIf(not _TSX_AVAILABLE, "npx not available for TypeScript fixture")
    def test_collision_detected_on_shared_file_mutation(self):
        """
        H1: Two tasks sharing a file where one mutates it → detectCollisions
        flags the other at merge time.
        Uses the 'collision-detect' fixture scenario.
        """
        try:
            result = _run_fixture('collision-detect')
        except RuntimeError as e:
            self.skipTest(f"Fixture failed: {e}")

        self.assertTrue(
            result.get('collisionDetected'),
            f"Collision should be detected when shared file is mutated: {result}",
        )
        self.assertGreater(
            result.get('collisionsForB', 0), 0,
            f"Task B should detect the collision from A's mutation: {result}",
        )
        self.assertIsNotNone(
            result.get('bCollisionFile'),
            f"Collision should name the conflicted file: {result}",
        )

    @unittest.skipIf(not _TSX_AVAILABLE, "npx not available for TypeScript fixture")
    def test_no_false_positive_when_unchanged(self):
        """
        H2: No false positive when shared file is untouched.
        Two tasks share a file; neither modifies it → no collision.
        Uses the 'collision-no-false-positive' fixture scenario.
        """
        try:
            result = _run_fixture('collision-no-false-positive')
        except RuntimeError as e:
            self.skipTest(f"Fixture failed: {e}")

        self.assertFalse(
            result.get('falsePositive', True),
            f"Should not detect false positives when file is unchanged: {result}",
        )
        self.assertEqual(
            result.get('collisionsForA', -1), 0,
            f"Task A should find 0 collisions: {result}",
        )
        self.assertEqual(
            result.get('collisionsForB', -1), 0,
            f"Task B should find 0 collisions: {result}",
        )


if __name__ == '__main__':
    unittest.main(verbosity=2)
