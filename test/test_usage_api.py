#!/usr/bin/env python3
"""Integration tests for transcript usage aggregation endpoints."""

import json
import os
import shutil
import sys

import requests

BASE_URL = os.environ.get('FORMIC_URL', 'http://localhost:8000')
WORKSPACE_PATH = os.environ.get('WORKSPACE_PATH', os.getcwd())
USAGE_DIR = os.path.join(WORKSPACE_PATH, '.formic', 'usage')
EVENTS_PATH = os.path.join(USAGE_DIR, 'events.ndjson')
BACKUP_PATH = EVENTS_PATH + '.usage-api-test-backup'


def fixture_events():
    return [
        {'id': 'usage-api-1', 'timestamp': '2026-07-12T10:00:10.000Z', 'taskId': 't-usage-api',
         'step': 'execute', 'agentType': 'claude', 'source': 'transcript', 'sessionId': 'session-execute',
         'model': 'claude-sonnet-5', 'inputTokens': 1000000, 'outputTokens': 0,
         'cacheCreationTokens': 0, 'cacheReadTokens': 0},
        {'id': 'usage-api-2', 'timestamp': '2026-07-12T10:00:40.000Z', 'taskId': 't-usage-api',
         'step': 'plan', 'agentType': 'claude', 'source': 'transcript', 'sessionId': 'session-plan',
         'model': 'unknown/model', 'inputTokens': 0, 'outputTokens': 1000000,
         'cacheCreationTokens': 0, 'cacheReadTokens': 0},
    ]


def assert_status(response, expected, label):
    if response.status_code != expected:
        raise AssertionError(f'{label}: expected {expected}, got {response.status_code}: {response.text}')


def run_tests():
    original_exists = os.path.exists(EVENTS_PATH)
    os.makedirs(USAGE_DIR, exist_ok=True)
    if original_exists:
        shutil.copyfile(EVENTS_PATH, BACKUP_PATH)
    try:
        with open(EVENTS_PATH, 'w', encoding='utf-8') as handle:
            for item in fixture_events():
                handle.write(json.dumps(item) + '\n')

        summary_response = requests.get(f'{BASE_URL}/api/usage/summary?period=all&groupBy=task', timeout=5)
        assert_status(summary_response, 200, 'summary')
        summary = summary_response.json()
        assert 'today' in summary['periodWindows'] and 'month' in summary['periodWindows']
        task = summary['groups']['t-usage-api']
        assert task['inputTokens'] == 1000000 and task['outputTokens'] == 1000000
        assert task['requests'] == 2 and task['estCostUsd'] is None

        tasks_response = requests.get(f'{BASE_URL}/api/usage/tasks', timeout=5)
        assert_status(tasks_response, 200, 'task totals')
        assert tasks_response.json()['tasks']['t-usage-api']['requests'] == 2

        task_response = requests.get(f'{BASE_URL}/api/usage/task/t-usage-api', timeout=5)
        assert_status(task_response, 200, 'task breakdown')
        breakdown = task_response.json()
        assert breakdown['total']['requests'] == 2
        assert breakdown['byModel']['unknown/model']['estCostUsd'] is None
        assert breakdown['bySession']['session-execute']['inputTokens'] == 1000000

        for endpoint in ('/api/usage/summary?period=invalid', '/api/usage/summary?groupBy=invalid'):
            assert_status(requests.get(BASE_URL + endpoint, timeout=5), 400, endpoint)
        assert_status(requests.get(f'{BASE_URL}/api/usage', timeout=5), 200, 'account usage')
        print('Usage API Tests: passed')
        return True
    except (AssertionError, requests.RequestException) as error:
        print(f'Usage API Tests: failed: {error}')
        return False
    finally:
        if original_exists:
            shutil.move(BACKUP_PATH, EVENTS_PATH)
        elif os.path.exists(EVENTS_PATH):
            os.remove(EVENTS_PATH)


if __name__ == '__main__':
    sys.exit(0 if run_tests() else 1)
