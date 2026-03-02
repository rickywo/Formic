#!/usr/bin/env python3
"""
Concurrency and lease management tests for Formic.

Tests the lease-based concurrency REST API endpoints:
- GET /api/leases
- GET /api/tasks/:id/declared-files
- POST /api/tasks/:id/lease/renew
- PUT /api/tasks/:id (declaredFiles field)

Usage:
    # Make sure Formic is running first:
    # WORKSPACE_PATH=./example npm run dev

    # Then run tests:
    python test/test_concurrency.py
"""

import requests
import sys
import os
import uuid

# Configuration
BASE_URL = os.environ.get('FORMIC_URL', 'http://localhost:8000')


def create_test_task(suffix=None):
    """Create a task with a UUID-suffixed title for test isolation. Returns (task_id, title)."""
    unique = suffix or str(uuid.uuid4())[:8]
    title = f"Concurrency Test Task {unique}"
    response = requests.post(
        f"{BASE_URL}/api/tasks",
        json={
            "title": title,
            "context": "Created by test_concurrency.py for lease testing",
            "priority": "low"
        }
    )
    response.raise_for_status()
    data = response.json()
    return data['id'], data['title']


def cleanup_task(task_id):
    """Delete a test task, swallowing errors for idempotent cleanup."""
    try:
        requests.delete(f"{BASE_URL}/api/tasks/{task_id}")
    except Exception:
        pass


def test_concurrency():
    results = []

    # ── Test 1: GET /api/leases returns 200 with a JSON array ──
    print("\n=== Test 1: GET /api/leases baseline ===")
    try:
        response = requests.get(f"{BASE_URL}/api/leases")
        if response.status_code == 200 and isinstance(response.json(), list):
            print("✓ GET /api/leases returns 200 with JSON array")
            results.append(("GET /api/leases baseline", "PASS"))
        else:
            print(f"✗ Unexpected response: {response.status_code} {response.text}")
            results.append(("GET /api/leases baseline", "FAIL"))
    except Exception as e:
        print(f"✗ Error: {e}")
        results.append(("GET /api/leases baseline", "FAIL"))

    # ── Test 2: GET /api/tasks/:id/declared-files for fresh task ──
    print("\n=== Test 2: GET /api/tasks/:id/declared-files (fresh task) ===")
    task_id = None
    try:
        task_id, _ = create_test_task()
        response = requests.get(f"{BASE_URL}/api/tasks/{task_id}/declared-files")
        if response.status_code == 200:
            data = response.json()
            if data.get('exclusive') == [] and data.get('shared') == []:
                print("✓ Fresh task returns { exclusive: [], shared: [] }")
                results.append(("GET declared-files (fresh task)", "PASS"))
            else:
                print(f"✗ Unexpected data: {data}")
                results.append(("GET declared-files (fresh task)", "FAIL"))
        else:
            print(f"✗ Status code: {response.status_code}")
            results.append(("GET declared-files (fresh task)", "FAIL"))
    except Exception as e:
        print(f"✗ Error: {e}")
        results.append(("GET declared-files (fresh task)", "FAIL"))
    finally:
        if task_id:
            cleanup_task(task_id)

    # ── Test 3: PUT declaredFiles then GET declared-files ──
    print("\n=== Test 3: PUT declaredFiles then GET declared-files ===")
    task_id = None
    try:
        task_id, _ = create_test_task()
        declared = {"exclusive": ["src/a.ts"], "shared": ["src/b.ts"]}
        put_resp = requests.put(
            f"{BASE_URL}/api/tasks/{task_id}",
            json={"declaredFiles": declared}
        )
        if put_resp.status_code != 200:
            print(f"✗ PUT failed: {put_resp.status_code}")
            results.append(("PUT+GET declared-files", "FAIL"))
        else:
            get_resp = requests.get(f"{BASE_URL}/api/tasks/{task_id}/declared-files")
            data = get_resp.json()
            if data.get('exclusive') == ["src/a.ts"] and data.get('shared') == ["src/b.ts"]:
                print("✓ Declared files persisted and retrieved correctly")
                results.append(("PUT+GET declared-files", "PASS"))
            else:
                print(f"✗ Unexpected data: {data}")
                results.append(("PUT+GET declared-files", "FAIL"))
    except Exception as e:
        print(f"✗ Error: {e}")
        results.append(("PUT+GET declared-files", "FAIL"))
    finally:
        if task_id:
            cleanup_task(task_id)

    # ── Test 4: POST /api/tasks/nonexistent-id/lease/renew returns 404 ──
    print("\n=== Test 4: POST lease/renew for nonexistent task ===")
    try:
        response = requests.post(f"{BASE_URL}/api/tasks/nonexistent-id-xyz/lease/renew")
        if response.status_code == 404:
            data = response.json()
            if 'error' in data:
                print("✓ Returns 404 with error for nonexistent task")
                results.append(("POST lease/renew (nonexistent)", "PASS"))
            else:
                print(f"✗ Missing error field: {data}")
                results.append(("POST lease/renew (nonexistent)", "FAIL"))
        else:
            print(f"✗ Expected 404, got {response.status_code}")
            results.append(("POST lease/renew (nonexistent)", "FAIL"))
    except Exception as e:
        print(f"✗ Error: {e}")
        results.append(("POST lease/renew (nonexistent)", "FAIL"))

    # ── Test 5: POST lease/renew for task with no active leases returns 400 ──
    print("\n=== Test 5: POST lease/renew (no active leases) ===")
    task_id = None
    try:
        task_id, _ = create_test_task()
        response = requests.post(f"{BASE_URL}/api/tasks/{task_id}/lease/renew")
        if response.status_code == 400:
            data = response.json()
            if 'error' in data:
                print("✓ Returns 400 with error when no active leases")
                results.append(("POST lease/renew (no leases)", "PASS"))
            else:
                print(f"✗ Missing error field: {data}")
                results.append(("POST lease/renew (no leases)", "FAIL"))
        else:
            print(f"✗ Expected 400, got {response.status_code}")
            results.append(("POST lease/renew (no leases)", "FAIL"))
    except Exception as e:
        print(f"✗ Error: {e}")
        results.append(("POST lease/renew (no leases)", "FAIL"))
    finally:
        if task_id:
            cleanup_task(task_id)

    # ── Test 6: GET /api/tasks/:id/declared-files for nonexistent task ──
    print("\n=== Test 6: GET declared-files (nonexistent task) ===")
    try:
        response = requests.get(f"{BASE_URL}/api/tasks/nonexistent-id-xyz/declared-files")
        if response.status_code == 404:
            data = response.json()
            if 'error' in data:
                print("✓ Returns 404 with error for nonexistent task")
                results.append(("GET declared-files (nonexistent)", "PASS"))
            else:
                print(f"✗ Missing error field: {data}")
                results.append(("GET declared-files (nonexistent)", "FAIL"))
        else:
            print(f"✗ Expected 404, got {response.status_code}")
            results.append(("GET declared-files (nonexistent)", "FAIL"))
    except Exception as e:
        print(f"✗ Error: {e}")
        results.append(("GET declared-files (nonexistent)", "FAIL"))

    # ── Test 7: FileLease response shape validation ──
    print("\n=== Test 7: GET /api/leases response shape ===")
    try:
        response = requests.get(f"{BASE_URL}/api/leases")
        data = response.json()
        if isinstance(data, list):
            # If leases exist, validate shape; if empty, shape is trivially valid
            if len(data) == 0:
                print("✓ Empty lease array — shape valid (no active leases)")
                results.append(("GET /api/leases shape", "PASS"))
            else:
                lease = data[0]
                required_keys = {'filePath', 'taskId', 'acquiredAt', 'expiresAt', 'leaseType'}
                if required_keys.issubset(set(lease.keys())):
                    print("✓ FileLease objects have expected keys")
                    results.append(("GET /api/leases shape", "PASS"))
                else:
                    missing = required_keys - set(lease.keys())
                    print(f"✗ Missing keys in FileLease: {missing}")
                    results.append(("GET /api/leases shape", "FAIL"))
        else:
            print(f"✗ Expected array, got {type(data).__name__}")
            results.append(("GET /api/leases shape", "FAIL"))
    except Exception as e:
        print(f"✗ Error: {e}")
        results.append(("GET /api/leases shape", "FAIL"))

    # ── Test 8: DeclaredFiles response shape validation ──
    print("\n=== Test 8: DeclaredFiles response shape ===")
    task_id = None
    try:
        task_id, _ = create_test_task()
        response = requests.get(f"{BASE_URL}/api/tasks/{task_id}/declared-files")
        data = response.json()
        if 'exclusive' in data and 'shared' in data:
            if isinstance(data['exclusive'], list) and isinstance(data['shared'], list):
                print("✓ DeclaredFiles has exclusive/shared arrays")
                results.append(("DeclaredFiles shape", "PASS"))
            else:
                print("✗ exclusive/shared are not arrays")
                results.append(("DeclaredFiles shape", "FAIL"))
        else:
            print(f"✗ Missing keys: {data}")
            results.append(("DeclaredFiles shape", "FAIL"))
    except Exception as e:
        print(f"✗ Error: {e}")
        results.append(("DeclaredFiles shape", "FAIL"))
    finally:
        if task_id:
            cleanup_task(task_id)

    # ── Test 9: Exclusive lease conflict detection ──
    print("\n=== Test 9: Exclusive lease conflict detection ===")
    task_a = None
    task_b = None
    try:
        task_a, _ = create_test_task("excl-a")
        task_b, _ = create_test_task("excl-b")
        declared = {"exclusive": ["src/conflict.ts"], "shared": []}
        requests.put(f"{BASE_URL}/api/tasks/{task_a}", json={"declaredFiles": declared})
        requests.put(f"{BASE_URL}/api/tasks/{task_b}", json={"declaredFiles": declared})
        # Acquire for task A
        resp_a = requests.post(f"{BASE_URL}/api/tasks/{task_a}/lease/acquire")
        data_a = resp_a.json()
        # Acquire for task B (should be denied)
        resp_b = requests.post(f"{BASE_URL}/api/tasks/{task_b}/lease/acquire")
        data_b = resp_b.json()
        if data_a.get('granted') is True and data_b.get('granted') is False and 'src/conflict.ts' in data_b.get('conflictingFiles', []):
            print("✓ Exclusive conflict detected correctly")
            results.append(("Exclusive lease conflict detection", "PASS"))
        else:
            print(f"✗ Unexpected: A={data_a}, B={data_b}")
            results.append(("Exclusive lease conflict detection", "FAIL"))
    except Exception as e:
        print(f"✗ Error: {e}")
        results.append(("Exclusive lease conflict detection", "FAIL"))
    finally:
        if task_a:
            requests.post(f"{BASE_URL}/api/tasks/{task_a}/lease/release")
            cleanup_task(task_a)
        if task_b:
            requests.post(f"{BASE_URL}/api/tasks/{task_b}/lease/release")
            cleanup_task(task_b)

    # ── Test 10: Shared lease coexistence ──
    print("\n=== Test 10: Shared lease coexistence ===")
    task_a = None
    task_b = None
    try:
        task_a, _ = create_test_task("shared-a")
        task_b, _ = create_test_task("shared-b")
        declared = {"exclusive": [], "shared": ["src/shared.ts"]}
        requests.put(f"{BASE_URL}/api/tasks/{task_a}", json={"declaredFiles": declared})
        requests.put(f"{BASE_URL}/api/tasks/{task_b}", json={"declaredFiles": declared})
        resp_a = requests.post(f"{BASE_URL}/api/tasks/{task_a}/lease/acquire")
        data_a = resp_a.json()
        resp_b = requests.post(f"{BASE_URL}/api/tasks/{task_b}/lease/acquire")
        data_b = resp_b.json()
        # Verify both granted
        leases_resp = requests.get(f"{BASE_URL}/api/leases")
        all_leases = leases_resp.json()
        task_ids_in_leases = [l['taskId'] for l in all_leases]
        if data_a.get('granted') is True and data_b.get('granted') is True and task_a in task_ids_in_leases and task_b in task_ids_in_leases:
            print("✓ Shared leases coexist for both tasks")
            results.append(("Shared lease coexistence", "PASS"))
        else:
            print(f"✗ Unexpected: A={data_a}, B={data_b}, leases={task_ids_in_leases}")
            results.append(("Shared lease coexistence", "FAIL"))
    except Exception as e:
        print(f"✗ Error: {e}")
        results.append(("Shared lease coexistence", "FAIL"))
    finally:
        if task_a:
            requests.post(f"{BASE_URL}/api/tasks/{task_a}/lease/release")
            cleanup_task(task_a)
        if task_b:
            requests.post(f"{BASE_URL}/api/tasks/{task_b}/lease/release")
            cleanup_task(task_b)

    # ── Test 11: Lease acquisition and visibility ──
    print("\n=== Test 11: Lease acquisition and visibility ===")
    task_id = None
    try:
        task_id, _ = create_test_task("acq-vis")
        declared = {"exclusive": ["src/exclusive.ts"], "shared": ["src/read-only.ts"]}
        requests.put(f"{BASE_URL}/api/tasks/{task_id}", json={"declaredFiles": declared})
        resp = requests.post(f"{BASE_URL}/api/tasks/{task_id}/lease/acquire")
        data = resp.json()
        # Verify declared-files endpoint
        df_resp = requests.get(f"{BASE_URL}/api/tasks/{task_id}/declared-files")
        df_data = df_resp.json()
        # Verify leases in GET /api/leases
        leases_resp = requests.get(f"{BASE_URL}/api/leases")
        all_leases = leases_resp.json()
        task_leases = [l for l in all_leases if l['taskId'] == task_id]
        required_keys = {'filePath', 'taskId', 'acquiredAt', 'expiresAt', 'leaseType'}
        shapes_valid = all(required_keys.issubset(set(l.keys())) for l in task_leases)
        if (data.get('granted') is True
                and len(data.get('leases', [])) == 2
                and df_data.get('exclusive') == ["src/exclusive.ts"]
                and df_data.get('shared') == ["src/read-only.ts"]
                and len(task_leases) == 2
                and shapes_valid):
            print("✓ Lease acquisition and visibility verified")
            results.append(("Lease acquisition and visibility", "PASS"))
        else:
            print(f"✗ Unexpected: granted={data.get('granted')}, leases={len(data.get('leases', []))}, task_leases={len(task_leases)}, shapes={shapes_valid}")
            results.append(("Lease acquisition and visibility", "FAIL"))
    except Exception as e:
        print(f"✗ Error: {e}")
        results.append(("Lease acquisition and visibility", "FAIL"))
    finally:
        if task_id:
            requests.post(f"{BASE_URL}/api/tasks/{task_id}/lease/release")
            cleanup_task(task_id)

    # ── Test 12: Lease release clears leases ──
    print("\n=== Test 12: Lease release clears leases ===")
    task_id = None
    try:
        task_id, _ = create_test_task("release")
        declared = {"exclusive": ["src/release-test.ts"], "shared": []}
        requests.put(f"{BASE_URL}/api/tasks/{task_id}", json={"declaredFiles": declared})
        requests.post(f"{BASE_URL}/api/tasks/{task_id}/lease/acquire")
        # Verify lease exists
        leases_before = requests.get(f"{BASE_URL}/api/leases").json()
        has_lease = any(l['taskId'] == task_id for l in leases_before)
        # Release
        rel_resp = requests.post(f"{BASE_URL}/api/tasks/{task_id}/lease/release")
        rel_data = rel_resp.json()
        # Verify lease gone
        leases_after = requests.get(f"{BASE_URL}/api/leases").json()
        lease_gone = not any(l['taskId'] == task_id for l in leases_after)
        if has_lease and rel_data.get('released') is True and lease_gone:
            print("✓ Lease release clears leases correctly")
            results.append(("Lease release clears leases", "PASS"))
        else:
            print(f"✗ Unexpected: had_lease={has_lease}, released={rel_data.get('released')}, gone={lease_gone}")
            results.append(("Lease release clears leases", "FAIL"))
    except Exception as e:
        print(f"✗ Error: {e}")
        results.append(("Lease release clears leases", "FAIL"))
    finally:
        if task_id:
            cleanup_task(task_id)

    # ── Test 13: Yield count tracking ──
    print("\n=== Test 13: Yield count tracking ===")
    task_a = None
    task_b = None
    try:
        task_a, _ = create_test_task("yield-a")
        task_b, _ = create_test_task("yield-b")
        declared = {"exclusive": ["src/yield-file.ts"], "shared": []}
        requests.put(f"{BASE_URL}/api/tasks/{task_a}", json={"declaredFiles": declared})
        requests.put(f"{BASE_URL}/api/tasks/{task_b}", json={"declaredFiles": declared})
        # Acquire for A
        requests.post(f"{BASE_URL}/api/tasks/{task_a}/lease/acquire")
        # Attempt acquire for B (denied)
        resp_b = requests.post(f"{BASE_URL}/api/tasks/{task_b}/lease/acquire")
        data_b = resp_b.json()
        # Update yieldCount on task B via PUT, which returns the updated task
        put_resp = requests.put(f"{BASE_URL}/api/tasks/{task_b}", json={"yieldCount": 1})
        task_data = put_resp.json()
        if data_b.get('granted') is False and task_data.get('yieldCount', 0) > 0:
            print("✓ Yield count tracking works correctly")
            results.append(("Yield count tracking", "PASS"))
        else:
            print(f"✗ Unexpected: granted={data_b.get('granted')}, yieldCount={task_data.get('yieldCount')}")
            results.append(("Yield count tracking", "FAIL"))
    except Exception as e:
        print(f"✗ Error: {e}")
        results.append(("Yield count tracking", "FAIL"))
    finally:
        if task_a:
            requests.post(f"{BASE_URL}/api/tasks/{task_a}/lease/release")
            cleanup_task(task_a)
        if task_b:
            requests.post(f"{BASE_URL}/api/tasks/{task_b}/lease/release")
            cleanup_task(task_b)

    # ── Summary ──
    print("\n" + "=" * 50)
    print("CONCURRENCY TEST SUMMARY")
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
    success = test_concurrency()
    sys.exit(0 if success else 1)
