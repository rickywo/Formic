#!/usr/bin/env python3
"""
Integration tests for the Phase 1 AGI Self-Healing QA loop.

Validates the self-healing fields and workflow against a running Formic server:
- safePointCommit, retryCount, fixForTaskId fields are present on new tasks (null)
- The 'verifying' TaskStatus is accepted by the PATCH/PUT update endpoint
- Fix tasks with priority/type combinations are stored and returned correctly
- GET /api/board exposes all three self-healing fields on every task object
- Queue priority ordering reflects task priority levels without 5xx errors

Usage:
    # Make sure Formic is running first:
    # WORKSPACE_PATH=./example npm run dev

    # Then run tests:
    python test/test_selfhealing.py
"""

import os
import unittest
import uuid

import requests

# Configuration
BASE_URL = os.environ.get('FORMIC_URL', 'http://localhost:3000')


class TestSelfHealingQALoop(unittest.TestCase):
    """Integration tests for the Phase 1 self-healing QA loop API surface."""

    def setUp(self):
        """Verify the server is reachable; skip all tests if it is not."""
        self.created_task_ids = []
        try:
            requests.get(f"{BASE_URL}/api/board", timeout=5)
        except requests.exceptions.ConnectionError:
            self.skipTest(f"Server unreachable at {BASE_URL}")

    def tearDown(self):
        """Delete all tasks created during the test, swallowing errors."""
        for task_id in self.created_task_ids:
            try:
                requests.delete(f"{BASE_URL}/api/tasks/{task_id}", timeout=5)
            except Exception:
                pass

    def _create_task(self, title=None, priority='medium', type_='standard', extra=None):
        """POST /api/tasks and register the returned ID for cleanup. Returns the task JSON."""
        if title is None:
            title = f"Self-Healing Test Task {str(uuid.uuid4())[:8]}"
        payload = {
            "title": title,
            "context": "Created by test_selfhealing.py for self-healing QA verification",
            "priority": priority,
            "type": type_,
        }
        if extra:
            payload.update(extra)
        response = requests.post(f"{BASE_URL}/api/tasks", json=payload, timeout=10)
        self.assertEqual(response.status_code, 201, f"Expected 201 but got {response.status_code}: {response.text}")
        task = response.json()
        self.created_task_ids.append(task['id'])
        return task

    def test_new_task_has_self_healing_fields_null(self):
        """New tasks must carry safePointCommit, retryCount, and fixForTaskId — all null."""
        task = self._create_task()

        self.assertIn('safePointCommit', task, "Task is missing 'safePointCommit' field")
        self.assertIn('retryCount', task, "Task is missing 'retryCount' field")
        self.assertIn('fixForTaskId', task, "Task is missing 'fixForTaskId' field")

        self.assertIsNone(task['safePointCommit'], "safePointCommit should be null on a new task")
        self.assertIsNone(task['retryCount'], "retryCount should be null on a new task")
        self.assertIsNone(task['fixForTaskId'], "fixForTaskId should be null on a new task")

    def test_verifying_status_accepted(self):
        """The 'verifying' status must be accepted by PUT /api/tasks/:id without a 400 response."""
        task = self._create_task()
        task_id = task['id']

        response = requests.put(
            f"{BASE_URL}/api/tasks/{task_id}",
            json={"status": "verifying"},
            timeout=10,
        )
        self.assertNotEqual(
            response.status_code,
            400,
            f"Server rejected 'verifying' status with 400: {response.text}",
        )

    def test_fix_task_priority_and_type_stored(self):
        """A task created with priority='high' and type='quick' must be returned with those values."""
        task = self._create_task(priority='high', type_='quick')

        self.assertEqual(task.get('priority'), 'high', f"Expected priority='high', got {task.get('priority')}")
        self.assertEqual(task.get('type'), 'quick', f"Expected type='quick', got {task.get('type')}")

    def test_board_exposes_self_healing_fields(self):
        """GET /api/board must include safePointCommit, retryCount, and fixForTaskId on every task."""
        # Ensure at least one task exists so the board is non-empty.
        self._create_task()

        response = requests.get(f"{BASE_URL}/api/board", timeout=10)
        self.assertEqual(response.status_code, 200, f"Expected 200 but got {response.status_code}")

        board = response.json()
        self.assertIn('tasks', board, "Board response missing 'tasks' key")

        for task in board['tasks']:
            task_id = task.get('id', '<unknown>')
            self.assertIn('safePointCommit', task, f"Task {task_id} missing 'safePointCommit'")
            self.assertIn('retryCount', task, f"Task {task_id} missing 'retryCount'")
            self.assertIn('fixForTaskId', task, f"Task {task_id} missing 'fixForTaskId'")

    def test_fix_task_queue_priority_ordering(self):
        """High-priority queued tasks must appear at a lower index than medium-priority ones."""
        # Create high-priority task (represents a fix task) and a medium-priority task.
        high_task = self._create_task(priority='high', type_='quick')
        medium_task = self._create_task(priority='medium', type_='standard')

        high_id = high_task['id']
        medium_id = medium_task['id']

        # Queue both tasks — POST /api/tasks/:id/queue
        queue_high = requests.post(f"{BASE_URL}/api/tasks/{high_id}/queue", timeout=10)
        queue_medium = requests.post(f"{BASE_URL}/api/tasks/{medium_id}/queue", timeout=10)

        self.assertLess(queue_high.status_code, 500, f"Queuing high-priority task returned 5xx: {queue_high.status_code}")
        self.assertLess(queue_medium.status_code, 500, f"Queuing medium-priority task returned 5xx: {queue_medium.status_code}")

        # Fetch board and find both tasks.
        board_resp = requests.get(f"{BASE_URL}/api/board", timeout=10)
        self.assertLess(board_resp.status_code, 500, f"GET /api/board returned 5xx: {board_resp.status_code}")

        board = board_resp.json()
        all_tasks = board.get('tasks', [])
        task_ids = [t['id'] for t in all_tasks]

        # Only assert ordering when both tasks are present and queued.
        if high_id in task_ids and medium_id in task_ids:
            high_index = task_ids.index(high_id)
            medium_index = task_ids.index(medium_id)
            # Note: when fixForTaskId is set, a medium-priority fix task would also sort
            # before regular queued tasks — this test validates the basic priority ordering.
            self.assertLess(
                high_index,
                medium_index,
                f"Expected high-priority task (index {high_index}) to appear before "
                f"medium-priority task (index {medium_index}) in the board task list",
            )


if __name__ == '__main__':
    unittest.main()
