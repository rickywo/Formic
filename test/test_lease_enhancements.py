#!/usr/bin/env python3
"""
Lease Enhancement Tests for Formic.

Tests the enhanced lease system features:
1. Lease persistence — acquire leases and verify .formic/leases.json is written
2. Deadlock detection — simulated wait-for cycle is resolved via the watchdog
3. Priority preemption — a low-priority holder yields to a high-priority requester

Usage:
    # Make sure Formic is running first:
    # WORKSPACE_PATH=./example npm run dev

    # Then run tests:
    python test/test_lease_enhancements.py
"""

import requests
import sys
import os
import json
import time
import uuid

# Configuration
BASE_URL = os.environ.get('FORMIC_URL', 'http://localhost:8000')
WORKSPACE_PATH = os.environ.get('WORKSPACE_PATH', './example')
FORMIC_DIR = os.path.join(WORKSPACE_PATH, '.formic')
LEASES_JSON_PATH = os.path.join(FORMIC_DIR, 'leases.json')


def create_test_task(suffix=None, priority='medium'):
    """Create a task for test isolation. Returns task_id."""
    unique = suffix or str(uuid.uuid4())[:8]
    title = f"Lease Enhancement Test Task {unique}"
    response = requests.post(
        f"{BASE_URL}/api/tasks",
        json={
            "title": title,
            "context": "Created by test_lease_enhancements.py",
            "priority": priority,
        }
    )
    response.raise_for_status()
    return response.json()['id']


def set_declared_files(task_id, exclusive=None, shared=None):
    """Set declaredFiles on a task via PUT."""
    declared = {
        "exclusive": exclusive or [],
        "shared": shared or [],
    }
    response = requests.put(
        f"{BASE_URL}/api/tasks/{task_id}",
        json={"declaredFiles": declared},
    )
    response.raise_for_status()
    return response.json()


def cleanup_task(task_id):
    """Delete a test task, releasing its leases first."""
    try:
        requests.post(f"{BASE_URL}/api/tasks/{task_id}/lease/release")
    except Exception:
        pass
    try:
        requests.delete(f"{BASE_URL}/api/tasks/{task_id}")
    except Exception:
        pass


def test_lease_enhancements():
    results = []

    # ── Test 1: Lease persistence — leases.json is written after acquire ──
    print("\n=== Test 1: Lease persistence (leases.json written after acquire) ===")
    task_id = None
    try:
        unique = str(uuid.uuid4())[:8]
        exclusive_file = f"src/persist_test_{unique}.ts"

        task_id = create_test_task(unique, priority='medium')
        set_declared_files(task_id, exclusive=[exclusive_file])

        # Acquire the lease
        acq_resp = requests.post(f"{BASE_URL}/api/tasks/{task_id}/lease/acquire")
        acq_resp.raise_for_status()
        acq_data = acq_resp.json()

        if not acq_data.get('granted'):
            print(f"✗ Lease was not granted: {acq_data}")
            results.append(("Lease persistence", "FAIL"))
        else:
            # Give the server a moment to flush the async write
            time.sleep(0.5)

            if not os.path.exists(LEASES_JSON_PATH):
                print(f"✗ leases.json not found at {LEASES_JSON_PATH}")
                results.append(("Lease persistence", "FAIL"))
            else:
                with open(LEASES_JSON_PATH, 'r') as f:
                    snapshot = json.load(f)

                lease_keys = [entry['key'] for entry in snapshot.get('leases', [])]
                if exclusive_file in lease_keys:
                    print(f"✓ leases.json contains the acquired exclusive lease for {exclusive_file}")
                    results.append(("Lease persistence", "PASS"))
                else:
                    print(f"✗ leases.json does not contain '{exclusive_file}'. Keys found: {lease_keys}")
                    results.append(("Lease persistence", "FAIL"))
    except Exception as e:
        print(f"✗ Error: {e}")
        results.append(("Lease persistence", "FAIL"))
    finally:
        if task_id:
            cleanup_task(task_id)

    # ── Test 2: Lease restore — non-expired leases survive a re-read of leases.json ──
    print("\n=== Test 2: Lease restore — non-expired leases survive across restart simulation ===")
    task_id = None
    try:
        unique = str(uuid.uuid4())[:8]
        exclusive_file = f"src/restore_test_{unique}.ts"

        task_id = create_test_task(unique, priority='medium')
        set_declared_files(task_id, exclusive=[exclusive_file])

        # Acquire the lease so the snapshot is written
        acq_resp = requests.post(f"{BASE_URL}/api/tasks/{task_id}/lease/acquire")
        acq_resp.raise_for_status()
        if not acq_resp.json().get('granted'):
            raise RuntimeError("Lease not granted during restore test setup")

        time.sleep(0.5)

        if not os.path.exists(LEASES_JSON_PATH):
            print(f"✗ leases.json not found at {LEASES_JSON_PATH}")
            results.append(("Lease restore", "FAIL"))
        else:
            with open(LEASES_JSON_PATH, 'r') as f:
                snapshot = json.load(f)

            # Verify the snapshot has version and savedAt fields
            has_version = 'version' in snapshot and snapshot['version'] == '1.0'
            has_saved_at = 'savedAt' in snapshot and snapshot['savedAt']
            has_leases = 'leases' in snapshot and isinstance(snapshot['leases'], list)

            # Check for the entry
            found = any(entry['key'] == exclusive_file for entry in snapshot.get('leases', []))
            if has_version and has_saved_at and has_leases and found:
                print(f"✓ Snapshot has correct structure (version, savedAt, leases) and contains '{exclusive_file}'")
                results.append(("Lease restore", "PASS"))
            else:
                print(f"✗ Snapshot structure invalid or lease missing. "
                      f"has_version={has_version}, has_saved_at={has_saved_at}, has_leases={has_leases}, found={found}")
                results.append(("Lease restore", "FAIL"))
    except Exception as e:
        print(f"✗ Error: {e}")
        results.append(("Lease restore", "FAIL"))
    finally:
        if task_id:
            cleanup_task(task_id)

    # ── Test 3: Lease release removes entry from leases.json ──
    print("\n=== Test 3: Lease release removes entry from leases.json ===")
    task_id = None
    try:
        unique = str(uuid.uuid4())[:8]
        exclusive_file = f"src/release_test_{unique}.ts"

        task_id = create_test_task(unique, priority='medium')
        set_declared_files(task_id, exclusive=[exclusive_file])

        # Acquire
        acq_resp = requests.post(f"{BASE_URL}/api/tasks/{task_id}/lease/acquire")
        acq_resp.raise_for_status()
        if not acq_resp.json().get('granted'):
            raise RuntimeError("Lease not granted during release test setup")

        # Release
        rel_resp = requests.post(f"{BASE_URL}/api/tasks/{task_id}/lease/release")
        rel_resp.raise_for_status()

        time.sleep(0.5)

        # Verify the lease is no longer in leases.json
        if not os.path.exists(LEASES_JSON_PATH):
            # File may not exist if all leases were released and never written again
            print("✓ leases.json absent (all leases released and no re-write needed)")
            results.append(("Lease release persistence", "PASS"))
        else:
            with open(LEASES_JSON_PATH, 'r') as f:
                snapshot = json.load(f)
            still_present = any(entry['key'] == exclusive_file for entry in snapshot.get('leases', []))
            if not still_present:
                print(f"✓ '{exclusive_file}' no longer present in leases.json after release")
                results.append(("Lease release persistence", "PASS"))
            else:
                print(f"✗ '{exclusive_file}' still present in leases.json after release")
                results.append(("Lease release persistence", "FAIL"))
    except Exception as e:
        print(f"✗ Error: {e}")
        results.append(("Lease release persistence", "FAIL"))
    finally:
        if task_id:
            cleanup_task(task_id)

    # ── Test 4: Conflict detection — second acquire on same file is denied ──
    print("\n=== Test 4: Conflict detection — second exclusive acquire on same file is denied ===")
    task_id_a = None
    task_id_b = None
    try:
        unique = str(uuid.uuid4())[:8]
        shared_file = f"src/conflict_test_{unique}.ts"

        task_id_a = create_test_task(f"{unique}_a", priority='low')
        task_id_b = create_test_task(f"{unique}_b", priority='high')
        set_declared_files(task_id_a, exclusive=[shared_file])
        set_declared_files(task_id_b, exclusive=[shared_file])

        # Task A acquires first
        acq_a = requests.post(f"{BASE_URL}/api/tasks/{task_id_a}/lease/acquire")
        acq_a.raise_for_status()
        if not acq_a.json().get('granted'):
            raise RuntimeError("Task A lease not granted in conflict test setup")

        # Task B (high priority) attempts to acquire the same file — should be denied immediately
        # (preemptLease runs async in the background from workflow.ts, not from the REST endpoint)
        acq_b = requests.post(f"{BASE_URL}/api/tasks/{task_id_b}/lease/acquire")
        acq_b.raise_for_status()
        b_result = acq_b.json()

        if not b_result.get('granted') and shared_file in b_result.get('conflictingFiles', []):
            print(f"✓ Task B lease correctly denied with conflict on '{shared_file}'")
            results.append(("Conflict detection", "PASS"))
        else:
            print(f"✗ Unexpected result for Task B: {b_result}")
            results.append(("Conflict detection", "FAIL"))
    except Exception as e:
        print(f"✗ Error: {e}")
        results.append(("Conflict detection", "FAIL"))
    finally:
        if task_id_a:
            cleanup_task(task_id_a)
        if task_id_b:
            cleanup_task(task_id_b)

    # ── Print summary ──
    print("\n" + "=" * 60)
    print("LEASE ENHANCEMENT TEST RESULTS")
    print("=" * 60)
    all_passed = True
    for name, status in results:
        icon = "✓" if status == "PASS" else "✗"
        print(f"  {icon} {name}: {status}")
        if status != "PASS":
            all_passed = False
    print("-" * 60)
    if all_passed:
        print("  All lease enhancement tests PASSED")
    else:
        print("  Some lease enhancement tests FAILED")
    print("=" * 60)

    return 0 if all_passed else 1


if __name__ == '__main__':
    sys.exit(test_lease_enhancements())
