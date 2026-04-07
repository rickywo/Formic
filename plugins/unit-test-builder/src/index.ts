import type { FormicPlugin, FormicAPI, Unsubscribe, StageRegistration } from '@rickywo/formic-sdk';

const DEFAULT_COVERAGE_THRESHOLD = 80;

const DEFAULT_PROMPT_TEMPLATE = `You are an expert software engineer specialising in test-driven quality assurance. \
Your job is to write or update unit tests for all files that were modified or created during \
the execute stage.

## Coverage Target

Iterate until code coverage meets or exceeds **{{COVERAGE_THRESHOLD}}%**.

## Task Context

**Task ID:** $TASK_ID
**Task Title:** $TASK_TITLE
**Task Docs:** $TASK_DOCS_PATH

## Your Workflow

### Step 1: Identify Files to Test

Read \`$TASK_DOCS_PATH/declared-files.json\` to find the files that were modified:

\`\`\`bash
cat "$TASK_DOCS_PATH/declared-files.json"
\`\`\`

The \`exclusive\` list contains files that were modified. Skip test files, configuration files,
documentation, and binary assets.

### Step 2: Detect the Test Framework

Inspect the project to determine the testing framework in use (Jest, Vitest, pytest, etc.).

### Step 3: Read the Source Files

Read each modified source file to understand what needs testing: the public API, business logic,
edge cases, error handling, and async operations.

### Step 4: Check for Existing Tests

Before writing new tests, check if test files already exist and identify coverage gaps.

### Step 5: Write or Update Tests

Write meaningful unit tests targeting:
1. Happy path — main success scenarios for each exported function/method
2. Edge cases — empty inputs, boundary values, null/undefined handling
3. Error paths — expected exceptions, rejected promises, invalid inputs
4. Integration points — interactions with direct dependencies (mock external ones)

### Step 6: Run the Tests and Measure Coverage

Run the test suite with coverage measurement:

\`\`\`bash
# Node.js / TypeScript
npm test -- --coverage 2>&1 | tail -50
# or
npx jest --coverage 2>&1 | tail -50

# Python
python -m pytest --cov=. --cov-report=term-missing 2>&1 | tail -50
\`\`\`

If coverage is below {{COVERAGE_THRESHOLD}}%, add more tests and re-run. Continue until
coverage meets or exceeds {{COVERAGE_THRESHOLD}}% or after 3 iterations.

### Step 7: Report Results

Log a summary to the task:

\`\`\`bash
curl -s -X POST "$FORMIC_API_URL/api/tasks/$TASK_ID/logs" \\\\
  -H 'Content-Type: application/json' \\\\
  -d '{"message": "Unit Testing complete — X test(s) added/updated. Coverage: Y%."}'
\`\`\`

## Important Constraints

- Only test files in \`declared-files.json\` — do not modify tests for unrelated code
- Do not modify source files to make tests pass; fix the tests instead
- Follow project coding standards from the development guidelines
- If a file has no testable logic (pure types, config, HTML templates), skip it
`;

/**
 * Build the final skill prompt by substituting the coverage threshold placeholder.
 * Supports both {{COVERAGE_THRESHOLD}} and {{coverageThreshold}} placeholder formats.
 */
function buildPrompt(template: string, coverageThreshold: number): string {
  return template
    .replace(/\{\{COVERAGE_THRESHOLD\}\}/g, String(coverageThreshold))
    .replace(/\{\{coverageThreshold\}\}/g, String(coverageThreshold));
}

export default class UnitTestBuilderPlugin implements FormicPlugin {
  readonly id = 'unit-test-builder';
  readonly name = 'Unit Test Builder';
  readonly version = '1.0.0';
  readonly description = 'Adds a unit-test pipeline stage that generates tests until a configurable coverage threshold is met';

  private unsubscribePanel: Unsubscribe | null = null;

  async onLoad(api: FormicAPI): Promise<void> {
    api.logger.info('Unit Test Builder plugin loading');

    const coverageThreshold =
      (await api.settings.get<number>('coverageThreshold', DEFAULT_COVERAGE_THRESHOLD)) ??
      DEFAULT_COVERAGE_THRESHOLD;

    const customPrompt = (await api.settings.get<string>('unitTestPrompt', '')) ?? '';

    // Build the skill override content: use custom prompt if set, otherwise use default template
    const promptTemplate = customPrompt.trim().length > 0 ? customPrompt : DEFAULT_PROMPT_TEMPLATE;
    const skillContent = buildPrompt(promptTemplate, coverageThreshold);

    // Register the unit-test pipeline stage (positioned after execute, before verify)
    const stageConfig: StageRegistration = {
      name: 'unit-test',
      displayName: 'Unit Testing',
      after: 'execute',
      skillContent,
    };
    await api.skills.registerStage(stageConfig);
    api.logger.info(`Unit Test Builder: registered unit-test stage (threshold: ${coverageThreshold}%)`);

    // Also register as a named skill override so loadSkillPrompt resolves it even if
    // the stage name does not match an on-disk skills/ directory entry.
    api.skills.registerSkillOverride('unit-test', skillContent);

    // Register a sidebar panel entry so the plugin appears in the settings UI
    this.unsubscribePanel = api.ui.registerSidebarPanel({
      id: 'unit-test-builder-settings',
      title: 'Unit Test Builder',
      icon: '🧪',
      mountPoint: 'settings-panel',
    });

    api.logger.info('Unit Test Builder plugin loaded');
  }

  async onUnload(): Promise<void> {
    // Unregister the settings sidebar panel
    if (this.unsubscribePanel) {
      this.unsubscribePanel();
      this.unsubscribePanel = null;
    }
    // Stage and skill override cleanup is handled automatically by apiDispose()
    // when the plugin manager calls dispose() after onUnload().
  }
}

