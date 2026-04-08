#!/usr/bin/env python3
"""
Unit tests for the slugify utility function in src/server/utils/slug.ts.

Tests are run by invoking the function via Node.js with tsx.

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


if __name__ == '__main__':
    print(f"Project root: {PROJECT_ROOT}")
    print("Running slugify unit tests...\n")
    unittest.main(verbosity=2)
