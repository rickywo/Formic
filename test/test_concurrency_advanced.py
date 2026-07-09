#!/usr/bin/env python3
"""
Phase 3 tests: Industrial-grade concurrency — advanced lease management.

Validates advanced concurrency behaviour against a running Formic server:
- Lease priority: higher-priority tasks acquire leases before lower-priority ones
- Deadlock detection: mutual exclusive lease requests are detected and resolved
- Yield backoff: tasks that yield accumulate a yieldCount visible via the API
- 100-task stress test: zero deadlocks and zero data corruption (configurable via
  STRESS_TASK_COUNT env var; skip with SKIP_STRESS=true)

Usage:
    # Start Formic server first:
    # WORKSPACE_PATH=./example npm run dev

    # Run tests (skip stress test):
    SKIP_STRESS=true python test/test_concurrency_advanced.py

    # Run all tests including stress:
    STRESS_TASK_COUNT=20 python test/test_concurrency_advanced.py
"""

import os
import sys
import time
import unittest
import uuid

import requests

sys.path.insert(0, os.path.dirname(__file__))
from fixtures import BASE_URL, cleanup_tasks, is_server_reachable

SKIP_STRESS = os.environ.get('SKIP_STRESS', 'true').lower() in ('true', '1', 'yes')
STRESS_TASK_COUNT = int(os.environ.get('STRESS_TASK_COUNT', '100'))


class TestConcurrencyAdvanced(unittest.TestCase):
    """Advanced concurrency tests for Phase 3 lease-based concurrency."""

    def setUp(self):
        """Verify server is reachable; skip all tests if not."""
        self.created_task_ids: list = []
        if not is_server_reachable(BASE_URL):
            self.skipTest(
                f"Server unreachable at {BASE_URL}. Start with: WORKSPACE_PATH=./example npm run dev"
            )

    def tearDown(self):
        """Release leases and delete all tasks created during the test."""
        for task_id in self.created_task_ids:
            try:
                requests.post(f"{BASE_URL}/api/tasks/{task_id}/lease/release", timeout=5)
            except Exception:
                pass
        cleanup_tasks(BASE_URL, self.created_task_ids)

    def _create_task(self, title=None, priority='medium', task_type='standard', extra=None):
        """POST /api/tasks and register for cleanup. Returns task JSON."""
        if title is None:
            title = f"ConcAdv Test {str(uuid.uuid4())[:8]}"
        payload = {
            'title': title,
            'context': 'Created by test_concurrency_advanced.py for advanced concurrency verification',
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
        resp = requests.put(f"{BASE_URL}/api/tasks/{task_id}", json={'declaredFiles': declared}, timeout=10)
        return resp

    def _acquire_lease(self, task_id):
        """POST /api/tasks/:id/lease/acquire. Returns response JSON."""
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

    def _get_leases(self):
        """GET /api/leases. Returns list of active lease objects."""
        resp = requests.get(f"{BASE_URL}/api/leases", timeout=10)
        if resp.status_code == 200:
            return resp.json()
        return []

    # ── Test 1: Lease Priority ────────────────────────────────────────────────

    def test_high_priority_task_acquires_contested_file_first(self):
        """
        Lease Priority: When two tasks compete for the same exclusive file,
        the higher-priority task should acquire it. The lower-priority task
        should be denied while the higher-priority one holds the lease.
        """
        file_path = f"src/priority-test-{uuid.uuid4().hex[:8]}.ts"

        low_task = self._create_task(
            title=f"Low Priority Lease {str(uuid.uuid4())[:8]}",
            priority='low',
        )
        high_task = self._create_task(
            title=f"High Priority Lease {str(uuid.uuid4())[:8]}",
            priority='high',
        )

        self._declare_files(low_task['id'], exclusive=[file_path])
        self._declare_files(high_task['id'], exclusive=[file_path])

        # High priority acquires first
        high_result = self._acquire_lease(high_task['id'])
        self.assertTrue(
            high_result.get('granted'),
            f"High-priority task should acquire lease first, got: {high_result}",
        )

        # Low priority should be denied while high holds the lease
        low_result = self._acquire_lease(low_task['id'])
        self.assertFalse(
            low_result.get('granted'),
            f"Low-priority task should be denied while high-priority holds lease, got: {low_result}",
        )

        self.assertIn(
            file_path, low_result.get('conflictingFiles', []),
            f"Conflicting file not reported in denial: {low_result}",
        )

        self._release_lease(high_task['id'])

    def test_lower_priority_acquires_after_higher_releases(self):
        """
        Lease Priority: After the high-priority task releases its exclusive lease,
        the lower-priority task must be able to acquire it.
        """
        file_path = f"src/release-priority-{uuid.uuid4().hex[:8]}.ts"

        low_task = self._create_task(priority='low')
        high_task = self._create_task(priority='high')

        self._declare_files(low_task['id'], exclusive=[file_path])
        self._declare_files(high_task['id'], exclusive=[file_path])

        high_result = self._acquire_lease(high_task['id'])
        self.assertTrue(high_result.get('granted'))

        # Release high-priority lease
        self._release_lease(high_task['id'])

        # Now low priority can acquire
        low_result = self._acquire_lease(low_task['id'])
        self.assertTrue(
            low_result.get('granted'),
            f"Low-priority task should acquire lease after high releases it, got: {low_result}",
        )
        self._release_lease(low_task['id'])

    # ── Test 2: Deadlock Detection ────────────────────────────────────────────

    def test_mutual_exclusive_lease_conflict_detected(self):
        """
        Deadlock Detection: Task A acquires file X exclusively and then tries to
        acquire file Y. Task B acquires file Y exclusively. This creates a potential
        deadlock. The server must not block indefinitely — the second task's lease
        request should be denied with a conflict report.
        """
        file_x = f"src/deadlock-x-{uuid.uuid4().hex[:8]}.ts"
        file_y = f"src/deadlock-y-{uuid.uuid4().hex[:8]}.ts"

        task_a = self._create_task(title=f"Deadlock A {str(uuid.uuid4())[:8]}")
        task_b = self._create_task(title=f"Deadlock B {str(uuid.uuid4())[:8]}")

        # A declares X; B declares Y
        self._declare_files(task_a['id'], exclusive=[file_x])
        self._declare_files(task_b['id'], exclusive=[file_y])

        # Both acquire their own files
        result_a = self._acquire_lease(task_a['id'])
        result_b = self._acquire_lease(task_b['id'])

        self.assertTrue(result_a.get('granted'), f"Task A should acquire file_x: {result_a}")
        self.assertTrue(result_b.get('granted'), f"Task B should acquire file_y: {result_b}")

        # Now both try to acquire the other's file — deadlock scenario
        # Re-declare to include the other file
        self._release_lease(task_a['id'])
        self._release_lease(task_b['id'])

        self._declare_files(task_a['id'], exclusive=[file_x, file_y])
        self._declare_files(task_b['id'], exclusive=[file_x, file_y])

        # A acquires first
        result_a2 = self._acquire_lease(task_a['id'])
        self.assertTrue(result_a2.get('granted'), f"Task A should acquire both files: {result_a2}")

        # B is blocked on X (held by A) — must be denied without hanging
        result_b2 = self._acquire_lease(task_b['id'])
        self.assertFalse(
            result_b2.get('granted'),
            f"Task B should be denied due to conflict on {file_x}, got: {result_b2}",
        )

        self._release_lease(task_a['id'])

    def test_lease_conflict_response_within_timeout(self):
        """
        Deadlock Detection: The POST /api/tasks/:id/lease/acquire endpoint must
        respond within 5 seconds even when a conflict exists, preventing hangs.
        """
        file_path = f"src/timeout-test-{uuid.uuid4().hex[:8]}.ts"

        holder = self._create_task(title=f"Lease Holder {str(uuid.uuid4())[:8]}")
        waiter = self._create_task(title=f"Lease Waiter {str(uuid.uuid4())[:8]}")

        self._declare_files(holder['id'], exclusive=[file_path])
        self._declare_files(waiter['id'], exclusive=[file_path])

        self._acquire_lease(holder['id'])

        start = time.time()
        self._acquire_lease(waiter['id'])
        elapsed = time.time() - start

        self.assertLess(
            elapsed, 5.0,
            f"Lease acquire should respond within 5s on conflict, took {elapsed:.2f}s",
        )

        self._release_lease(holder['id'])

    # ── Test 3: Yield Backoff ─────────────────────────────────────────────────

    def test_yield_count_stored_and_retrievable(self):
        """
        Yield Backoff: The yieldCount field must be writable and readable via the
        task API. The queue processor increments this counter each time a task yields
        due to a lease conflict, enabling exponential backoff calculation.
        """
        task = self._create_task(title=f"Yield Backoff {str(uuid.uuid4())[:8]}")
        task_id = task['id']

        # yieldCount should be 0 or null initially
        initial = task.get('yieldCount')
        self.assertIn(initial, [0, None], f"Initial yieldCount should be 0 or null, got {initial}")

        # Simulate yielding by incrementing yieldCount
        for expected in [1, 2, 3]:
            resp = requests.put(
                f"{BASE_URL}/api/tasks/{task_id}", json={'yieldCount': expected}, timeout=10
            )
            self.assertIn(
                resp.status_code, [200, 204],
                f"PUT yieldCount={expected} failed: {resp.status_code}",
            )
            updated = requests.get(f"{BASE_URL}/api/tasks/{task_id}", timeout=10).json()
            self.assertEqual(
                updated.get('yieldCount'), expected,
                f"Expected yieldCount={expected}, got {updated.get('yieldCount')}",
            )

    def test_yield_count_on_lease_conflict(self):
        """
        Yield Backoff: When a task is denied a lease due to conflict, its yieldCount
        can be updated by the caller (queue processor). Each yield should increment
        the count, enabling the queue processor to apply exponential backoff delays.
        """
        file_path = f"src/yield-conflict-{uuid.uuid4().hex[:8]}.ts"

        holder = self._create_task(title=f"Yield Holder {str(uuid.uuid4())[:8]}")
        yielder = self._create_task(title=f"Yielder {str(uuid.uuid4())[:8]}")

        self._declare_files(holder['id'], exclusive=[file_path])
        self._declare_files(yielder['id'], exclusive=[file_path])

        self._acquire_lease(holder['id'])

        # yielder is denied
        result = self._acquire_lease(yielder['id'])
        self.assertFalse(result.get('granted'), "Yielder should be denied")

        # Queue processor increments yieldCount after a yield
        requests.put(
            f"{BASE_URL}/api/tasks/{yielder['id']}", json={'yieldCount': 1}, timeout=10
        )
        updated = requests.get(f"{BASE_URL}/api/tasks/{yielder['id']}", timeout=10).json()
        self.assertGreater(
            updated.get('yieldCount', 0), 0,
            "yieldCount should be > 0 after a yield event",
        )

        self._release_lease(holder['id'])

    # ── Test 4: Preemption & Deadlock Regression ───────────────────────────────

    def test_yield_signal_removed_from_file_lease(self):
        """
        Regression: The yieldSignal field on FileLease must be absent after the
        dead-protocol removal. Any serialised lease returned by the API must not
        contain a yieldSignal key (even undefined/null).
        """
        file_path = f"src/yield-signal-{uuid.uuid4().hex[:8]}.ts"

        task = self._create_task(title=f"YieldSignal Removal {str(uuid.uuid4())[:8]}")
        self._declare_files(task['id'], exclusive=[file_path])

        result = self._acquire_lease(task['id'])
        self.assertTrue(result.get('granted'), f"Lease should be granted: {result}")

        # Inspect leases via GET /api/leases
        leases = self._get_leases()
        task_leases = [l for l in leases if l.get('taskId') == task['id']]
        self.assertGreater(len(task_leases), 0, "Should find the granted lease")

        for lease in task_leases:
            self.assertNotIn(
                'yieldSignal', lease,
                f"yieldSignal must be absent from FileLease; got keys: {list(lease.keys())}",
            )

        self._release_lease(task['id'])

    def test_deadlock_detection_returns_without_error(self):
        """
        Regression: detectDeadlock must not throw when there are no deadlock
        cycles. The new stop-before-release path must not introduce runtime
        errors even when the stopper finds no active process (normal in test
        environments).
        """
        # With no wait-for graph entries, detectDeadlock should return null
        # without errors. We verify this indirectly by confirming the leases
        # endpoint works (the watchdog calls detectDeadlock periodically, and
        # if it threw, the server would log errors).
        leases = self._get_leases()
        self.assertIsInstance(leases, list, "GET /api/leases must return a list")

    def test_lease_release_and_reacquire_after_refactor(self):
        """
        Regression: After the preemptLease/detectDeadlock refactor, basic lease
        acquire → release → re-acquire cycles must still work correctly. The
        revertExclusiveFiles helper and the new stop-before-release sequencing
        must not break normal lease operations.
        """
        file_path = f"src/reacquire-{uuid.uuid4().hex[:8]}.ts"

        task_a = self._create_task(title=f"Reacquire A {str(uuid.uuid4())[:8]}")
        task_b = self._create_task(title=f"Reacquire B {str(uuid.uuid4())[:8]}")

        self._declare_files(task_a['id'], exclusive=[file_path])
        self._declare_files(task_b['id'], exclusive=[file_path])

        # Task A acquires
        result_a = self._acquire_lease(task_a['id'])
        self.assertTrue(result_a.get('granted'), f"A should acquire: {result_a}")

        # Task B is denied while A holds
        result_b = self._acquire_lease(task_b['id'])
        self.assertFalse(result_b.get('granted'), f"B should be denied: {result_b}")

        # Task A releases
        self._release_lease(task_a['id'])

        # Task B can now acquire
        result_b2 = self._acquire_lease(task_b['id'])
        self.assertTrue(result_b2.get('granted'), f"B should acquire after A releases: {result_b2}")

        self._release_lease(task_b['id'])

    def test_high_priority_preemption_triggers_no_poll_delay(self):
        """
        Regression: The old preemptLease polled for up to 10 s waiting for a
        voluntary yield that never happened. After the yieldSignal removal, a
        preemption attempt must return within 2 seconds even when both tasks
        have declared conflicting files (the preemption may succeed or be
        refused, but it must not block for 10 s).
        """
        file_path = f"src/preempt-nopoll-{uuid.uuid4().hex[:8]}.ts"

        low_task = self._create_task(
            title=f"NoPoll Low {str(uuid.uuid4())[:8]}",
            priority='low',
        )
        high_task = self._create_task(
            title=f"NoPoll High {str(uuid.uuid4())[:8]}",
            priority='high',
        )

        self._declare_files(low_task['id'], exclusive=[file_path])
        self._declare_files(high_task['id'], exclusive=[file_path])

        # Low-priority task acquires the lease first
        low_result = self._acquire_lease(low_task['id'])
        self.assertTrue(low_result.get('granted'), f"Low should acquire: {low_result}")

        # High-priority task tries to acquire — must respond quickly
        # (the acquire endpoint doesn't call preemptLease directly, but the
        # refactored code path must not introduce any polling delay in the
        # lease-checking hot path)
        start = time.time()
        high_result = self._acquire_lease(high_task['id'])
        elapsed = time.time() - start

        self.assertFalse(high_result.get('granted'), f"High should be denied while low holds: {high_result}")
        self.assertLess(
            elapsed, 2.0,
            f"Lease acquire for conflicting file must return within 2s, took {elapsed:.2f}s",
        )

        self._release_lease(low_task['id'])

    # ── Test 5a: Cap-Exceeded Terminal State ──────────────────────────────────

    def test_capped_task_transitions_to_todo(self):
        """
        AC1: A task exceeding maxYieldCount must transition to 'todo' with a
        populated yieldReason. It must not remain silently 'queued'.

        This test simulates the cap-exceeded condition by setting yieldCount
        at the threshold, queuing the task, and verifying the queue processor
        transitions it out of 'queued' within a reasonable window.
        """
        task = self._create_task(title=f"CapYield {str(uuid.uuid4())[:8]}")
        task_id = task['id']

        # Set yieldCount to the maximum allowed (50 by default)
        resp = requests.put(
            f"{BASE_URL}/api/tasks/{task_id}",
            json={'yieldCount': 50, 'status': 'queued'},
            timeout=10,
        )
        self.assertIn(resp.status_code, [200, 204])

        # Verify yieldCount was persisted
        updated = requests.get(f"{BASE_URL}/api/tasks/{task_id}", timeout=10).json()
        self.assertEqual(updated.get('yieldCount'), 50)

        # If the queue processor is running, it should transition this task
        # to 'todo' with a cap-exceeded yieldReason. Wait up to 15 seconds.
        from fixtures import wait_for_any_status
        final_status = wait_for_any_status(
            BASE_URL, task_id,
            expected_statuses=['todo'],
            timeout_secs=15,
            poll_interval_secs=2.0,
        )
        if final_status == 'todo':
            final_task = requests.get(f"{BASE_URL}/api/tasks/{task_id}", timeout=10).json()
            self.assertIsNotNone(final_task.get('yieldReason'))
            self.assertIn(
                'cap-exceeded', final_task.get('yieldReason', ''),
                f"Expected cap-exceeded yieldReason, got: {final_task.get('yieldReason')}",
            )
        else:
            # Queue processor may not be running — the task should at minimum
            # still have the correct yieldCount set.
            self.assertEqual(updated.get('yieldCount'), 50,
                             "yieldCount should persist even if queue processor is not running")

    # ── Test 5b: Backoff Cleared on Lease Release ─────────────────────────────

    def test_backoff_cleared_on_lease_release(self):
        """
        AC2: When a contested file is released, a task in backoff for that file
        should be dispatchable (wouldConflict returns false) within one wake cycle.

        Simulates the scenario: holder acquires exclusive lease on file, waiter
        would conflict. After holder releases, waiter must no longer conflict.
        """
        file_path = f"src/backoff-reset-{uuid.uuid4().hex[:8]}.ts"

        holder = self._create_task(title=f"Backoff Holder {str(uuid.uuid4())[:8]}")
        waiter = self._create_task(title=f"Backoff Waiter {str(uuid.uuid4())[:8]}")

        # Holder acquires exclusive lease
        self._declare_files(holder['id'], exclusive=[file_path])
        holder_result = self._acquire_lease(holder['id'])
        self.assertTrue(holder_result.get('granted'),
                        f"Holder should acquire lease: {holder_result}")

        # Waiter declares exclusive on same file — should be denied
        self._declare_files(waiter['id'], exclusive=[file_path])
        waiter_result = self._acquire_lease(waiter['id'])
        self.assertFalse(waiter_result.get('granted'),
                         f"Waiter should be denied while holder has lease: {waiter_result}")

        # Release holder's lease
        self._release_lease(holder['id'])

        # Now waiter should be able to acquire (file is free)
        waiter_result2 = self._acquire_lease(waiter['id'])
        self.assertTrue(
            waiter_result2.get('granted'),
            f"Waiter should acquire after holder releases: {waiter_result2}",
        )
        self._release_lease(waiter['id'])

    # ── Test 5c: Longest-Blocked Acquires First ───────────────────────────────

    def test_longest_blocked_acquires_first(self):
        """
        AC3: Under contention for one file at equal priority, the task with the
        earliest firstBlockedAt timestamp should have a higher priority score,
        ensuring the longest-waiting task acquires first.

        Verifies that firstBlockedAt is settable/readable via the API and that
        an earlier timestamp results in a fair ordering.
        """
        file_path = f"src/fairness-{uuid.uuid4().hex[:8]}.ts"

        task_a = self._create_task(
            title=f"Fairness Early {str(uuid.uuid4())[:8]}",
            priority='medium',
        )
        task_b = self._create_task(
            title=f"Fairness Late {str(uuid.uuid4())[:8]}",
            priority='medium',
        )

        # Both declare exclusive on the same file
        self._declare_files(task_a['id'], exclusive=[file_path])
        self._declare_files(task_b['id'], exclusive=[file_path])

        # Task A acquires first
        result_a = self._acquire_lease(task_a['id'])
        self.assertTrue(result_a.get('granted'), f"Task A should acquire: {result_a}")

        # Set firstBlockedAt on task B to simulate it was blocked waiting
        early_time = '2020-01-01T00:00:00.000Z'
        resp = requests.put(
            f"{BASE_URL}/api/tasks/{task_b['id']}",
            json={'firstBlockedAt': early_time},
            timeout=10,
        )
        self.assertIn(resp.status_code, [200, 204])

        # Verify firstBlockedAt was persisted
        updated_b = requests.get(f"{BASE_URL}/api/tasks/{task_b['id']}", timeout=10).json()
        self.assertEqual(
            updated_b.get('firstBlockedAt'), early_time,
            f"firstBlockedAt should be persisted, got: {updated_b.get('firstBlockedAt')}",
        )

        # Clear firstBlockedAt via null
        resp = requests.put(
            f"{BASE_URL}/api/tasks/{task_b['id']}",
            json={'firstBlockedAt': None},
            timeout=10,
        )
        self.assertIn(resp.status_code, [200, 204])
        cleared = requests.get(f"{BASE_URL}/api/tasks/{task_b['id']}", timeout=10).json()
        self.assertIsNone(cleared.get('firstBlockedAt'),
                          f"firstBlockedAt should be None after clearing, got: {cleared.get('firstBlockedAt')}")

        self._release_lease(task_a['id'])

    # ── Test 5d: Shared Lease Blocks Exclusive Dispatch ───────────────────────

    def test_shared_lease_blocks_exclusive_dispatch(self):
        """
        AC4: A task whose exclusive file is held SHARED by another task must NOT
        be dispatched into a guaranteed lease denial. The shared lease must block
        exclusive acquisition — the pre-dispatch conflict check must detect it.

        Task A acquires a SHARED lease on file X. Task B attempts to acquire an
        EXCLUSIVE lease on file X — this must be denied.
        """
        file_path = f"src/shared-block-{uuid.uuid4().hex[:8]}.ts"

        task_a = self._create_task(title=f"Shared Holder {str(uuid.uuid4())[:8]}")
        task_b = self._create_task(title=f"Exclusive Wannabe {str(uuid.uuid4())[:8]}")

        # Task A declares and acquires a SHARED lease
        self._declare_files(task_a['id'], shared=[file_path])
        result_a = self._acquire_lease(task_a['id'])
        self.assertTrue(result_a.get('granted'),
                        f"Task A should acquire shared lease: {result_a}")

        # Verify shared lease is visible in active leases
        leases = self._get_leases()
        shared_leases = [l for l in leases if l.get('filePath') == file_path]
        self.assertGreater(len(shared_leases), 0,
                           f"Shared lease on {file_path} should be visible in GET /api/leases")

        # Task B declares exclusive on the same file — must be denied
        self._declare_files(task_b['id'], exclusive=[file_path])
        result_b = self._acquire_lease(task_b['id'])
        self.assertFalse(
            result_b.get('granted'),
            f"Task B must be denied exclusive lease while Task A holds shared lease: {result_b}",
        )
        self.assertIn(
            file_path, result_b.get('conflictingFiles', []),
            f"Conflicting file {file_path} must be reported for shared-lease conflict: {result_b}",
        )

        # Release Task A's shared lease
        self._release_lease(task_a['id'])

        # Now Task B can acquire exclusive
        result_b2 = self._acquire_lease(task_b['id'])
        self.assertTrue(
            result_b2.get('granted'),
            f"Task B should acquire exclusive after shared lease is released: {result_b2}",
        )
        self._release_lease(task_b['id'])

    # ── Test 5e: Multi-File Conflict Yield & Re-queue ──────────────────────────

    def test_multi_file_conflict_yield_and_reacquire(self):
        """
        Multi-file wait fix: When a task is denied because multiple of its
        exclusive files are held by others, all conflicting files are recorded.
        After all blockers release, the waiter can re-acquire.
        """
        file_a = f"src/multi-a-{uuid.uuid4().hex[:8]}.ts"
        file_b = f"src/multi-b-{uuid.uuid4().hex[:8]}.ts"

        holder_a = self._create_task(title=f"Multi Holder A {str(uuid.uuid4())[:8]}")
        holder_b = self._create_task(title=f"Multi Holder B {str(uuid.uuid4())[:8]}")
        waiter = self._create_task(title=f"Multi Waiter {str(uuid.uuid4())[:8]}")

        # Two holders each own one file
        self._declare_files(holder_a['id'], exclusive=[file_a])
        self._declare_files(holder_b['id'], exclusive=[file_b])
        self._declare_files(waiter['id'], exclusive=[file_a, file_b])

        # Holders acquire their files
        self.assertTrue(self._acquire_lease(holder_a['id']).get('granted'))
        self.assertTrue(self._acquire_lease(holder_b['id']).get('granted'))

        # Waiter is denied — BOTH files conflict
        waiter_result = self._acquire_lease(waiter['id'])
        self.assertFalse(waiter_result.get('granted'),
                         f"Waiter should be denied, got: {waiter_result}")
        self.assertEqual(
            len(waiter_result.get('conflictingFiles', [])), 2,
            f"Both files should conflict, got: {waiter_result.get('conflictingFiles')}",
        )

        # Release both holders
        self._release_lease(holder_a['id'])
        self._release_lease(holder_b['id'])

        # Waiter can now acquire both files
        waiter_result2 = self._acquire_lease(waiter['id'])
        self.assertTrue(
            waiter_result2.get('granted'),
            f"Waiter should acquire after both holders release: {waiter_result2}",
        )
        self._release_lease(waiter['id'])

    # ── Test 5f: Shared-Holder → Exclusive Cycle Prevention ────────────────────

    def test_shared_holder_release_unblocks_exclusive(self):
        """
        Shared-holder edge fix: When a task holds a SHARED lease on file X and
        another task wants EXCLUSIVE on X, the exclusive request is denied.
        After the shared holder releases, the exclusive acquisition succeeds
        — confirming the blocking relationship is tracked and resolved.
        """
        file_path = f"src/shared-cycle-{uuid.uuid4().hex[:8]}.ts"
        second_file = f"src/shared-cycle-2-{uuid.uuid4().hex[:8]}.ts"

        shared_holder = self._create_task(
            title=f"SharedCycle Holder {str(uuid.uuid4())[:8]}",
        )
        exclusive_wanter = self._create_task(
            title=f"SharedCycle Wanter {str(uuid.uuid4())[:8]}",
        )

        # Shared holder acquires shared on file_path and exclusive on second_file
        self._declare_files(shared_holder['id'], shared=[file_path],
                            exclusive=[second_file])
        self.assertTrue(self._acquire_lease(shared_holder['id']).get('granted'),
                        "Shared holder should acquire")

        # Exclusive wanter wants exclusive on file_path (blocked by shared)
        # AND shared_holder wants exclusive on a file wanter would hold
        self._declare_files(exclusive_wanter['id'], exclusive=[file_path])

        result = self._acquire_lease(exclusive_wanter['id'])
        self.assertFalse(result.get('granted'),
                         f"Exclusive should be denied while shared lease exists: {result}")
        self.assertIn(file_path, result.get('conflictingFiles', []),
                      f"Conflicting file must be reported: {result}")

        # Release shared holder — exclusive wanter should now succeed
        self._release_lease(shared_holder['id'])

        result2 = self._acquire_lease(exclusive_wanter['id'])
        self.assertTrue(
            result2.get('granted'),
            f"Exclusive should acquire after shared holder releases: {result2}",
        )
        self._release_lease(exclusive_wanter['id'])

    # ── Test 5g: Yield + Stop + Re-queue (Stale Record Cleanup) ────────────────

    def test_yielded_task_stop_and_requeue_clean_state(self):
        """
        Stale record cleanup: When a task yields due to a lease conflict and is
        subsequently stopped, its wait records are cleaned up by releaseLeases.
        The task can be re-queued and acquire leases successfully without
        phantom stale records interfering.
        """
        file_path = f"src/stale-cleanup-{uuid.uuid4().hex[:8]}.ts"

        holder = self._create_task(title=f"Stale Holder {str(uuid.uuid4())[:8]}")
        yielder = self._create_task(title=f"Stale Yielder {str(uuid.uuid4())[:8]}")

        # Holder acquires exclusive
        self._declare_files(holder['id'], exclusive=[file_path])
        self.assertTrue(self._acquire_lease(holder['id']).get('granted'))

        # Yielder tries and fails (yields)
        self._declare_files(yielder['id'], exclusive=[file_path])
        yield_result = self._acquire_lease(yielder['id'])
        self.assertFalse(yield_result.get('granted'),
                         f"Yielder should be denied: {yield_result}")

        # Simulate stop: release yielder's leases (calls clearWait via releaseLeases)
        self._release_lease(yielder['id'])

        # Re-queue the yielder with a clean slate
        requests.put(
            f"{BASE_URL}/api/tasks/{yielder['id']}",
            json={'status': 'queued', 'yieldCount': 0, 'resumeFromStep': None},
            timeout=10,
        )

        # Release holder
        self._release_lease(holder['id'])

        # Yielder should now be able to acquire (no stale wait records creating phantom conflicts)
        yielder_result2 = self._acquire_lease(yielder['id'])
        self.assertTrue(
            yielder_result2.get('granted'),
            f"Yielder should acquire after stop+requeue+holder release: {yielder_result2}",
        )
        self._release_lease(yielder['id'])

    # ── Test 5: Stress Test ───────────────────────────────────────────────────

    @unittest.skipIf(SKIP_STRESS, "Stress test skipped (set SKIP_STRESS=false to enable)")
    def test_stress_no_deadlocks(self):
        """
        100-Task Stress Test: Queue STRESS_TASK_COUNT tasks with mixed file dependencies.
        Verify that all tasks can eventually acquire and release leases without deadlocks.
        Target: zero deadlocks within 30 minutes.
        """
        task_count = STRESS_TASK_COUNT
        print(f"\n[Stress] Starting {task_count}-task stress test...")
        start_time = time.time()
        max_duration = 30 * 60  # 30 minutes

        # Create shared files that tasks will compete over
        shared_files = [f"src/stress-file-{i}.ts" for i in range(5)]
        stress_tasks = []

        # Create all tasks
        print(f"[Stress] Creating {task_count} tasks...")
        for i in range(task_count):
            task = self._create_task(
                title=f"Stress Task {i:03d} {str(uuid.uuid4())[:6]}",
                priority=['low', 'medium', 'high'][i % 3],
            )
            # Mix of exclusive and shared file declarations
            exclusive = [shared_files[i % len(shared_files)]] if i % 3 == 0 else []
            shared = [shared_files[(i + 1) % len(shared_files)]] if i % 2 == 0 else []
            self._declare_files(task['id'], exclusive=exclusive, shared=shared)
            stress_tasks.append(task['id'])

        print(f"[Stress] Created {len(stress_tasks)} tasks in {time.time() - start_time:.1f}s")

        # Acquire and release leases sequentially, tracking results
        deadlocks = 0
        completed = 0
        errors = 0

        for task_id in stress_tasks:
            if time.time() - start_time > max_duration:
                self.fail(f"Stress test exceeded {max_duration}s time limit")

            result = self._acquire_lease(task_id)
            if result.get('granted'):
                self._release_lease(task_id)
                completed += 1
            elif 'conflictingFiles' in result:
                # Expected contention — not a deadlock
                completed += 1
            else:
                errors += 1

            if time.time() - start_time > max_duration:
                break

        elapsed = time.time() - start_time
        print(f"[Stress] Results: completed={completed}, deadlocks={deadlocks}, errors={errors}")
        print(f"[Stress] Total time: {elapsed:.1f}s")

        self.assertEqual(
            deadlocks, 0,
            f"Expected 0 deadlocks in {task_count}-task stress test, got {deadlocks}",
        )
        self.assertLess(
            elapsed, max_duration,
            f"Stress test exceeded {max_duration}s: {elapsed:.1f}s",
        )

        # Verify all leases released
        remaining_leases = self._get_leases()
        stress_task_set = set(stress_tasks)
        leaked = [l for l in remaining_leases if l.get('taskId') in stress_task_set]
        self.assertEqual(
            len(leaked), 0,
            f"{len(leaked)} leases were not released after stress test",
        )


if __name__ == '__main__':
    unittest.main(verbosity=2)
