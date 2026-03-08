#!/usr/bin/env python3
"""
Test runner for Formic.

Runs all test suites and reports overall results.

Usage:
    # Run baseline test suites:
    python test/run_tests.py

    # Include AGI evolution test suites:
    python test/run_tests.py --agi

    # Also works via environment variable:
    AGI_TESTS=true python test/run_tests.py
"""

import subprocess
import sys
import os

# Get the directory where this script is located
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

# Enable AGI test suites via --agi flag or AGI_TESTS env var
_agi_flag = '--agi' in sys.argv
_agi_env = os.environ.get('AGI_TESTS', '').lower() in ('true', '1', 'yes')
INCLUDE_AGI_TESTS = _agi_flag or _agi_env


def run_test_suite(name: str, script: str) -> bool:
    """Run a test suite and return True if all tests passed."""
    print(f"\n{'=' * 60}")
    print(f"Running: {name}")
    print('=' * 60)

    script_path = os.path.join(SCRIPT_DIR, script)
    result = subprocess.run([sys.executable, script_path])

    return result.returncode == 0


def main():
    print("=" * 60)
    print("Formic Test Suite")
    print("=" * 60)

    # Define baseline test suites (always run)
    test_suites = [
        ("API Tests", "test_api.py"),
        ("Concurrency Tests", "test_concurrency.py"),
        ("Lease Enhancement Tests", "test_lease_enhancements.py"),
        ("Self-Healing QA Tests", "test_selfhealing.py"),
        ("Tool Forging Tests", "test_tool_forging.py"),
        ("UI Tests (Playwright)", "test_formic.py"),
    ]

    # AGI evolution test suites (opt-in via --agi flag or AGI_TESTS=true)
    agi_suites = [
        ("AGI Phase 1 — QA Loop Tests", "test_qa_loop.py"),
        ("AGI Phase 2 — DAG Scheduling Tests", "test_dag_scheduling.py"),
        ("AGI Phase 3 — Concurrency Advanced Tests", "test_concurrency_advanced.py"),
        ("AGI Phase 4 — Memory System Tests", "test_memory.py"),
        ("AGI Integration Tests", "test_agi_integration.py"),
    ]

    if INCLUDE_AGI_TESTS:
        print(f"  [AGI] Including {len(agi_suites)} AGI evolution test suites")
        test_suites = test_suites + agi_suites

    results = []

    for name, script in test_suites:
        passed = run_test_suite(name, script)
        results.append((name, passed))

    # Print overall summary
    print("\n" + "=" * 60)
    print("OVERALL TEST RESULTS")
    print("=" * 60)

    all_passed = True
    for name, passed in results:
        icon = "✓" if passed else "✗"
        status = "PASSED" if passed else "FAILED"
        print(f"  {icon} {name}: {status}")
        if not passed:
            all_passed = False

    print("-" * 60)
    if all_passed:
        print("  All test suites PASSED")
    else:
        print("  Some test suites FAILED")
    print("=" * 60)

    return 0 if all_passed else 1


if __name__ == '__main__':
    sys.exit(main())
