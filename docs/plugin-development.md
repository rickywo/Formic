# Formic Plugin Development Guide

This guide covers building plugins with the **class-based `FormicPlugin` SDK** — the modern way to extend Formic. It documents the full `FormicAPI` surface, all eight sub-APIs, plugin lifecycle, UI slots, permissions, and includes a complete example plugin walkthrough.

> **Legacy plugins:** If you need to build a server-side Fastify plugin or a client-side IIFE script using the manifest-based format, see [`docs/plugins.md`](./plugins.md).

---

## Table of Contents

1. [Getting Started](#getting-started)
2. [Plugin Lifecycle](#plugin-lifecycle)
3. [API Reference](#api-reference)
   - [TaskApi](#taskapi)
   - [SkillApi](#skillapi)
   - [SettingsApi](#settingsapi)
   - [UIApi](#uiapi)
   - [IntegrationApi](#integrationapi)
   - [MemoryApi](#memoryapi)
   - [EventApi](#eventapi)
   - [PluginLogger](#pluginlogger)
4. [Permissions Reference](#permissions-reference)
5. [UI Slots Reference](#ui-slots-reference)
6. [Development Workflow](#development-workflow)
7. [Best Practices](#best-practices)
8. [Example Plugin Walkthrough](#example-plugin-walkthrough)

---

## Getting Started

### Prerequisites

- **Node.js** ≥ 20
- **TypeScript** ≥ 5.5 (for type-safe plugin development)
- A running Formic instance

### Install the SDK

Add `@rickywo/formic-sdk` as a dev dependency in your plugin project:

```bash
npm install --save-dev @rickywo/formic-sdk
```

The SDK is a types-only package — it contains no runtime code. All type definitions mirror the interfaces used by the Formic server at runtime.

### Scaffold a Plugin

Use the `create-plugin` command to scaffold a new plugin project:

```bash
npx formic-sdk create-plugin
```

You will be prompted for:
- Plugin name (kebab-case, e.g., `my-plugin`)
- Display name (e.g., `My Plugin`)
- Description
- Author

The command creates a ready-to-use TypeScript project:

```
my-plugin/
├── src/
│   └── index.ts          # Plugin entry point — exports a default FormicPlugin class
├── manifest.json         # Plugin metadata and permission declarations
├── package.json
└── tsconfig.json
```

### Manifest Reference

Every plugin needs a `manifest.json`:

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "What this plugin does",
  "author": "Your Name",
  "permissions": [
    "tasks:read",
    "events:subscribe"
  ],
  "serverEntry": "dist/index.js"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | ✓ | Unique plugin ID (kebab-case) |
| `version` | ✓ | Semver version string |
| `description` | — | Human-readable summary |
| `author` | — | Author name or identifier |
| `permissions` | — | Declared `PluginPermission[]` — see [Permissions Reference](#permissions-reference) |
| `serverEntry` | — | Path to the compiled entry file (e.g., `dist/index.js`) |
| `clientEntry` | — | Path to a client-side IIFE script (legacy only) |
| `minFormicVersion` | — | Minimum Formic version required (semver) |

### Build and Install

```bash
# In your plugin directory
npm run build          # Compiles TypeScript to dist/
```

Then place (or symlink) the plugin directory into Formic's plugin directory:

```bash
cp -r my-plugin/ /path/to/your/project/.formic/plugins/my-plugin/
```

Or use the `--plugins` flag for local development — see [Development Workflow](#development-workflow).

---

## Plugin Lifecycle

### The `FormicPlugin` Interface

```typescript
import type { FormicPlugin, FormicAPI } from '@rickywo/formic-sdk';

export default class MyPlugin implements FormicPlugin {
  id = 'my-plugin';
  name = 'My Plugin';
  version = '1.0.0';
  description = 'Optional description';

  async onLoad(api: FormicAPI): Promise<void> {
    // Called once when the plugin is loaded.
    // Register event handlers, UI slots, verifiers, etc.
  }

  async onUnload(): Promise<void> {
    // Called when the plugin is unloaded or Formic is shutting down.
    // Clean up any state your plugin manages.
  }
}
```

### Interface Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | ✓ | Unique plugin identifier (must match `manifest.json` `name`) |
| `name` | `string` | ✓ | Human-readable display name |
| `version` | `string` | ✓ | Semver version string |
| `description` | `string` | — | Optional description shown in plugin manager |
| `onLoad(api)` | `(api: FormicAPI) => Promise<void>` | ✓ | Invoked when the plugin is loaded |
| `onUnload()` | `() => Promise<void>` | ✓ | Invoked when the plugin is unloaded |

### `onLoad(api: FormicAPI)`

Called once after Formic loads your plugin. The `api` object provides access to all eight sub-APIs. Use `onLoad` to:

- Subscribe to task lifecycle events via `api.tasks.onTaskCreated(...)` etc.
- Register custom skills or verifiers via `api.skills`
- Mount UI components via `api.ui.registerSlot(...)`
- Read or write plugin settings via `api.settings`
- Register webhook endpoints via `api.integrations.registerWebhook(...)`

Store all `Unsubscribe` handles returned by event registrations so you can call them in `onUnload`.

### `onUnload()`

Called when the plugin is disabled, unloaded, or Formic is shutting down. Formic **automatically** cleans up:

- Event listeners registered via `api.events.on(...)`
- Task lifecycle listeners registered via `api.tasks.on*(...)`
- Custom pipeline stages registered via `api.skills.register(...)`
- UI slots registered via `api.ui.registerSlot(...)`
- Webhook handlers registered via `api.integrations.registerWebhook(...)`
- Bot commands registered via `api.integrations.registerBotCommand(...)`

Your plugin should additionally clean up any **external state** it manages: timers, external connections, cached data, or custom DOM elements.

---

## API Reference

The `FormicAPI` object passed to `onLoad` has the following sub-APIs:

```typescript
interface FormicAPI {
  tasks: TaskApi;
  skills: SkillApi;
  settings: SettingsApi;
  ui: UIApi;
  integrations: IntegrationApi;
  memory: MemoryApi;
  events: EventApi;
  logger: PluginLogger;
}
```

---

### TaskApi

Access and manipulate tasks. Subscribe to lifecycle events.

**Required permissions:** `tasks:read` (reads), `tasks:write` (writes), `events:subscribe` (lifecycle hooks)

```typescript
interface TaskApi {
  getTask(id: string): Promise<Task | null>;
  getAllTasks(): Promise<Task[]>;
  createTask(data: CreateTaskInput): Promise<Task>;
  updateTask(id: string, data: Partial<Task>): Promise<Task>;
  onTaskCreated(handler: (task: Task) => void): Unsubscribe;
  onTaskUpdated(handler: (task: Task) => void): Unsubscribe;
  onTaskCompleted(handler: (task: Task) => void): Unsubscribe;
  onTaskFailed(handler: (task: Task, error: string) => void): Unsubscribe;
  onStageChanged(handler: (task: Task, fromStage: string, toStage: string) => void): Unsubscribe;
}
```

#### Methods

**`getTask(id: string): Promise<Task | null>`**
Returns a deep clone of the task with the given ID, or `null` if not found.
- Permission: `tasks:read`

**`getAllTasks(): Promise<Task[]>`**
Returns a deep clone of all tasks on the board.
- Permission: `tasks:read`

**`createTask(data: CreateTaskInput): Promise<Task>`**
Creates a new task and returns the created task object.
- Permission: `tasks:write`
- Key fields of `CreateTaskInput`: `title` (required), `context`, `priority`, `type`

**`updateTask(id: string, data: Partial<Task>): Promise<Task>`**
Applies a partial update to a task. Throws if the task is not found.
- Permission: `tasks:write`

**`onTaskCreated(handler: (task: Task) => void): Unsubscribe`**
Fires when a new task is created.
- Permission: `events:subscribe`
- Returns an `Unsubscribe` function — call it in `onUnload()`

**`onTaskUpdated(handler: (task: Task) => void): Unsubscribe`**
Fires when any field of a task changes.
- Permission: `events:subscribe`

**`onTaskCompleted(handler: (task: Task) => void): Unsubscribe`**
Fires when a task reaches the `done` status.
- Permission: `events:subscribe`

**`onTaskFailed(handler: (task: Task, error: string) => void): Unsubscribe`**
Fires when a task transitions to the `blocked` status with an error message.
- Permission: `events:subscribe`

**`onStageChanged(handler: (task: Task, fromStage: string, toStage: string) => void): Unsubscribe`**
Fires on every status transition with the old and new stage names.
- Permission: `events:subscribe`

#### Example

```typescript
async onLoad(api: FormicAPI): Promise<void> {
  this.unsubs.push(
    api.tasks.onTaskCreated((task) => {
      api.logger.info(`New task created: ${task.title}`);
    }),
    api.tasks.onStageChanged((task, from, to) => {
      api.logger.info(`Task ${task.id} moved from ${from} → ${to}`);
    }),
  );
}
```

---

### SkillApi

Register custom skills, task types, and verifiers.

**Required permissions:** `skills:override` (overrides), `workflow:extend` (task types, verifiers, new skills)

```typescript
interface SkillApi {
  register(stageName: string, content: string): Promise<void>;
  registerTaskType(definition: TaskTypeDefinition): void;
  registerVerifier(verifier: VerifierDefinition): void;
  registerSkillOverride(stageName: string, content: string): void;
  getAvailable(): Promise<string[]>;
}
```

#### Methods

**`register(stageName: string, content: string): Promise<void>`**
Registers a new skill (agent prompt) for a custom pipeline stage.
- Permission: `workflow:extend`
- `stageName`: Unique identifier for the stage
- `content`: The skill prompt content (Markdown)

**`registerTaskType(definition: TaskTypeDefinition): void`**
Registers a custom task type with its own workflow pipeline.
- Permission: `workflow:extend`

```typescript
interface TaskTypeDefinition {
  id: string;
  label: string;
  icon?: string;
  workflow: StageDescriptor[];
  skillPrompt?: string;
}
```

**`registerVerifier(verifier: VerifierDefinition): void`**
Registers a custom verification step run during the `verifying` stage.
- Permission: `workflow:extend`

```typescript
interface VerifierDefinition {
  id: string;
  name: string;
  pluginName: string;
  description?: string;
  verify(taskId: string): Promise<VerifierResult>;
}

interface VerifierResult {
  passed: boolean;
  message?: string;
  details?: string;
}
```

**`registerSkillOverride(stageName: string, content: string): void`**
Overrides the prompt content for an existing built-in skill stage.
- Permission: `skills:override` and `workflow:extend`
- Use carefully — overriding built-in skills (e.g., `execute`, `plan`) affects all tasks

**`getAvailable(): Promise<string[]>`**
Returns the names of all currently registered skills.
- No permission required

#### Example

```typescript
async onLoad(api: FormicAPI): Promise<void> {
  await api.skills.register('security-scan', `
    # Security Scan Skill
    Run OWASP dependency check on the modified files.
    Report any HIGH or CRITICAL vulnerabilities.
  `);

  api.skills.registerVerifier({
    id: 'no-console-log',
    name: 'No console.log',
    pluginName: this.id,
    description: 'Fails if any console.log calls were introduced',
    async verify(taskId) {
      // ... run check
      return { passed: true };
    },
  });
}
```

---

### SettingsApi

Read and write plugin-scoped configuration values.

**Required permissions:** `config:read` (reads), `config:write` (writes)

```typescript
interface SettingsApi {
  get<T = unknown>(key: string, defaultValue?: T): Promise<T | undefined>;
  set<T = unknown>(key: string, value: T): Promise<void>;
}
```

#### Methods

**`get<T>(key: string, defaultValue?: T): Promise<T | undefined>`**
Reads a plugin setting by key. Returns `defaultValue` if the key is not set.
- Permission: `config:read`
- Values are scoped to the plugin — keys don't conflict with other plugins

**`set<T>(key: string, value: T): Promise<void>`**
Writes a plugin setting by key. Values are persisted across restarts.
- Permission: `config:write`

#### Example

```typescript
async onLoad(api: FormicAPI): Promise<void> {
  const count = await api.settings.get<number>('completedCount', 0);
  api.logger.info(`Completed count: ${count}`);

  await api.settings.set('lastStarted', new Date().toISOString());
}
```

---

### UIApi

Register UI components or render functions into named slots in the Formic client.

**Required permissions:** `ui:panel`

```typescript
interface UIApi {
  registerSlot(
    slotId: UISlot,
    component: ComponentType<Record<string, unknown>> | RenderFunction<Record<string, unknown>>
  ): Unsubscribe;

  unregisterSlot(
    slotId: UISlot,
    component: ComponentType<Record<string, unknown>> | RenderFunction<Record<string, unknown>>
  ): void;

  registerSidebarPanel(panel: SidebarPanelDefinition): Unsubscribe;
  registerToolbarAction(action: ToolbarActionDefinition): Unsubscribe;
}
```

#### Methods

**`registerSlot(slotId, component): Unsubscribe`**
Mounts a render function or component class into a named UI slot.
- Permission: `ui:panel`
- See [UI Slots Reference](#ui-slots-reference) for available slot IDs and their prop types
- Returns an `Unsubscribe` handle — calling it removes the slot registration

**`unregisterSlot(slotId, component): void`**
Removes a previously registered component from a slot.
- Permission: `ui:panel`

**`registerSidebarPanel(panel: SidebarPanelDefinition): Unsubscribe`**
Adds a panel to the sidebar.
- Permission: `ui:panel`

```typescript
interface SidebarPanelDefinition {
  id: string;
  title: string;
  icon?: string;
  mountPoint: UISlot | string;
}
```

**`registerToolbarAction(action: ToolbarActionDefinition): Unsubscribe`**
Adds a button to the toolbar.
- Permission: `ui:panel`

```typescript
interface ToolbarActionDefinition {
  id: string;
  label: string;
  icon?: string;
  onClick: () => void;
}
```

#### Example

```typescript
async onLoad(api: FormicAPI): Promise<void> {
  const unsub = api.ui.registerSlot(
    'kanban-card-badge',
    (container, props) => {
      const badge = document.createElement('span');
      badge.textContent = '★';
      container.appendChild(badge);
    }
  );
  this.unsubs.push(unsub);
}
```

---

### IntegrationApi

Register webhook endpoints and bot commands, and send notifications.

**Required permissions:** `integrations:webhook` (webhooks and bot commands), `integrations:notify` (notifications)

```typescript
type WebhookResponse = { status: number; body?: unknown };
type WebhookHandler = (body: unknown, headers: Record<string, string>) => Promise<WebhookResponse>;

interface BotCommandDefinition {
  name: string;
  description: string;
  handler: (args: string, chatId: string) => Promise<string>;
}

interface IntegrationApi {
  registerWebhook(path: string, handler: WebhookHandler): void;
  registerBotCommand(command: BotCommandDefinition): void;
  sendNotification(message: string): Promise<void>;
}
```

#### Methods

**`registerWebhook(path: string, handler: WebhookHandler): void`**
Registers a POST endpoint at `/api/webhooks/plugins/<path>`.
- Permission: `integrations:webhook`
- The `body` parameter is the parsed request body
- Return a `WebhookResponse` with a `status` code and optional `body`

**`registerBotCommand(command: BotCommandDefinition): void`**
Registers a bot command for messaging integrations (e.g., Telegram).
- Permission: `integrations:webhook`
- `handler` receives the command arguments string and the chat ID; returns the reply text

**`sendNotification(message: string): Promise<void>`**
Sends a notification via the configured messaging integration.
- Permission: `integrations:notify`

#### Example

```typescript
async onLoad(api: FormicAPI): Promise<void> {
  api.integrations.registerWebhook('github-push', async (body, headers) => {
    const event = headers['x-github-event'];
    api.logger.info(`GitHub event: ${event}`);
    return { status: 200, body: { ok: true } };
  });

  api.integrations.registerBotCommand({
    name: 'status',
    description: 'Show task counts',
    handler: async (_args, _chatId) => {
      const tasks = await api.tasks.getAllTasks();
      return `Total tasks: ${tasks.length}`;
    },
  });
}
```

---

### MemoryApi

Read from and write to Formic's long-term memory store. Subscribe to reflection events.

**Required permissions:** `memory:read` (reads and reflection), `memory:write` (writes)

```typescript
type MemoryType = 'pattern' | 'pitfall' | 'preference';

interface MemoryEntry {
  id: string;
  type: MemoryType;
  content: string;
  tags?: string[];
  created_at: string;
  // ... additional fields
}

interface MemoryApi {
  getLessons(filter?: { tags?: string[] }): Promise<MemoryEntry[]>;
  addLesson(lesson: Omit<MemoryEntry, 'id' | 'created_at'>): Promise<MemoryEntry>;
  onReflection(handler: (task: Task, lessons: MemoryEntry[]) => void): Unsubscribe;
}
```

#### Methods

**`getLessons(filter?): Promise<MemoryEntry[]>`**
Returns memory entries, optionally filtered by tags.
- Permission: `memory:read`

**`addLesson(lesson): Promise<MemoryEntry>`**
Adds a new memory entry. Returns the created entry with generated `id` and `created_at`.
- Permission: `memory:write`

**`onReflection(handler): Unsubscribe`**
Fires after each task completes, providing the task and any relevant lessons retrieved during reflection.
- Permission: `memory:read`

---

### EventApi

Subscribe to and unsubscribe from raw internal events by name.

**Required permissions:** `events:subscribe`

```typescript
interface EventApi {
  on(event: string, handler: (...args: unknown[]) => void): Unsubscribe;
  off(event: string, handler: (...args: unknown[]) => void): void;
}
```

#### Methods

**`on(event: string, handler): Unsubscribe`**
Subscribes to a named internal event. Returns an `Unsubscribe` handle.
- Permission: `events:subscribe`
- Prefer the typed `TaskApi` lifecycle hooks (`onTaskCreated`, etc.) over raw events where possible

**`off(event: string, handler): void`**
Unsubscribes a previously registered handler.
- Permission: `events:subscribe`

#### Well-Known Event Names

| Event | Description |
|-------|-------------|
| `board:updated` | Fires whenever the board state changes |
| `task:created` | Fires when a task is created |
| `task:updated` | Fires when a task is updated |
| `task:completed` | Fires when a task reaches `done` |
| `task:failed` | Fires when a task is blocked |
| `task:stage-changed` | Fires on every stage transition |

---

### PluginLogger

A plugin-scoped logger that prefixes all messages with `[Plugin:<name>]`.

```typescript
interface PluginLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}
```

No permissions required — always available.

**`info(message, ...args)`** — Logs at info level. Output: `[Plugin:my-plugin] <message>`  
**`warn(message, ...args)`** — Logs at warn level.  
**`error(message, ...args)`** — Logs at error level.

#### Example

```typescript
api.logger.info('Plugin loaded successfully');
api.logger.warn('Config key "apiKey" is not set — using default');
api.logger.error('Failed to fetch data', err);
```

---

## Permissions Reference

Declare required permissions in your `manifest.json` under `"permissions"`. Attempting to call an API method without the necessary permission throws a `PluginPermissionError`.

### Full Permission List

| Permission | Description | Required by |
|------------|-------------|-------------|
| `tasks:read` | Read task data | `TaskApi.getTask`, `getAllTasks`, `onTaskCreated`\*, `onTaskUpdated`\*, `onTaskCompleted`\*, `onTaskFailed`\*, `onStageChanged`\* |
| `tasks:write` | Create and update tasks | `TaskApi.createTask`, `updateTask` |
| `events:subscribe` | Subscribe to internal events | `TaskApi.onTaskCreated`, `onTaskUpdated`, `onTaskCompleted`, `onTaskFailed`, `onStageChanged`; `EventApi.on`, `off` |
| `config:read` | Read plugin settings | `SettingsApi.get` |
| `config:write` | Write plugin settings | `SettingsApi.set` |
| `workflow:extend` | Register new pipeline stages and task types | `SkillApi.register`, `registerTaskType`, `registerVerifier` |
| `skills:override` | Override built-in skill prompts | `SkillApi.registerSkillOverride` (also requires `workflow:extend`) |
| `ui:panel` | Register UI components and panels | `UIApi.registerSlot`, `unregisterSlot`, `registerSidebarPanel`, `registerToolbarAction` |
| `integrations:webhook` | Register webhook endpoints and bot commands | `IntegrationApi.registerWebhook`, `registerBotCommand` |
| `integrations:notify` | Send notifications via messaging integration | `IntegrationApi.sendNotification` |
| `memory:read` | Read from long-term memory store | `MemoryApi.getLessons`, `onReflection` |
| `memory:write` | Write to long-term memory store | `MemoryApi.addLesson` |
| `http:outbound` | Make outbound HTTP requests | Available for plugin use, not currently gated on a specific API method |
| `fs:workspace` | Read from the workspace filesystem | Available for plugin use, not currently gated on a specific API method |
| `process:info` | Read process and environment information | Available for plugin use |

> **\*Note:** Lifecycle hooks (`onTaskCreated` etc.) require both `tasks:read` (to access task data) and `events:subscribe` (to subscribe to the event stream).

### Minimal Permission Example

```json
{
  "permissions": ["tasks:read", "events:subscribe"]
}
```

### Recommended Approach

Request the minimum permissions your plugin needs. Users and administrators can inspect permission declarations before installing a plugin.

---

## UI Slots Reference

Formic exposes eight named extension slots in the client UI where plugins can inject render functions.

### Available Slots

| Slot ID | Location | Props Type |
|---------|----------|-----------|
| `kanban-card-badge` | Badge overlay on each Kanban card | `KanbanCardBadgeProps` |
| `kanban-card-footer` | Footer area below each Kanban card | `KanbanCardFooterProps` |
| `task-node-editor` | Editor panel in the task node view | `TaskNodeEditorProps` |
| `task-stage-panel` | Stage-specific panel in the task detail view | `TaskStagePanelProps` |
| `dag-visualization` | DAG graph visualization area | `DagVisualizationProps` |
| `task-detail-sidebar` | Sidebar in the task detail view | `TaskDetailSidebarProps` |
| `toolbar-right` | Right side of the main toolbar | `ToolbarRightProps` |
| `settings-panel` | Plugin settings panel | `SettingsPanelProps` |

### Prop Type Interfaces

```typescript
/** kanban-card-badge — shown as an overlay badge on each card */
interface KanbanCardBadgeProps {
  task: Task;
}

/** kanban-card-footer — shown at the bottom of each card */
interface KanbanCardFooterProps {
  task: Task;
}

/** task-node-editor — editor panel in the task node */
interface TaskNodeEditorProps {
  task: Task;
  onUpdate: (patch: Partial<Task>) => void;
}

/** task-stage-panel — panel for a specific workflow stage */
interface TaskStagePanelProps {
  task: Task;
  stage: string;
  onUpdate: (patch: Partial<Task>) => void;
}

/** dag-visualization — DAG graph view */
interface DagVisualizationProps {
  tasks: Task[];
  edges: Array<{ from: string; to: string }>;
}

/** task-detail-sidebar — sidebar in task detail */
interface TaskDetailSidebarProps {
  task: Task;
}

/** toolbar-right — right side toolbar area */
type ToolbarRightProps = Record<string, never>;

/** settings-panel — plugin settings section */
type SettingsPanelProps = Record<string, never>;
```

### Render Function Signature

```typescript
type RenderFunction<P extends Record<string, unknown>> =
  (container: HTMLElement, props: P) => void | (() => void);
```

The render function receives:
- `container`: The DOM element to mount into
- `props`: Typed props for the slot

It may optionally return a **cleanup function** (called when the slot is unregistered or the component unmounts).

### Example: Registering a Badge

```typescript
import type { FormicPlugin, FormicAPI, KanbanCardBadgeProps } from '@rickywo/formic-sdk';

export default class PriorityBadgePlugin implements FormicPlugin {
  id = 'priority-badge';
  name = 'Priority Badge';
  version = '1.0.0';

  private unsub?: () => void;

  async onLoad(api: FormicAPI): Promise<void> {
    this.unsub = api.ui.registerSlot(
      'kanban-card-badge',
      (container: HTMLElement, props: KanbanCardBadgeProps) => {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = props.task.priority === 'high' ? '🔥' : '';
        container.appendChild(badge);

        // Return cleanup function
        return () => {
          container.removeChild(badge);
        };
      }
    );
  }

  async onUnload(): Promise<void> {
    this.unsub?.();
  }
}
```

---

## Development Workflow

### 1. Scaffold Your Plugin

```bash
npx formic-sdk create-plugin
cd my-plugin
npm install
```

### 2. Develop with Live Reload

Use the `--plugins` flag to load your plugin from a local directory:

```bash
formic start --plugins ./my-plugin
```

Formic watches the plugin directory and **hot-reloads** class-based plugins automatically:
- File changes are debounced with a **500ms delay**
- Only plugins loaded via `--plugins` support hot-reload
- The plugin's `onUnload()` is called before re-loading the new version

> **Debugging:** All plugin log output is prefixed with `[Plugin:<name>]`. Filter your terminal for this prefix to isolate plugin logs.

### 3. Build

```bash
npm run build
# Outputs compiled JS to dist/
```

### 4. Install into Formic

```bash
cp -r . /path/to/your/project/.formic/plugins/my-plugin/
# Or use a symlink for development:
ln -s $(pwd) /path/to/your/project/.formic/plugins/my-plugin
```

Restart Formic (or wait for auto-discovery) to activate the installed plugin.

### 5. Publish to the Marketplace

When your plugin is ready to share, publish it to npm under the `formic-plugin-*` naming convention and submit it to the Formic community registry.

---

## Best Practices

### Store and Call `Unsubscribe` Handles

All lifecycle hook registrations (`onTaskCreated`, `registerSlot`, `registerSidebarPanel`, etc.) return an `Unsubscribe` function. Store all handles and call them in `onUnload()` to prevent memory leaks:

```typescript
export default class MyPlugin implements FormicPlugin {
  id = 'my-plugin';
  name = 'My Plugin';
  version = '1.0.0';

  private unsubs: Array<() => void> = [];

  async onLoad(api: FormicAPI): Promise<void> {
    this.unsubs.push(
      api.tasks.onTaskCreated((task) => { /* ... */ }),
      api.tasks.onTaskCompleted((task) => { /* ... */ }),
      api.ui.registerSlot('kanban-card-badge', myRenderer),
    );
  }

  async onUnload(): Promise<void> {
    for (const unsub of this.unsubs) {
      unsub();
    }
    this.unsubs = [];
  }
}
```

### Handle Errors in Event Handlers

Uncaught exceptions in event handlers can crash the plugin or produce silent failures. Wrap handler bodies in try/catch:

```typescript
api.tasks.onTaskCreated(async (task) => {
  try {
    await doSomethingAsync(task);
  } catch (err) {
    api.logger.error('Failed to handle task:created', err);
  }
});
```

### Minimize Permissions

Request only the permissions your plugin actually uses. This builds trust with users and reduces the blast radius of bugs.

```json
// Bad — overly broad
{ "permissions": ["tasks:read", "tasks:write", "config:read", "config:write", "ui:panel", "memory:read", "memory:write"] }

// Good — minimal
{ "permissions": ["tasks:read", "events:subscribe"] }
```

### `structuredClone` Awareness

Data returned by `TaskApi` methods (`getTask`, `getAllTasks`, etc.) is a **deep clone** of the internal state. Mutating the returned object does not affect Formic's internal board — you must call `updateTask()` to persist changes.

### Async Initialization

`onLoad` is an async function. Perform all async setup there — do not perform async work in the constructor.

```typescript
// Good
async onLoad(api: FormicAPI): Promise<void> {
  const count = await api.settings.get('count', 0);
  this.count = count;
}

// Bad — constructor cannot be async
constructor() {
  this.count = await api.settings.get('count', 0); // SyntaxError
}
```

### Testing Your Plugin

Write unit tests by mocking the `FormicAPI` object:

```typescript
import { describe, it, expect, vi } from 'vitest';
import MyPlugin from './src/index.js';

describe('MyPlugin', () => {
  it('subscribes to task events on load', async () => {
    const mockApi = {
      tasks: {
        onTaskCreated: vi.fn(() => () => {}),
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };

    const plugin = new MyPlugin();
    await plugin.onLoad(mockApi as any);

    expect(mockApi.tasks.onTaskCreated).toHaveBeenCalled();
  });
});
```

---

## Example Plugin Walkthrough

### Goal

Build a **Task Counter** plugin that:
1. Counts how many tasks have been completed since the plugin was loaded
2. Persists the total across restarts using `SettingsApi`
3. Displays a badge on each completed task's Kanban card showing the running total

### Step 1: Scaffold

```bash
npx formic-sdk create-plugin
# name: task-counter
# display: Task Counter
# description: Shows a running count of completed tasks
```

### Step 2: Declare Permissions

Edit `manifest.json`:

```json
{
  "name": "task-counter",
  "version": "1.0.0",
  "description": "Shows a running count of completed tasks",
  "author": "you",
  "permissions": [
    "tasks:read",
    "events:subscribe",
    "config:read",
    "config:write",
    "ui:panel"
  ],
  "serverEntry": "dist/index.js"
}
```

### Step 3: Implement the Plugin

Replace the contents of `src/index.ts`:

```typescript
import type {
  FormicPlugin,
  FormicAPI,
  KanbanCardBadgeProps,
} from '@rickywo/formic-sdk';

const SETTINGS_KEY = 'completedCount';

export default class TaskCounterPlugin implements FormicPlugin {
  id = 'task-counter';
  name = 'Task Counter';
  version = '1.0.0';
  description = 'Shows a running count of completed tasks as a badge';

  private completedCount = 0;
  private unsubs: Array<() => void> = [];

  async onLoad(api: FormicAPI): Promise<void> {
    // Restore persisted count from settings
    const saved = await api.settings.get<number>(SETTINGS_KEY, 0);
    this.completedCount = saved ?? 0;
    api.logger.info(`Task Counter loaded — starting count: ${this.completedCount}`);

    // Increment and persist the count when any task completes
    const onCompleted = api.tasks.onTaskCompleted(async (task) => {
      try {
        this.completedCount += 1;
        await api.settings.set(SETTINGS_KEY, this.completedCount);
        api.logger.info(
          `Task "${task.title}" completed — total: ${this.completedCount}`
        );
      } catch (err) {
        api.logger.error('Failed to persist completed count', err);
      }
    });

    // Register a badge renderer on each Kanban card
    const unregisterSlot = api.ui.registerSlot(
      'kanban-card-badge',
      (container: HTMLElement, props: KanbanCardBadgeProps) => {
        // Only show badge on done tasks
        if (props.task.status !== 'done') return;

        const badge = document.createElement('span');
        badge.title = `Completed task #${this.completedCount}`;
        badge.style.cssText = `
          display: inline-flex;
          align-items: center;
          justify-content: center;
          background: #22c55e;
          color: white;
          font-size: 10px;
          font-weight: 600;
          border-radius: 9999px;
          padding: 2px 6px;
          margin-left: 4px;
        `;
        badge.textContent = `✓ ${this.completedCount}`;
        container.appendChild(badge);

        // Return cleanup to remove the badge when unmounted
        return () => {
          if (container.contains(badge)) {
            container.removeChild(badge);
          }
        };
      }
    );

    // Store all unsubscribe handles for cleanup
    this.unsubs.push(onCompleted, unregisterSlot);
  }

  async onUnload(): Promise<void> {
    // Call all unsubscribe handles to clean up listeners and slots
    for (const unsub of this.unsubs) {
      unsub();
    }
    this.unsubs = [];
    // completedCount is already persisted via SettingsApi — no extra cleanup needed
  }
}
```

### Step 4: Build and Install

```bash
npm run build

# Install into Formic
cp -r . /path/to/your-project/.formic/plugins/task-counter/
```

Or for local dev:

```bash
formic start --plugins ./task-counter
```

### Step 5: Verify

1. Open the Formic board at `http://localhost:8000`
2. Complete a few tasks by approving them in the Review column
3. Each approved (done) task card should show a green `✓ N` badge
4. Restart Formic — the counter should resume from the persisted value

### What This Example Demonstrates

| Feature | Where Used |
|---------|-----------|
| `onLoad` / `onUnload` lifecycle | Plugin class methods |
| `SettingsApi.get` / `set` | Persisting the counter across restarts |
| `TaskApi.onTaskCompleted` | Incrementing on task completion |
| `UIApi.registerSlot` with `kanban-card-badge` | Rendering the badge |
| Slot render function with cleanup | Returning a cleanup function from the renderer |
| `Unsubscribe` handle management | Storing in `this.unsubs`, calling in `onUnload` |
| Error handling in event handlers | try/catch in `onTaskCompleted` |
| `PluginLogger` | Logging with `[Plugin:task-counter]` prefix |

---

## Backward Compatibility

The class-based `FormicPlugin` SDK is the recommended approach for all new plugins. If you are maintaining a legacy server-side Fastify plugin built with the manifest-based format, see [`docs/plugins.md`](./plugins.md).

Legacy `PluginContext`-style plugins continue to work — they are adapted internally via `pluginContextToFormicAPI()`. However, the `PluginContext` interface is considered legacy and will not receive new features.
