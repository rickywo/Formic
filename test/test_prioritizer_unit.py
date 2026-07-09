#!/usr/bin/env python3
"""
Pure-unit tests for src/server/services/prioritizer.ts

Tests the two exported functions directly without a running server:
  - prioritizeQueue    — re-orders queued tasks by descending score
  - getQueueAnalysis   — returns scored analysis entries without reordering

Tests invoke the TypeScript module via Node.js + tsx (same pattern as test_slugify.py).
These tests do NOT require a running Formic server.

Usage:
    python test/test_prioritizer_unit.py
"""

import subprocess
import sys
import os
import json
import unittest
import time

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ── helpers ────────────────────────────────────────────────────────────────────

def run_ts(script: str) -> object:
    """Execute a TypeScript ESM snippet via node+tsx and return parsed JSON.

    The prioritizer emits a console.log status line before the JSON result;
    we therefore scan stdout lines in reverse and return the first one that
    parses as valid JSON (the result line), ignoring any preceding log lines.
    """
    result = subprocess.run(
        ['node', '--import=tsx/esm', '--input-type=module'],
        input=script,
        capture_output=True,
        text=True,
        cwd=PROJECT_ROOT,
    )
    if result.returncode != 0:
        raise RuntimeError(f"Node error:\n{result.stderr.strip()}")
    for line in reversed(result.stdout.splitlines()):
        line = line.strip()
        if not line:
            continue
        try:
            return json.loads(line)
        except json.JSONDecodeError:
            continue
    raise RuntimeError(f"No valid JSON found in output:\n{result.stdout!r}")


def prioritize_queue(tasks: list, all_tasks: list) -> list:
    payload_tasks = json.dumps(tasks)
    payload_all = json.dumps(all_tasks)
    script = f"""
import {{ prioritizeQueue }} from './src/server/services/prioritizer.js';
const result = prioritizeQueue({payload_tasks}, {payload_all});
console.log(JSON.stringify(result));
"""
    return run_ts(script)


def get_queue_analysis(tasks: list, all_tasks: list) -> list:
    payload_tasks = json.dumps(tasks)
    payload_all = json.dumps(all_tasks)
    script = f"""
import {{ getQueueAnalysis }} from './src/server/services/prioritizer.js';
const result = getQueueAnalysis({payload_tasks}, {payload_all});
console.log(JSON.stringify(result));
"""
    return run_ts(script)


# ── task factory ───────────────────────────────────────────────────────────────

def make_task(task_id: str, priority: str = 'medium', status: str = 'queued',
              fix_for: str = None, depends_on_resolved: list = None,
              queued_at: str = None, first_blocked_at: str = None) -> dict:
    t = {
        "id": task_id,
        "title": f"Task {task_id}",
        "status": status,
        "priority": priority,
        "context": "",
        "docsPath": "",
        "agentLogs": [],
        "pid": None,
        "createdAt": "2024-01-01T00:00:00.000Z",
        "queuedAt": queued_at or "2024-01-01T00:00:00.000Z",
    }
    if fix_for is not None:
        t["fixForTaskId"] = fix_for
    if depends_on_resolved is not None:
        t["dependsOnResolved"] = depends_on_resolved
    if first_blocked_at is not None:
        t["firstBlockedAt"] = first_blocked_at
    return t


# ── prioritizeQueue ────────────────────────────────────────────────────────────

class TestPrioritizeQueue(unittest.TestCase):

    def test_empty_list_returns_empty(self):
        result = prioritize_queue([], [])
        self.assertEqual(result, [])

    def test_single_task_returned_unchanged(self):
        tasks = [make_task('t1')]
        result = prioritize_queue(tasks, tasks)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]['id'], 't1')

    def test_high_priority_before_medium(self):
        tasks = [make_task('low-t', 'low'), make_task('high-t', 'high')]
        all_tasks = tasks[:]
        result = prioritize_queue(tasks, all_tasks)
        self.assertEqual(result[0]['id'], 'high-t')

    def test_high_priority_before_low(self):
        tasks = [make_task('low-t', 'low'), make_task('high-t', 'high')]
        all_tasks = tasks[:]
        result = prioritize_queue(tasks, all_tasks)
        ids = [t['id'] for t in result]
        self.assertGreater(ids.index('low-t'), ids.index('high-t'))

    def test_medium_priority_before_low(self):
        tasks = [make_task('low-t', 'low'), make_task('med-t', 'medium')]
        all_tasks = tasks[:]
        result = prioritize_queue(tasks, all_tasks)
        self.assertEqual(result[0]['id'], 'med-t')

    def test_fix_task_gets_top_priority(self):
        """A fix task (fixForTaskId set) must be first regardless of priority."""
        tasks = [
            make_task('high-t', 'high'),
            make_task('fix-t', 'low', fix_for='some-task'),
        ]
        all_tasks = tasks[:]
        result = prioritize_queue(tasks, all_tasks)
        self.assertEqual(result[0]['id'], 'fix-t')

    def test_fix_task_beats_all_priorities(self):
        """Fix bonus (+1000) exceeds any combination of priority + unblocking."""
        tasks = [
            make_task('h1', 'high'),
            make_task('h2', 'high'),
            make_task('fix', 'medium', fix_for='other'),
        ]
        all_tasks = tasks[:]
        result = prioritize_queue(tasks, all_tasks)
        self.assertEqual(result[0]['id'], 'fix')

    def test_unblocking_task_ranked_higher(self):
        """A task that unblocks blocked tasks should rank above a same-priority task."""
        blocker = make_task('blocker', 'medium')
        blocked = make_task('dep', 'medium', status='blocked',
                            depends_on_resolved=['blocker'])
        regular = make_task('regular', 'medium')
        all_tasks = [blocker, blocked, regular]
        queued = [blocker, regular]
        result = prioritize_queue(queued, all_tasks)
        self.assertEqual(result[0]['id'], 'blocker')

    def test_preserves_all_tasks_in_output(self):
        tasks = [make_task(f't{i}') for i in range(5)]
        result = prioritize_queue(tasks, tasks)
        self.assertEqual(len(result), 5)
        returned_ids = {t['id'] for t in result}
        expected_ids = {t['id'] for t in tasks}
        self.assertEqual(returned_ids, expected_ids)

    def test_older_task_ranks_higher_when_all_else_equal(self):
        """FIFO age bonus: a task queued long ago beats one queued just now."""
        # 'old_task' was queued years ago → ageBonus capped at MAX_AGE_BONUS (10)
        # 'new_task' is queued right now → ageBonus ≈ 0
        import datetime
        now_iso = datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%S.000Z')
        old_task = make_task('old', 'medium', queued_at='2020-01-01T00:00:00.000Z')
        new_task = make_task('new', 'medium', queued_at=now_iso)
        result = prioritize_queue([new_task, old_task], [new_task, old_task])
        self.assertEqual(result[0]['id'], 'old')

    def test_two_tasks_same_score_both_returned(self):
        t1 = make_task('t1', 'medium')
        t2 = make_task('t2', 'medium')
        result = prioritize_queue([t1, t2], [t1, t2])
        self.assertEqual(len(result), 2)

    def test_does_not_mutate_input_order_reference(self):
        tasks = [make_task('low', 'low'), make_task('high', 'high')]
        original_ids = [t['id'] for t in tasks]
        prioritize_queue(tasks, tasks)
        # Python-side list is unchanged (JS operates on its own copy)
        self.assertEqual([t['id'] for t in tasks], original_ids)

    def test_transitive_unblocking_counts_multi_hop(self):
        """A task that transitively unblocks a chain of blocked tasks scores higher."""
        # t1 → t2 (blocked, depends on t1) → t3 (blocked, depends on t2)
        t1 = make_task('t1', 'medium')
        t2 = make_task('t2', 'medium', status='blocked', depends_on_resolved=['t1'])
        t3 = make_task('t3', 'medium', status='blocked', depends_on_resolved=['t2'])
        regular = make_task('reg', 'medium')
        all_tasks = [t1, t2, t3, regular]
        queued = [regular, t1]
        result = prioritize_queue(queued, all_tasks)
        self.assertEqual(result[0]['id'], 't1')

    def test_blocked_tasks_not_in_output_unless_queued(self):
        """Blocked tasks in allTasks should not appear in the result unless queued."""
        t1 = make_task('t1', 'medium')
        blocked = make_task('blocked', 'high', status='blocked')
        all_tasks = [t1, blocked]
        result = prioritize_queue([t1], all_tasks)
        ids = [t['id'] for t in result]
        self.assertNotIn('blocked', ids)

    # ── Fairness tiebreaker (firstBlockedAt) ───────────────────────────────

    def test_firstblocked_task_wins_at_equal_score(self):
        """Two tasks with same priority and same queuedAt: the one blocked
        longer (older firstBlockedAt) should rank first due to fairness bonus."""
        # Both tasks: same priority, same queuedAt, no fix bonus, no deps
        # Task A has firstBlockedAt from 10 seconds ago → bonus ≈ 1.0 capped at 0.9
        # Task B has no firstBlockedAt → bonus 0
        import datetime
        ten_sec_ago = (datetime.datetime.utcnow() - datetime.timedelta(seconds=10)).strftime('%Y-%m-%dT%H:%M:%S.000Z')
        now_iso = datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%S.000Z')

        blocked_longer = make_task('blocked-old', 'medium', queued_at=now_iso,
                                   first_blocked_at=ten_sec_ago)
        not_blocked = make_task('not-blocked', 'medium', queued_at=now_iso)

        result = prioritize_queue([not_blocked, blocked_longer],
                                  [not_blocked, blocked_longer])
        self.assertEqual(result[0]['id'], 'blocked-old',
                         'Task with older firstBlockedAt should win fairness tiebreaker')

    def test_firstblocked_fairness_bonus_does_not_override_priority(self):
        """The fairness bonus (max 0.9) must not override a 10-point priority
        difference (high=30 vs low=10)."""
        import datetime
        old_blocked = (datetime.datetime.utcnow() - datetime.timedelta(hours=1)).strftime('%Y-%m-%dT%H:%M:%S.000Z')
        now_iso = datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%S.000Z')

        low_blocked = make_task('low-blocked', 'low', queued_at=now_iso,
                                first_blocked_at=old_blocked)
        high_fresh = make_task('high-fresh', 'high', queued_at=now_iso)

        result = prioritize_queue([low_blocked, high_fresh],
                                  [low_blocked, high_fresh])
        self.assertEqual(result[0]['id'], 'high-fresh',
                         'Priority (high=30 vs low=10, diff=20) should dominate fairness bonus (max 0.9)')

    def test_firstblocked_does_not_override_fifo_age(self):
        """The fairness bonus (max 0.9) should not override a 1-second
        age difference (1 point of age bonus). An older queued task without
        firstBlockedAt should beat a newer queued task with firstBlockedAt."""
        import datetime
        now = datetime.datetime.utcnow()
        one_sec_older = (now - datetime.timedelta(seconds=1)).strftime('%Y-%m-%dT%H:%M:%S.000Z')
        now_iso = now.strftime('%Y-%m-%dT%H:%M:%S.000Z')
        long_blocked = (now - datetime.timedelta(hours=2)).strftime('%Y-%m-%dT%H:%M:%S.000Z')

        # Age bonus difference ≈ 1 second = 1 point
        # Fairness bonus max = 0.9
        # So the 1-sec-older task should still win
        older_no_block = make_task('older-no-block', 'medium', queued_at=one_sec_older)
        newer_blocked = make_task('newer-blocked', 'medium', queued_at=now_iso,
                                  first_blocked_at=long_blocked)

        result = prioritize_queue([newer_blocked, older_no_block],
                                  [newer_blocked, older_no_block])
        self.assertEqual(result[0]['id'], 'older-no-block',
                         '1-second age bonus should dominate max 0.9 fairness bonus')

    def test_firstblocked_null_does_not_contribute_bonus(self):
        """Null firstBlockedAt should not contribute any fairness bonus."""
        import datetime
        now_iso = datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%S.000Z')

        null_blocked = make_task('null-blocked', 'medium', queued_at=now_iso)
        null_blocked['firstBlockedAt'] = None
        no_blocked = make_task('no-blocked', 'medium', queued_at=now_iso)

        result = prioritize_queue([null_blocked, no_blocked],
                                  [null_blocked, no_blocked])
        # Both should have essentially the same score — order is stable
        self.assertEqual(len(result), 2)

    def test_getqueueanalysis_includes_fairness_in_reasoning_when_blocked(self):
        """When firstBlockedAt is set, the reasoning should include a fairness
        component."""
        import datetime
        old_blocked = (datetime.datetime.utcnow() - datetime.timedelta(seconds=30)).strftime('%Y-%m-%dT%H:%M:%S.000Z')
        now_iso = datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%S.000Z')

        blocked_task = make_task('blocked-task', 'medium', queued_at=now_iso,
                                 first_blocked_at=old_blocked)
        regular_task = make_task('regular-task', 'medium', queued_at=now_iso)

        result = get_queue_analysis([blocked_task, regular_task],
                                    [blocked_task, regular_task])
        entries = {e['taskId']: e for e in result}
        self.assertIn('fairness', entries['blocked-task']['reasoning'],
                      'Reasoning should include fairness component for blocked task')
        self.assertNotIn('fairness', entries['regular-task']['reasoning'],
                         'Reasoning should NOT include fairness for task without firstBlockedAt')

    def test_getqueueanalysis_fairness_bonus_is_small(self):
        """The fairness bonus for getQueueAnalysis should be ≤ 0.9 (the cap)."""
        import datetime
        old_blocked = (datetime.datetime.utcnow() - datetime.timedelta(hours=24)).strftime('%Y-%m-%dT%H:%M:%S.000Z')
        now_iso = datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%S.000Z')

        blocked_task = make_task('blocked-task', 'medium', queued_at=now_iso,
                                 first_blocked_at=old_blocked)
        regular_task = make_task('regular-task', 'medium', queued_at=now_iso)

        result = get_queue_analysis([regular_task, blocked_task],
                                    [regular_task, blocked_task])
        entries = {e['taskId']: e for e in result}

        # Score difference should be small (≤ 0.9 because fairness is capped)
        score_diff = entries['blocked-task']['score'] - entries['regular-task']['score']
        self.assertLessEqual(score_diff, 0.91,
                             f'Fairness bonus difference should be ≤ 0.9, got {score_diff}')
        self.assertGreater(score_diff, 0,
                           'Blocked task should have strictly higher score due to fairness bonus')


# ── getQueueAnalysis ───────────────────────────────────────────────────────────

class TestGetQueueAnalysis(unittest.TestCase):

    def test_empty_tasks_returns_empty_list(self):
        result = get_queue_analysis([], [])
        self.assertEqual(result, [])

    def test_returns_one_entry_per_queued_task(self):
        tasks = [make_task('t1'), make_task('t2'), make_task('t3')]
        result = get_queue_analysis(tasks, tasks)
        self.assertEqual(len(result), 3)

    def test_entry_has_required_fields(self):
        tasks = [make_task('t1')]
        result = get_queue_analysis(tasks, tasks)
        entry = result[0]
        self.assertIn('taskId', entry)
        self.assertIn('score', entry)
        self.assertIn('unblockingPotential', entry)
        self.assertIn('reasoning', entry)

    def test_task_id_matches(self):
        tasks = [make_task('abc')]
        result = get_queue_analysis(tasks, tasks)
        self.assertEqual(result[0]['taskId'], 'abc')

    def test_high_priority_has_higher_score_than_medium(self):
        high_task = make_task('h', 'high')
        med_task = make_task('m', 'medium')
        result = get_queue_analysis([high_task, med_task], [high_task, med_task])
        scores = {e['taskId']: e['score'] for e in result}
        self.assertGreater(scores['h'], scores['m'])

    def test_fix_task_has_highest_score(self):
        fix_task = make_task('fix', 'low', fix_for='other-task')
        high_task = make_task('high', 'high')
        result = get_queue_analysis([fix_task, high_task], [fix_task, high_task])
        scores = {e['taskId']: e['score'] for e in result}
        self.assertGreater(scores['fix'], scores['high'])

    def test_unblocking_potential_counted(self):
        blocker = make_task('blocker', 'medium')
        blocked = make_task('dep', 'medium', status='blocked',
                            depends_on_resolved=['blocker'])
        regular = make_task('regular', 'medium')
        all_tasks = [blocker, blocked, regular]
        result = get_queue_analysis([blocker, regular], all_tasks)
        entries = {e['taskId']: e for e in result}
        self.assertGreater(entries['blocker']['unblockingPotential'], 0)
        self.assertEqual(entries['regular']['unblockingPotential'], 0)

    def test_reasoning_string_contains_score(self):
        tasks = [make_task('t1')]
        result = get_queue_analysis(tasks, tasks)
        self.assertIn('score=', result[0]['reasoning'])

    def test_does_not_reorder_input_list(self):
        """getQueueAnalysis must not mutate caller's list — output order may differ."""
        low = make_task('low', 'low')
        high = make_task('high', 'high')
        tasks = [low, high]
        result = get_queue_analysis(tasks, tasks)
        # The analysis entries set should match — order is not mandated
        ids = {e['taskId'] for e in result}
        self.assertEqual(ids, {'low', 'high'})

    def test_score_is_numeric(self):
        tasks = [make_task('t1', 'medium')]
        result = get_queue_analysis(tasks, tasks)
        self.assertIsInstance(result[0]['score'], (int, float))

    def test_unblocking_potential_is_non_negative_integer(self):
        tasks = [make_task('t1')]
        result = get_queue_analysis(tasks, tasks)
        self.assertGreaterEqual(result[0]['unblockingPotential'], 0)

    def test_transitive_unblocking_counts_chain(self):
        """A chain A→B→C where B,C are blocked: unblockingPotential for A == 2."""
        t_a = make_task('A', 'medium')
        t_b = make_task('B', 'medium', status='blocked', depends_on_resolved=['A'])
        t_c = make_task('C', 'medium', status='blocked', depends_on_resolved=['B'])
        all_tasks = [t_a, t_b, t_c]
        result = get_queue_analysis([t_a], all_tasks)
        self.assertEqual(result[0]['unblockingPotential'], 2)

    def test_no_deps_yields_zero_unblocking_potential(self):
        tasks = [make_task('standalone', 'high')]
        result = get_queue_analysis(tasks, tasks)
        self.assertEqual(result[0]['unblockingPotential'], 0)


if __name__ == '__main__':
    print(f"Project root: {PROJECT_ROOT}")
    print("Running prioritizer pure-unit tests...\n")
    unittest.main(verbosity=2)
