#!/usr/bin/env python3
"""
Test script to verify that skills are copied to .claude/commands/
and are read at runtime when running a task workflow.
"""

import subprocess
import requests
import time
import os
import sys
import signal
import json

# Configuration
SERVER_PORT = 8001  # Use different port to avoid conflicts
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(os.path.dirname(SCRIPT_DIR))  # /Users/.../Kanban
WORKSPACE_PATH = os.path.join(SCRIPT_DIR, "test_react_app")
SERVER_URL = f"http://localhost:{SERVER_PORT}"

def print_header(msg):
    print(f"\n{'='*60}")
    print(f"  {msg}")
    print(f"{'='*60}")

def print_result(test_name, passed, details=""):
    status = "✅ PASS" if passed else "❌ FAIL"
    print(f"{status} | {test_name}")
    if details:
        print(f"       {details}")

def start_server():
    """Start the Formic server"""
    print_header("Starting Formic Server")

    print(f"Project root: {PROJECT_ROOT}")
    print(f"Workspace: {WORKSPACE_PATH}")

    # Build first
    print("Building project...")
    build_result = subprocess.run(
        ["npm", "run", "build"],
        cwd=PROJECT_ROOT,
        capture_output=True,
        text=True
    )

    if build_result.returncode != 0:
        print(f"Build failed: {build_result.stderr}")
        return None

    print(f"Starting server on port {SERVER_PORT}...")

    env = os.environ.copy()
    env["PORT"] = str(SERVER_PORT)
    env["WORKSPACE_PATH"] = WORKSPACE_PATH

    process = subprocess.Popen(
        ["node", "dist/server/index.js"],
        cwd=PROJECT_ROOT,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE
    )

    # Wait for server to start
    for i in range(30):
        try:
            response = requests.get(f"{SERVER_URL}/api/board", timeout=1)
            if response.status_code == 200:
                print(f"Server started successfully (attempt {i+1})")
                return process
        except:
            pass
        time.sleep(1)

    print("Server failed to start")
    process.kill()
    return None

def stop_server(process):
    """Stop the server"""
    if process:
        process.send_signal(signal.SIGTERM)
        process.wait(timeout=5)

def test_skills_copied():
    """Test 1: Verify skills are copied to .claude/commands/ on first access"""
    print_header("Test 1: Skills Copied to .claude/commands/")

    # Check if skills directory exists
    skills_path = os.path.join(WORKSPACE_PATH, ".claude", "commands")
    brief_skill = os.path.join(skills_path, "brief", "SKILL.md")
    plan_skill = os.path.join(skills_path, "plan", "SKILL.md")

    results = []

    # Skills directory should be created after first /api/board call
    results.append(("Skills directory exists", os.path.isdir(skills_path), skills_path))
    results.append(("brief/SKILL.md exists", os.path.isfile(brief_skill), brief_skill))
    results.append(("plan/SKILL.md exists", os.path.isfile(plan_skill), plan_skill))

    for test_name, passed, details in results:
        print_result(test_name, passed, details)

    return all(r[1] for r in results)

def test_skill_content():
    """Test 2: Verify skill files have correct variable placeholders"""
    print_header("Test 2: Skill Content Has Variables")

    skills_path = os.path.join(WORKSPACE_PATH, ".claude", "commands")
    brief_skill = os.path.join(skills_path, "brief", "SKILL.md")
    plan_skill = os.path.join(skills_path, "plan", "SKILL.md")

    results = []

    # Check brief skill content
    if os.path.isfile(brief_skill):
        with open(brief_skill, 'r') as f:
            content = f.read()
        results.append(("Brief has $TASK_TITLE", "$TASK_TITLE" in content, ""))
        results.append(("Brief has $TASK_CONTEXT", "$TASK_CONTEXT" in content, ""))
        results.append(("Brief has $TASK_DOCS_PATH", "$TASK_DOCS_PATH" in content, ""))
    else:
        results.append(("Brief skill file", False, "File not found"))

    # Check plan skill content
    if os.path.isfile(plan_skill):
        with open(plan_skill, 'r') as f:
            content = f.read()
        results.append(("Plan has $TASK_TITLE", "$TASK_TITLE" in content, ""))
        results.append(("Plan has $TASK_DOCS_PATH", "$TASK_DOCS_PATH" in content, ""))
    else:
        results.append(("Plan skill file", False, "File not found"))

    for test_name, passed, details in results:
        print_result(test_name, passed, details)

    return all(r[1] for r in results)

def test_create_task():
    """Test 3: Create a task and verify it's created"""
    print_header("Test 3: Create Task via API")

    task_data = {
        "title": "Skill Test Task",
        "context": "This is a test task to verify skill file reading works correctly.",
        "priority": "medium"
    }

    try:
        response = requests.post(
            f"{SERVER_URL}/api/tasks",
            json=task_data,
            timeout=10
        )

        if response.status_code in [200, 201]:
            task = response.json()
            print_result("Task created", True, f"ID: {task.get('id')}")
            print_result("Has docsPath", bool(task.get('docsPath')), task.get('docsPath'))
            return task
        else:
            print_result("Task creation", False, f"Status: {response.status_code}")
            return None
    except Exception as e:
        print_result("Task creation", False, str(e))
        return None

def test_workflow_status(task_id):
    """Test 4: Check workflow status endpoint"""
    print_header("Test 4: Workflow Status API")

    try:
        response = requests.get(
            f"{SERVER_URL}/api/tasks/{task_id}/workflow",
            timeout=10
        )

        if response.status_code == 200:
            status = response.json()
            print_result("Workflow status endpoint", True, json.dumps(status))
            return True
        else:
            print_result("Workflow status", False, f"Status: {response.status_code}")
            return False
    except Exception as e:
        print_result("Workflow status", False, str(e))
        return False

def test_task_docs_folder(task):
    """Test 5: Verify task documentation folder is created"""
    print_header("Test 5: Task Documentation Folder")

    docs_path = os.path.join(WORKSPACE_PATH, task.get('docsPath', ''))

    results = []
    results.append(("Docs folder exists", os.path.isdir(docs_path), docs_path))

    for test_name, passed, details in results:
        print_result(test_name, passed, details)

    return all(r[1] for r in results)

def test_delete_task(task_id):
    """Cleanup: Delete the test task"""
    print_header("Cleanup: Delete Test Task")

    try:
        response = requests.delete(
            f"{SERVER_URL}/api/tasks/{task_id}",
            timeout=10
        )
        print_result("Task deleted", response.status_code == 204, f"Status: {response.status_code}")
        return response.status_code == 204
    except Exception as e:
        print_result("Task deletion", False, str(e))
        return False

def main():
    print("\n" + "="*60)
    print("  SKILL FILE READING TEST")
    print("  Verifying Phase 8.2 Implementation")
    print("="*60)

    # Clean up any existing .claude folder first
    claude_path = os.path.join(WORKSPACE_PATH, ".claude")
    formic_path = os.path.join(WORKSPACE_PATH, ".formic")

    if os.path.exists(claude_path):
        import shutil
        shutil.rmtree(claude_path)
        print(f"Cleaned up existing {claude_path}")

    if os.path.exists(formic_path):
        import shutil
        shutil.rmtree(formic_path)
        print(f"Cleaned up existing {formic_path}")

    # Start server
    server_process = start_server()
    if not server_process:
        print("\n❌ FAILED: Could not start server")
        return 1

    try:
        # Run tests
        results = []

        # Test 1: Skills copied
        results.append(("Skills copied to .claude/commands/", test_skills_copied()))

        # Test 2: Skill content
        results.append(("Skill files have variables", test_skill_content()))

        # Test 3: Create task
        task = test_create_task()
        results.append(("Task created", task is not None))

        if task:
            # Test 4: Workflow status
            results.append(("Workflow status API", test_workflow_status(task['id'])))

            # Test 5: Task docs folder
            results.append(("Task docs folder", test_task_docs_folder(task)))

            # Cleanup
            test_delete_task(task['id'])

        # Print summary
        print_header("TEST SUMMARY")
        passed = sum(1 for _, p in results if p)
        total = len(results)

        for test_name, passed_flag in results:
            status = "✅" if passed_flag else "❌"
            print(f"  {status} {test_name}")

        print(f"\n  Total: {passed}/{total} tests passed")

        return 0 if passed == total else 1

    finally:
        stop_server(server_process)
        print("\nServer stopped.")

if __name__ == "__main__":
    sys.exit(main())
