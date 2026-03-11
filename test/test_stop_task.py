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


def test_no_bouncing():
    """Regression test for the task-bouncing bug (t-109 through t-112).

    Verifies that a running task never transitions back to 'queued'
    due to the queueProcessor re-admitting it across poll cycles.
    """
    results = []
    unique_id = str(uuid.uuid4())[:8]

    print("\n=== Test 3: No running→queued bouncing regression ===")
    task_id = None
    try:
        # Create a quick task whose agent will sleep long enough to observe
        response = requests.post(
            f"{BASE_URL}/api/tasks",
            json={
                "title": f"Bouncing Regression Test {unique_id}",
                "context": (
                    "Run `sleep 30` in the workspace and do nothing else. "
                    "This task is intentionally long-running so it stays in 'running' state."
                ),
                "priority": "high",
                "type": "quick",
            },
            timeout=5,
        )
        assert response.status_code in (200, 201), f"Create failed: {response.status_code}"
        task_id = response.json()['id']
        print(f"  Created task {task_id}")

        # Queue the task
        queue_resp = requests.post(f"{BASE_URL}/api/tasks/{task_id}/queue", timeout=5)
        assert queue_resp.status_code == 200, f"Queue failed: {queue_resp.status_code}"
        print(f"  Queued task")

        # Trigger execution
        run_resp = requests.post(f"{BASE_URL}/api/tasks/{task_id}/run", timeout=5)
        print(f"  Run response: {run_resp.status_code} {run_resp.text[:80]}")

        # Wait up to 5 seconds for task to reach 'running'
        reached_running = poll_task_status(task_id, 'running', timeout=5.0)
        if not reached_running:
            board = requests.get(f"{BASE_URL}/api/board", timeout=5).json()
            current = next((t['status'] for t in board['tasks'] if t['id'] == task_id), 'unknown')
            print(f"  Task never reached 'running' (current: '{current}') — skipping bounce check")
            results.append(("No bouncing - task reached running", "FAIL"))
            return results

        print(f"  Task reached 'running' — polling for 10s watching for bouncing...")
        results.append(("No bouncing - task reached running", "PASS"))

        # Poll every 250ms for 10 seconds; assert status never goes back to 'queued'
        bounced = False
        poll_deadline = time.time() + 10.0
        while time.time() < poll_deadline:
            try:
                board_resp = requests.get(f"{BASE_URL}/api/board", timeout=5)
                if board_resp.status_code == 200:
                    tasks = board_resp.json().get('tasks', [])
                    for t in tasks:
                        if t['id'] == task_id and t['status'] == 'queued':
                            bounced = True
                            print(f"  ✗ BOUNCE DETECTED: task transitioned from 'running' back to 'queued'!")
                            break
            except Exception:
                pass
            if bounced:
                break
            time.sleep(0.25)

        if not bounced:
            print(f"  ✓ No running→queued bounce detected over 10s")
            results.append(("No bouncing - no running→queued transition", "PASS"))
        else:
            results.append(("No bouncing - no running→queued transition", "FAIL"))

        # Stop the task and verify it resets to 'todo'
        stop_resp = requests.post(f"{BASE_URL}/api/tasks/{task_id}/stop", timeout=5)
        if stop_resp.status_code == 200:
            print(f"  ✓ Stop returned 200")
            results.append(("No bouncing - stop returns 200", "PASS"))
        else:
            print(f"  ✗ Stop returned {stop_resp.status_code}: {stop_resp.text}")
            results.append(("No bouncing - stop returns 200", "FAIL"))

        reset_ok = poll_task_status(task_id, 'todo', timeout=3.0)
        if reset_ok:
            print(f"  ✓ Task reset to 'todo' after stop")
            results.append(("No bouncing - resets to todo after stop", "PASS"))
        else:
            board = requests.get(f"{BASE_URL}/api/board", timeout=5).json()
            current = next((t['status'] for t in board['tasks'] if t['id'] == task_id), 'unknown')
            print(f"  ✗ Task status is '{current}' after stop (expected 'todo')")
            results.append(("No bouncing - resets to todo after stop", "FAIL"))

    except AssertionError as e:
        print(f"  ✗ Assertion: {e}")
        results.append(("No bouncing - task reached running", "FAIL"))
    except Exception as e:
        print(f"  ✗ Error: {e}")
        results.append(("No bouncing - task reached running", "FAIL"))
    finally:
        if task_id:
            try:
                requests.delete(f"{BASE_URL}/api/tasks/{task_id}", timeout=5)
            except Exception:
                pass

    return results


if __name__ == '__main__':
    stop_results = []
    unique_id = str(uuid.uuid4())[:8]

    # Run original stop tests and collect results
    import io
    import contextlib

    # We call the original function but need combined results for summary
    # Re-implement inline collection by running each test and gathering
    stop_success = test_stop_task()
    bouncing_results = test_no_bouncing()

    # Print bouncing test summary
    print("\n" + "=" * 50)
    print("BOUNCING REGRESSION TEST SUMMARY")
    print("=" * 50)
    b_passed = sum(1 for r in bouncing_results if r[1] == "PASS")
    b_failed = sum(1 for r in bouncing_results if r[1] == "FAIL")
    b_skipped = sum(1 for r in bouncing_results if r[1] == "SKIP")
    for test_name, status in bouncing_results:
        icon = "✓" if status == "PASS" else ("○" if status == "SKIP" else "✗")
        print(f"  {icon} {test_name}: {status}")
    print("-" * 50)
    print(f"  Total: {len(bouncing_results)} | Passed: {b_passed} | Failed: {b_failed} | Skipped: {b_skipped}")
    print("=" * 50)

    bouncing_success = b_failed == 0
    sys.exit(0 if (stop_success and bouncing_success) else 1)
