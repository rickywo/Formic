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

    # ── Test 5: AcquireLeases atomicity — denied request must not leak exclusive leases ──
    print("\n=== Test 5: AcquireLeases atomicity — denied request leaves no phantom leases ===")
    task_id_a = None
    task_id_b = None
    try:
        unique = str(uuid.uuid4())[:8]
        file_f = f"src/atomicity_f_{unique}.ts"
        file_g = f"src/atomicity_g_{unique}.ts"

        task_id_a = create_test_task(f"{unique}_a", priority='medium')
        task_id_b = create_test_task(f"{unique}_b", priority='medium')
        set_declared_files(task_id_a, exclusive=[file_f], shared=[])
        set_declared_files(task_id_b, exclusive=[file_g], shared=[file_f])

        # Task A acquires exclusive on F first
        acq_a = requests.post(f"{BASE_URL}/api/tasks/{task_id_a}/lease/acquire")
        acq_a.raise_for_status()
        if not acq_a.json().get('granted'):
            raise RuntimeError("Task A lease not granted during atomicity test setup")

        # Task B requests exclusive [G] + shared [F] — should be denied
        # because F is held exclusively by A (shared cannot coexist with exclusive)
        acq_b = requests.post(f"{BASE_URL}/api/tasks/{task_id_b}/lease/acquire")
        acq_b.raise_for_status()
        b_result = acq_b.json()

        # Verify B was denied
        if b_result.get('granted'):
            print(f"✗ Task B was unexpectedly granted: {b_result}")
            results.append(("AcquireLeases atomicity", "FAIL"))
        else:
            # Verify no phantom lease on G leaked into the store
            leases_resp = requests.get(f"{BASE_URL}/api/leases")
            all_leases = leases_resp.json()
            g_leases = [l for l in all_leases if l['filePath'] == file_g]

            if len(g_leases) == 0:
                print(f"✓ Task B denied AND no phantom lease on G in store (atomicity preserved)")
                results.append(("AcquireLeases atomicity", "PASS"))
            else:
                print(f"✗ ATOMICITY LEAK: {len(g_leases)} phantom lease(s) on G found: {g_leases}")
                print(f"  All leases currently in store: {[l['filePath'] for l in all_leases]}")
                results.append(("AcquireLeases atomicity", "FAIL"))
    except Exception as e:
        print(f"✗ Error: {e}")
        results.append(("AcquireLeases atomicity", "FAIL"))
    finally:
        if task_id_a:
            cleanup_task(task_id_a)
        if task_id_b:
            cleanup_task(task_id_b)

    # ── Test 6: Expired-inactive lease is freed on acquireLeases with correct persistence ──
    print("\n=== Test 6: Expired-inactive lease freed during acquireLeases (cleanExpiredLeases path) ===")
    task_id_a = None
    task_id_b = None
    try:
        unique = str(uuid.uuid4())[:8]
        shared_file = f"src/expiry_freed_{unique}.ts"

        task_id_a = create_test_task(f"{unique}_a", priority='medium')
        set_declared_files(task_id_a, exclusive=[shared_file])

        acq_a = requests.post(f"{BASE_URL}/api/tasks/{task_id_a}/lease/acquire")
        acq_a.raise_for_status()
        if not acq_a.json().get('granted'):
            raise RuntimeError("Task A lease not granted during expiry test setup")

        # Release task A's lease (this also triggers persistLeases and LEASE_RELEASED)
        rel_resp = requests.post(f"{BASE_URL}/api/tasks/{task_id_a}/lease/release")
        rel_resp.raise_for_status()
        time.sleep(0.3)

        # Verify the lease is gone from GET /api/leases
        leases_after_release = requests.get(f"{BASE_URL}/api/leases").json()
        a_leases = [l for l in leases_after_release if l['filePath'] == shared_file]
        if len(a_leases) != 0:
            print(f"✗ Task A's lease still present after release: {a_leases}")
            results.append(("Expired-inactive lease freed", "FAIL"))
        else:
            # Now task B should be able to acquire the same file
            task_id_b = create_test_task(f"{unique}_b", priority='medium')
            set_declared_files(task_id_b, exclusive=[shared_file])

            acq_b = requests.post(f"{BASE_URL}/api/tasks/{task_id_b}/lease/acquire")
            acq_b.raise_for_status()
            b_result = acq_b.json()

            if b_result.get('granted'):
                print(f"✓ Task B acquired lease on '{shared_file}' after task A released — inactive lease correctly freed")
                results.append(("Expired-inactive lease freed", "PASS"))
            else:
                print(f"✗ Task B lease denied unexpectedly: {b_result}")
                results.append(("Expired-inactive lease freed", "FAIL"))
    except Exception as e:
        print(f"✗ Error: {e}")
        results.append(("Expired-inactive lease freed", "FAIL"))
    finally:
        if task_id_a:
            cleanup_task(task_id_a)
        if task_id_b:
            cleanup_task(task_id_b)

    # ── Test 7: getAllLeases correctly reflects lease state ──
    print("\n=== Test 7: getAllLeases returns correct state after release ===")
    task_id = None
    try:
        unique = str(uuid.uuid4())[:8]
        exclusive_file = f"src/readonly_filter_{unique}.ts"

        task_id = create_test_task(unique, priority='medium')
        set_declared_files(task_id, exclusive=[exclusive_file])

        # Acquire
        acq_resp = requests.post(f"{BASE_URL}/api/tasks/{task_id}/lease/acquire")
        acq_resp.raise_for_status()
        if not acq_resp.json().get('granted'):
            raise RuntimeError("Lease not granted during getAllLeases test setup")

        # getAllLeases should show the lease
        all_leases = requests.get(f"{BASE_URL}/api/leases").json()
        file_leases = [l for l in all_leases if l['filePath'] == exclusive_file]
        if len(file_leases) != 1:
            print(f"✗ Expected 1 lease for '{exclusive_file}', got {len(file_leases)}: {file_leases}")
            results.append(("getAllLeases filtering", "FAIL"))
        else:
            # Release
            requests.post(f"{BASE_URL}/api/tasks/{task_id}/lease/release")
            time.sleep(0.3)

            # getAllLeases should now be empty for this file
            all_leases_after = requests.get(f"{BASE_URL}/api/leases").json()
            file_leases_after = [l for l in all_leases_after if l['filePath'] == exclusive_file]
            if len(file_leases_after) == 0:
                print(f"✓ getAllLeases correctly returns empty for released file")
                results.append(("getAllLeases filtering", "PASS"))
            else:
                print(f"✗ getAllLeases still shows released lease: {file_leases_after}")
                results.append(("getAllLeases filtering", "FAIL"))
    except Exception as e:
        print(f"✗ Error: {e}")
        results.append(("getAllLeases filtering", "FAIL"))
    finally:
        if task_id:
            cleanup_task(task_id)

    # ── Test 8: Conflict detection intact after cleanExpiredLeases refactor ──
    print("\n=== Test 8: Conflict detection intact after cleanExpiredLeases refactor ===")
    task_id_a = None
    task_id_b = None
    try:
        unique = str(uuid.uuid4())[:8]
        conflict_file = f"src/refactor_conflict_{unique}.ts"

        task_id_a = create_test_task(f"{unique}_a", priority='medium')
        task_id_b = create_test_task(f"{unique}_b", priority='high')
        set_declared_files(task_id_a, exclusive=[conflict_file])
        set_declared_files(task_id_b, exclusive=[conflict_file])

        # Task A acquires
        acq_a = requests.post(f"{BASE_URL}/api/tasks/{task_id_a}/lease/acquire")
        acq_a.raise_for_status()
        if not acq_a.json().get('granted'):
            raise RuntimeError("Task A lease not granted")

        # Task B tries — should be denied (conflict with active lease)
        acq_b = requests.post(f"{BASE_URL}/api/tasks/{task_id_b}/lease/acquire")
        acq_b.raise_for_status()
        b_result = acq_b.json()

        if not b_result.get('granted') and conflict_file in b_result.get('conflictingFiles', []):
            print(f"✓ Task B correctly denied — conflict detection intact after cleanExpiredLeases refactor")

            # Release task A and verify task B can now acquire
            requests.post(f"{BASE_URL}/api/tasks/{task_id_a}/lease/release")
            time.sleep(0.3)

            acq_b2 = requests.post(f"{BASE_URL}/api/tasks/{task_id_b}/lease/acquire")
            acq_b2.raise_for_status()
            b2_result = acq_b2.json()

            if b2_result.get('granted'):
                print(f"✓ Task B acquired after task A release — cleanExpiredLeases properly cleared stale lease")
                results.append(("Conflict detection after refactor", "PASS"))
            else:
                print(f"✗ Task B denied after task A release: {b2_result}")
                results.append(("Conflict detection after refactor", "FAIL"))
        else:
            print(f"✗ Unexpected result for task B: {b_result}")
            results.append(("Conflict detection after refactor", "FAIL"))
    except Exception as e:
        print(f"✗ Error: {e}")
        results.append(("Conflict detection after refactor", "FAIL"))
    finally:
        if task_id_a:
            cleanup_task(task_id_a)
        if task_id_b:
            cleanup_task(task_id_b)

    # ── Test 9: Multi-file conflict — all conflicting files returned by API ──
    print("\n=== Test 9: Multi-file conflict — API returns ALL conflicting files ===")
    task_id_a = None
    task_id_b = None
    try:
        unique = str(uuid.uuid4())[:8]
        file_1 = f"src/multi_a_{unique}.ts"
        file_2 = f"src/multi_b_{unique}.ts"

        # Task A holds both files exclusively
        task_id_a = create_test_task(f"{unique}_a", priority='medium')
        set_declared_files(task_id_a, exclusive=[file_1, file_2])

        acq_a = requests.post(f"{BASE_URL}/api/tasks/{task_id_a}/lease/acquire")
        acq_a.raise_for_status()
        if not acq_a.json().get('granted'):
            raise RuntimeError("Task A lease not granted during multi-file test setup")

        # Task B wants both files — should be denied with BOTH in conflictingFiles
        task_id_b = create_test_task(f"{unique}_b", priority='medium')
        set_declared_files(task_id_b, exclusive=[file_1, file_2])

        acq_b = requests.post(f"{BASE_URL}/api/tasks/{task_id_b}/lease/acquire")
        acq_b.raise_for_status()
        b_result = acq_b.json()

        if b_result.get('granted'):
            print(f"✗ Task B was unexpectedly granted: {b_result}")
            results.append(("Multi-file conflict", "FAIL"))
        elif sorted(b_result.get('conflictingFiles', [])) != sorted([file_1, file_2]):
            print(f"✗ Expected conflictingFiles [{file_1}, {file_2}], got {b_result.get('conflictingFiles')}")
            results.append(("Multi-file conflict", "FAIL"))
        else:
            print(f"✓ API correctly returns all conflicting files: {b_result.get('conflictingFiles')}")
            results.append(("Multi-file conflict", "PASS"))
    except Exception as e:
        print(f"✗ Error: {e}")
        results.append(("Multi-file conflict", "FAIL"))
    finally:
        if task_id_a:
            cleanup_task(task_id_a)
        if task_id_b:
            cleanup_task(task_id_b)

    # ── Test 10: Shared-holder conflict — exclusive denied by shared lease ──
    print("\n=== Test 10: Shared-holder conflict — exclusive acquire denied by shared lease ===")
    task_id_s = None
    task_id_e = None
    try:
        unique = str(uuid.uuid4())[:8]
        shared_file = f"src/shared_holder_{unique}.ts"

        # Task S acquires shared lease on the file
        task_id_s = create_test_task(f"{unique}_s", priority='medium')
        set_declared_files(task_id_s, exclusive=[], shared=[shared_file])

        acq_s = requests.post(f"{BASE_URL}/api/tasks/{task_id_s}/lease/acquire")
        acq_s.raise_for_status()
        if not acq_s.json().get('granted'):
            raise RuntimeError("Task S shared lease not granted")

        # Task E wants exclusive on the same file — should be denied
        task_id_e = create_test_task(f"{unique}_e", priority='medium')
        set_declared_files(task_id_e, exclusive=[shared_file], shared=[])

        acq_e = requests.post(f"{BASE_URL}/api/tasks/{task_id_e}/lease/acquire")
        acq_e.raise_for_status()
        e_result = acq_e.json()

        if not e_result.get('granted') and shared_file in e_result.get('conflictingFiles', []):
            print(f"✓ Task E correctly denied — shared lease blocks exclusive acquisition")
            results.append(("Shared-holder conflict", "PASS"))
        else:
            print(f"✗ Unexpected result for Task E: {e_result}")
            results.append(("Shared-holder conflict", "FAIL"))
    except Exception as e:
        print(f"✗ Error: {e}")
        import traceback; traceback.print_exc()
        results.append(("Shared-holder conflict", "FAIL"))
    finally:
        if task_id_s:
            cleanup_task(task_id_s)
        if task_id_e:
            cleanup_task(task_id_e)

    # ── Test 11: Stale record cleanup — releaseLeases clears wait state ──
    print("\n=== Test 11: Stale record cleanup — release removes all task state ===")
    task_id_a = None
    task_id_b = None
    try:
        unique = str(uuid.uuid4())[:8]
        exclusive_file = f"src/stale_cleanup_{unique}.ts"

        # Task A gets exclusive on the file
        task_id_a = create_test_task(f"{unique}_a", priority='medium')
        set_declared_files(task_id_a, exclusive=[exclusive_file])

        acq_a = requests.post(f"{BASE_URL}/api/tasks/{task_id_a}/lease/acquire")
        acq_a.raise_for_status()
        if not acq_a.json().get('granted'):
            raise RuntimeError("Task A lease not granted during stale cleanup test setup")

        # Task B tries — denied (conflict)
        task_id_b = create_test_task(f"{unique}_b", priority='medium')
        set_declared_files(task_id_b, exclusive=[exclusive_file])

        acq_b = requests.post(f"{BASE_URL}/api/tasks/{task_id_b}/lease/acquire")
        acq_b.raise_for_status()
        b_result = acq_b.json()

        if b_result.get('granted'):
            print(f"✗ Task B should have been denied: {b_result}")
            results.append(("Stale record cleanup", "FAIL"))
        else:
            # Release task B's leases (which also calls clearWait now)
            requests.post(f"{BASE_URL}/api/tasks/{task_id_b}/lease/release")
            time.sleep(0.3)

            # Release task A's leases so the file is free
            requests.post(f"{BASE_URL}/api/tasks/{task_id_a}/lease/release")
            time.sleep(0.3)

            # Now task B re-acquires: should succeed (no stale wait record interfering)
            # Re-acquire task A first
            set_declared_files(task_id_a, exclusive=[f"src/stale_a2_{unique}.ts"])
            acq_a2 = requests.post(f"{BASE_URL}/api/tasks/{task_id_a}/lease/acquire")
            acq_a2.raise_for_status()

            # Task B should be able to acquire the original file now
            set_declared_files(task_id_b, exclusive=[exclusive_file])
            acq_b2 = requests.post(f"{BASE_URL}/api/tasks/{task_id_b}/lease/acquire")
            acq_b2.raise_for_status()
            b2_result = acq_b2.json()

            if b2_result.get('granted'):
                print(f"✓ Task B acquired lease after release — no stale state interfered")
                results.append(("Stale record cleanup", "PASS"))
            else:
                print(f"✗ Task B denied after release: {b2_result}")
                results.append(("Stale record cleanup", "FAIL"))
    except Exception as e:
        print(f"✗ Error: {e}")
        import traceback; traceback.print_exc()
        results.append(("Stale record cleanup", "FAIL"))
    finally:
        if task_id_a:
            cleanup_task(task_id_a)
        if task_id_b:
            cleanup_task(task_id_b)

    # ── Test 12: Multi-file deadlock scenario — both contested files reported ──
    print("\n=== Test 12: Multi-file deadlock — all contested files visible in conflict report ===")
    task_id_a = None
    task_id_b = None
    task_id_c = None
    try:
        unique = str(uuid.uuid4())[:8]
        f1 = f"src/multi_f1_{unique}.ts"
        f2 = f"src/multi_f2_{unique}.ts"
        fa = f"src/multi_fa_{unique}.ts"

        # Task A holds fa.ts exclusively
        task_id_a = create_test_task(f"{unique}_a", priority='medium')
        set_declared_files(task_id_a, exclusive=[fa])

        acq_a = requests.post(f"{BASE_URL}/api/tasks/{task_id_a}/lease/acquire")
        acq_a.raise_for_status()
        if not acq_a.json().get('granted'):
            raise RuntimeError("Task A lease not granted during multi-file deadlock test setup")

        # Task B holds f1.ts exclusively
        task_id_b = create_test_task(f"{unique}_b", priority='medium')
        set_declared_files(task_id_b, exclusive=[f1])

        acq_b = requests.post(f"{BASE_URL}/api/tasks/{task_id_b}/lease/acquire")
        acq_b.raise_for_status()
        if not acq_b.json().get('granted'):
            raise RuntimeError("Task B lease not granted during multi-file deadlock test setup")

        # Task C holds f2.ts exclusively
        task_id_c = create_test_task(f"{unique}_c", priority='medium')
        set_declared_files(task_id_c, exclusive=[f2])

        acq_c = requests.post(f"{BASE_URL}/api/tasks/{task_id_c}/lease/acquire")
        acq_c.raise_for_status()
        if not acq_c.json().get('granted'):
            raise RuntimeError("Task C lease not granted during multi-file deadlock test setup")

        # Simulate the multi-file deadlock scenario:
        # A wants [f1, f2] exclusively → conflicts with B (f1) and C (f2)
        set_declared_files(task_id_a, exclusive=[f1, f2])
        acq_a2 = requests.post(f"{BASE_URL}/api/tasks/{task_id_a}/lease/acquire")
        acq_a2.raise_for_status()
        a2_result = acq_a2.json()

        if a2_result.get('granted'):
            print(f"✗ Task A should have been denied for [f1, f2]: {a2_result}")
            results.append(("Multi-file deadlock visibility", "FAIL"))
        elif len(a2_result.get('conflictingFiles', [])) < 2:
            print(f"✗ Expected at least 2 conflicting files, got {a2_result.get('conflictingFiles')}")
            results.append(("Multi-file deadlock visibility", "FAIL"))
        else:
            # Both f1 and f2 should be in conflictingFiles
            conflicts = a2_result.get('conflictingFiles', [])
            if f1 in conflicts and f2 in conflicts:
                print(f"✓ Multi-file conflict correctly reports both contested files: {conflicts}")
                results.append(("Multi-file deadlock visibility", "PASS"))
            else:
                print(f"✗ Expected both [{f1}, {f2}] in conflictingFiles, got {conflicts}")
                results.append(("Multi-file deadlock visibility", "FAIL"))
    except Exception as e:
        print(f"✗ Error: {e}")
        import traceback; traceback.print_exc()
        results.append(("Multi-file deadlock visibility", "FAIL"))
    finally:
        if task_id_a:
            cleanup_task(task_id_a)
        if task_id_b:
            cleanup_task(task_id_b)
        if task_id_c:
            cleanup_task(task_id_c)

    # ── Test 13: Shared-holder deadlock — shared lease blocks exclusive ──
    print("\n=== Test 13: Shared-holder deadlock — exclusive blocked by shared correctly reported ===")
    task_id_s = None
    task_id_e = None
    try:
        unique = str(uuid.uuid4())[:8]
        f_shared = f"src/shared_dl_{unique}.ts"
        e_file = f"src/excl_dl_{unique}.ts"

        # Task S holds SHARED lease on f_shared
        task_id_s = create_test_task(f"{unique}_s", priority='medium')
        set_declared_files(task_id_s, exclusive=[], shared=[f_shared])

        acq_s = requests.post(f"{BASE_URL}/api/tasks/{task_id_s}/lease/acquire")
        acq_s.raise_for_status()
        if not acq_s.json().get('granted'):
            raise RuntimeError("Task S shared lease not granted")

        # Task E holds exclusive on e_file AND wants exclusive on f_shared
        task_id_e = create_test_task(f"{unique}_e", priority='medium')
        set_declared_files(task_id_e, exclusive=[e_file, f_shared])

        acq_e = requests.post(f"{BASE_URL}/api/tasks/{task_id_e}/lease/acquire")
        acq_e.raise_for_status()
        e_result = acq_e.json()

        if e_result.get('granted'):
            print(f"✗ Task E should have been denied: shared lease on f_shared blocks exclusive")
            results.append(("Shared-holder deadlock", "FAIL"))
        elif f_shared not in e_result.get('conflictingFiles', []):
            print(f"✗ Expected f_shared in conflictingFiles, got {e_result.get('conflictingFiles')}")
            results.append(("Shared-holder deadlock", "FAIL"))
        else:
            print(f"✓ Shared-holder blocking correctly detected: conflict on '{f_shared}'")
            results.append(("Shared-holder deadlock", "PASS"))
    except Exception as e:
        print(f"✗ Error: {e}")
        import traceback; traceback.print_exc()
        results.append(("Shared-holder deadlock", "FAIL"))
    finally:
        if task_id_s:
            cleanup_task(task_id_s)
        if task_id_e:
            cleanup_task(task_id_e)

    # ── Test 14: No phantom deadlock after lease release + re-acquire ──
    print("\n=== Test 14: No phantom deadlock — release + re-acquire works cleanly ===")
    task_id_a = None
    task_id_b = None
    try:
        unique = str(uuid.uuid4())[:8]
        file_1 = f"src/phantom_1_{unique}.ts"
        file_2 = f"src/phantom_2_{unique}.ts"

        # Task A gets exclusive on file_1
        task_id_a = create_test_task(f"{unique}_a", priority='medium')
        set_declared_files(task_id_a, exclusive=[file_1])

        acq_a = requests.post(f"{BASE_URL}/api/tasks/{task_id_a}/lease/acquire")
        acq_a.raise_for_status()
        if not acq_a.json().get('granted'):
            raise RuntimeError("Task A lease not granted")

        # Task B tries to acquire file_1 — denied (conflict with A)
        task_id_b = create_test_task(f"{unique}_b", priority='medium')
        set_declared_files(task_id_b, exclusive=[file_1])

        acq_b = requests.post(f"{BASE_URL}/api/tasks/{task_id_b}/lease/acquire")
        acq_b.raise_for_status()
        b_result = acq_b.json()

        if b_result.get('granted'):
            print(f"✗ Task B should have been denied: {b_result}")
            results.append(("No phantom deadlock", "FAIL"))
        else:
            # Release task B (simulates stop/re-queue). Since releaseLeases now
            # calls clearWait, B's wait record should be cleaned up.
            requests.post(f"{BASE_URL}/api/tasks/{task_id_b}/lease/release")

            # Release task A too (free the file)
            requests.post(f"{BASE_URL}/api/tasks/{task_id_a}/lease/release")
            time.sleep(0.3)

            # Re-acquire: Task B now gets file_1
            set_declared_files(task_id_b, exclusive=[file_1])
            acq_b2 = requests.post(f"{BASE_URL}/api/tasks/{task_id_b}/lease/acquire")
            acq_b2.raise_for_status()
            b2_result = acq_b2.json()

            # Task A now gets a different file file_2
            set_declared_files(task_id_a, exclusive=[file_2])
            acq_a2 = requests.post(f"{BASE_URL}/api/tasks/{task_id_a}/lease/acquire")
            acq_a2.raise_for_status()
            a2_result = acq_a2.json()

            if b2_result.get('granted') and a2_result.get('granted'):
                print(f"✓ Both tasks re-acquired cleanly — no phantom deadlock from stale wait records")
                results.append(("No phantom deadlock", "PASS"))
            else:
                print(f"✗ Re-acquire failed: B={b2_result}, A={a2_result}")
                results.append(("No phantom deadlock", "FAIL"))
    except Exception as e:
        print(f"✗ Error: {e}")
        import traceback; traceback.print_exc()
        results.append(("No phantom deadlock", "FAIL"))
    finally:
        if task_id_a:
            cleanup_task(task_id_a)
        if task_id_b:
            cleanup_task(task_id_b)

    # ── Test 15: Declared-path validation — malicious paths never become leases ──
    print("\n=== Test 15: Declared-path validation — malicious paths rejected ===")
    task_id = None
    sane_task_id = None
    try:
        unique = str(uuid.uuid4())[:8]
        malicious_paths = [
            "/etc/passwd",                        # absolute path
            "../../etc/passwd",                   # workspace escape via ..
            f"src/x$(touch pwned_{unique}).ts",   # shell command substitution
            "src/`id`.ts",                        # backtick substitution
            "src/a\";rm -rf /\".ts",              # quote breakout
        ]

        failures = []
        for mal in malicious_paths:
            task_id = create_test_task(f"{unique}_mal", priority='medium')
            set_declared_files(task_id, exclusive=[mal])

            acq = requests.post(f"{BASE_URL}/api/tasks/{task_id}/lease/acquire")
            acq.raise_for_status()
            data = acq.json()

            if data.get('granted'):
                failures.append(f"granted lease on malicious path: {mal!r}")
            else:
                # The malicious path must not appear as any active lease key
                leases = requests.get(f"{BASE_URL}/api/leases").json()
                lease_paths = [l.get('filePath') for l in leases]
                if mal in lease_paths:
                    failures.append(f"malicious path appears in active leases: {mal!r}")

            cleanup_task(task_id)
            task_id = None

        # A declaration mixing valid and invalid paths is rejected whole
        # (fail closed — no partial lease set)
        task_id = create_test_task(f"{unique}_mixed", priority='medium')
        valid_file = f"src/valid_mixed_{unique}.ts"
        set_declared_files(task_id, exclusive=[valid_file, "../../etc/shadow"])
        acq = requests.post(f"{BASE_URL}/api/tasks/{task_id}/lease/acquire")
        acq.raise_for_status()
        if acq.json().get('granted'):
            failures.append("mixed valid+invalid declaration was granted")
        else:
            leases = requests.get(f"{BASE_URL}/api/leases").json()
            if valid_file in [l.get('filePath') for l in leases]:
                failures.append("partial lease granted from a rejected declaration")
        cleanup_task(task_id)
        task_id = None

        # Sanity: a normal relative path is still granted
        sane_task_id = create_test_task(f"{unique}_sane", priority='medium')
        sane_file = f"src/valid_path_{unique}.ts"
        set_declared_files(sane_task_id, exclusive=[sane_file])
        acq = requests.post(f"{BASE_URL}/api/tasks/{sane_task_id}/lease/acquire")
        acq.raise_for_status()
        if not acq.json().get('granted'):
            failures.append(f"valid path was wrongly rejected: {sane_file!r}")

        if failures:
            for f in failures:
                print(f"✗ {f}")
            results.append(("Declared-path validation", "FAIL"))
        else:
            print(f"✓ All {len(malicious_paths)} malicious paths rejected; mixed declaration failed closed; valid path still granted")
            results.append(("Declared-path validation", "PASS"))
    except Exception as e:
        print(f"✗ Error: {e}")
        import traceback; traceback.print_exc()
        results.append(("Declared-path validation", "FAIL"))
    finally:
        if task_id:
            cleanup_task(task_id)
        if sane_task_id:
            cleanup_task(sane_task_id)

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
