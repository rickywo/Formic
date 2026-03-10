#!/usr/bin/env python3
"""
Stop-task tests for Formic.

Tests that the stop button immediately kills a running task and resets it to todo.

Scenarios:
1. Stop a quick task while it is actively running (status == 'running')
2. Stop a standard task immediately after queuing (between-steps scenario)

Usage:
    # Make sure Formic is running first:
    # WORKSPACE_PATH=./example npm run dev

    # Then run tests:
    python test/test_stop_task.py
"""

import requests
import sys
import os
import uuid
import time

# Configuration
BASE_URL = os.environ.get('FORMIC_URL', 'http://localhost:8000')


def poll_task_status(task_id: str, expected_status: str, timeout: float = 3.0) -> bool:
    """Poll GET /api/board until the task has the expected status or timeout expires."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            response = requests.get(f"{BASE_URL}/api/board", timeout=5)
            if response.status_code == 200:
                tasks = response.json().get('tasks', [])
                for t in tasks:
                    if t['id'] == task_id:
                        if t['status'] == expected_status:
                            return True
                        break
        except Exception:
            pass
        time.sleep(0.25)
    return False


def test_stop_task():
    results = []
    unique_id = str(uuid.uuid4())[:8]

    # ==================== Test 1: Stop a running quick task ====================
    print("\n=== Test 1: Stop a running quick task ===")
    quick_task_id = None
    try:
        # Create a quick task with a long-running context so it stays in 'running'
        response = requests.post(
            f"{BASE_URL}/api/tasks",
            json={
                "title": f"Stop Test Quick Task {unique_id}",
                "context": "Sleep for 60 seconds: run `sleep 60` in the workspace. Do not do anything else.",
                "priority": "medium",
                "type": "quick",
            },
            timeout=5,
        )
        assert response.status_code in (200, 201), f"Create failed: {response.status_code}"
        quick_task_id = response.json()['id']
        print(f"  Created task {quick_task_id}")

        # Queue the task
        queue_resp = requests.post(f"{BASE_URL}/api/tasks/{quick_task_id}/queue", timeout=5)
        assert queue_resp.status_code == 200, f"Queue failed: {queue_resp.status_code}"
        print(f"  Queued task")

        # Trigger execution immediately (bypass auto-queue)
        run_resp = requests.post(f"{BASE_URL}/api/tasks/{quick_task_id}/run", timeout=5)
        if run_resp.status_code == 409:
            # Another agent is running — skip but still pass the route test below
            print(f"  Agent already running (409), stopping anyway")
        elif run_resp.status_code == 200:
            print(f"  Run triggered: {run_resp.json().get('status')}")
        else:
            print(f"  Run response: {run_resp.status_code}")

        # Wait briefly for status to reach 'running' (up to 2s)
        poll_task_status(quick_task_id, 'running', timeout=2.0)

        # Stop the task
        stop_resp = requests.post(f"{BASE_URL}/api/tasks/{quick_task_id}/stop", timeout=5)
        if stop_resp.status_code == 200:
            print(f"  ✓ Stop returned 200: {stop_resp.json()}")
            results.append(("Stop running quick task - HTTP 200", "PASS"))
        else:
            print(f"  ✗ Stop returned {stop_resp.status_code}: {stop_resp.text}")
            results.append(("Stop running quick task - HTTP 200", "FAIL"))

        # Assert task status becomes 'todo' within 3 seconds
        reset_ok = poll_task_status(quick_task_id, 'todo', timeout=3.0)
        if reset_ok:
            print(f"  ✓ Task status reset to 'todo' within 3s")
            results.append(("Stop running quick task - resets to todo", "PASS"))
        else:
            # Fetch current status for diagnostic output
            board = requests.get(f"{BASE_URL}/api/board", timeout=5).json()
            current = next((t['status'] for t in board['tasks'] if t['id'] == quick_task_id), 'unknown')
            print(f"  ✗ Task status is '{current}' after 3s (expected 'todo')")
            results.append(("Stop running quick task - resets to todo", "FAIL"))

    except AssertionError as e:
        print(f"  ✗ Assertion: {e}")
        results.append(("Stop running quick task - HTTP 200", "FAIL"))
        results.append(("Stop running quick task - resets to todo", "FAIL"))
    except Exception as e:
        print(f"  ✗ Error: {e}")
        results.append(("Stop running quick task - HTTP 200", "FAIL"))
        results.append(("Stop running quick task - resets to todo", "FAIL"))
    finally:
        # Clean up
        if quick_task_id:
            try:
                requests.delete(f"{BASE_URL}/api/tasks/{quick_task_id}", timeout=5)
            except Exception:
                pass

    # ==================== Test 2: Stop between workflow steps ====================
    print("\n=== Test 2: Stop standard task immediately after queuing (between-steps scenario) ===")
    std_task_id = None
    try:
        # Create a standard task
        response = requests.post(
            f"{BASE_URL}/api/tasks",
            json={
                "title": f"Stop Test Standard Task {unique_id}",
                "context": "Add a hello world comment to any file in the project.",
                "priority": "medium",
                "type": "standard",
            },
            timeout=5,
        )
        assert response.status_code in (200, 201), f"Create failed: {response.status_code}"
        std_task_id = response.json()['id']
        print(f"  Created task {std_task_id}")

        # Queue the task
        queue_resp = requests.post(f"{BASE_URL}/api/tasks/{std_task_id}/queue", timeout=5)
        assert queue_resp.status_code == 200, f"Queue failed: {queue_resp.status_code}"
        print(f"  Queued task")

        # Immediately stop it (possibly before or during briefing)
        stop_resp = requests.post(f"{BASE_URL}/api/tasks/{std_task_id}/stop", timeout=5)
        if stop_resp.status_code == 200:
            print(f"  ✓ Stop returned 200: {stop_resp.json()}")
            results.append(("Stop between-steps task - HTTP 200 (not 404)", "PASS"))
        else:
            print(f"  ✗ Stop returned {stop_resp.status_code}: {stop_resp.text}")
            results.append(("Stop between-steps task - HTTP 200 (not 404)", "FAIL"))

        # Assert task resets to 'todo' within 3 seconds
        reset_ok = poll_task_status(std_task_id, 'todo', timeout=3.0)
        if reset_ok:
            print(f"  ✓ Task status reset to 'todo' within 3s")
            results.append(("Stop between-steps task - resets to todo", "PASS"))
        else:
            board = requests.get(f"{BASE_URL}/api/board", timeout=5).json()
            current = next((t['status'] for t in board['tasks'] if t['id'] == std_task_id), 'unknown')
            print(f"  ✗ Task status is '{current}' after 3s (expected 'todo')")
            results.append(("Stop between-steps task - resets to todo", "FAIL"))

        # Assert task is not in any in-progress status
        board = requests.get(f"{BASE_URL}/api/board", timeout=5).json()
        in_progress_statuses = {'briefing', 'planning', 'declaring', 'running', 'verifying'}
        task_status = next((t['status'] for t in board['tasks'] if t['id'] == std_task_id), 'unknown')
        if task_status not in in_progress_statuses:
            print(f"  ✓ Task is not in any in-progress status (status: '{task_status}')")
            results.append(("Stop between-steps task - not in active status", "PASS"))
        else:
            print(f"  ✗ Task is still in in-progress status: '{task_status}'")
            results.append(("Stop between-steps task - not in active status", "FAIL"))

    except AssertionError as e:
        print(f"  ✗ Assertion: {e}")
        results.append(("Stop between-steps task - HTTP 200 (not 404)", "FAIL"))
        results.append(("Stop between-steps task - resets to todo", "FAIL"))
        results.append(("Stop between-steps task - not in active status", "FAIL"))
    except Exception as e:
        print(f"  ✗ Error: {e}")
        results.append(("Stop between-steps task - HTTP 200 (not 404)", "FAIL"))
        results.append(("Stop between-steps task - resets to todo", "FAIL"))
        results.append(("Stop between-steps task - not in active status", "FAIL"))
    finally:
        # Clean up
        if std_task_id:
            try:
                requests.delete(f"{BASE_URL}/api/tasks/{std_task_id}", timeout=5)
            except Exception:
                pass

    # ==================== Summary ====================
    print("\n" + "=" * 50)
    print("STOP TASK TEST SUMMARY")
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
    success = test_stop_task()
    sys.exit(0 if success else 1)
