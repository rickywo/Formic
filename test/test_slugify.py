#!/usr/bin/env python3
"""
Unit tests for slug utilities in src/server/utils/slug.ts.

Covers both exported functions:
  - slugify  — no truncation
  - generateSlug — truncates to 30 characters

Tests are run by invoking each function via Node.js with tsx.

Usage:
    python test/test_slugify.py
"""

import subprocess
import sys
import os
import unittest

# Resolve project root relative to this file
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def call_slugify(input_str: str) -> str:
    """Invoke the slugify function via Node.js + tsx and return the result."""
    script = (
        f"import {{ slugify }} from './src/server/utils/slug.js';"
        f"console.log(slugify({repr(input_str)}));"
    )
    result = subprocess.run(
        ['node', '--import=tsx/esm', '--input-type=module'],
        input=script,
        capture_output=True,
        text=True,
        cwd=PROJECT_ROOT,
    )
    if result.returncode != 0:
        raise RuntimeError(f"Node error: {result.stderr.strip()}")
    return result.stdout.strip()


class TestSlugify(unittest.TestCase):

    def test_normal_mixed_case(self):
        self.assertEqual(call_slugify('Hello World'), 'hello-world')

    def test_empty_string(self):
        self.assertEqual(call_slugify(''), '')

    def test_all_special_characters(self):
        self.assertEqual(call_slugify('!!!'), '')

    def test_leading_trailing_whitespace(self):
        self.assertEqual(call_slugify('  foo   bar  '), 'foo-bar')

    def test_consecutive_hyphens(self):
        self.assertEqual(call_slugify('foo--bar'), 'foo-bar')

    def test_no_truncation(self):
        long_input = 'a b c d e f g h i j k l m n o p q r s t u v w x y z'
        result = call_slugify(long_input)
        self.assertEqual(result, 'a-b-c-d-e-f-g-h-i-j-k-l-m-n-o-p-q-r-s-t-u-v-w-x-y-z')
        self.assertGreater(len(result), 30)

    def test_strips_special_chars(self):
        self.assertEqual(call_slugify('foo@bar!baz'), 'foobarbaz')

    def test_lowercase(self):
        self.assertEqual(call_slugify('UPPER CASE'), 'upper-case')

    def test_already_slug(self):
        self.assertEqual(call_slugify('already-slug'), 'already-slug')

    def test_numbers_preserved(self):
        self.assertEqual(call_slugify('version 2 release'), 'version-2-release')


def call_generate_slug(title: str) -> str:
    """Invoke the generateSlug function via Node.js + tsx and return the result."""
    script = (
        f"import {{ generateSlug }} from './src/server/utils/slug.js';"
        f"console.log(generateSlug({repr(title)}));"
    )
    result = subprocess.run(
        ['node', '--import=tsx/esm', '--input-type=module'],
        input=script,
        capture_output=True,
        text=True,
        cwd=PROJECT_ROOT,
    )
    if result.returncode != 0:
        raise RuntimeError(f"Node error: {result.stderr.strip()}")
    return result.stdout.strip()


class TestGenerateSlug(unittest.TestCase):

    def test_normal_mixed_case(self):
        self.assertEqual(call_generate_slug('Hello World'), 'hello-world')

    def test_empty_string(self):
        self.assertEqual(call_generate_slug(''), '')

    def test_all_special_characters(self):
        self.assertEqual(call_generate_slug('!!!'), '')

    def test_leading_trailing_whitespace(self):
        self.assertEqual(call_generate_slug('  foo   bar  '), 'foo-bar')

    def test_consecutive_hyphens(self):
        self.assertEqual(call_generate_slug('foo--bar'), 'foo-bar')

    def test_strips_special_chars(self):
        self.assertEqual(call_generate_slug('foo@bar!baz'), 'foobarbaz')

    def test_lowercase(self):
        self.assertEqual(call_generate_slug('UPPER CASE'), 'upper-case')

    def test_already_slug(self):
        self.assertEqual(call_generate_slug('already-slug'), 'already-slug')

    def test_numbers_preserved(self):
        self.assertEqual(call_generate_slug('version 2 release'), 'version-2-release')

    def test_truncates_to_30_chars(self):
        """generateSlug truncates the result to 30 characters."""
        long_input = 'a b c d e f g h i j k l m n o p q r s t u v w x y z'
        result = call_generate_slug(long_input)
        self.assertLessEqual(len(result), 30)

    def test_short_string_not_truncated(self):
        """Strings within the 30-char limit are returned in full."""
        result = call_generate_slug('short title here')
        self.assertEqual(result, 'short-title-here')
        self.assertLessEqual(len(result), 30)

    def test_exact_30_char_boundary(self):
        """A title that produces exactly 30 chars is preserved fully."""
        # "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" = 30 a's
        result = call_generate_slug('a' * 30)
        self.assertEqual(result, 'a' * 30)
        self.assertEqual(len(result), 30)

    def test_exceeds_30_chars_is_truncated(self):
        """A title that produces more than 30 chars is cut at 30."""
        result = call_generate_slug('a' * 40)
        self.assertEqual(len(result), 30)
        self.assertEqual(result, 'a' * 30)

    def test_hyphens_at_leading_position_removed(self):
        """Leading hyphens produced by stripping are removed."""
        self.assertEqual(call_generate_slug('---hello'), 'hello')

    def test_hyphens_at_trailing_position_removed(self):
        """Trailing hyphens produced by stripping are removed."""
        self.assertEqual(call_generate_slug('hello---'), 'hello')

    def test_mixed_spaces_and_hyphens(self):
        """Mixed whitespace and hyphens collapse into a single hyphen."""
        self.assertEqual(call_generate_slug('foo  -  bar'), 'foo-bar')

    def test_single_word(self):
        self.assertEqual(call_generate_slug('word'), 'word')

    def test_numeric_only(self):
        self.assertEqual(call_generate_slug('12345'), '12345')


if __name__ == '__main__':
    print(f"Project root: {PROJECT_ROOT}")
    print("Running slug utility unit tests...\n")
    unittest.main(verbosity=2)
