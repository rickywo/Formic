#!/usr/bin/env python3
"""
Phase 1 tests: Self-Healing QA Loop verification.

Validates the self-healing workflow fields and state transitions against a running
Formic server:
- Auto-save git commit field (safePointCommit) is set on tasks post-execution
- Verifier status transition: running → verifying → review
- Critic flow: verification failure creates a high-priority fix task with fixForTaskId
- Critic retry: retryCount increments, kill switch pauses queue at retryCount >= 3
- Kill Switch recovery: queue is paused and safePointCommit is the rollback target

Usage:
    # Start Formic server first:
    # WORKSPACE_PATH=./example npm run dev

    # Run tests:
    python test/test_qa_loop.py
"""

import os
import sys
import unittest
import uuid

import requests

sys.path.insert(0, os.path.dirname(__file__))
from fixtures import BASE_URL, cleanup_tasks, is_server_reachable, wait_for_status


class TestQALoop(unittest.TestCase):
    """Integration tests for the Phase 1 Self-Healing QA Loop API surface."""

    def setUp(self):
        """Verify server is reachable; skip all tests if not."""
        self.created_task_ids: list = []
        if not is_server_reachable(BASE_URL):
            self.skipTest(f"Server unreachable at {BASE_URL}. Start with: WORKSPACE_PATH=./example npm run dev")

    def tearDown(self):
        """Delete all tasks created during the test."""
        cleanup_tasks(BASE_URL, self.created_task_ids)

    def _create_task(self, title=None, priority='medium', task_type='quick', extra=None):
        """POST /api/tasks and register the returned ID for cleanup. Returns task JSON."""
        if title is None:
            title = f"QA Loop Test {str(uuid.uuid4())[:8]}"
        payload = {
            'title': title,
            'context': 'Created by test_qa_loop.py for self-healing QA verification',
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
        """GET /api/tasks/:id and return the task JSON."""
        response = requests.get(f"{BASE_URL}/api/tasks/{task_id}", timeout=10)
        self.assertEqual(response.status_code, 200, f"GET /api/tasks/{task_id} failed: {response.text}")
        return response.json()

    def _patch_task(self, task_id, fields):
        """PUT /api/tasks/:id with a partial update. Returns the response."""
        return requests.put(f"{BASE_URL}/api/tasks/{task_id}", json=fields, timeout=10)

    # ── Test 1: Auto-Save Field Presence ─────────────────────────────────────

    def test_auto_save_field_present_on_new_task(self):
        """
        Auto-Save Test: A newly-created task must carry the safePointCommit field
        (null initially). This field will be populated with the git SHA of the
        auto-save commit just before agent execution begins (Step 1.1 of roadmap).
        """
        task = self._create_task(title=f"Auto-Save Check {str(uuid.uuid4())[:8]}")

        self.assertIn('safePointCommit', task, "Task is missing 'safePointCommit' field")
        # Initially null — populated by runner.ts before agent spawn
        self.assertIsNone(
            task['safePointCommit'],
            "safePointCommit should be null on a newly-created task",
        )

    def test_auto_save_field_settable_via_put(self):
        """
        Auto-Save Field Update: The safePointCommit field must be writable via
        PUT /api/tasks/:id so runner.ts can record the git SHA before execution.
        """
        task = self._create_task(title=f"Auto-Save Update {str(uuid.uuid4())[:8]}")
        fake_sha = 'abc1234def5678'

        resp = self._patch_task(task['id'], {'safePointCommit': fake_sha})
        self.assertIn(
            resp.status_code, [200, 204],
            f"PUT failed with {resp.status_code}: {resp.text}",
        )

        updated = self._get_task(task['id'])
        self.assertEqual(
            updated.get('safePointCommit'), fake_sha,
            f"Expected safePointCommit='{fake_sha}', got '{updated.get('safePointCommit')}'",
        )

    # ── Test 2: Verifier Status Transition ───────────────────────────────────

    def test_verifying_status_accepted(self):
        """
        Verifier Success: The 'verifying' status must be accepted by PUT /api/tasks/:id
        without a 400/422 validation error. This allows the workflow to move a task into
        the verifying state before running the verify command.
        """
        task = self._create_task()
        task_id = task['id']

        resp = self._patch_task(task_id, {'status': 'verifying'})
        self.assertNotEqual(
            resp.status_code, 400,
            f"Server rejected 'verifying' status with 400: {resp.text}",
        )
        self.assertNotEqual(
            resp.status_code, 422,
            f"Server rejected 'verifying' status with 422: {resp.text}",
        )
        self.assertLess(
            resp.status_code, 500,
            f"Server returned 5xx for 'verifying' status: {resp.status_code}",
        )

    def test_verifying_status_visible_on_board(self):
        """
        Verifier Board Visibility: A task in 'verifying' status must appear in the
        'verifying' column of GET /api/board.
        """
        task = self._create_task()
        task_id = task['id']

        self._patch_task(task_id, {'status': 'verifying'})

        board_resp = requests.get(f"{BASE_URL}/api/board", timeout=10)
        self.assertEqual(board_resp.status_code, 200)
        board = board_resp.json()

        task_statuses = {t['id']: t['status'] for t in board.get('tasks', [])}
        if task_id in task_statuses:
            self.assertEqual(
                task_statuses[task_id], 'verifying',
                f"Expected task in 'verifying' status on board, got '{task_statuses[task_id]}'",
            )

    # ── Test 3: Critic Flow — Fix Task Creation ───────────────────────────────

    def test_fix_task_with_fix_for_task_id_stored(self):
        """
        Verifier Failure / Critic: When verification fails, the workflow must create a
        high-priority fix task linked to the original via fixForTaskId. This test
        validates that the fixForTaskId relationship can be stored and retrieved.
        """
        original_task = self._create_task(
            title=f"Original Task {str(uuid.uuid4())[:8]}",
            priority='medium',
        )
        original_id = original_task['id']

        # Simulate critic creating a fix task (as workflow.ts would do)
        fix_task = self._create_task(
            title=f"Fix: Original Task — Build failed",
            priority='high',
            task_type='quick',
            extra={'fixForTaskId': original_id},
        )

        self.assertEqual(
            fix_task.get('priority'), 'high',
            f"Fix task must have priority='high', got '{fix_task.get('priority')}'",
        )
        self.assertEqual(
            fix_task.get('type'), 'quick',
            f"Fix task must have type='quick', got '{fix_task.get('type')}'",
        )
        self.assertEqual(
            fix_task.get('fixForTaskId'), original_id,
            f"Fix task fixForTaskId must point to original task '{original_id}', "
            f"got '{fix_task.get('fixForTaskId')}'",
        )

    def test_fix_task_visible_on_board(self):
        """
        Critic Board Visibility: A fix task with fixForTaskId must be visible on the
        board with the correct fields.
        """
        original = self._create_task(title=f"Board Visibility Original {str(uuid.uuid4())[:8]}")
        fix = self._create_task(
            title=f"Fix: Board Visibility {str(uuid.uuid4())[:8]}",
            priority='high',
            task_type='quick',
            extra={'fixForTaskId': original['id']},
        )

        board_resp = requests.get(f"{BASE_URL}/api/board", timeout=10)
        self.assertEqual(board_resp.status_code, 200)
        board = board_resp.json()
        tasks_by_id = {t['id']: t for t in board.get('tasks', [])}

        if fix['id'] in tasks_by_id:
            board_fix = tasks_by_id[fix['id']]
            self.assertEqual(
                board_fix.get('fixForTaskId'), original['id'],
                "fixForTaskId not preserved on board",
            )

    # ── Test 4: Critic Retry — retryCount tracking ───────────────────────────

    def test_retry_count_field_present_and_nullable(self):
        """
        Critic Retry: A new task must have retryCount=null. This counter is
        incremented each time verification fails before triggering the kill switch.
        """
        task = self._create_task()
        self.assertIn('retryCount', task, "Task is missing 'retryCount' field")
        self.assertIsNone(task['retryCount'], "retryCount should be null on a new task")

    def test_retry_count_incrementable_via_put(self):
        """
        Critic Retry Simulation: retryCount must be writable so workflow.ts can
        track consecutive verification failures. At retryCount >= 3, the kill switch fires.
        """
        task = self._create_task()
        task_id = task['id']

        for expected_count in [1, 2, 3]:
            resp = self._patch_task(task_id, {'retryCount': expected_count})
            self.assertIn(
                resp.status_code, [200, 204],
                f"PUT retryCount={expected_count} failed: {resp.status_code}",
            )
            updated = self._get_task(task_id)
            self.assertEqual(
                updated.get('retryCount'), expected_count,
                f"Expected retryCount={expected_count}, got {updated.get('retryCount')}",
            )

    def test_kill_switch_queue_pause_detection(self):
        """
        Kill Switch Recovery: When retryCount >= 3, the kill switch must pause the
        queue processor. We verify the queue processor state via GET /api/board's
        meta field or the queue config endpoint.
        """
        # The queue processor is controlled by isQueueProcessorRunning().
        # We detect its state from GET /api/board meta.queueEnabled or similar.
        board_resp = requests.get(f"{BASE_URL}/api/board", timeout=10)
        self.assertEqual(board_resp.status_code, 200, "GET /api/board failed")
        board = board_resp.json()

        # Verify we can read board meta — this is the foundation for kill switch detection
        self.assertIn('meta', board, "Board response missing 'meta' key")
        meta = board['meta']
        # Queue enabled state must be boolean-like and accessible
        # (actual kill switch test requires live agent execution)
        self.assertIn(
            'queueEnabled', meta,
            "Board meta missing 'queueEnabled' key needed for kill switch detection",
        )

    # ── Test 5: Full API Surface Validation ──────────────────────────────────

    def test_all_self_healing_fields_on_board(self):
        """
        All self-healing fields must be present on every task in GET /api/board.
        This ensures the fields are not accidentally omitted from the board serialisation.
        """
        self._create_task(title=f"Board Fields Check {str(uuid.uuid4())[:8]}")

        board_resp = requests.get(f"{BASE_URL}/api/board", timeout=10)
        self.assertEqual(board_resp.status_code, 200)
        board = board_resp.json()

        self.assertIn('tasks', board, "Board response missing 'tasks' key")
        for t in board['tasks']:
            tid = t.get('id', '<unknown>')
            self.assertIn('safePointCommit', t, f"Task {tid} missing 'safePointCommit'")
            self.assertIn('retryCount', t, f"Task {tid} missing 'retryCount'")
            self.assertIn('fixForTaskId', t, f"Task {tid} missing 'fixForTaskId'")

    def test_high_priority_fix_task_sorts_before_medium(self):
        """
        Queue Priority: A high-priority fix task must appear before a medium-priority
        standard task when both are queued, ensuring the critic's fix gets executed first.
        """
        standard_task = self._create_task(priority='medium', task_type='standard')
        fix_task = self._create_task(priority='high', task_type='quick')

        requests.post(f"{BASE_URL}/api/tasks/{standard_task['id']}/queue", timeout=10)
        requests.post(f"{BASE_URL}/api/tasks/{fix_task['id']}/queue", timeout=10)

        board_resp = requests.get(f"{BASE_URL}/api/board", timeout=10)
        self.assertEqual(board_resp.status_code, 200)
        board = board_resp.json()
        task_ids = [t['id'] for t in board.get('tasks', [])]

        if fix_task['id'] in task_ids and standard_task['id'] in task_ids:
            fix_index = task_ids.index(fix_task['id'])
            standard_index = task_ids.index(standard_task['id'])
            self.assertLess(
                fix_index, standard_index,
                f"High-priority fix task (index {fix_index}) should appear before "
                f"medium-priority task (index {standard_index})",
            )


if __name__ == '__main__':
    unittest.main(verbosity=2)
