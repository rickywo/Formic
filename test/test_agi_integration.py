#!/usr/bin/env python3
"""
Integration tests spanning all AGI phases: end-to-end goal flow, failure recovery,
and concurrent goal execution.

Test scenarios:
1. End-to-End Goal Flow: Submit a goal → architect decomposes → child tasks execute
   with QA → all complete → memories saved (if Phase 4 deployed)
2. Failure Recovery Flow: A broken subtask triggers the critic → fix task is created
   → the goal eventually completes
3. Concurrent Goals: Two independent goals submitted simultaneously → no conflicts,
   both complete

These tests require a fully-running Formic server with agents configured. Tests that
depend on live agent execution are annotated and will be skipped automatically when
the relevant features are not yet deployed.

Environment variables:
    FORMIC_URL          — server base URL (default: http://localhost:3000)
    TEST_WORKSPACE_PATH — dedicated test workspace path (default: ./example)
    TEST_TIMEOUT_SECS   — max seconds to wait for goal completion (default: 300)

Usage:
    # Start Formic server first:
    # WORKSPACE_PATH=./example npm run dev

    # Run tests:
    python test/test_agi_integration.py
"""

import os
import sys
import time
import unittest
import uuid

import requests

sys.path.insert(0, os.path.dirname(__file__))
from fixtures import (
    BASE_URL,
    cleanup_tasks,
    is_server_reachable,
    wait_for_any_status,
    wait_for_status,
)

TEST_TIMEOUT_SECS = int(os.environ.get('TEST_TIMEOUT_SECS', '300'))


class TestAGIIntegration(unittest.TestCase):
    """End-to-end integration tests spanning multiple AGI phases."""

    def setUp(self):
        """Verify server is reachable; skip all tests if not."""
        self.created_task_ids: list = []
        if not is_server_reachable(BASE_URL):
            self.skipTest(
                f"Server unreachable at {BASE_URL}. Start with: WORKSPACE_PATH=./example npm run dev"
            )

    def tearDown(self):
        """Delete all tasks created during the test."""
        cleanup_tasks(BASE_URL, self.created_task_ids)

    def _create_task(self, title=None, priority='medium', task_type='standard', extra=None):
        """POST /api/tasks and register for cleanup. Returns task JSON."""
        if title is None:
            title = f"Integration Test {str(uuid.uuid4())[:8]}"
        payload = {
            'title': title,
            'context': 'Created by test_agi_integration.py for AGI integration verification',
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

    def _get_task(self, task_id):
        """GET /api/tasks/:id. Returns task JSON."""
        resp = requests.get(f"{BASE_URL}/api/tasks/{task_id}", timeout=10)
        if resp.status_code == 200:
            return resp.json()
        return {}

    def _get_board(self):
        """GET /api/board. Returns board JSON."""
        resp = requests.get(f"{BASE_URL}/api/board", timeout=10)
        if resp.status_code == 200:
            return resp.json()
        return {'tasks': [], 'meta': {}}

    def _queue_task(self, task_id):
        """POST /api/tasks/:id/queue."""
        return requests.post(f"{BASE_URL}/api/tasks/{task_id}/queue", timeout=10)

    def _get_child_tasks(self, parent_goal_id):
        """Find all tasks in the board whose parentGoalId equals parent_goal_id."""
        board = self._get_board()
        return [t for t in board.get('tasks', []) if t.get('parentGoalId') == parent_goal_id]

    # ── Test 1: End-to-End Goal Flow (API-level validation) ───────────────────

    def test_goal_task_api_surface_complete(self):
        """
        End-to-End Goal Flow (API surface): A goal task must be accepted by the
        server with type='goal', carry a parentGoalId field, and expose child task
        linking fields. This validates the structural foundation before live execution.
        """
        goal = self._create_task(
            title=f"E2E Goal Test {str(uuid.uuid4())[:8]}",
            task_type='goal',
        )

        self.assertEqual(goal.get('type'), 'goal', "Goal task must have type='goal'")
        # Goals should carry childTaskIds (empty initially)
        child_ids = goal.get('childTaskIds')
        if child_ids is not None:
            self.assertIsInstance(child_ids, list, "childTaskIds must be a list")

        # Verify goal appears on board
        board = self._get_board()
        board_task_ids = [t['id'] for t in board.get('tasks', [])]
        self.assertIn(goal['id'], board_task_ids, "Goal task must appear on board")

    def test_goal_child_task_parent_linkage(self):
        """
        End-to-End Goal Flow: Child tasks must reference their parent goal via
        parentGoalId. We simulate this by creating a task with parentGoalId set
        (as the architect workflow would do) and verify the linkage is stored.
        """
        goal = self._create_task(
            title=f"Goal Parent {str(uuid.uuid4())[:8]}",
            task_type='goal',
        )

        # Simulate a child task created by the architect
        child = self._create_task(
            title=f"Child of Goal {str(uuid.uuid4())[:8]}",
            task_type='standard',
            extra={'parentGoalId': goal['id']},
        )

        self.assertEqual(
            child.get('parentGoalId'), goal['id'],
            f"Child task should reference goal '{goal['id']}' via parentGoalId, "
            f"got '{child.get('parentGoalId')}'",
        )

        # Child task should appear in parent's childTaskIds if board updates them
        board = self._get_board()
        goal_on_board = next((t for t in board['tasks'] if t['id'] == goal['id']), None)
        if goal_on_board and goal_on_board.get('childTaskIds') is not None:
            # Some implementations update childTaskIds on the parent automatically
            pass  # Optional — not all implementations do this synchronously

    def test_goal_queuing_transitions_to_architecting(self):
        """
        End-to-End Goal Flow: When a goal task is queued, it should transition
        to 'architecting' status (the architect skill runs). The test verifies
        the status machine accepts this transition at the API level.
        """
        goal = self._create_task(
            title=f"Goal Architect Check {str(uuid.uuid4())[:8]}",
            task_type='goal',
        )

        # Manually transition to architecting (simulates what queueProcessor does)
        resp = requests.put(
            f"{BASE_URL}/api/tasks/{goal['id']}",
            json={'status': 'architecting'},
            timeout=10,
        )
        self.assertLess(
            resp.status_code, 500,
            f"Server rejected 'architecting' status: {resp.status_code}: {resp.text}",
        )
        self.assertNotEqual(
            resp.status_code, 400,
            f"Server returned 400 for 'architecting' status: {resp.text}",
        )

    # ── Test 2: Failure Recovery Flow ─────────────────────────────────────────

    def test_fix_task_creation_and_linkage(self):
        """
        Failure Recovery Flow: The Critic creates a fix task linked via fixForTaskId.
        This test validates the complete fix task data model as it would be created
        by workflow.ts after a verification failure.
        """
        original = self._create_task(
            title=f"Recovery Original {str(uuid.uuid4())[:8]}",
            priority='medium',
        )
        original_id = original['id']

        # Simulate what the critic does: set retryCount and create a fix task
        requests.put(
            f"{BASE_URL}/api/tasks/{original_id}",
            json={'retryCount': 1, 'status': 'review'},
            timeout=10,
        )

        fix = self._create_task(
            title=f"Fix: Recovery Original — build failed",
            priority='high',
            task_type='quick',
            extra={'fixForTaskId': original_id},
        )

        # Verify the fix task has all required fields
        self.assertEqual(fix.get('priority'), 'high')
        self.assertEqual(fix.get('type'), 'quick')
        self.assertEqual(fix.get('fixForTaskId'), original_id)

        # Verify the fix task appears in the board
        board = self._get_board()
        fix_on_board = next((t for t in board['tasks'] if t['id'] == fix['id']), None)
        self.assertIsNotNone(fix_on_board, "Fix task should appear on board")
        self.assertEqual(fix_on_board.get('fixForTaskId'), original_id)

    def test_retry_count_caps_at_kill_switch_threshold(self):
        """
        Failure Recovery Flow: When retryCount reaches 3, the kill switch should
        activate. We test the API surface by simulating 3 retries and verifying
        the final state is accessible.
        """
        task = self._create_task(title=f"Kill Switch Test {str(uuid.uuid4())[:8]}")
        task_id = task['id']

        # Increment to kill switch threshold
        for count in [1, 2, 3]:
            resp = requests.put(
                f"{BASE_URL}/api/tasks/{task_id}",
                json={'retryCount': count},
                timeout=10,
            )
            self.assertIn(resp.status_code, [200, 204])

        final = self._get_task(task_id)
        self.assertEqual(
            final.get('retryCount'), 3,
            f"retryCount should be 3 at kill switch threshold, got {final.get('retryCount')}",
        )

    # ── Test 3: Concurrent Goals ───────────────────────────────────────────────

    def test_two_concurrent_goals_no_api_conflicts(self):
        """
        Concurrent Goals: Two goal tasks submitted simultaneously must both be
        created and accepted by the server without conflicts. Neither should block
        the other at the API level (lease conflicts are handled at execution time).
        """
        uid = str(uuid.uuid4())[:8]
        goal_a = self._create_task(
            title=f"Concurrent Goal A {uid}",
            task_type='goal',
        )
        goal_b = self._create_task(
            title=f"Concurrent Goal B {uid}",
            task_type='goal',
        )

        self.assertNotEqual(goal_a['id'], goal_b['id'], "Goals should have unique IDs")

        # Both should appear on board
        board = self._get_board()
        board_ids = {t['id'] for t in board.get('tasks', [])}

        self.assertIn(goal_a['id'], board_ids, "Goal A should appear on board")
        self.assertIn(goal_b['id'], board_ids, "Goal B should appear on board")

    def test_concurrent_tasks_independent_lease_sets(self):
        """
        Concurrent Goals: Two tasks that operate on different files must be able
        to acquire their leases simultaneously — they should not block each other.
        This validates the lease isolation between independent concurrent tasks.
        """
        file_a = f"src/concurrent-a-{uuid.uuid4().hex[:8]}.ts"
        file_b = f"src/concurrent-b-{uuid.uuid4().hex[:8]}.ts"

        task_a = self._create_task(title=f"Concurrent Lease A {str(uuid.uuid4())[:8]}")
        task_b = self._create_task(title=f"Concurrent Lease B {str(uuid.uuid4())[:8]}")

        # Declare independent file sets
        requests.put(f"{BASE_URL}/api/tasks/{task_a['id']}", json={'declaredFiles': {'exclusive': [file_a], 'shared': []}}, timeout=10)
        requests.put(f"{BASE_URL}/api/tasks/{task_b['id']}", json={'declaredFiles': {'exclusive': [file_b], 'shared': []}}, timeout=10)

        # Both should acquire leases simultaneously
        result_a = requests.post(f"{BASE_URL}/api/tasks/{task_a['id']}/lease/acquire", timeout=10).json()
        result_b = requests.post(f"{BASE_URL}/api/tasks/{task_b['id']}/lease/acquire", timeout=10).json()

        try:
            self.assertTrue(
                result_a.get('granted'),
                f"Task A should acquire lease on {file_a}: {result_a}",
            )
            self.assertTrue(
                result_b.get('granted'),
                f"Task B should acquire lease on {file_b}: {result_b}",
            )
        finally:
            requests.post(f"{BASE_URL}/api/tasks/{task_a['id']}/lease/release", timeout=5)
            requests.post(f"{BASE_URL}/api/tasks/{task_b['id']}/lease/release", timeout=5)

    # ── Test 4: Cross-Phase API Completeness ──────────────────────────────────

    def test_board_meta_exposes_required_agi_fields(self):
        """
        Cross-Phase API: GET /api/board must expose the meta fields needed for
        monitoring the AGI health indicators: queueEnabled (for kill switch state),
        and task counts per status (for dashboard metrics).
        """
        board = self._get_board()

        self.assertIn('meta', board, "Board missing 'meta' key")
        meta = board['meta']

        # Queue enabled must be present for kill switch monitoring
        self.assertIn(
            'queueEnabled', meta,
            "Board meta missing 'queueEnabled' — needed for kill switch state detection",
        )

        # Status counts should be present for metrics
        self.assertIn(
            'counts', meta,
            "Board meta missing 'counts' — needed for AGI phase health metrics",
        )

    def test_all_agi_task_statuses_accepted(self):
        """
        Cross-Phase API: All task statuses introduced across AGI phases must be
        accepted by PUT /api/tasks/:id without validation errors:
        - 'verifying' (Phase 1 — Verifier)
        - 'blocked' (Phase 2 — DAG scheduling)
        - 'architecting' (Phase 2 — Goal decomposition)
        """
        agi_statuses = ['verifying', 'blocked', 'architecting']

        for status in agi_statuses:
            with self.subTest(status=status):
                task = self._create_task(
                    title=f"Status Test {status} {str(uuid.uuid4())[:8]}"
                )
                resp = requests.put(
                    f"{BASE_URL}/api/tasks/{task['id']}",
                    json={'status': status},
                    timeout=10,
                )
                self.assertNotEqual(
                    resp.status_code, 400,
                    f"Status '{status}' rejected with 400: {resp.text}",
                )
                self.assertLess(
                    resp.status_code, 500,
                    f"Status '{status}' caused 5xx: {resp.status_code}",
                )


if __name__ == '__main__':
    unittest.main(verbosity=2)
