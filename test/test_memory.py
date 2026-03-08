#!/usr/bin/env python3
"""
Memory Store integration tests for Formic.

Validates the on-disk .formic/memory.json schema produced by the memory
reflection pipeline.  Tests gracefully skip when memory.json is absent
(i.e. no task has completed a reflection run yet).

Schema under test (MemoryStore / MemoryEntry from src/types/index.ts):
  { version: string, entries: MemoryEntry[] }
  MemoryEntry: { id, type, content, source_task, created_at, relevance_tags }

Usage:
    # Start Formic server first:
    # WORKSPACE_PATH=./example npm run dev

    # Run tests:
    python test/test_memory.py

    # Point at a custom workspace:
    TEST_WORKSPACE_PATH=/path/to/workspace python test/test_memory.py
"""

import json
import os
import sys

import requests  # noqa: F401 — imported for BASE_URL convention and future HTTP tests

BASE_URL = os.environ.get('FORMIC_URL', 'http://localhost:8000')
TEST_WORKSPACE_PATH = os.environ.get('TEST_WORKSPACE_PATH', '.')
MEMORY_JSON_PATH = os.path.join(TEST_WORKSPACE_PATH, '.formic', 'memory.json')

REQUIRED_FIELDS = {'id', 'type', 'content', 'source_task', 'created_at', 'relevance_tags'}
VALID_TYPES = {'pattern', 'pitfall', 'preference'}


def _print_summary(results: list) -> None:
    passed = sum(1 for _, r in results if r == 'PASS')
    failed = sum(1 for _, r in results if r == 'FAIL')
    skipped = sum(1 for _, r in results if r == 'SKIP')

    print('\n' + '=' * 50)
    print('MEMORY TEST SUMMARY')
    print('=' * 50)
    for test_name, status in results:
        icon = '✓' if status == 'PASS' else ('○' if status == 'SKIP' else '✗')
        print(f'  {icon} {test_name}: {status}')
    print('-' * 50)
    print(f'  Total: {len(results)} | Passed: {passed} | Failed: {failed} | Skipped: {skipped}')
    print('=' * 50)


def test_memory() -> bool:
    results: list = []

    # ------------------------------------------------------------------
    # Test 1: memory.json presence
    # ------------------------------------------------------------------
    print('\n=== Test 1: memory.json presence ===')
    if not os.path.isfile(MEMORY_JSON_PATH):
        print(f'○ memory.json not found at {MEMORY_JSON_PATH} — no reflection run completed yet')
        results.append(('memory.json presence', 'SKIP'))
        for name in [
            'MemoryStore top-level schema',
            'MemoryEntry required fields',
            'MemoryEntry type values',
            'MemoryEntry relevance_tags type',
            'MemoryEntry id prefix',
        ]:
            print(f'○ Skipping: {name} (memory.json absent)')
            results.append((name, 'SKIP'))
        _print_summary(results)
        return True  # graceful skip is not a failure

    print(f'✓ memory.json found at {MEMORY_JSON_PATH}')
    results.append(('memory.json presence', 'PASS'))

    # Load file
    try:
        with open(MEMORY_JSON_PATH, 'r', encoding='utf-8') as f:
            data = json.load(f)
    except Exception as e:
        print(f'✗ Failed to parse memory.json: {e}')
        results.append(('MemoryStore top-level schema', 'FAIL'))
        _print_summary(results)
        return False

    # ------------------------------------------------------------------
    # Test 2: MemoryStore top-level schema
    # ------------------------------------------------------------------
    print('\n=== Test 2: MemoryStore top-level schema ===')
    try:
        assert isinstance(data, dict), f"root must be an object, got {type(data).__name__}"
        assert 'version' in data, "missing 'version' key"
        assert isinstance(data['version'], str), \
            f"'version' must be a string, got {type(data['version']).__name__}"
        assert 'entries' in data, "missing 'entries' key"
        assert isinstance(data['entries'], list), \
            f"'entries' must be a list, got {type(data['entries']).__name__}"
        print(f"✓ MemoryStore has version='{data['version']}' and entries list "
              f"({len(data['entries'])} entries)")
        results.append(('MemoryStore top-level schema', 'PASS'))
    except AssertionError as e:
        print(f'✗ {e}')
        results.append(('MemoryStore top-level schema', 'FAIL'))
        for name in [
            'MemoryEntry required fields',
            'MemoryEntry type values',
            'MemoryEntry relevance_tags type',
            'MemoryEntry id prefix',
        ]:
            print(f'○ Skipping: {name} (invalid top-level schema)')
            results.append((name, 'SKIP'))
        _print_summary(results)
        return False

    entries = data['entries']
    if len(entries) == 0:
        print('○ entries list is empty — skipping per-entry validation')
        for name in [
            'MemoryEntry required fields',
            'MemoryEntry type values',
            'MemoryEntry relevance_tags type',
            'MemoryEntry id prefix',
        ]:
            results.append((name, 'SKIP'))
        _print_summary(results)
        return True

    # ------------------------------------------------------------------
    # Test 3: MemoryEntry required fields
    # ------------------------------------------------------------------
    print('\n=== Test 3: MemoryEntry required fields ===')
    try:
        for i, entry in enumerate(entries):
            missing = REQUIRED_FIELDS - set(entry.keys())
            assert not missing, f"entry[{i}] missing fields: {sorted(missing)}"
        print(f'✓ All {len(entries)} entries have required fields: {sorted(REQUIRED_FIELDS)}')
        results.append(('MemoryEntry required fields', 'PASS'))
    except AssertionError as e:
        print(f'✗ {e}')
        results.append(('MemoryEntry required fields', 'FAIL'))

    # ------------------------------------------------------------------
    # Test 4: MemoryEntry type values
    # ------------------------------------------------------------------
    print('\n=== Test 4: MemoryEntry type values ===')
    try:
        for i, entry in enumerate(entries):
            t = entry.get('type')
            assert t in VALID_TYPES, \
                f"entry[{i}] type='{t}' must be one of {sorted(VALID_TYPES)}"
        print(f'✓ All entries have valid type values: {sorted(VALID_TYPES)}')
        results.append(('MemoryEntry type values', 'PASS'))
    except AssertionError as e:
        print(f'✗ {e}')
        results.append(('MemoryEntry type values', 'FAIL'))

    # ------------------------------------------------------------------
    # Test 5: MemoryEntry relevance_tags type
    # ------------------------------------------------------------------
    print('\n=== Test 5: MemoryEntry relevance_tags type ===')
    try:
        for i, entry in enumerate(entries):
            tags = entry.get('relevance_tags')
            assert isinstance(tags, list), \
                f"entry[{i}] relevance_tags must be a list, got {type(tags).__name__}"
        print('✓ All entries have relevance_tags as a list')
        results.append(('MemoryEntry relevance_tags type', 'PASS'))
    except AssertionError as e:
        print(f'✗ {e}')
        results.append(('MemoryEntry relevance_tags type', 'FAIL'))

    # ------------------------------------------------------------------
    # Test 6: MemoryEntry id prefix
    # ------------------------------------------------------------------
    print('\n=== Test 6: MemoryEntry id prefix ===')
    try:
        for i, entry in enumerate(entries):
            id_val = entry.get('id', '')
            assert isinstance(id_val, str) and id_val.startswith('mem-'), \
                f"entry[{i}] id='{id_val}' must be a string starting with 'mem-'"
        print("✓ All entries have id prefixed with 'mem-'")
        results.append(('MemoryEntry id prefix', 'PASS'))
    except AssertionError as e:
        print(f'✗ {e}')
        results.append(('MemoryEntry id prefix', 'FAIL'))

    _print_summary(results)
    return all(r[1] != 'FAIL' for r in results)


if __name__ == '__main__':
    success = test_memory()
    sys.exit(0 if success else 1)
