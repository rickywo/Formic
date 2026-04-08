#!/usr/bin/env python3
"""
Unit tests for src/server/services/outputParser.ts

Covers all exported pure functions:
  - parseClaudeStreamJson  — parses Claude Code CLI stream-json lines
  - parseCopilotOutput     — parses GitHub Copilot CLI plain-text lines
  - cleanAgentOutput       — strips tool-call XML blocks from content
  - parseAgentOutput       — dispatches to agent-specific parsers
  - usesJsonOutput         — returns whether agent uses JSON output format

Tests invoke each function via Node.js + tsx (same pattern as test_slugify.py).

Usage:
    python test/test_output_parser.py
"""

import subprocess
import sys
import os
import json
import unittest

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run_ts(script: str) -> object:
    """Execute a TypeScript ESM snippet via node+tsx and return parsed JSON output."""
    result = subprocess.run(
        ['node', '--import=tsx/esm', '--input-type=module'],
        input=script,
        capture_output=True,
        text=True,
        cwd=PROJECT_ROOT,
    )
    if result.returncode != 0:
        raise RuntimeError(f"Node error:\n{result.stderr.strip()}")
    return json.loads(result.stdout.strip())


def parse_claude(line: str) -> dict:
    """Invoke parseClaudeStreamJson with the given line and return the result object."""
    payload = json.dumps(line)
    script = f"""
import {{ parseClaudeStreamJson }} from './src/server/services/outputParser.js';
console.log(JSON.stringify(parseClaudeStreamJson({payload})));
"""
    return run_ts(script)


def parse_copilot(line: str) -> dict:
    """Invoke parseCopilotOutput with the given line and return the result object."""
    payload = json.dumps(line)
    script = f"""
import {{ parseCopilotOutput }} from './src/server/services/outputParser.js';
console.log(JSON.stringify(parseCopilotOutput({payload})));
"""
    return run_ts(script)


def clean_output(content: str) -> str:
    """Invoke cleanAgentOutput and return the cleaned string."""
    payload = json.dumps(content)
    script = f"""
import {{ cleanAgentOutput }} from './src/server/services/outputParser.js';
console.log(JSON.stringify(cleanAgentOutput({payload})));
"""
    return run_ts(script)


def parse_agent(line: str, agent_type: str) -> dict:
    """Invoke parseAgentOutput with an explicit agentType."""
    payload = json.dumps(line)
    script = f"""
import {{ parseAgentOutput }} from './src/server/services/outputParser.js';
console.log(JSON.stringify(parseAgentOutput({payload}, '{agent_type}')));
"""
    return run_ts(script)


def uses_json_output(agent_type: str) -> bool:
    """Invoke usesJsonOutput with an explicit agentType."""
    script = f"""
import {{ usesJsonOutput }} from './src/server/services/outputParser.js';
console.log(JSON.stringify(usesJsonOutput('{agent_type}')));
"""
    return run_ts(script)


# ── parseClaudeStreamJson ──────────────────────────────────────────────────────

class TestParseClaudeStreamJson(unittest.TestCase):

    def test_empty_line_returns_unknown(self):
        result = parse_claude('')
        self.assertEqual(result['type'], 'unknown')

    def test_whitespace_only_returns_unknown(self):
        result = parse_claude('   ')
        self.assertEqual(result['type'], 'unknown')

    def test_invalid_json_returns_unknown_with_content(self):
        result = parse_claude('not json at all')
        self.assertEqual(result['type'], 'unknown')
        self.assertEqual(result.get('content'), 'not json at all')

    def test_assistant_event_with_text_returns_text(self):
        event = json.dumps({
            "type": "assistant",
            "message": {
                "content": [{"type": "text", "text": "Hello, world!"}]
            }
        })
        result = parse_claude(event)
        self.assertEqual(result['type'], 'text')
        self.assertEqual(result['content'], 'Hello, world!')

    def test_assistant_event_multiple_text_blocks_concatenated(self):
        event = json.dumps({
            "type": "assistant",
            "message": {
                "content": [
                    {"type": "text", "text": "Hello, "},
                    {"type": "text", "text": "world!"}
                ]
            }
        })
        result = parse_claude(event)
        self.assertEqual(result['type'], 'text')
        self.assertEqual(result['content'], 'Hello, world!')

    def test_assistant_event_tool_use_bash_returns_status(self):
        event = json.dumps({
            "type": "assistant",
            "message": {
                "content": [{"type": "tool_use", "name": "Bash", "input": {}}]
            }
        })
        result = parse_claude(event)
        self.assertEqual(result['type'], 'status')
        self.assertIn('Running', result['content'])

    def test_assistant_event_text_takes_priority_over_tool_use(self):
        event = json.dumps({
            "type": "assistant",
            "message": {
                "content": [
                    {"type": "text", "text": "Some text"},
                    {"type": "tool_use", "name": "Bash", "input": {}}
                ]
            }
        })
        result = parse_claude(event)
        self.assertEqual(result['type'], 'text')
        self.assertEqual(result['content'], 'Some text')

    def test_result_event_returns_result_type_with_content(self):
        event = json.dumps({"type": "result", "result": "Task complete"})
        result = parse_claude(event)
        self.assertEqual(result['type'], 'result')
        self.assertEqual(result['content'], 'Task complete')
        self.assertTrue(result.get('isFinal'))

    def test_result_event_missing_result_field_returns_empty_content(self):
        event = json.dumps({"type": "result"})
        result = parse_claude(event)
        self.assertEqual(result['type'], 'result')
        self.assertEqual(result['content'], '')

    def test_system_init_returns_thinking_status(self):
        event = json.dumps({"type": "system", "subtype": "init"})
        result = parse_claude(event)
        self.assertEqual(result['type'], 'status')
        self.assertIn('Thinking', result['content'])

    def test_system_hook_started_returns_system_type(self):
        event = json.dumps({"type": "system", "subtype": "hook_started"})
        result = parse_claude(event)
        self.assertEqual(result['type'], 'system')
        self.assertEqual(result['content'], 'hook_started')

    def test_unknown_top_level_event_type_returns_unknown(self):
        event = json.dumps({"type": "user", "content": "hi"})
        result = parse_claude(event)
        self.assertEqual(result['type'], 'unknown')

    def test_tool_use_read_long_path_shows_last_two_segments(self):
        event = json.dumps({
            "type": "assistant",
            "message": {
                "content": [
                    {"type": "tool_use", "name": "Read",
                     "input": {"file_path": "a/b/c/d/file.ts"}}
                ]
            }
        })
        result = parse_claude(event)
        self.assertEqual(result['type'], 'status')
        self.assertIn('d/file.ts', result['content'])

    def test_tool_use_read_short_path_shows_full_path(self):
        event = json.dumps({
            "type": "assistant",
            "message": {
                "content": [
                    {"type": "tool_use", "name": "Read",
                     "input": {"file_path": "src/utils/slug.ts"}}
                ]
            }
        })
        result = parse_claude(event)
        self.assertEqual(result['type'], 'status')
        self.assertIn('Reading', result['content'])

    def test_tool_use_read_no_file_path(self):
        event = json.dumps({
            "type": "assistant",
            "message": {"content": [{"type": "tool_use", "name": "Read", "input": {}}]}
        })
        result = parse_claude(event)
        self.assertEqual(result['type'], 'status')
        self.assertIn('Reading', result['content'])

    def test_tool_use_grep_with_pattern(self):
        event = json.dumps({
            "type": "assistant",
            "message": {
                "content": [{"type": "tool_use", "name": "Grep", "input": {"pattern": "TODO"}}]
            }
        })
        result = parse_claude(event)
        self.assertEqual(result['type'], 'status')
        self.assertIn('TODO', result['content'])

    def test_tool_use_grep_no_pattern(self):
        event = json.dumps({
            "type": "assistant",
            "message": {
                "content": [{"type": "tool_use", "name": "Grep", "input": {}}]
            }
        })
        result = parse_claude(event)
        self.assertEqual(result['type'], 'status')
        self.assertIn('Searching', result['content'])

    def test_tool_use_glob_with_pattern(self):
        event = json.dumps({
            "type": "assistant",
            "message": {
                "content": [{"type": "tool_use", "name": "Glob", "input": {"pattern": "**/*.ts"}}]
            }
        })
        result = parse_claude(event)
        self.assertEqual(result['type'], 'status')
        self.assertIn('**/*.ts', result['content'])

    def test_tool_use_websearch_returns_searching_web(self):
        event = json.dumps({
            "type": "assistant",
            "message": {"content": [{"type": "tool_use", "name": "WebSearch", "input": {}}]}
        })
        result = parse_claude(event)
        self.assertIn('Searching web', result['content'])

    def test_tool_use_webfetch_with_url(self):
        event = json.dumps({
            "type": "assistant",
            "message": {
                "content": [
                    {"type": "tool_use", "name": "WebFetch",
                     "input": {"url": "https://example.com"}}
                ]
            }
        })
        result = parse_claude(event)
        self.assertIn('https://example.com', result['content'])

    def test_tool_use_agent_returns_launching_agent(self):
        event = json.dumps({
            "type": "assistant",
            "message": {"content": [{"type": "tool_use", "name": "Agent", "input": {}}]}
        })
        result = parse_claude(event)
        self.assertIn('agent', result['content'].lower())

    def test_tool_use_edit_returns_editing_file(self):
        event = json.dumps({
            "type": "assistant",
            "message": {"content": [{"type": "tool_use", "name": "Edit", "input": {}}]}
        })
        result = parse_claude(event)
        self.assertIn('Editing', result['content'])

    def test_tool_use_write_returns_writing_file(self):
        event = json.dumps({
            "type": "assistant",
            "message": {"content": [{"type": "tool_use", "name": "Write", "input": {}}]}
        })
        result = parse_claude(event)
        self.assertIn('Writing', result['content'])

    def test_tool_use_mcp_tool_returns_using_label(self):
        event = json.dumps({
            "type": "assistant",
            "message": {
                "content": [
                    {"type": "tool_use", "name": "mcp__github__get_issue", "input": {}}
                ]
            }
        })
        result = parse_claude(event)
        self.assertEqual(result['type'], 'status')
        self.assertIn('get_issue', result['content'])

    def test_tool_use_unknown_name_returns_using_name(self):
        event = json.dumps({
            "type": "assistant",
            "message": {
                "content": [{"type": "tool_use", "name": "MyCustomTool", "input": {}}]
            }
        })
        result = parse_claude(event)
        self.assertEqual(result['type'], 'status')
        self.assertIn('MyCustomTool', result['content'])

    def test_assistant_no_content_blocks_returns_unknown(self):
        event = json.dumps({
            "type": "assistant",
            "message": {"content": []}
        })
        result = parse_claude(event)
        self.assertEqual(result['type'], 'unknown')


# ── parseCopilotOutput ─────────────────────────────────────────────────────────

class TestParseCopilotOutput(unittest.TestCase):

    def test_empty_line_returns_unknown(self):
        result = parse_copilot('')
        self.assertEqual(result['type'], 'unknown')

    def test_whitespace_only_returns_unknown(self):
        result = parse_copilot('   ')
        self.assertEqual(result['type'], 'unknown')

    def test_plain_text_returns_text_type(self):
        result = parse_copilot('Here is the output from the agent')
        self.assertEqual(result['type'], 'text')
        self.assertIn('Here is the output', result['content'])

    def test_calling_tool_pattern_returns_status(self):
        result = parse_copilot('● Calling bash_execute...')
        self.assertEqual(result['type'], 'status')
        self.assertIn('bash_execute', result['content'])

    def test_reading_pattern_returns_status(self):
        result = parse_copilot('● Reading some/file.ts')
        self.assertEqual(result['type'], 'status')
        self.assertIn('Reading', result['content'])

    def test_generic_bullet_action_returns_status(self):
        result = parse_copilot('● Searching for pattern')
        self.assertEqual(result['type'], 'status')

    def test_spinner_chars_returns_unknown(self):
        result = parse_copilot('⠋')
        self.assertEqual(result['type'], 'unknown')

    def test_ansi_escape_codes_stripped_then_evaluated(self):
        # ANSI bold + reset around plain text should still yield text
        result = parse_copilot('\x1B[1mHello\x1B[0m')
        self.assertEqual(result['type'], 'text')

    def test_calling_pattern_without_trailing_dots(self):
        result = parse_copilot('● Calling read_file')
        self.assertEqual(result['type'], 'status')
        self.assertIn('read_file', result['content'])

    def test_multiword_generic_bullet_returns_status(self):
        result = parse_copilot('● Writing file')
        self.assertEqual(result['type'], 'status')


# ── cleanAgentOutput ───────────────────────────────────────────────────────────

class TestCleanAgentOutput(unittest.TestCase):

    def test_plain_text_unchanged(self):
        result = clean_output('Hello world')
        self.assertEqual(result, 'Hello world')

    def test_function_calls_block_removed(self):
        content = 'Before<function_calls><invoke>stuff</invoke></function_calls>After'
        result = clean_output(content)
        self.assertNotIn('<function_calls>', result)
        self.assertIn('Before', result)
        self.assertIn('After', result)

    def test_tool_call_block_removed(self):
        content = 'Start<tool_call>{"tool": "read"}</tool_call>End'
        result = clean_output(content)
        self.assertNotIn('<tool_call>', result)
        self.assertIn('Start', result)
        self.assertIn('End', result)

    def test_invoke_block_removed(self):
        content = 'A<invoke name="bash"><command>ls</command></invoke>B'
        result = clean_output(content)
        self.assertNotIn('<invoke', result)
        self.assertIn('A', result)
        self.assertIn('B', result)

    def test_read_file_xml_removed(self):
        content = 'X<read_file><path>/tmp/foo</path></read_file>Y'
        result = clean_output(content)
        self.assertNotIn('<read_file>', result)

    def test_write_file_xml_removed(self):
        content = 'X<write_file><path>/tmp/foo</path></write_file>Y'
        result = clean_output(content)
        self.assertNotIn('<write_file>', result)

    def test_search_files_xml_removed(self):
        content = 'X<search_files><pattern>*.ts</pattern></search_files>Y'
        result = clean_output(content)
        self.assertNotIn('<search_files>', result)

    def test_parameter_block_removed(self):
        content = 'X<parameter name="foo">bar</parameter>Y'
        result = clean_output(content)
        self.assertNotIn('<parameter', result)

    def test_empty_string_returns_empty(self):
        result = clean_output('')
        self.assertEqual(result, '')

    def test_multiple_consecutive_newlines_collapsed(self):
        content = 'line1\n\n\n\nline2'
        result = clean_output(content)
        self.assertNotIn('\n\n\n', result)

    def test_multiple_spaces_collapsed(self):
        content = 'word1    word2'
        result = clean_output(content)
        self.assertNotIn('   ', result)


# ── parseAgentOutput ───────────────────────────────────────────────────────────

class TestParseAgentOutput(unittest.TestCase):

    def test_claude_agent_type_uses_json_parser(self):
        event = json.dumps({"type": "result", "result": "done"})
        result = parse_agent(event, 'claude')
        self.assertEqual(result['type'], 'result')

    def test_copilot_agent_type_uses_copilot_parser(self):
        result = parse_agent('● Calling bash_execute...', 'copilot')
        self.assertEqual(result['type'], 'status')

    def test_unknown_agent_type_falls_back_to_text(self):
        result = parse_agent('some output', 'unknown_agent')
        self.assertEqual(result['type'], 'text')
        self.assertEqual(result['content'], 'some output')


# ── usesJsonOutput ─────────────────────────────────────────────────────────────

class TestUsesJsonOutput(unittest.TestCase):

    def test_claude_uses_json_output(self):
        self.assertTrue(uses_json_output('claude'))

    def test_copilot_does_not_use_json_output(self):
        self.assertFalse(uses_json_output('copilot'))

    def test_unknown_agent_does_not_use_json_output(self):
        self.assertFalse(uses_json_output('unknown'))


if __name__ == '__main__':
    print(f"Project root: {PROJECT_ROOT}")
    print("Running outputParser unit tests...\n")
    unittest.main(verbosity=2)
