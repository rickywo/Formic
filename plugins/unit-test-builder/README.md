# unit-test-builder

A Formic plugin that configures the `unit-test` pipeline stage with a configurable coverage threshold and custom skill prompt.

## What it does

When loaded, this plugin registers a skill override for the `unit-test` stage. The override:

- Sets an explicit **coverage threshold** (default: 80%) that the agent must reach before completing the stage
- Allows a **custom prompt** to be supplied via plugin settings, which fully replaces the default skill content

If no custom prompt is configured, a built-in default prompt is used that mirrors the standard `skills/unit-test/SKILL.md` workflow with the coverage threshold injected.

## Settings

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `coverageThreshold` | number | `80` | Minimum code coverage percentage the agent must reach |
| `unitTestPrompt` | string | `""` | Custom skill prompt — overrides the default when non-empty. Use `{{coverageThreshold}}` as a placeholder for the threshold value. |

Settings are stored in the Formic plugin config and can be updated via the Settings → Plugins panel or the Formic API:

```bash
# Update coverage threshold
curl -s -X PUT http://localhost:8000/api/plugins/unit-test-builder/settings \
  -H 'Content-Type: application/json' \
  -d '{"coverageThreshold": 90}'

# Set a custom prompt
curl -s -X PUT http://localhost:8000/api/plugins/unit-test-builder/settings \
  -H 'Content-Type: application/json' \
  -d '{"unitTestPrompt": "Write tests for all modified files. Target: {{coverageThreshold}}% coverage."}'
```

## Permissions

| Permission | Reason |
|-----------|--------|
| `workflow:extend` | Required to register the skill override for the `unit-test` stage |
| `config:read` | Read `coverageThreshold` and `unitTestPrompt` settings |
| `config:write` | Write settings updates |
| `tasks:read` | Access task context |
| `ui:panel` | Register the settings panel entry |

## Development

To rebuild the plugin after modifying `src/index.ts`:

```bash
cd plugins/unit-test-builder
npm install   # only needed once
npm run build
```

The compiled output is committed at `dist/index.js` so the server can load it without a separate build step.
