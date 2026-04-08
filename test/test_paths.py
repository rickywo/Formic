#!/usr/bin/env python3
"""
Unit tests for src/server/utils/paths.ts

Covers all exported path-computation functions that do not require
I/O or a running server:
  - getWorkspacePath / setWorkspacePath
  - getFormicDir, getBoardPath, getTasksDir
  - getTaskDocsPath, getRelativeDocsPath
  - getLogsDir, getTaskLogsDir
  - getSkillsDir
  - getPackageRoot (structural check only)
  - getGlobalFormicDir, getGlobalConfigPath (structure check)

Tests invoke the TypeScript module via Node.js + tsx.

Usage:
    python test/test_paths.py
"""

import subprocess
import sys
import os
import json
import unittest

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run_ts(script: str) -> object:
    """Execute a TypeScript ESM snippet via node+tsx and return parsed JSON."""
    result = subprocess.run(
        ['node', '--import=tsx/esm', '--input-type=module'],
        input=script,
        capture_output=True,
        text=True,
        cwd=PROJECT_ROOT,
    )
    if result.returncode != 0:
        raise RuntimeError(f"Node error:\n{result.stderr.strip()}")
    for line in reversed(result.stdout.splitlines()):
        line = line.strip()
        if not line:
            continue
        try:
            return json.loads(line)
        except json.JSONDecodeError:
            continue
    raise RuntimeError(f"No valid JSON found in stdout:\n{result.stdout!r}")


def call_fn(fn_call: str) -> str:
    """Call a single paths.ts function and return its string result."""
    script = f"""
import * as p from './src/server/utils/paths.js';
console.log(JSON.stringify({fn_call}));
"""
    return run_ts(script)


def call_multi(statements: str, expr: str) -> object:
    """Execute arbitrary statements then return JSON-serialised expr."""
    script = f"""
import * as p from './src/server/utils/paths.js';
{statements}
console.log(JSON.stringify({expr}));
"""
    return run_ts(script)


# ── getWorkspacePath / setWorkspacePath ────────────────────────────────────────

class TestWorkspacePath(unittest.TestCase):

    def test_default_workspace_path_is_string(self):
        result = call_fn('p.getWorkspacePath()')
        self.assertIsInstance(result, str)
        self.assertTrue(len(result) > 0)

    def test_set_workspace_path_updates_getter(self):
        result = call_multi(
            "p.setWorkspacePath('/tmp/test-workspace');",
            "p.getWorkspacePath()"
        )
        self.assertEqual(result, '/tmp/test-workspace')

    def test_set_workspace_path_to_relative_path(self):
        result = call_multi(
            "p.setWorkspacePath('./my-workspace');",
            "p.getWorkspacePath()"
        )
        self.assertEqual(result, './my-workspace')

    def test_workspace_path_env_var_respected(self):
        """If WORKSPACE_PATH env var is set, getWorkspacePath() returns it."""
        script = """
import * as p from './src/server/utils/paths.js';
console.log(JSON.stringify(p.getWorkspacePath()));
"""
        env = os.environ.copy()
        env['WORKSPACE_PATH'] = '/env/workspace'
        result = subprocess.run(
            ['node', '--import=tsx/esm', '--input-type=module'],
            input=script,
            capture_output=True,
            text=True,
            cwd=PROJECT_ROOT,
            env=env,
        )
        value = json.loads(result.stdout.strip())
        self.assertEqual(value, '/env/workspace')


# ── derived workspace paths ────────────────────────────────────────────────────

class TestDerivedWorkspacePaths(unittest.TestCase):

    def _paths_under_workspace(self, workspace: str) -> dict:
        """Return a dict of path values for a given workspace root."""
        result = call_multi(
            f"p.setWorkspacePath({json.dumps(workspace)});",
            """{
              formicDir: p.getFormicDir(),
              boardPath: p.getBoardPath(),
              tasksDir: p.getTasksDir(),
              logsDir: p.getLogsDir()
            }"""
        )
        return result

    def test_formic_dir_is_inside_workspace(self):
        paths = self._paths_under_workspace('/my/workspace')
        self.assertTrue(paths['formicDir'].startswith('/my/workspace'))
        self.assertIn('.formic', paths['formicDir'])

    def test_board_path_ends_with_board_json(self):
        paths = self._paths_under_workspace('/my/workspace')
        self.assertTrue(paths['boardPath'].endswith('board.json'))

    def test_board_path_is_inside_formic_dir(self):
        paths = self._paths_under_workspace('/my/workspace')
        self.assertTrue(paths['boardPath'].startswith(paths['formicDir']))

    def test_tasks_dir_is_inside_formic_dir(self):
        paths = self._paths_under_workspace('/my/workspace')
        self.assertTrue(paths['tasksDir'].startswith(paths['formicDir']))

    def test_logs_dir_is_inside_formic_dir(self):
        paths = self._paths_under_workspace('/my/workspace')
        self.assertTrue(paths['logsDir'].startswith(paths['formicDir']))

    def test_tasks_dir_ends_with_tasks(self):
        paths = self._paths_under_workspace('/my/workspace')
        self.assertTrue(paths['tasksDir'].endswith('tasks') or
                        'tasks' in paths['tasksDir'])

    def test_logs_dir_ends_with_logs(self):
        paths = self._paths_under_workspace('/my/workspace')
        self.assertTrue(paths['logsDir'].endswith('logs') or
                        'logs' in paths['logsDir'])


# ── getTaskDocsPath / getRelativeDocsPath ──────────────────────────────────────

class TestTaskDocsPaths(unittest.TestCase):

    def test_task_docs_path_contains_id_and_slug(self):
        result = call_multi(
            "p.setWorkspacePath('/ws');",
            "p.getTaskDocsPath('t-42', 'my-feature')"
        )
        self.assertIn('t-42', result)
        self.assertIn('my-feature', result)

    def test_task_docs_path_is_inside_tasks_dir(self):
        result = call_multi(
            "p.setWorkspacePath('/ws');",
            "p.getTaskDocsPath('t-1', 'slug')"
        )
        self.assertIn('.formic', result)
        self.assertIn('tasks', result)

    def test_task_docs_path_format_id_underscore_slug(self):
        result = call_multi(
            "p.setWorkspacePath('/ws');",
            "p.getTaskDocsPath('t-99', 'add-auth')"
        )
        self.assertIn('t-99_add-auth', result)

    def test_relative_docs_path_starts_with_formic(self):
        result = call_fn("p.getRelativeDocsPath('t-1', 'slug')")
        self.assertTrue(result.startswith('.formic/'))

    def test_relative_docs_path_contains_id_and_slug(self):
        result = call_fn("p.getRelativeDocsPath('t-42', 'my-feature')")
        self.assertIn('t-42', result)
        self.assertIn('my-feature', result)

    def test_relative_docs_path_format(self):
        result = call_fn("p.getRelativeDocsPath('t-7', 'fix-bug')")
        self.assertEqual(result, '.formic/tasks/t-7_fix-bug')


# ── getTaskLogsDir ─────────────────────────────────────────────────────────────

class TestTaskLogsDir(unittest.TestCase):

    def test_task_logs_dir_contains_task_id(self):
        result = call_multi(
            "p.setWorkspacePath('/ws');",
            "p.getTaskLogsDir('t-55')"
        )
        self.assertIn('t-55', result)

    def test_task_logs_dir_is_inside_logs_dir(self):
        result = call_multi(
            "p.setWorkspacePath('/ws');",
            "{ base: p.getLogsDir(), task: p.getTaskLogsDir('t-1') }"
        )
        self.assertTrue(result['task'].startswith(result['base']))


# ── getSkillsDir ───────────────────────────────────────────────────────────────

class TestSkillsDir(unittest.TestCase):

    def test_skills_dir_contains_claude_skills(self):
        result = call_multi(
            "p.setWorkspacePath('/ws');",
            "p.getSkillsDir()"
        )
        self.assertIn('.claude', result)
        self.assertIn('skills', result)

    def test_skills_dir_is_inside_workspace(self):
        result = call_multi(
            "p.setWorkspacePath('/my/project');",
            "p.getSkillsDir()"
        )
        self.assertTrue(result.startswith('/my/project'))


# ── getPackageRoot ─────────────────────────────────────────────────────────────

class TestPackageRoot(unittest.TestCase):

    def test_package_root_is_non_empty_string(self):
        result = call_fn('p.getPackageRoot()')
        self.assertIsInstance(result, str)
        self.assertTrue(len(result) > 0)

    def test_package_root_is_absolute_path(self):
        result = call_fn('p.getPackageRoot()')
        self.assertTrue(os.path.isabs(result))


# ── getGlobalFormicDir / getGlobalConfigPath ───────────────────────────────────

class TestGlobalPaths(unittest.TestCase):

    def test_global_formic_dir_ends_with_formic(self):
        result = call_fn('p.getGlobalFormicDir()')
        self.assertTrue(result.endswith('.formic'))

    def test_global_formic_dir_is_inside_home(self):
        home = os.path.expanduser('~')
        result = call_fn('p.getGlobalFormicDir()')
        self.assertTrue(result.startswith(home))

    def test_global_config_path_ends_with_config_json(self):
        result = call_fn('p.getGlobalConfigPath()')
        self.assertTrue(result.endswith('config.json'))

    def test_global_config_path_is_inside_global_formic_dir(self):
        result = call_multi(
            '',
            "{ dir: p.getGlobalFormicDir(), cfg: p.getGlobalConfigPath() }"
        )
        self.assertTrue(result['cfg'].startswith(result['dir']))

    def test_bundled_skills_path_contains_skills(self):
        result = call_fn('p.getBundledSkillsPath()')
        self.assertIn('skills', result)

    def test_bundled_templates_path_contains_templates(self):
        result = call_fn('p.getBundledTemplatesPath()')
        self.assertIn('templates', result)


if __name__ == '__main__':
    print(f"Project root: {PROJECT_ROOT}")
    print("Running paths utility unit tests...\n")
    unittest.main(verbosity=2)
