/**
 * Unit Test Plugin — Server Entry
 *
 * Registers a custom "unit-test" pipeline stage that runs after the "execute"
 * stage. When reached, the workflow engine loads the skill prompt and spawns
 * an AI agent that:
 *   1. Analyses the code changes made during execution
 *   2. Generates comprehensive unit tests covering those changes
 *   3. Runs the tests and writes a report to the task docs directory
 *
 * This plugin exercises the configurable pipeline system (task t-10):
 *   - pipelineRegistry.registerStage() for stage insertion
 *   - skillReader.registerSkillOverride() for inline skill content
 */

// ---------------------------------------------------------------------------
// Skill prompt — inlined so the plugin is fully self-contained
// ---------------------------------------------------------------------------
const SKILL_CONTENT = `---
name: unit-test
description: Assesses code changes from the execute stage and generates comprehensive unit tests to cover them.
---

# Unit Test Skill — Generate Tests for Code Changes

You are an expert software testing engineer. Your task is to analyse the code
changes made during the execute stage of a Formic task and produce
comprehensive unit tests that cover the new and modified code.

**Task Title:** $TASK_TITLE

**Task ID:** $TASK_ID

**Task Docs Path:** $TASK_DOCS_PATH

---

## Instructions

### Step 1 — Understand what was implemented

1. Read the task specification and plan:
   - \\\`$TASK_DOCS_PATH/README.md\\\` — feature specification
   - \\\`$TASK_DOCS_PATH/PLAN.md\\\` — implementation plan
   - \\\`$TASK_DOCS_PATH/subtasks.json\\\` — subtask list with completion status

2. Identify the files that were created or modified during execution:
   - Read \\\`$TASK_DOCS_PATH/declared-files.json\\\` if it exists (lists exclusive and shared files)
   - Run \\\`git diff --name-only HEAD~1\\\` (or an appropriate range) to discover changed files
   - For each changed file, run \\\`git diff HEAD~1 -- <file>\\\` to see exactly what changed

3. Read the full content of every changed source file so you understand the
   implementation context, function signatures, class structures, and edge cases.

### Step 2 — Discover the project's testing conventions

Before writing any tests, explore the existing test infrastructure:

1. Check for existing test configuration files:
   - \\\`jest.config.*\\\`, \\\`vitest.config.*\\\`, \\\`mocha*\\\`, \\\`.mocharc.*\\\`, \\\`pytest.ini\\\`, \\\`setup.cfg\\\`
   - \\\`package.json\\\` — look for \\\`scripts.test\\\`, \\\`jest\\\`, \\\`vitest\\\` keys
   - \\\`tsconfig.json\\\` — check test include patterns

2. Find existing test files to understand patterns:
   - Search for \\\`*.test.*\\\`, \\\`*.spec.*\\\`, \\\`test_*\\\`, \\\`*_test.*\\\` files
   - Read 2-3 existing test files to learn:
     - Import style and test runner API usage
     - Naming conventions (describe/it blocks, test names)
     - Mocking patterns and test utilities used
     - File location conventions (co-located vs \\\`test/\\\` directory)

3. Adopt the **exact same patterns** you discover. Do NOT introduce a new test
   framework or style — match the project's existing conventions.

### Step 3 — Design the test plan

For each changed file, determine what needs to be tested:

- **New functions/methods**: Test happy path, edge cases, error handling
- **Modified functions**: Test the changed behaviour; ensure existing contracts still hold
- **New types/interfaces**: Test type guards and validation if applicable
- **New API routes**: Test request/response for success and error cases
- **New services**: Test public API with mocked dependencies
- **Configuration changes**: Test that new config values are read correctly

Create a mental checklist covering:
- ✅ Happy path (normal inputs produce correct output)
- ✅ Edge cases (empty inputs, boundary values, null/undefined)
- ✅ Error handling (invalid inputs throw or return errors)
- ✅ Integration points (mocked dependencies behave as expected)

### Step 4 — Write the unit tests

Write test files following the project's conventions. Key rules:

1. **One test file per source file** (or per logical module)
2. **Co-locate or mirror** the project's existing test file placement
3. **Use descriptive test names** that explain the expected behaviour
4. **Mock external dependencies** (file I/O, network, databases) — tests must be deterministic
5. **Do NOT modify source code** — only create/modify test files
6. **Import from the actual source paths** — do not duplicate implementation code

### Step 5 — Run the tests

Execute the test suite to verify all new tests pass:

\\\`\\\`\\\`bash
# Use the project's test command (discovered in Step 2)
npm test          # or: npx jest, npx vitest, python -m pytest, etc.
\\\`\\\`\\\`

If any tests fail:
1. Read the error output carefully
2. Fix the test (NOT the source code)
3. Re-run until all tests pass

### Step 6 — Write the test report

Write a JSON report to \\\`$TASK_DOCS_PATH/test-report.json\\\`:

\\\`\\\`\\\`json
{
  "version": "1.0",
  "taskId": "$TASK_ID",
  "generatedAt": "[ISO 8601 timestamp]",
  "summary": {
    "totalTests": 0,
    "passed": 0,
    "failed": 0,
    "skipped": 0
  },
  "testFiles": [
    {
      "path": "relative/path/to/test-file.test.ts",
      "sourceFile": "relative/path/to/source-file.ts",
      "tests": [
        { "name": "should do X when Y", "status": "passed" }
      ]
    }
  ],
  "coverage": {
    "note": "Run coverage tool separately if configured",
    "filesWithoutTests": []
  }
}
\\\`\\\`\\\`

---

## Guidelines

- **Match existing patterns** — your tests should look like a senior developer on the project wrote them
- **Aim for meaningful coverage** — test behaviour, not implementation details
- **Keep tests fast** — mock I/O, avoid network calls, use in-memory data
- **Be thorough but practical** — cover the critical paths; don't over-test trivial getters/setters
- **Never modify source code** — if you find a bug, note it in the test report but do not fix it
- **Use the project's assertion library** — do not introduce new testing dependencies

---

## Output

1. Unit test files (placed according to project conventions)
2. \\\`$TASK_DOCS_PATH/test-report.json\\\` — structured test report

Do not output anything else.
`;

// ---------------------------------------------------------------------------
// Dynamic module loader — resolves pipeline + skill services from the running
// Formic process regardless of dev (tsx) or production (dist/) mode.
// ---------------------------------------------------------------------------
async function loadFormicServices() {
  const cwd = process.cwd();

  // Try production (dist/) first, then dev (src/ via tsx)
  const bases = [
    `file://${cwd}/dist/server/services`,
    `file://${cwd}/src/server/services`,
  ];

  for (const base of bases) {
    try {
      const [pipeline, skill, configStore] = await Promise.all([
        import(`${base}/pipelineRegistry.js`),
        import(`${base}/skillReader.js`),
        import(`${base}/configStore.js`),
      ]);
      return { pipeline, skill, configStore };
    } catch {
      // Try next base path
    }
  }

  throw new Error('Could not resolve Formic service modules from dist/ or src/');
}

// ---------------------------------------------------------------------------
// Prompt resolution — merges built-in SKILL_CONTENT with user settings
// ---------------------------------------------------------------------------

/**
 * Resolves the final skill prompt based on plugin settings.
 *
 * - `customPrompt` (string): User-supplied prompt text. Supports the same
 *   template variables as the built-in prompt ($TASK_TITLE, $TASK_ID,
 *   $TASK_DOCS_PATH) — they are resolved later by the workflow engine.
 * - `promptMode` ("append" | "replace"):
 *   - "append"  → SKILL_CONTENT + "\n\n" + customPrompt
 *   - "replace" → customPrompt only (falls back to default if empty)
 *
 * Returns the built-in SKILL_CONTENT when customPrompt is empty or undefined.
 */
async function resolvePrompt(configStore) {
  try {
    const customPrompt = await configStore.getPluginSetting('unit-test', 'customPrompt');
    const promptMode = await configStore.getPluginSetting('unit-test', 'promptMode');

    const trimmed = typeof customPrompt === 'string' ? customPrompt.trim() : '';

    if (!trimmed) {
      return SKILL_CONTENT;
    }

    const mode = promptMode === 'replace' ? 'replace' : 'append';

    if (mode === 'replace') {
      return trimmed;
    }

    // append mode (default)
    return SKILL_CONTENT + '\n\n' + trimmed;
  } catch (err) {
    console.warn(
      '[Plugin:unit-test] Failed to read prompt settings, using default:',
      err instanceof Error ? err.message : 'Unknown error',
    );
    return SKILL_CONTENT;
  }
}

// ---------------------------------------------------------------------------
// Fastify plugin — default export
// ---------------------------------------------------------------------------
export default async function unitTestPlugin(fastify) {
  let services;
  try {
    services = await loadFormicServices();
  } catch (err) {
    console.warn(
      '[Plugin:unit-test] Failed to load Formic services:',
      err instanceof Error ? err.message : 'Unknown error',
    );
    console.warn('[Plugin:unit-test] Stage registration skipped — plugin routes still available');
    registerRoutes(fastify);
    return;
  }

  const { pipeline, skill, configStore } = services;

  // Register the "unit-test" stage after "execute" in the pipeline
  try {
    pipeline.registerStage(
      {
        name: 'unit-test',
        displayName: 'Unit Testing',
        after: 'execute',
      },
      'unit-test', // pluginName
    );
  } catch (err) {
    // Stage may already be registered from a previous load
    console.warn(
      '[Plugin:unit-test] Stage registration note:',
      err instanceof Error ? err.message : 'Unknown error',
    );
  }

  // Resolve the skill prompt from settings (custom prompt + mode)
  const resolvedContent = await resolvePrompt(configStore);

  // Register the resolved skill content so skillReader returns it for this stage
  try {
    skill.registerSkillOverride('unit-test', resolvedContent, 'unit-test');
  } catch (err) {
    console.warn(
      '[Plugin:unit-test] Skill override registration note:',
      err instanceof Error ? err.message : 'Unknown error',
    );
  }

  console.warn('[Plugin:unit-test] Registered "unit-test" stage after "execute" in the pipeline');

  // Register plugin-specific routes
  registerRoutes(fastify);
}

// ---------------------------------------------------------------------------
// Plugin REST routes (scoped under /api/plugins/unit-test/)
// ---------------------------------------------------------------------------
function registerRoutes(fastify) {
  // GET /status — confirm the plugin is active and the stage is registered
  fastify.get('/status', async () => {
    return {
      plugin: 'unit-test',
      version: '1.0.0',
      stageRegistered: true,
      position: 'after execute',
      timestamp: Date.now(),
    };
  });
}
