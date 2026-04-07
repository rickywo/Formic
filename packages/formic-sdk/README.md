# @rickywo/formic-sdk

TypeScript type definitions and scaffolding CLI for building [Formic](https://github.com/rickywo/formic) plugins.

## What is this?

`@rickywo/formic-sdk` gives you:

- **Full TypeScript types** for the `FormicPlugin` interface and the entire `FormicAPI` surface (`TaskApi`, `SkillApi`, `UIApi`, `SettingsApi`, `IntegrationApi`, `MemoryApi`, `EventApi`, `PluginLogger`)
- **`formic-sdk create-plugin`** — a scaffolding CLI that generates a ready-to-build plugin project
- **Type definitions** for all UI slot props, pipeline types, webhook helpers, and memory entries

The SDK is **types-only** — no runtime code is bundled. All types mirror the interfaces used by the Formic server.

---

## Installation

```bash
npm install --save-dev @rickywo/formic-sdk
```

---

## Quick Start

### 1. Scaffold a plugin

```bash
npx formic-sdk create-plugin
```

Follow the prompts to enter a plugin name, description, and author. A project directory is created with:

```
my-plugin/
├── src/
│   └── index.ts       # Your FormicPlugin class
├── manifest.json      # Plugin metadata and permissions
├── package.json
└── tsconfig.json
```

### 2. Implement your plugin

```typescript
import type { FormicPlugin, FormicAPI } from '@rickywo/formic-sdk';

export default class MyPlugin implements FormicPlugin {
  id = 'my-plugin';
  name = 'My Plugin';
  version = '1.0.0';
  description = 'An example Formic plugin';

  private unsubs: Array<() => void> = [];

  async onLoad(api: FormicAPI): Promise<void> {
    api.logger.info('My Plugin loaded!');

    // Subscribe to task lifecycle events
    this.unsubs.push(
      api.tasks.onTaskCreated((task) => {
        api.logger.info(`New task: ${task.title}`);
      }),
      api.tasks.onTaskCompleted((task) => {
        api.logger.info(`Completed: ${task.title}`);
      }),
    );
  }

  async onUnload(): Promise<void> {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
  }
}
```

### 3. Declare permissions in `manifest.json`

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "An example Formic plugin",
  "permissions": ["tasks:read", "events:subscribe"],
  "serverEntry": "dist/index.js"
}
```

### 4. Build and load

```bash
npm run build
formic start --plugins ./my-plugin
```

---

## Full Documentation

For the complete plugin development guide — API reference, permissions, UI slots, lifecycle, best practices, and a full example plugin walkthrough — see:

👉 **[`docs/plugin-development.md`](../../docs/plugin-development.md)**

---

## Exported Types

### Core Plugin Interface

| Export | Description |
|--------|-------------|
| `FormicPlugin` | The plugin class contract (`id`, `name`, `version`, `onLoad`, `onUnload`) |
| `FormicAPI` | The API object passed to `onLoad` (all sub-APIs) |
| `PluginPermission` | Union type of all permission strings |
| `PluginManifest` | The `manifest.json` schema |
| `Unsubscribe` | `() => void` — returned by event registration methods |

### Sub-API Interfaces

| Export | Description |
|--------|-------------|
| `TaskApi` | Read/write tasks and subscribe to lifecycle events |
| `SkillApi` | Register skills, task types, and verifiers |
| `SettingsApi` | Read/write plugin-scoped settings |
| `UIApi` | Register slot renderers, sidebar panels, and toolbar actions |
| `IntegrationApi` | Register webhooks, bot commands, and send notifications |
| `MemoryApi` | Read/write long-term memory, subscribe to reflection events |
| `EventApi` | Subscribe to raw internal events by name |
| `PluginLogger` | Plugin-scoped logger with `[Plugin:<name>]` prefix |

### UI Types

| Export | Description |
|--------|-------------|
| `UISlot` | Union type of all slot IDs |
| `RenderFunction<P>` | Vanilla JS render function signature |
| `ComponentType<P>` | React-compatible component type |
| `KanbanCardBadgeProps` | Props for `kanban-card-badge` slot |
| `KanbanCardFooterProps` | Props for `kanban-card-footer` slot |
| `TaskNodeEditorProps` | Props for `task-node-editor` slot |
| `TaskStagePanelProps` | Props for `task-stage-panel` slot |
| `DagVisualizationProps` | Props for `dag-visualization` slot |
| `TaskDetailSidebarProps` | Props for `task-detail-sidebar` slot |
| `ToolbarRightProps` | Props for `toolbar-right` slot |
| `SettingsPanelProps` | Props for `settings-panel` slot |

### Pipeline Types

| Export | Description |
|--------|-------------|
| `TaskTypeDefinition` | Custom task type definition with workflow stages |
| `VerifierDefinition` | Custom verifier that runs during the verify stage |
| `VerifierResult` | Result returned by a verifier (`passed`, `message`, `details`) |
| `StageDescriptor` | A single pipeline stage descriptor |

### Task & Memory Types

| Export | Description |
|--------|-------------|
| `Task` | Full task object |
| `CreateTaskInput` | Input for creating a task |
| `TaskStatus` | Task status union type |
| `MemoryEntry` | A single memory entry |
| `MemoryType` | `'pattern' \| 'pitfall' \| 'preference'` |

---

## License

MIT
