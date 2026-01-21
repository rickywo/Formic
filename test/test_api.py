#!/usr/bin/env python3
"""
API tests for Formic.

Tests the REST API endpoints:
- GET /api/board
- POST /api/tasks
- PUT /api/tasks/:id
- DELETE /api/tasks/:id

Usage:
    # Make sure Formic is running first:
    # WORKSPACE_PATH=./example npm run dev

    # Then run tests:
    python test/test_api.py
"""

import requests
import sys
import os
import uuid

# Configuration
BASE_URL = os.environ.get('FORMIC_URL', 'http://localhost:8000')


def test_api():
    results = []
    unique_id = str(uuid.uuid4())[:8]
    test_task_title = f"API Test Task {unique_id}"
    created_task_id = None

    # Test 1: GET /api/board
    print("\n=== Test 1: GET /api/board ===")
    try:
        response = requests.get(f"{BASE_URL}/api/board")
        if response.status_code == 200:
            data = response.json()
            if 'meta' in data and 'tasks' in data:
                print(f"✓ Board retrieved successfully")
                print(f"  Project: {data['meta'].get('projectName', 'unknown')}")
                print(f"  Tasks: {len(data['tasks'])}")
                results.append(("GET /api/board", "PASS"))
            else:
                print("✗ Invalid board structure")
                results.append(("GET /api/board", "FAIL"))
        else:
            print(f"✗ Status code: {response.status_code}")
            results.append(("GET /api/board", "FAIL"))
    except Exception as e:
        print(f"✗ Error: {e}")
        results.append(("GET /api/board", "FAIL"))

    # Test 2: POST /api/tasks
    print("\n=== Test 2: POST /api/tasks ===")
    try:
        response = requests.post(
            f"{BASE_URL}/api/tasks",
            json={
                "title": test_task_title,
                "context": "This task was created by API tests",
                "priority": "medium"
            }
        )
        if response.status_code in [200, 201]:
            data = response.json()
            if data.get('title') == test_task_title and data.get('status') == 'todo':
                created_task_id = data.get('id')
                print(f"✓ Task created successfully (status: {response.status_code})")
                print(f"  ID: {created_task_id}")
                print(f"  Title: {data['title']}")
                results.append(("POST /api/tasks", "PASS"))
            else:
                print("✗ Invalid task data returned")
                results.append(("POST /api/tasks", "FAIL"))
        else:
            print(f"✗ Status code: {response.status_code}")
            results.append(("POST /api/tasks", "FAIL"))
    except Exception as e:
        print(f"✗ Error: {e}")
        results.append(("POST /api/tasks", "FAIL"))

    # Test 3: PUT /api/tasks/:id
    print("\n=== Test 3: PUT /api/tasks/:id ===")
    if created_task_id:
        try:
            response = requests.put(
                f"{BASE_URL}/api/tasks/{created_task_id}",
                json={"priority": "high"}
            )
            if response.status_code == 200:
                data = response.json()
                if data.get('priority') == 'high':
                    print(f"✓ Task updated successfully")
                    print(f"  Priority changed to: {data['priority']}")
                    results.append(("PUT /api/tasks/:id", "PASS"))
                else:
                    print("✗ Priority not updated")
                    results.append(("PUT /api/tasks/:id", "FAIL"))
            else:
                print(f"✗ Status code: {response.status_code}")
                results.append(("PUT /api/tasks/:id", "FAIL"))
        except Exception as e:
            print(f"✗ Error: {e}")
            results.append(("PUT /api/tasks/:id", "FAIL"))
    else:
        print("✗ Skipped (no task created)")
        results.append(("PUT /api/tasks/:id", "SKIP"))

    # Test 4: DELETE /api/tasks/:id
    print("\n=== Test 4: DELETE /api/tasks/:id ===")
    if created_task_id:
        try:
            response = requests.delete(f"{BASE_URL}/api/tasks/{created_task_id}")
            if response.status_code == 204:
                # Verify task is gone
                board_response = requests.get(f"{BASE_URL}/api/board")
                board_data = board_response.json()
                task_exists = any(t['id'] == created_task_id for t in board_data['tasks'])
                if not task_exists:
                    print(f"✓ Task deleted successfully")
                    results.append(("DELETE /api/tasks/:id", "PASS"))
                else:
                    print("✗ Task still exists after deletion")
                    results.append(("DELETE /api/tasks/:id", "FAIL"))
            else:
                print(f"✗ Status code: {response.status_code}")
                results.append(("DELETE /api/tasks/:id", "FAIL"))
        except Exception as e:
            print(f"✗ Error: {e}")
            results.append(("DELETE /api/tasks/:id", "FAIL"))
    else:
        print("✗ Skipped (no task created)")
        results.append(("DELETE /api/tasks/:id", "SKIP"))

    # Print summary
    print("\n" + "=" * 50)
    print("API TEST SUMMARY")
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
    success = test_api()
    sys.exit(0 if success else 1)
