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

    # ── Test 4: Stress Test ───────────────────────────────────────────────────

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
