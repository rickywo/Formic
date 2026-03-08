#!/usr/bin/env python3
"""
AGI Metrics Collector — evaluates and reports on the health of Formic's AGI mechanisms.

Runs all four phase test suites plus the integration suite programmatically, captures
pass/fail counts, and emits a structured JSON report with five key metrics:

  selfHealingRate    — fraction of critic-triggered tasks that recovered within 3 retries
  dagAccuracy        — fraction of goal tasks where architect output has valid depends_on
  deadlockRate       — deadlocks per 100 tasks observed (from stress test data)
  memoryUtilization  — fraction of tasks that benefited from memory injection (0.0 if Phase 4 absent)
  avgTaskCompletionMs — average task completion duration from the board (completedAt - startedAt)

Usage:
    # Basic run — outputs JSON to stdout:
    python test/agi_metrics.py

    # Write report to file:
    python test/agi_metrics.py metrics-report.json

    # Against a different server:
    FORMIC_URL=http://localhost:8000 python test/agi_metrics.py
"""

import json
import os
import sys
import unittest
from datetime import datetime, timezone

import requests

# Resolve the test directory so we can import suites from the same location
TEST_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, TEST_DIR)

BASE_URL = os.environ.get('FORMIC_URL', 'http://localhost:3000')


def _run_suite(suite_module_name: str) -> dict:
    """
    Discover and run the tests in suite_module_name.
    Returns a dict with keys: total, passed, failed, errors, skipped.
    """
    result = {
        'module': suite_module_name,
        'total': 0,
        'passed': 0,
        'failed': 0,
        'errors': 0,
        'skipped': 0,
    }
    try:
        loader = unittest.TestLoader()
        suite = loader.loadTestsFromName(suite_module_name)
        runner = unittest.TextTestRunner(stream=open(os.devnull, 'w'), verbosity=0)
        test_result = runner.run(suite)
        result['total'] = test_result.testsRun
        result['failed'] = len(test_result.failures)
        result['errors'] = len(test_result.errors)
        result['skipped'] = len(test_result.skipped)
        result['passed'] = test_result.testsRun - len(test_result.failures) - len(test_result.errors) - len(test_result.skipped)
    except Exception as e:
        result['errors'] = 1
        result['error_message'] = str(e)
    return result


def _get_board_tasks() -> list:
    """Fetch all tasks from the board. Returns empty list on failure."""
    try:
        resp = requests.get(f"{BASE_URL}/api/board", timeout=10)
        if resp.status_code == 200:
            return resp.json().get('tasks', [])
    except Exception:
        pass
    return []


def _calculate_self_healing_rate(tasks: list) -> float:
    """
    Self-Healing Rate: fraction of tasks with retryCount > 0 that eventually
    reached 'review' or 'done' status (recovered). Target: >= 0.80.
    Returns 0.0 if no retry data is available.
    """
    retried = [t for t in tasks if t.get('retryCount') and t['retryCount'] > 0]
    if not retried:
        return 0.0
    recovered = [
        t for t in retried
        if t.get('status') in ('review', 'done') and (t.get('retryCount') or 0) < 3
    ]
    return len(recovered) / len(retried) if retried else 0.0


def _calculate_dag_accuracy(tasks: list) -> float:
    """
    DAG Accuracy: fraction of completed goal tasks whose childTaskIds all have
    valid dependsOn relationships (non-empty for at least one child). Target: >= 0.90.
    Returns 0.0 if no goal tasks have completed.
    """
    goal_tasks = [
        t for t in tasks
        if t.get('type') == 'goal' and t.get('status') in ('done', 'review')
    ]
    if not goal_tasks:
        return 0.0

    accurate = 0
    for goal in goal_tasks:
        child_ids = goal.get('childTaskIds') or []
        if not child_ids:
            continue
        # Find child tasks
        child_tasks_map = {t['id']: t for t in tasks}
        children = [child_tasks_map[cid] for cid in child_ids if cid in child_tasks_map]
        # DAG is accurate if at least one child has a non-empty dependsOn
        has_dag = any(c.get('dependsOn') for c in children)
        if has_dag:
            accurate += 1

    return accurate / len(goal_tasks) if goal_tasks else 0.0


def _calculate_deadlock_rate(suite_results: list) -> float:
    """
    Deadlock Rate: number of deadlocks per 100 tasks. Target: 0.
    We proxy this via stress test failures in the concurrency_advanced suite.
    Returns 0.0 if the stress test was skipped or passed.
    """
    concurrency_result = next(
        (r for r in suite_results if 'concurrency_advanced' in r.get('module', '')),
        None,
    )
    if not concurrency_result:
        return 0.0
    # If concurrency advanced tests failed, report a non-zero rate
    failures = concurrency_result.get('failed', 0) + concurrency_result.get('errors', 0)
    total = concurrency_result.get('total', 1) or 1
    return (failures / total) * 100


def _calculate_memory_utilization(tasks: list) -> float:
    """
    Memory Utilization: fraction of tasks that had memory context injected.
    Returns 0.0 if Phase 4 (memory system) is not deployed.
    We detect this by checking if any tasks have a non-empty memoryContext field
    or if the /api/memory endpoint exists.
    """
    # Check if memory API is available
    try:
        resp = requests.get(f"{BASE_URL}/api/memory", timeout=5)
        if resp.status_code == 404:
            return 0.0
        memory_data = resp.json() if resp.status_code == 200 else {}
        rule_count = len(memory_data.get('rules', []))
        if rule_count == 0:
            return 0.0
    except Exception:
        return 0.0

    # Count tasks that might have benefited from memory injection
    done_tasks = [t for t in tasks if t.get('status') == 'done']
    if not done_tasks:
        return 0.0
    # Proxy: tasks with memoryContext field set
    with_memory = [t for t in done_tasks if t.get('memoryContext')]
    return len(with_memory) / len(done_tasks) if done_tasks else 0.0


def _calculate_avg_completion_ms(tasks: list) -> float:
    """
    Average Task Completion Time in milliseconds.
    Calculated from tasks that have both startedAt and completedAt timestamps.
    Returns 0.0 if no completed tasks have duration data.
    """
    durations = []
    for task in tasks:
        started = task.get('startedAt')
        completed = task.get('completedAt')
        if not started or not completed:
            continue
        try:
            started_dt = datetime.fromisoformat(started.replace('Z', '+00:00'))
            completed_dt = datetime.fromisoformat(completed.replace('Z', '+00:00'))
            duration_ms = (completed_dt - started_dt).total_seconds() * 1000
            if duration_ms >= 0:
                durations.append(duration_ms)
        except Exception:
            continue
    return sum(durations) / len(durations) if durations else 0.0


def collect_metrics(output_path: str | None = None) -> dict:
    """
    Run all AGI test suites, gather board data, compute metrics, and return the
    JSON-serialisable report. Optionally write to output_path.
    """
    report = {
        'generatedAt': datetime.now(timezone.utc).isoformat(),
        'serverUrl': BASE_URL,
        'suiteResults': [],
        'selfHealingRate': 0.0,
        'dagAccuracy': 0.0,
        'deadlockRate': 0.0,
        'memoryUtilization': 0.0,
        'avgTaskCompletionMs': 0.0,
    }

    # Check server reachability
    try:
        requests.get(f"{BASE_URL}/api/board", timeout=5)
    except Exception as e:
        report['error'] = f"Server unreachable at {BASE_URL}: {e}"
        _write_report(report, output_path)
        return report

    # Run all test suites
    suite_modules = [
        'test_qa_loop',
        'test_dag_scheduling',
        'test_concurrency_advanced',
        'test_memory',
        'test_agi_integration',
    ]

    print(f"[Metrics] Running {len(suite_modules)} test suites against {BASE_URL}...")
    suite_results = []
    for module in suite_modules:
        print(f"[Metrics]   Running {module}...", end='', flush=True)
        result = _run_suite(module)
        suite_results.append(result)
        status = '✓' if result['failed'] == 0 and result['errors'] == 0 else '✗'
        print(f" {status} ({result['passed']}/{result['total']} passed, {result['skipped']} skipped)")

    report['suiteResults'] = suite_results

    # Gather board data for metric calculations
    print("[Metrics] Fetching board data for metric calculations...")
    all_tasks = _get_board_tasks()

    # Calculate metrics
    report['selfHealingRate'] = round(_calculate_self_healing_rate(all_tasks), 4)
    report['dagAccuracy'] = round(_calculate_dag_accuracy(all_tasks), 4)
    report['deadlockRate'] = round(_calculate_deadlock_rate(suite_results), 4)
    report['memoryUtilization'] = round(_calculate_memory_utilization(all_tasks), 4)
    report['avgTaskCompletionMs'] = round(_calculate_avg_completion_ms(all_tasks), 2)

    # Summary
    total_passed = sum(r['passed'] for r in suite_results)
    total_tests = sum(r['total'] for r in suite_results)
    total_failed = sum(r['failed'] + r['errors'] for r in suite_results)
    total_skipped = sum(r['skipped'] for r in suite_results)

    report['summary'] = {
        'totalTests': total_tests,
        'passed': total_passed,
        'failed': total_failed,
        'skipped': total_skipped,
        'passRate': round(total_passed / total_tests, 4) if total_tests > 0 else 0.0,
    }

    _write_report(report, output_path)
    return report


def _write_report(report: dict, output_path: str | None) -> None:
    """Write the report JSON to stdout and optionally to a file."""
    report_json = json.dumps(report, indent=2)
    print("\n" + "=" * 60)
    print("AGI METRICS REPORT")
    print("=" * 60)
    print(report_json)
    print("=" * 60)

    if output_path:
        try:
            with open(output_path, 'w') as f:
                f.write(report_json)
            print(f"\n[Metrics] Report written to: {output_path}")
        except Exception as e:
            print(f"\n[Metrics] Failed to write report to '{output_path}': {e}", file=sys.stderr)


def main():
    output_path = sys.argv[1] if len(sys.argv) > 1 else None
    report = collect_metrics(output_path)

    # Validate required keys are present
    required_keys = [
        'selfHealingRate', 'dagAccuracy', 'deadlockRate',
        'memoryUtilization', 'avgTaskCompletionMs',
    ]
    missing = [k for k in required_keys if k not in report]
    if missing:
        print(f"\n[Metrics] ERROR: Report missing required keys: {missing}", file=sys.stderr)
        sys.exit(1)

    # Exit with non-zero if any suites had failures
    total_failed = sum(r.get('failed', 0) + r.get('errors', 0) for r in report.get('suiteResults', []))
    sys.exit(0 if total_failed == 0 else 1)


if __name__ == '__main__':
    main()
