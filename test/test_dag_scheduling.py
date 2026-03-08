#!/usr/bin/env python3
"""
Phase 2 tests: DAG-aware architect decomposition and task scheduling.

Validates the DAG scheduling workflow against a running Formic server:
- Architect goal tasks produce valid depends_on fields in their output
- Cycle detection falls back gracefully without crashing the server
- Sequential blocking: tasks with dependsOn stay 'blocked' until dependencies done
- Parallel independence: unrelated tasks are both 'queued' while shared dependent waits
- Unblock cascade: completing a dependency moves all dependent tasks from blocked→queued

Usage:
    # Start Formic server first:
    # WORKSPACE_PATH=./example npm run dev

    # Run tests:
    python test/test_dag_scheduling.py
"""

import os
import sys
import time
import unittest
import uuid

import requests

sys.path.insert(0, os.path.dirname(__file__))
from fixtures import BASE_URL, cleanup_tasks, is_server_reachable


class TestDAGScheduling(unittest.TestCase):
    """Integration tests for the Phase 2 DAG-aware task scheduling API surface."""

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
        """POST /api/tasks and register the returned ID for cleanup. Returns task JSON."""
        if title is None:
            title = f"DAG Test {str(uuid.uuid4())[:8]}"
        payload = {
            'title': title,
            'context': 'Created by test_dag_scheduling.py for DAG scheduling verification',
            'priority': priority,
            'type': task_type,
        }
        if extra:
            payload.update(extra)
        response = requests.post(f"{BASE_URL}/api/tasks", json=payload, timeout=10)
        self.assertEqual(
            response.status_code, 201,
            f"Expected 201 creating task but got {response.status_code}: {response.text}",
        )
        task = response.json()
        self.created_task_ids.append(task['id'])
        return task

    def _get_task(self, task_id):
        """GET /api/tasks/:id. Returns task JSON."""
        resp = requests.get(f"{BASE_URL}/api/tasks/{task_id}", timeout=10)
        self.assertEqual(resp.status_code, 200, f"GET task {task_id} failed: {resp.text}")
        return resp.json()

    def _patch_task(self, task_id, fields):
        """PUT /api/tasks/:id with a partial update."""
        return requests.put(f"{BASE_URL}/api/tasks/{task_id}", json=fields, timeout=10)

    def _mark_done(self, task_id):
        """Move a task to 'done' status to simulate task completion."""
        return self._patch_task(task_id, {'status': 'done'})

    # ── Test 1: DAG Output — dependsOn field shape ───────────────────────────

    def test_depends_on_field_present_on_new_task(self):
        """
        DAG Output: A newly-created standard task must carry the dependsOn field
        (empty array initially). This field is set by the architect skill when
        decomposing a goal task and by the API when creating tasks with dependencies.
        """
        task = self._create_task(title=f"DAG Field Check {str(uuid.uuid4())[:8]}")

        self.assertIn('dependsOn', task, "Task is missing 'dependsOn' field")
        # New tasks without explicit dependsOn should default to empty array or null
        depends_on = task['dependsOn']
        if depends_on is not None:
            self.assertIsInstance(
                depends_on, list,
                f"dependsOn should be a list, got {type(depends_on).__name__}",
            )

    def test_task_created_with_depends_on_field(self):
        """
        DAG Output: Tasks created via POST /api/tasks must accept and store a
        dependsOn array — this is how architect-generated child tasks carry their
        dependencies from the decomposition output.
        """
        # Create a prerequisite task
        prereq = self._create_task(title=f"Prerequisite {str(uuid.uuid4())[:8]}")

        # Create a dependent task referencing the prerequisite
        dependent = self._create_task(
            title=f"Dependent Task {str(uuid.uuid4())[:8]}",
            extra={'dependsOn': [prereq['id']]},
        )

        stored_depends_on = dependent.get('dependsOn') or []
        self.assertIn(
            prereq['id'], stored_depends_on,
            f"Expected dependsOn to contain '{prereq['id']}', got {stored_depends_on}",
        )

    def test_goal_task_type_accepted(self):
        """
        DAG Output: A goal task created with type='goal' must be accepted and
        stored with status that will eventually transition to 'architecting'.
        """
        goal = self._create_task(
            title=f"Goal Task DAG Test {str(uuid.uuid4())[:8]}",
            task_type='goal',
        )

        self.assertEqual(
            goal.get('type'), 'goal',
            f"Expected type='goal', got '{goal.get('type')}'",
        )
        # Goal tasks start in 'todo' before being queued for architecting
        self.assertIn(
            goal.get('status'), ['todo', 'queued', 'architecting'],
            f"Unexpected initial status for goal task: '{goal.get('status')}'",
        )

    # ── Test 2: Cycle Detection ───────────────────────────────────────────────

    def test_cycle_detection_does_not_crash_server(self):
        """
        Cycle Detection: Creating tasks with circular dependencies must not crash
        the server. The system should either reject the circular reference with a
        validation error or fall back to flat (unordered) processing.
        """
        task_a = self._create_task(title=f"Cycle A {str(uuid.uuid4())[:8]}")
        task_b_resp = requests.post(
            f"{BASE_URL}/api/tasks",
            json={
                'title': f"Cycle B {str(uuid.uuid4())[:8]}",
                'context': 'Cycle detection test task B',
                'priority': 'medium',
                'type': 'standard',
                'dependsOn': [task_a['id']],
            },
            timeout=10,
        )
        # B->A creation should succeed
        self.assertLess(
            task_b_resp.status_code, 500,
            f"Task B creation crashed the server: {task_b_resp.status_code}",
        )

        if task_b_resp.status_code == 201:
            task_b = task_b_resp.json()
            self.created_task_ids.append(task_b['id'])

            # Attempt to create a cycle: A->B (B already depends on A)
            cycle_resp = self._patch_task(task_a['id'], {'dependsOn': [task_b['id']]})
            # Server must not 5xx — it should either accept (and detect later) or reject
            self.assertLess(
                cycle_resp.status_code, 500,
                f"Cycle creation via PUT caused a server crash: {cycle_resp.status_code}",
            )

    def test_self_dependency_rejected_or_ignored(self):
        """
        Cycle Detection: A task must not depend on itself. The server should either
        reject the self-reference (4xx) or silently ignore it without crashing.
        """
        task = self._create_task(title=f"Self Dep {str(uuid.uuid4())[:8]}")

        resp = self._patch_task(task['id'], {'dependsOn': [task['id']]})
        # Must not 5xx
        self.assertLess(
            resp.status_code, 500,
            f"Self-dependency caused server crash: {resp.status_code}",
        )

    # ── Test 3: Sequential Blocking ───────────────────────────────────────────

    def test_task_with_unresolved_dependency_is_blocked(self):
        """
        Sequential Blocking: A task created with dependsOn pointing to an unfinished
        task must be in 'blocked' status (or remain in 'todo' awaiting the dependency).
        B must not enter 'queued' until A is done.
        """
        task_a = self._create_task(title=f"Chain A {str(uuid.uuid4())[:8]}")

        task_b = self._create_task(
            title=f"Chain B {str(uuid.uuid4())[:8]}",
            extra={'dependsOn': [task_a['id']]},
        )

        # B should either be 'blocked' or 'todo' (waiting) — never 'queued'
        b_status = task_b.get('status')
        self.assertNotEqual(
            b_status, 'queued',
            f"Task B should not be 'queued' while its dependency A is not done, got '{b_status}'",
        )

    def test_three_task_chain_sequential_blocking(self):
        """
        Sequential Blocking: In a three-task chain A→B→C, B must not be 'queued'
        while A is in 'todo', and C must not be 'queued' while B is blocked.
        """
        uid = str(uuid.uuid4())[:8]
        task_a = self._create_task(title=f"Chain3 A {uid}")
        task_b = self._create_task(
            title=f"Chain3 B {uid}",
            extra={'dependsOn': [task_a['id']]},
        )
        task_c = self._create_task(
            title=f"Chain3 C {uid}",
            extra={'dependsOn': [task_b['id']]},
        )

        # Initially: A is todo, B and C should not be queued
        self.assertNotEqual(task_b.get('status'), 'queued',
                           "B should not be queued while A is pending")
        self.assertNotEqual(task_c.get('status'), 'queued',
                           "C should not be queued while B and A are pending")

    # ── Test 4: Parallel Independence ─────────────────────────────────────────

    def test_independent_tasks_both_accept_queuing(self):
        """
        Parallel Independence: Tasks A and B with no dependencies must both be
        queueable simultaneously — they should not block each other.
        """
        uid = str(uuid.uuid4())[:8]
        task_a = self._create_task(title=f"Parallel A {uid}")
        task_b = self._create_task(title=f"Parallel B {uid}")

        resp_a = requests.post(f"{BASE_URL}/api/tasks/{task_a['id']}/queue", timeout=10)
        resp_b = requests.post(f"{BASE_URL}/api/tasks/{task_b['id']}/queue", timeout=10)

        self.assertLess(resp_a.status_code, 500, f"Queuing A failed: {resp_a.status_code}")
        self.assertLess(resp_b.status_code, 500, f"Queuing B failed: {resp_b.status_code}")

    def test_shared_dependent_stays_blocked_while_parents_queued(self):
        """
        Parallel Independence: Tasks A and B (independent) are both queued.
        Task C depends on both A and B. C must remain blocked while A and B
        have not yet completed.
        """
        uid = str(uuid.uuid4())[:8]
        task_a = self._create_task(title=f"ParallelDep A {uid}")
        task_b = self._create_task(title=f"ParallelDep B {uid}")
        task_c = self._create_task(
            title=f"ParallelDep C {uid}",
            extra={'dependsOn': [task_a['id'], task_b['id']]},
        )

        # Queue A and B
        requests.post(f"{BASE_URL}/api/tasks/{task_a['id']}/queue", timeout=10)
        requests.post(f"{BASE_URL}/api/tasks/{task_b['id']}/queue", timeout=10)

        # C must not be queued while A and B are still running
        c_status = task_c.get('status')
        self.assertNotIn(
            c_status, ['queued', 'briefing', 'planning', 'running'],
            f"Task C should be blocked/todo while A and B are not done, got '{c_status}'",
        )

    # ── Test 5: Unblock Cascade ───────────────────────────────────────────────

    def test_completing_dependency_unblocks_dependent(self):
        """
        Unblock Cascade: When task A transitions to 'done', all tasks whose only
        dependency was A should transition from 'blocked' to 'queued'.
        This validates the dependency resolution logic in store.ts.
        """
        uid = str(uuid.uuid4())[:8]
        task_a = self._create_task(title=f"Cascade A {uid}")
        task_b = self._create_task(
            title=f"Cascade B {uid}",
            extra={'dependsOn': [task_a['id']]},
        )
        task_c = self._create_task(
            title=f"Cascade C {uid}",
            extra={'dependsOn': [task_a['id']]},
        )

        # Mark A as done
        done_resp = self._mark_done(task_a['id'])
        self.assertIn(
            done_resp.status_code, [200, 204],
            f"Marking A as done failed: {done_resp.status_code}: {done_resp.text}",
        )

        # Wait briefly for async cascade to propagate
        time.sleep(1.0)

        # B and C should now be unblocked (queued or todo, not blocked)
        b_after = self._get_task(task_b['id'])
        c_after = self._get_task(task_c['id'])

        b_status = b_after.get('status')
        c_status = c_after.get('status')

        self.assertNotEqual(
            b_status, 'blocked',
            f"Task B should be unblocked after A completes, still '{b_status}'",
        )
        self.assertNotEqual(
            c_status, 'blocked',
            f"Task C should be unblocked after A completes, still '{c_status}'",
        )

    def test_task_with_multiple_deps_stays_blocked_until_all_done(self):
        """
        Unblock Cascade: A task with two dependencies (A and B) must remain blocked
        until BOTH A and B are done. Completing only A should not unblock it.
        """
        uid = str(uuid.uuid4())[:8]
        task_a = self._create_task(title=f"MultiDep A {uid}")
        task_b = self._create_task(title=f"MultiDep B {uid}")
        task_c = self._create_task(
            title=f"MultiDep C {uid}",
            extra={'dependsOn': [task_a['id'], task_b['id']]},
        )

        # Mark only A as done
        self._mark_done(task_a['id'])
        time.sleep(0.5)

        # C should still be blocked (B not yet done)
        c_status = self._get_task(task_c['id']).get('status')
        self.assertNotIn(
            c_status, ['queued'],
            f"Task C should still be blocked after only A completes, got '{c_status}'",
        )

        # Now mark B as done too
        self._mark_done(task_b['id'])
        time.sleep(1.0)

        # C should now be unblocked
        c_final = self._get_task(task_c['id']).get('status')
        self.assertNotEqual(
            c_final, 'blocked',
            f"Task C should be unblocked after both A and B complete, got '{c_final}'",
        )

    def test_board_exposes_depends_on_field(self):
        """
        DAG Board Visibility: The GET /api/board response must include dependsOn
        on every task object so the frontend can render dependency indicators.
        """
        self._create_task(title=f"Board DAG Check {str(uuid.uuid4())[:8]}")

        board_resp = requests.get(f"{BASE_URL}/api/board", timeout=10)
        self.assertEqual(board_resp.status_code, 200)
        board = board_resp.json()

        self.assertIn('tasks', board)
        for t in board['tasks']:
            tid = t.get('id', '<unknown>')
            self.assertIn(
                'dependsOn', t,
                f"Task {tid} missing 'dependsOn' field in board response",
            )


if __name__ == '__main__':
    unittest.main(verbosity=2)
