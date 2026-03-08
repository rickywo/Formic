#!/usr/bin/env python3
"""
Shared test fixtures for the Formic AGI Evolution test suites.

Provides:
- setup_test_workspace()  — validates TEST_WORKSPACE_PATH and returns the path
- reset_git_state()       — runs git reset --hard + git clean -fd in a workspace
- cleanup_tasks()         — DELETEs a list of task IDs via the Formic API
- wait_for_status()       — polls a task until it reaches an expected status or times out

Usage:
    from fixtures import setup_test_workspace, cleanup_tasks, wait_for_status
"""

import os
import subprocess
import time

import requests

# Default server URL (overridable via env)
BASE_URL = os.environ.get('FORMIC_URL', 'http://localhost:3000')


def setup_test_workspace() -> str:
    """
    Return the test workspace path from TEST_WORKSPACE_PATH env var.
    Falls back to './example' if the variable is not set.
    Raises RuntimeError if the path does not exist.
    """
    workspace = os.environ.get('TEST_WORKSPACE_PATH', os.path.join(os.path.dirname(__file__), '..', 'example'))
    workspace = os.path.abspath(workspace)
    if not os.path.isdir(workspace):
        raise RuntimeError(
            f"TEST_WORKSPACE_PATH '{workspace}' does not exist. "
            "Set TEST_WORKSPACE_PATH to a valid workspace directory."
        )
    return workspace


def reset_git_state(workspace_path: str) -> bool:
    """
    Run `git reset --hard` and `git clean -fd` in workspace_path to discard all
    uncommitted changes and untracked files. Returns True on success.
    """
    try:
        subprocess.run(
            ['git', 'reset', '--hard'],
            cwd=workspace_path,
            capture_output=True,
            check=True,
        )
        subprocess.run(
            ['git', 'clean', '-fd'],
            cwd=workspace_path,
            capture_output=True,
            check=True,
        )
        return True
    except subprocess.CalledProcessError:
        return False


def cleanup_tasks(base_url: str, task_ids: list) -> None:
    """DELETE each task ID from the Formic API, swallowing all errors."""
    for task_id in task_ids:
        try:
            requests.delete(f"{base_url}/api/tasks/{task_id}", timeout=5)
        except Exception:
            pass


def wait_for_status(
    base_url: str,
    task_id: str,
    expected_status: str,
    timeout_secs: int = 300,
    poll_interval_secs: float = 2.0,
) -> bool:
    """
    Poll GET /api/tasks/:id every poll_interval_secs until the task's status
    equals expected_status. Returns True if reached within timeout_secs, else False.
    """
    deadline = time.time() + timeout_secs
    while time.time() < deadline:
        try:
            resp = requests.get(f"{base_url}/api/tasks/{task_id}", timeout=10)
            if resp.status_code == 200:
                task = resp.json()
                if task.get('status') == expected_status:
                    return True
        except Exception:
            pass
        time.sleep(poll_interval_secs)
    return False


def wait_for_any_status(
    base_url: str,
    task_id: str,
    expected_statuses: list,
    timeout_secs: int = 300,
    poll_interval_secs: float = 2.0,
) -> str | None:
    """
    Poll until the task reaches any of the expected_statuses.
    Returns the actual status reached, or None on timeout.
    """
    deadline = time.time() + timeout_secs
    while time.time() < deadline:
        try:
            resp = requests.get(f"{base_url}/api/tasks/{task_id}", timeout=10)
            if resp.status_code == 200:
                status = resp.json().get('status')
                if status in expected_statuses:
                    return status
        except Exception:
            pass
        time.sleep(poll_interval_secs)
    return None


def get_git_log(workspace_path: str, n: int = 5) -> list:
    """Return the last n git commit messages in workspace_path."""
    try:
        result = subprocess.run(
            ['git', 'log', f'--oneline', f'-{n}'],
            cwd=workspace_path,
            capture_output=True,
            text=True,
            check=True,
        )
        return result.stdout.strip().splitlines()
    except subprocess.CalledProcessError:
        return []


def is_server_reachable(base_url: str = BASE_URL, timeout: int = 5) -> bool:
    """Return True if the Formic server responds to GET /api/board."""
    try:
        requests.get(f"{base_url}/api/board", timeout=timeout)
        return True
    except Exception:
        return False
