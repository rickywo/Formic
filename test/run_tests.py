#!/usr/bin/env python3
"""
Test runner for AgentRunner.

Runs all test suites and reports overall results.

Usage:
    python test/run_tests.py
"""

import subprocess
import sys
import os

# Get the directory where this script is located
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))


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
    print("AgentRunner Test Suite")
    print("=" * 60)

    # Define test suites
    test_suites = [
        ("API Tests", "test_api.py"),
        ("UI Tests (Playwright)", "test_agentrunner.py"),
    ]

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
