#!/usr/bin/env python3
"""
Tool Forging API integration tests for Formic.

Exercises the live /api/tools REST endpoints:
  GET  /api/tools  — list all registered tools (HTTP 200, { tools: [...] })
  POST /api/tools  — register a tool (HTTP 201), reject duplicates (HTTP 400),
                     reject missing required fields (HTTP 400)

Tests use uuid4-generated tool names to stay idempotent across repeated runs.

Usage:
    # Start Formic server first:
    # WORKSPACE_PATH=./example npm run dev

    # Run tests:
    python test/test_tool_forging.py
"""

import os
import sys
import uuid

import requests

BASE_URL = os.environ.get('FORMIC_URL', 'http://localhost:8000')


def test_tool_forging() -> bool:
    results: list = []

    # Unique suffix for this run — ensures idempotent tool names
    run_id = uuid.uuid4().hex[:8]
    tool_name = f'test-{run_id}'

    # ------------------------------------------------------------------
    # Test 1: GET /api/tools returns HTTP 200 with { tools: [...] }
    # ------------------------------------------------------------------
    print('\n=== Test 1: GET /api/tools returns 200 with tools list ===')
    try:
        resp = requests.get(f'{BASE_URL}/api/tools', timeout=10)
        if resp.status_code == 200:
            data = resp.json()
            if isinstance(data.get('tools'), list):
                print(f"✓ GET /api/tools returned 200 with tools list ({len(data['tools'])} tools)")
                results.append(('GET /api/tools', 'PASS'))
            else:
                print(f"✗ Response missing 'tools' list key: {resp.text}")
                results.append(('GET /api/tools', 'FAIL'))
        else:
            print(f'✗ Expected 200, got {resp.status_code}: {resp.text}')
            results.append(('GET /api/tools', 'FAIL'))
    except Exception as e:
        print(f'✗ Error: {e}')
        results.append(('GET /api/tools', 'FAIL'))

    # ------------------------------------------------------------------
    # Test 2: POST /api/tools creates a tool and returns HTTP 201
    # with the full Tool schema (name, description, command, created_by,
    # created_at, usage_count == 0)
    # ------------------------------------------------------------------
    print('\n=== Test 2: POST /api/tools creates a tool (201) ===')
    try:
        payload = {
            'name': tool_name,
            'description': 'A test tool created by test_tool_forging.py',
            'command': 'echo hello',
            'created_by': 'test_tool_forging.py',
        }
        resp = requests.post(f'{BASE_URL}/api/tools', json=payload, timeout=10)
        if resp.status_code == 201:
            tool = resp.json()
            required = ['name', 'description', 'command', 'created_by', 'created_at', 'usage_count']
            missing = [f for f in required if f not in tool]
            if (
                not missing
                and tool.get('usage_count') == 0
                and tool.get('name') == tool_name
                and isinstance(tool.get('created_at'), str)
                and len(tool['created_at']) > 0
            ):
                print(f"✓ Tool '{tool_name}' created (HTTP 201) with all required fields and usage_count=0")
                results.append(('POST /api/tools (create)', 'PASS'))
            else:
                print(f'✗ Tool schema invalid — missing={missing}, tool={tool}')
                results.append(('POST /api/tools (create)', 'FAIL'))
        else:
            print(f'✗ Expected 201, got {resp.status_code}: {resp.text}')
            results.append(('POST /api/tools (create)', 'FAIL'))
    except Exception as e:
        print(f'✗ Error: {e}')
        results.append(('POST /api/tools (create)', 'FAIL'))

    # ------------------------------------------------------------------
    # Test 3: GET /api/tools includes the newly created tool
    # ------------------------------------------------------------------
    print('\n=== Test 3: GET /api/tools includes the newly created tool ===')
    try:
        resp = requests.get(f'{BASE_URL}/api/tools', timeout=10)
        if resp.status_code == 200:
            tools = resp.json().get('tools', [])
            names = [t.get('name') for t in tools]
            if tool_name in names:
                print(f"✓ Created tool '{tool_name}' found in GET /api/tools list")
                results.append(('GET /api/tools includes new tool', 'PASS'))
            else:
                print(f"✗ Tool '{tool_name}' not found in list: {names}")
                results.append(('GET /api/tools includes new tool', 'FAIL'))
        else:
            print(f'✗ Expected 200, got {resp.status_code}: {resp.text}')
            results.append(('GET /api/tools includes new tool', 'FAIL'))
    except Exception as e:
        print(f'✗ Error: {e}')
        results.append(('GET /api/tools includes new tool', 'FAIL'))

    # ------------------------------------------------------------------
    # Test 4: POST /api/tools with duplicate name returns HTTP 400
    # ------------------------------------------------------------------
    print('\n=== Test 4: POST /api/tools duplicate name returns 400 ===')
    try:
        payload = {
            'name': tool_name,
            'description': 'Duplicate tool attempt',
            'command': 'echo duplicate',
            'created_by': 'test_tool_forging.py',
        }
        resp = requests.post(f'{BASE_URL}/api/tools', json=payload, timeout=10)
        if resp.status_code == 400:
            print('✓ Duplicate tool name correctly rejected with HTTP 400')
            results.append(('POST /api/tools (duplicate name)', 'PASS'))
        else:
            print(f'✗ Expected 400, got {resp.status_code}: {resp.text}')
            results.append(('POST /api/tools (duplicate name)', 'FAIL'))
    except Exception as e:
        print(f'✗ Error: {e}')
        results.append(('POST /api/tools (duplicate name)', 'FAIL'))

    # ------------------------------------------------------------------
    # Test 5: POST /api/tools missing required 'command' field returns 400
    # ------------------------------------------------------------------
    print("\n=== Test 5: POST /api/tools missing 'command' returns 400 ===")
    try:
        payload = {
            'name': f'missing-cmd-{run_id}',
            'description': 'Tool missing command field',
            'created_by': 'test_tool_forging.py',
        }
        resp = requests.post(f'{BASE_URL}/api/tools', json=payload, timeout=10)
        if resp.status_code == 400:
            print("✓ Tool missing 'command' correctly rejected with HTTP 400")
            results.append(("POST /api/tools (missing 'command')", 'PASS'))
        else:
            print(f'✗ Expected 400, got {resp.status_code}: {resp.text}')
            results.append(("POST /api/tools (missing 'command')", 'FAIL'))
    except Exception as e:
        print(f'✗ Error: {e}')
        results.append(("POST /api/tools (missing 'command')", 'FAIL'))

    # ------------------------------------------------------------------
    # Test 6: POST /api/tools missing required 'name' field returns 400
    # ------------------------------------------------------------------
    print("\n=== Test 6: POST /api/tools missing 'name' returns 400 ===")
    try:
        payload = {
            'description': 'Tool missing name field',
            'command': 'echo test',
            'created_by': 'test_tool_forging.py',
        }
        resp = requests.post(f'{BASE_URL}/api/tools', json=payload, timeout=10)
        if resp.status_code == 400:
            print("✓ Tool missing 'name' correctly rejected with HTTP 400")
            results.append(("POST /api/tools (missing 'name')", 'PASS'))
        else:
            print(f'✗ Expected 400, got {resp.status_code}: {resp.text}')
            results.append(("POST /api/tools (missing 'name')", 'FAIL'))
    except Exception as e:
        print(f'✗ Error: {e}')
        results.append(("POST /api/tools (missing 'name')", 'FAIL'))

    # Print summary
    passed = sum(1 for _, r in results if r == 'PASS')
    failed = sum(1 for _, r in results if r == 'FAIL')
    skipped = sum(1 for _, r in results if r == 'SKIP')

    print('\n' + '=' * 50)
    print('TOOL FORGING TEST SUMMARY')
    print('=' * 50)
    for test_name, status in results:
        icon = '✓' if status == 'PASS' else ('○' if status == 'SKIP' else '✗')
        print(f'  {icon} {test_name}: {status}')
    print('-' * 50)
    print(f'  Total: {len(results)} | Passed: {passed} | Failed: {failed} | Skipped: {skipped}')
    print('=' * 50)

    return failed == 0


if __name__ == '__main__':
    success = test_tool_forging()
    sys.exit(0 if success else 1)
