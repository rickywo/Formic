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

    # ============================================================
    # Tests for PUT /api/tasks/:id field whitelist and validation
    # ============================================================

    # Create a fresh task for the whitelist/validation tests
    whitelist_task_id = None
    try:
        response = requests.post(
            f"{BASE_URL}/api/tasks",
            json={
                "title": f"Whitelist Validation Test {unique_id}",
                "context": "Testing field whitelist and value validation on PUT",
                "priority": "medium"
            }
        )
        if response.status_code in [200, 201]:
            whitelist_task_id = response.json().get('id')
            print(f"\n✓ Created test task for whitelist tests: {whitelist_task_id}")
        else:
            print(f"\n✗ Failed to create test task for whitelist tests: {response.status_code}")
    except Exception as e:
        print(f"\n✗ Error creating test task for whitelist tests: {e}")

    if whitelist_task_id:
        # Test 5a: Reject unknown field 'pid'
        print("\n=== Test 5a: PUT with unknown field 'pid' → 400 ===")
        try:
            response = requests.put(
                f"{BASE_URL}/api/tasks/{whitelist_task_id}",
                json={"pid": 9999}
            )
            if response.status_code == 400:
                print(f"✓ Correctly rejected unknown 'pid' field (400)")
                results.append(("PUT whitelist: reject 'pid'", "PASS"))
            else:
                print(f"✗ Expected 400, got {response.status_code}: {response.text}")
                results.append(("PUT whitelist: reject 'pid'", "FAIL"))
        except Exception as e:
            print(f"✗ Error: {e}")
            results.append(("PUT whitelist: reject 'pid'", "FAIL"))

        # Test 5b: Reject unknown field 'retryCount'
        print("\n=== Test 5b: PUT with unknown field 'retryCount' → 400 ===")
        try:
            response = requests.put(
                f"{BASE_URL}/api/tasks/{whitelist_task_id}",
                json={"retryCount": 5}
            )
            if response.status_code == 400:
                print(f"✓ Correctly rejected unknown 'retryCount' field (400)")
                results.append(("PUT whitelist: reject 'retryCount'", "PASS"))
            else:
                print(f"✗ Expected 400, got {response.status_code}: {response.text}")
                results.append(("PUT whitelist: reject 'retryCount'", "FAIL"))
        except Exception as e:
            print(f"✗ Error: {e}")
            results.append(("PUT whitelist: reject 'retryCount'", "FAIL"))

        # Test 5c: Reject unknown field 'agentLogs'
        print("\n=== Test 5c: PUT with unknown field 'agentLogs' → 400 ===")
        try:
            response = requests.put(
                f"{BASE_URL}/api/tasks/{whitelist_task_id}",
                json={"agentLogs": ["fake log"]}
            )
            if response.status_code == 400:
                print(f"✓ Correctly rejected unknown 'agentLogs' field (400)")
                results.append(("PUT whitelist: reject 'agentLogs'", "PASS"))
            else:
                print(f"✗ Expected 400, got {response.status_code}: {response.text}")
                results.append(("PUT whitelist: reject 'agentLogs'", "FAIL"))
        except Exception as e:
            print(f"✗ Error: {e}")
            results.append(("PUT whitelist: reject 'agentLogs'", "FAIL"))

        # Test 5d: Reject invalid status value
        print("\n=== Test 5d: PUT with invalid status 'bogus' → 400 ===")
        try:
            response = requests.put(
                f"{BASE_URL}/api/tasks/{whitelist_task_id}",
                json={"status": "bogus"}
            )
            if response.status_code == 400:
                print(f"✓ Correctly rejected invalid status 'bogus' (400)")
                results.append(("PUT validation: reject invalid status", "PASS"))
            else:
                print(f"✗ Expected 400, got {response.status_code}: {response.text}")
                results.append(("PUT validation: reject invalid status", "FAIL"))
        except Exception as e:
            print(f"✗ Error: {e}")
            results.append(("PUT validation: reject invalid status", "FAIL"))

        # Test 5e: Reject invalid priority value
        print("\n=== Test 5e: PUT with invalid priority 'urgent' → 400 ===")
        try:
            response = requests.put(
                f"{BASE_URL}/api/tasks/{whitelist_task_id}",
                json={"priority": "urgent"}
            )
            if response.status_code == 400:
                print(f"✓ Correctly rejected invalid priority 'urgent' (400)")
                results.append(("PUT validation: reject invalid priority", "PASS"))
            else:
                print(f"✗ Expected 400, got {response.status_code}: {response.text}")
                results.append(("PUT validation: reject invalid priority", "FAIL"))
        except Exception as e:
            print(f"✗ Error: {e}")
            results.append(("PUT validation: reject invalid priority", "FAIL"))

        # Test 5f: Reject invalid type value
        print("\n=== Test 5f: PUT with invalid type 'epic' → 400 ===")
        try:
            response = requests.put(
                f"{BASE_URL}/api/tasks/{whitelist_task_id}",
                json={"type": "epic"}
            )
            if response.status_code == 400:
                print(f"✓ Correctly rejected invalid type 'epic' (400)")
                results.append(("PUT validation: reject invalid type", "PASS"))
            else:
                print(f"✗ Expected 400, got {response.status_code}: {response.text}")
                results.append(("PUT validation: reject invalid type", "FAIL"))
        except Exception as e:
            print(f"✗ Error: {e}")
            results.append(("PUT validation: reject invalid type", "FAIL"))

        # Test 5g: Successful partial update with allowed fields
        print("\n=== Test 5g: PUT with allowed fields → 200 ===")
        try:
            response = requests.put(
                f"{BASE_URL}/api/tasks/{whitelist_task_id}",
                json={"title": "Updated Title via Whitelist", "priority": "low"}
            )
            if response.status_code == 200:
                data = response.json()
                if data.get('title') == 'Updated Title via Whitelist' and data.get('priority') == 'low':
                    print(f"✓ Allowed fields updated successfully")
                    results.append(("PUT whitelist: allowed fields succeed", "PASS"))
                else:
                    print(f"✗ Fields not updated correctly: title={data.get('title')}, priority={data.get('priority')}")
                    results.append(("PUT whitelist: allowed fields succeed", "FAIL"))
            else:
                print(f"✗ Expected 200, got {response.status_code}: {response.text}")
                results.append(("PUT whitelist: allowed fields succeed", "FAIL"))
        except Exception as e:
            print(f"✗ Error: {e}")
            results.append(("PUT whitelist: allowed fields succeed", "FAIL"))

        # Test 5h: Verify internal fields were NOT overwritten by earlier rejection tests
        print("\n=== Test 5h: GET verifies internal fields unchanged ===")
        try:
            response = requests.get(f"{BASE_URL}/api/tasks/{whitelist_task_id}")
            if response.status_code == 200:
                data = response.json()
                # pid should not be 9999 (from test 5a)
                # retryCount should not be 5 (from test 5b)
                # agentLogs should not be ['fake log'] (from test 5c)
                checks_ok = True
                if data.get('pid') == 9999:
                    print(f"✗ pid was overwritten to 9999!")
                    checks_ok = False
                if data.get('retryCount') == 5:
                    print(f"✗ retryCount was overwritten to 5!")
                    checks_ok = False
                if data.get('agentLogs') == ['fake log']:
                    print(f"✗ agentLogs was overwritten!")
                    checks_ok = False
                if checks_ok:
                    print(f"✓ Internal fields (pid, retryCount, agentLogs) were NOT overwritten")
                    results.append(("PUT whitelist: internal fields protected", "PASS"))
                else:
                    results.append(("PUT whitelist: internal fields protected", "FAIL"))
            else:
                print(f"✗ GET failed: {response.status_code}")
                results.append(("PUT whitelist: internal fields protected", "FAIL"))
        except Exception as e:
            print(f"✗ Error: {e}")
            results.append(("PUT whitelist: internal fields protected", "FAIL"))

        # Clean up the whitelist test task
        try:
            requests.delete(f"{BASE_URL}/api/tasks/{whitelist_task_id}")
        except Exception:
            pass
    else:
        print("\n✗ Skipping whitelist/validation tests (no test task created)")
        results.append(("PUT whitelist: reject 'pid'", "SKIP"))
        results.append(("PUT whitelist: reject 'retryCount'", "SKIP"))
        results.append(("PUT whitelist: reject 'agentLogs'", "SKIP"))
        results.append(("PUT validation: reject invalid status", "SKIP"))
        results.append(("PUT validation: reject invalid priority", "SKIP"))
        results.append(("PUT validation: reject invalid type", "SKIP"))
        results.append(("PUT whitelist: allowed fields succeed", "SKIP"))
        results.append(("PUT whitelist: internal fields protected", "SKIP"))

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
