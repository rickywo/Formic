#!/usr/bin/env python3
"""
Playwright test script for Formic UI.

Tests the Kanban board functionality including:
- Page load and structure
- Creating a new task
- Task display in columns
- Task deletion

Usage:
    # Make sure Formic is running first:
    # WORKSPACE_PATH=./example npm run dev

    # Then run tests:
    python test/test_formic.py
"""

from playwright.sync_api import sync_playwright
import time
import uuid
import sys
import os

# Configuration
BASE_URL = os.environ.get('FORMIC_URL', 'http://localhost:8000')


def test_formic():
    results = []
    # Use unique task name to avoid conflicts with leftover tasks
    unique_id = str(uuid.uuid4())[:8]
    test_task_name = f"Test Task {unique_id}"

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()

        # Test 1: Page loads correctly
        print("\n=== Test 1: Page Load ===")
        page.goto(BASE_URL)
        page.wait_for_load_state('networkidle')

        title = page.title()
        if "Formic" in title:
            print(f"✓ Page title correct: {title}")
            results.append(("Page Load", "PASS"))
        else:
            print(f"✗ Page title incorrect: {title}")
            results.append(("Page Load", "FAIL"))

        # Test 2: Kanban columns exist
        print("\n=== Test 2: Kanban Structure ===")
        columns = page.locator('.column').all()
        column_count = len(columns)
        if column_count == 4:
            print(f"✓ Found {column_count} columns (TODO, RUNNING, REVIEW, DONE)")
            results.append(("Kanban Structure", "PASS"))
        else:
            print(f"✗ Expected 4 columns, found {column_count}")
            results.append(("Kanban Structure", "FAIL"))

        # Test 3: New Task button exists
        print("\n=== Test 3: New Task Button ===")
        new_task_btn = page.locator('button:has-text("New Task")')
        if new_task_btn.is_visible():
            print("✓ New Task button is visible")
            results.append(("New Task Button", "PASS"))
        else:
            print("✗ New Task button not found")
            results.append(("New Task Button", "FAIL"))

        # Test 4: Create a new task
        print("\n=== Test 4: Create New Task ===")
        new_task_btn.click()
        page.wait_for_selector('.modal', state='visible')
        print("  Modal opened")

        # Fill in the task form (using id selectors)
        page.fill('#task-title', test_task_name)
        page.fill('#task-context', 'This task was created by Playwright automated testing')

        # Submit the form
        page.click('button:has-text("Create Task")')
        page.wait_for_selector('.modal', state='hidden')
        print("  Form submitted")

        # Wait for task to appear
        time.sleep(1)
        page.wait_for_load_state('networkidle')

        # Check if task appears in TODO column
        todo_column = page.locator('.column').first
        task_card = todo_column.locator(f'.task-card:has-text("{test_task_name}")')
        if task_card.is_visible():
            print("✓ New task created and visible in TODO column")
            results.append(("Create New Task", "PASS"))
        else:
            print("✗ New task not found in TODO column")
            results.append(("Create New Task", "FAIL"))

        # Test 5: Task card has correct content
        print("\n=== Test 5: Task Card Content ===")
        task_title = task_card.locator('.task-title')
        task_context = task_card.locator('.task-context')

        title_correct = task_title.text_content() == test_task_name
        context_visible = task_context.is_visible()

        if title_correct and context_visible:
            print("✓ Task card displays correct content")
            results.append(("Task Card Content", "PASS"))
        else:
            print(f"✗ Task card content incorrect")
            results.append(("Task Card Content", "FAIL"))

        # Test 6: Run button exists on task
        print("\n=== Test 6: Run Button ===")
        run_btn = task_card.locator('button:has-text("Run")')
        if run_btn.is_visible():
            print("✓ Run button visible on task card")
            results.append(("Run Button", "PASS"))
        else:
            print("✗ Run button not found on task card")
            results.append(("Run Button", "FAIL"))

        # Test 7: Delete the test task
        print("\n=== Test 7: Delete Task ===")
        delete_btn = task_card.locator('button:has-text("Delete")')
        if delete_btn.is_visible():
            # Handle the confirm dialog
            page.on("dialog", lambda dialog: dialog.accept())
            delete_btn.click()
            time.sleep(2)
            page.wait_for_load_state('networkidle')

            # Check if task is gone
            task_still_exists = page.locator(f'.task-card:has-text("{test_task_name}")').count() > 0
            if not task_still_exists:
                print("✓ Task deleted successfully")
                results.append(("Delete Task", "PASS"))
            else:
                print("✗ Task still exists after deletion")
                results.append(("Delete Task", "FAIL"))
        else:
            print("✗ Delete button not found")
            results.append(("Delete Task", "FAIL"))

        browser.close()

    # Print summary
    print("\n" + "=" * 50)
    print("TEST SUMMARY")
    print("=" * 50)
    passed = sum(1 for r in results if r[1] == "PASS")
    failed = sum(1 for r in results if r[1] == "FAIL")

    for test_name, status in results:
        icon = "✓" if status == "PASS" else "✗"
        print(f"  {icon} {test_name}: {status}")

    print("-" * 50)
    print(f"  Total: {len(results)} | Passed: {passed} | Failed: {failed}")
    print("=" * 50)

    return failed == 0


if __name__ == '__main__':
    success = test_formic()
    sys.exit(0 if success else 1)
