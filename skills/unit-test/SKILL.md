---
name: unit-test
description: Generates and improves unit tests until a configurable coverage threshold is met
---

# Unit Test Generation

You are working on task **$TASK_ID**: $TASK_TITLE

Task documentation is at: $TASK_DOCS_PATH

## Objective

Generate or improve unit tests for all files modified during the execute stage of this task. Iterate until the configured coverage threshold is reached.

## Coverage Target

Target code coverage: **{{COVERAGE_THRESHOLD}}%**

## Instructions

1. **Identify modified files**: Review the git diff or task execution logs to determine which source files were created or modified during the execute stage.

2. **Write or update tests**: For each modified file:
   - Create or update the corresponding test file
   - Cover all public functions, methods, and edge cases
   - Use the project's existing test framework and patterns
   - Follow the test file naming convention used in the project

3. **Run the test suite**: Execute the project's test runner to measure current coverage.

4. **Check coverage**: If coverage is below {{COVERAGE_THRESHOLD}}%, identify untested code paths and add more tests.

5. **Iterate**: Repeat steps 3–4 until coverage meets or exceeds {{COVERAGE_THRESHOLD}}%, or until all reasonable test cases have been covered.

6. **Commit tests**: Once the threshold is met, the tests are complete.

## Notes

- Do not modify production source files during this stage — only add or update test files.
- If a file has no testable logic (e.g., pure configuration, type definitions), note this and move on.
- Use the project's existing mock/stub patterns for external dependencies.
- If coverage tooling is not configured, set it up following the project's conventions.
