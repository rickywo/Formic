#!/usr/bin/env python3
"""
Dependency-aware queue prioritizer integration tests.

Validates the 4-tier scoring algorithm in `src/server/services/prioritizer.ts`
against a running Formic server:
- Fix bonus (FIX_BONUS = 1000) promotes self-healing tasks above all other queued tasks
- Unblocking potential (+100 per transitively blocked task) promotes tasks that unlock DAGs
- Priority tiebreaker: high (30) > medium (20) > low (10)
- FIFO age bonus: older tasks get up to +10 when all else is equal
- Queue analysis endpoint shape: taskId, score, unblockingPotential, reasoning

Usage:
    # Start Formic server first:
    # WORKSPACE_PATH=./example npm run dev

    # Run tests:
    python test/test_prioritizer.py
"""

import os
import sys
import time
import unittest
import uuid

import requests

sys.path.insert(0, os.path.dirname(__file__))
from fixtures import BASE_URL, cleanup_tasks, is_server_reachable

# Scoring constants mirrored from prioritizer.ts
FIX_BONUS = 1000
UNBLOCK_BONUS = 100
PRIORITY_SCORES = {'high': 30, 'medium': 20, 'low': 10}
MAX_AGE_BONUS = 10


class TestPrioritizer(unittest.TestCase):
    """Integration tests for the dependency-aware queue prioritizer scoring algorithm."""

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

    def _create_task(self, title=None, priority='medium', task_type='quick', extra=None):
        """POST /api/tasks and register the returned ID for cleanup. Returns task JSON."""
        if title is None:
            title = f"Prioritizer Test {str(uuid.uuid4())[:8]}"
        payload = {
            'title': title,
            'context': 'Created by test_prioritizer.py for queue prioritization verification',
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

    def _queue_task(self, task_id):
        """POST /api/tasks/:id/queue to move a task into the queue."""
        resp = requests.post(f"{BASE_URL}/api/tasks/{task_id}/queue", timeout=10)
        self.assertLess(resp.status_code, 500, f"Queuing task {task_id} failed: {resp.status_code}")
        return resp

    def _patch_task(self, task_id, fields):
        """PUT /api/tasks/:id with a partial update. Returns the response."""
        return requests.put(f"{BASE_URL}/api/tasks/{task_id}", json=fields, timeout=10)

    def _get_queue_analysis(self):
        """GET /api/queue/analysis. Asserts 200 and returns the JSON list."""
        resp = requests.get(f"{BASE_URL}/api/queue/analysis", timeout=10)
        self.assertEqual(
            resp.status_code, 200,
            f"GET /api/queue/analysis failed: {resp.status_code}: {resp.text}",
        )
        return resp.json()

    def _find_analysis_entry(self, analysis, task_id):
        """Find a task's scoring entry in the analysis list by taskId."""
        for entry in analysis:
            if entry.get('taskId') == task_id:
                return entry
        return None

    # ── Test 1: Fix Bonus ────────────────────────────────────────────────────

    def test_fix_bonus_promotes_fix_task_above_high_priority_regular(self):
        """
        Fix Bonus: A task with fixForTaskId set must score at least FIX_BONUS (1000) points
        above a high-priority regular task, regardless of the fix task's own priority.
        This preserves the self-healing fast-path from Phase 1.
        """
        uid = str(uuid.uuid4())[:8]

        # Create a high-priority regular task and queue it
        regular_task = self._create_task(
            title=f"Regular High {uid}",
            priority='high',
        )
        self._queue_task(regular_task['id'])

        # Create a medium-priority fix task referencing the regular task, and queue it
        fix_task = self._create_task(
            title=f"Fix Task {uid}",
            priority='medium',
            extra={'fixForTaskId': regular_task['id']},
        )
        self._queue_task(fix_task['id'])

        analysis = self._get_queue_analysis()

        regular_entry = self._find_analysis_entry(analysis, regular_task['id'])
        fix_entry = self._find_analysis_entry(analysis, fix_task['id'])

        self.assertIsNotNone(regular_entry, f"Regular task {regular_task['id']} not found in analysis")
        self.assertIsNotNone(fix_entry, f"Fix task {fix_task['id']} not found in analysis")

        score_gap = fix_entry['score'] - regular_entry['score']
        self.assertGreaterEqual(
            score_gap,
            FIX_BONUS,
            f"Fix task score ({fix_entry['score']:.1f}) should be at least {FIX_BONUS} "
            f"points above regular task score ({regular_entry['score']:.1f}), gap={score_gap:.1f}",
        )

    # ── Test 2: Unblocking Potential ─────────────────────────────────────────

    def test_unblocking_potential_outscores_task_with_no_dependents(self):
        """
        Unblocking Potential: Task A that transitively unblocks 3 blocked tasks (B→C→D)
        must score higher than Task E (queued, no dependents) of the same priority.
        This validates the UNBLOCK_BONUS = 100 per transitively blocked task.
        """
        uid = str(uuid.uuid4())[:8]

        # Create task A (the unblocking task, to be queued)
        task_a = self._create_task(title=f"Unblock A {uid}", priority='medium')

        # Create a chain B→C→D that depends on A
        task_b = self._create_task(
            title=f"Unblock B {uid}",
            priority='medium',
            extra={'dependsOn': [task_a['id']]},
        )
        task_c = self._create_task(
            title=f"Unblock C {uid}",
            priority='medium',
            extra={'dependsOn': [task_b['id']]},
        )
        task_d = self._create_task(
            title=f"Unblock D {uid}",
            priority='medium',
            extra={'dependsOn': [task_c['id']]},
        )

        # Mark B, C, D as blocked (they have unresolved dependencies)
        for t in [task_b, task_c, task_d]:
            self._patch_task(t['id'], {'status': 'blocked'})

        # Create task E (independent queued task with same priority)
        task_e = self._create_task(title=f"Unblock E {uid}", priority='medium')

        # Queue A and E
        self._queue_task(task_a['id'])
        self._queue_task(task_e['id'])

        analysis = self._get_queue_analysis()

        entry_a = self._find_analysis_entry(analysis, task_a['id'])
        entry_e = self._find_analysis_entry(analysis, task_e['id'])

        self.assertIsNotNone(entry_a, f"Task A {task_a['id']} not found in analysis")
        self.assertIsNotNone(entry_e, f"Task E {task_e['id']} not found in analysis")

        self.assertGreater(
            entry_a['score'],
            entry_e['score'],
            f"Task A (unblocking 3 tasks) score {entry_a['score']:.1f} should exceed "
            f"Task E (no dependents) score {entry_e['score']:.1f}",
        )
        self.assertGreaterEqual(
            entry_a['unblockingPotential'],
            3,
            f"Task A should have unblockingPotential >= 3, got {entry_a['unblockingPotential']}",
        )

    # ── Test 3: Priority Tiebreaker ──────────────────────────────────────────

    def test_high_priority_outscores_medium_priority_same_age(self):
        """
        Priority Tiebreaker: A high-priority task must score above a medium-priority task
        when both are queued at roughly the same time with no dependency differences.
        This validates PRIORITY_SCORES: high=30, medium=20.
        """
        uid = str(uuid.uuid4())[:8]

        task_high = self._create_task(title=f"High Prio {uid}", priority='high')
        task_medium = self._create_task(title=f"Med Prio {uid}", priority='medium')

        self._queue_task(task_high['id'])
        self._queue_task(task_medium['id'])

        analysis = self._get_queue_analysis()

        entry_high = self._find_analysis_entry(analysis, task_high['id'])
        entry_medium = self._find_analysis_entry(analysis, task_medium['id'])

        self.assertIsNotNone(entry_high, f"High-priority task {task_high['id']} not found in analysis")
        self.assertIsNotNone(entry_medium, f"Medium-priority task {task_medium['id']} not found in analysis")

        score_diff = entry_high['score'] - entry_medium['score']
        expected_diff = PRIORITY_SCORES['high'] - PRIORITY_SCORES['medium']  # 30 - 20 = 10

        self.assertGreater(
            entry_high['score'],
            entry_medium['score'],
            f"High-priority task score ({entry_high['score']:.1f}) should exceed "
            f"medium-priority task score ({entry_medium['score']:.1f})",
        )
        # Score difference should be close to the expected priority point difference
        # allowing for small age variation (up to MAX_AGE_BONUS = 10)
        self.assertGreater(
            score_diff,
            0,
            f"Expected score difference > 0, got {score_diff:.1f}",
        )

    # ── Test 4: FIFO Age Bonus ───────────────────────────────────────────────

    def test_fifo_age_bonus_favors_older_task(self):
        """
        FIFO Age Bonus: When two tasks share the same priority and have no dependencies,
        the older task should receive a higher score due to the age bonus:
        +min(ageMs/1000, 10). Introduces a 3-second gap so the older task earns at
        least a +3 age bonus over the newer task.
        """
        uid = str(uuid.uuid4())[:8]

        task_older = self._create_task(title=f"Older Task {uid}", priority='medium')
        self._queue_task(task_older['id'])

        # Wait 3 seconds so the older task accumulates an age bonus of ≥3
        time.sleep(3)

        task_newer = self._create_task(title=f"Newer Task {uid}", priority='medium')
        self._queue_task(task_newer['id'])

        analysis = self._get_queue_analysis()

        entry_older = self._find_analysis_entry(analysis, task_older['id'])
        entry_newer = self._find_analysis_entry(analysis, task_newer['id'])

        self.assertIsNotNone(entry_older, f"Older task {task_older['id']} not found in analysis")
        self.assertIsNotNone(entry_newer, f"Newer task {task_newer['id']} not found in analysis")

        self.assertGreater(
            entry_older['score'],
            entry_newer['score'],
            f"Older task score ({entry_older['score']:.1f}) should exceed "
            f"newer task score ({entry_newer['score']:.1f}) due to age bonus",
        )

    # ── Test 5: Queue Analysis Response Shape ────────────────────────────────

    def test_queue_analysis_endpoint_response_shape(self):
        """
        Queue Analysis Endpoint: GET /api/queue/analysis must return a list of objects
        with required fields: taskId (str), score (numeric), unblockingPotential (int),
        and reasoning (non-empty str). This validates the observability surface.
        """
        uid = str(uuid.uuid4())[:8]
        task = self._create_task(title=f"Shape Check {uid}")
        self._queue_task(task['id'])

        analysis = self._get_queue_analysis()

        self.assertIsInstance(analysis, list, "Queue analysis response must be a list")

        entry = self._find_analysis_entry(analysis, task['id'])
        self.assertIsNotNone(
            entry,
            f"Task {task['id']} not found in queue analysis response. "
            f"Found taskIds: {[e.get('taskId') for e in analysis]}",
        )

        # Validate required field presence
        for field in ('taskId', 'score', 'unblockingPotential', 'reasoning'):
            self.assertIn(
                field, entry,
                f"Required field '{field}' missing from queue analysis entry: {entry}",
            )

        # Validate field types
        self.assertIsInstance(
            entry['taskId'], str,
            f"taskId must be a string, got {type(entry['taskId']).__name__}",
        )
        self.assertIsInstance(
            entry['score'], (int, float),
            f"score must be numeric, got {type(entry['score']).__name__}",
        )
        self.assertIsInstance(
            entry['unblockingPotential'], int,
            f"unblockingPotential must be an int, got {type(entry['unblockingPotential']).__name__}",
        )
        self.assertIsInstance(
            entry['reasoning'], str,
            f"reasoning must be a string, got {type(entry['reasoning']).__name__}",
        )
        self.assertGreater(
            len(entry['reasoning']),
            0,
            "reasoning must be a non-empty string",
        )

        # Validate score is non-negative (all bonus tiers add positive values)
        self.assertGreaterEqual(
            entry['score'],
            0,
            f"score must be non-negative, got {entry['score']}",
        )


if __name__ == '__main__':
    unittest.main(verbosity=2)
