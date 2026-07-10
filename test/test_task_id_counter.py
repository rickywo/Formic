#!/usr/bin/env python3
"""
Task ID counter tests for Formic.

Verifies that task IDs are generated from a persistent monotonic counter
(board.meta.nextTaskId) rather than derived from the current max task ID.
This ensures deleting the highest-numbered task never causes ID reuse.

Usage:
    # Make sure Formic is running first:
    # WORKSPACE_PATH=./example npm run dev

    # Then run tests:
    python test/test_task_id_counter.py
"""

import re
import requests
import sys
import os
import uuid

# Configuration
BASE_URL = os.environ.get('FORMIC_URL', 'http://localhost:8000')


def _task_num(task_id: str):
    match = re.match(r'^t-(\d+)$', task_id)
    return int(match.group(1)) if match else None


def test_task_id_counter():
    results = []
    unique_id = str(uuid.uuid4())[:8]
    created_ids = []

    # Test 1: Create three tasks in sequence
    print("\n=== Test 1: Create three tasks in sequence ===")
    try:
        for i in range(3):
            response = requests.post(
                f"{BASE_URL}/api/tasks",
                json={
                    "title": f"ID Counter Test {unique_id}-{i}",
                    "context": "Verifying monotonic task ID counter",
                    "type": "quick",
                },
            )
            if response.status_code != 201:
                raise RuntimeError(f"Unexpected status code: {response.status_code}")
            task = response.json()
            created_ids.append(task["id"])

        if all(_task_num(tid) is not None for tid in created_ids) and \
                created_ids == sorted(created_ids, key=_task_num):
            print(f"✓ Created tasks with increasing IDs: {created_ids}")
            results.append(("Create sequential tasks", "PASS"))
        else:
            print(f"✗ Task IDs not monotonically increasing: {created_ids}")
            results.append(("Create sequential tasks", "FAIL"))
    except Exception as e:
        print(f"✗ Error: {e}")
        results.append(("Create sequential tasks", "FAIL"))

    # Test 2: Delete the highest-numbered task, then create a new one and
    # confirm the new ID is not a reused ID.
    print("\n=== Test 2: Delete highest task then create — no ID reuse ===")
    new_task_id = None
    try:
        if len(created_ids) < 3:
            raise RuntimeError("Prerequisite tasks were not created")

        highest_id = max(created_ids, key=_task_num)
        del_response = requests.delete(f"{BASE_URL}/api/tasks/{highest_id}")
        if del_response.status_code not in (200, 204):
            raise RuntimeError(f"Delete failed with status {del_response.status_code}")

        create_response = requests.post(
            f"{BASE_URL}/api/tasks",
            json={
                "title": f"ID Counter Test {unique_id}-post-delete",
                "context": "Verifying no ID reuse after deletion",
                "type": "quick",
            },
        )
        if create_response.status_code != 201:
            raise RuntimeError(f"Unexpected status code: {create_response.status_code}")

        new_task = create_response.json()
        new_task_id = new_task["id"]
        created_ids.append(new_task_id)

        if new_task_id != highest_id and _task_num(new_task_id) is not None and \
                _task_num(new_task_id) > _task_num(highest_id):
            print(f"✓ Deleted {highest_id}, new task got fresh ID {new_task_id} (no reuse)")
            results.append(("No ID reuse after delete", "PASS"))
        else:
            print(f"✗ ID reuse detected: deleted {highest_id}, new task got {new_task_id}")
            results.append(("No ID reuse after delete", "FAIL"))
    except Exception as e:
        print(f"✗ Error: {e}")
        results.append(("No ID reuse after delete", "FAIL"))

    # Cleanup: delete all remaining created tasks
    print("\n=== Cleanup: removing test tasks ===")
    for tid in created_ids:
        try:
            requests.delete(f"{BASE_URL}/api/tasks/{tid}")
        except Exception as e:
            print(f"  (cleanup warning for {tid}: {e})")

    # Print summary
    print("\n" + "=" * 50)
    print("TASK ID COUNTER TEST SUMMARY")
    print("=" * 50)
    passed = sum(1 for r in results if r[1] == "PASS")
    failed = sum(1 for r in results if r[1] == "FAIL")
    skipped = sum(1 for r in results if r[1] == "SKIP")

    for test_name, status in results:
        icon = "✓" if status == "PASS" else ("○" if status == "SKIP" else "✗")
        print(f"  {icon} {test_name}: {status}")

    print("-" * 50)
    print(f"  Total: {len(results)} | Passed: {passed} | Failed: {failed} | Skipped: {skipped}")
    print("=" * 50)

    return failed == 0


if __name__ == '__main__':
    success = test_task_id_counter()
    sys.exit(0 if success else 1)
