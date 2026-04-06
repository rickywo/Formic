# Formic Plugin Development Guide

Build plugins to extend Formic with custom server routes, client-side UI panels, event handlers, and configurable settings.

## Quick Start

1. Create a directory under `.formic/plugins/<your-plugin-name>/`
2. Add a `manifest.json` describing your plugin
3. Optionally add `server.js` (server-side Fastify plugin) and/or `client.js` (client-side UI)
4. Restart Formic — your plugin is auto-discovered

## Directory Structure

```
.formic/plugins/
└── my-plugin/
    ├── manifest.json     # Required — plugin metadata and configuration
    ├── server.js         # Optional — server-side Fastify plugin (ESM)
    ├── client.js         # Optional — client-side UI script (IIFE)
    └── README.md         # Recommended — documentation for your plugin
```

## Manifest Schema

Every plugin must have a `manifest.json` in its root directory.

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "What this plugin does",
  "author": "Your Name",
  "minFormicVersion": "0.7.0",
  "permissions": ["tasks:read", "ui:panel"],
  "serverEntry": "server.js",
  "clientEntry": "client.js",
  "settings": {
    "apiKey": { "type": "secret", "default": "", "description": "External API key" },
    "limit": { "type": "number", "default": 10, "description": "Max items to show" },
    "enabled": { "type": "boolean", "default": true, "description": "Feature toggle" }
  }
}
```

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Unique plugin identifier (kebab-case) |
| `version` | string | Semver version (e.g., `"1.0.0"`) |

### Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `description` | string | Human-readable summary |
| `author` | string | Author name or identifier |
| `minFormicVersion` | string | Minimum Formic version required (semver) |
| `permissions` | string[] | Declared permissions (see below) |
| `serverEntry` | string | Relative path to server-side entry file |
| `clientEntry` | string | Relative path to client-side entry file |
| `settings` | object | Settings schema with defaults |

### Settings Schema

Each setting is defined as an object with:

| Property | Type | Description |
|----------|------|-------------|
| `type` | string | One of: `"string"`, `"boolean"`, `"number"`, `"secret"` |
| `default` | any | Default value for this setting |
| `description` | string | Shown in the settings UI |

Settings of type `"secret"` are masked (`***`) in API responses.

## Permissions

Plugins must declare the permissions they need. Undeclared permissions are denied at runtime.

| Permission | Description |
|------------|-------------|
| `tasks:read` | Read board state, list tasks, get task details |
| `tasks:write` | Create and update tasks |
| `config:read` | Read plugin settings |
| `config:write` | Write/update plugin settings |
| `events:subscribe` | Subscribe to internal Formic events |
| `ui:panel` | Register UI panels in the sidebar |
| `http:outbound` | Make outbound HTTP requests |
| `fs:workspace` | Access the workspace filesystem |
| `process:info` | Read process info (uptime, memory) |

## Server-Side Plugin (`server.js`)

The server entry must export a default async function that receives a scoped Fastify instance. Routes registered on this instance are automatically prefixed with `/api/plugins/<name>/`.

### Basic Example

```js
export default async function myPlugin(fastify) {
  // This route becomes GET /api/plugins/my-plugin/data
  fastify.get('/data', async (request, reply) => {
    return { message: 'Hello from my plugin', timestamp: Date.now() };
  });

  console.warn('[Plugin:my-plugin] Plugin loaded');
}
```

### Reading Settings

Use `fastify.inject()` to read settings from the Formic API:

```js
export default async function myPlugin(fastify) {
  fastify.get('/greeting', async () => {
    let greeting = 'Default greeting';
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: '/api/plugins/my-plugin/settings',
      });
      const data = JSON.parse(res.body);
      const raw = data?.settings?.greeting;
      // Settings may be schema objects or plain values
      greeting = (typeof raw === 'string') ? raw : (raw?.default ?? greeting);
    } catch {
      // Fall back to default
    }
    return { greeting };
  });
}
```

### Important Notes

- **ESM only**: Use `export default` (no CommonJS `module.exports`)
- **Error isolation**: If your plugin throws during registration, Formic catches the error, marks the plugin as `status: 'error'`, and continues loading other plugins
- **Prefix scoping**: All routes are automatically prefixed — register `/hello`, it becomes `/api/plugins/<name>/hello`

## Client-Side Plugin (`client.js`)

The client entry is loaded as a classic `<script>` tag. Use the IIFE (Immediately Invoked Function Expression) pattern to avoid polluting the global scope. Access the plugin API via `window.FormicPluginAPI`.

### Basic Example

```js
(function myPluginClient() {
  'use strict';

  const API = window.FormicPluginAPI;
  if (!API) {
    console.error('[Plugin:my-plugin] FormicPluginAPI not available');
    return;
  }

  API.addPanel('right-sidebar', {
    id: 'my-panel',
    title: '🔌 My Plugin',
    render: function (body) {
      body.innerHTML = '<div style="color: var(--text-primary);">Hello!</div>';
    },
  });
})();
```

## FormicPluginAPI Reference (Client-Side)

### `addPanel(position, options)`

Register a UI panel at a mount position.

**Parameters:**
- `position` — `'left-sidebar'` | `'right-sidebar'` | `'bottom-bar'` | `'settings-tab'`
- `options`:
  - `id` (string, required) — Unique panel identifier
  - `title` (string) — Panel header text
  - `icon` (string) — Emoji or icon for the panel header
  - `render` (function, required) — Called with a DOM element to populate

```js
API.addPanel('right-sidebar', {
  id: 'my-panel',
  title: '📊 Stats',
  render: function (container) {
    container.innerHTML = '<p>Content here</p>';
  },
});
```

### `addBoardWidget(options)`

Add a widget near the board area.

**Parameters:**
- `options`:
  - `id` (string, required) — Unique widget identifier
  - `title` (string) — Widget title
  - `render` (function, required) — Called with a DOM element
  - `position` (string) — `'above'` (default) or `'below'` the board

### `addMenuItem(options)`

Add a menu item to the settings panel.

**Parameters:**
- `options`:
  - `label` (string, required) — Menu item text
  - `icon` (string) — Emoji or icon
  - `onClick` (function, required) — Click handler
  - `section` (string) — Settings section to add to

### `onEvent(eventName, callback)`

Subscribe to a plugin event. Returns an unsubscribe function.

**Valid events:**
- `board-updated` — Board state changed (receives `{ board }`)
- `task-selected` — A task card was selected
- `theme-changed` — UI theme was toggled
- `settings-opened` / `settings-closed` — Settings panel toggled
- `plugins-loaded` — All plugin scripts finished loading

```js
const unsub = API.onEvent('board-updated', function (data) {
  console.log('Board updated, task count:', data.board.tasks.length);
});
// Later: unsub() to unsubscribe
```

### `getState()`

Get a shallow clone of the current board state.

```js
const state = API.getState();
console.log('Tasks:', state.tasks.length);
```

### `getTheme()`

Get the current UI theme (`'dark'` or `'light'`).

## Plugin Lifecycle

1. **Discovery**: On startup, Formic scans `.formic/plugins/` for directories with `manifest.json`
2. **Validation**: Each manifest is validated (required fields, permissions, version compatibility)
3. **Config Init**: First-time plugins get a default config entry with `enabled: true` and manifest settings
4. **Server Loading**: `server.js` is dynamically imported and registered as a Fastify plugin
5. **Client Loading**: After the UI loads, enabled plugins with `clientEntry` have their scripts injected
6. **Runtime**: Plugins respond to routes, events, and UI interactions
7. **Disable/Enable**: Plugins can be toggled via the API or settings UI

### Status Values

| Status | Meaning |
|--------|---------|
| `discovered` | Manifest parsed, not yet loaded |
| `loaded` | Server module imported and registered |
| `enabled` | Active and running |
| `disabled` | Turned off by user |
| `error` | Failed to load — check `error` field |

## REST API

### List Plugins

```
GET /api/plugins
```

Returns all discovered plugins with status, version, and capabilities.

### Get Plugin Details

```
GET /api/plugins/:name
```

Returns full plugin info including the manifest.

### Enable/Disable

```
POST /api/plugins/:name/enable
POST /api/plugins/:name/disable
```

### Settings

```
GET /api/plugins/:name/settings
PUT /api/plugins/:name/settings
```

PUT accepts a JSON object with setting keys and values:

```bash
curl -X PUT http://localhost:8000/api/plugins/my-plugin/settings \
  -H "Content-Type: application/json" \
  -d '{"limit": 20, "enabled": false}'
```

### Client Script

```
GET /api/plugins/:name/client.js
```

Serves the client-side script for browser loading.

### Uninstall

```
DELETE /api/plugins/:name
```

Removes the plugin directory and config.

## Hello World Walkthrough

The `hello-world` plugin in `.formic/plugins/hello-world/` demonstrates all plugin features. Here's how it works:

### 1. Manifest

```json
{
  "name": "hello-world",
  "version": "1.0.0",
  "permissions": ["tasks:read", "events:subscribe", "ui:panel", "config:read"],
  "serverEntry": "server.js",
  "clientEntry": "client.js",
  "settings": {
    "greeting": { "type": "string", "default": "Hello from Formic!" },
    "showTaskCount": { "type": "boolean", "default": true }
  }
}
```

### 2. Server Route

`server.js` registers `GET /hello` (served at `/api/plugins/hello-world/hello`) that reads the `greeting` setting and returns it with a timestamp:

```bash
$ curl http://localhost:8000/api/plugins/hello-world/hello
{"greeting":"Hello from Formic!","timestamp":1712345678901}
```

### 3. Client Panel

`client.js` uses an IIFE to register a right-sidebar panel that shows the greeting and a live task count. It subscribes to `board-updated` events to keep the count current.

### 4. Error Isolation

The `broken-test` plugin (`.formic/plugins/broken-test/`) deliberately throws during registration. Formic catches the error, logs it, and marks the plugin as `status: 'error'` — the hello-world plugin and all core functionality remain unaffected.

## Tips

- **Keep it simple**: Start with just a `manifest.json` and one entry point
- **Use IIFE for client code**: Formic loads client scripts as classic tags, not ES modules
- **Handle missing settings gracefully**: Settings may be schema objects initially; check for `default` property
- **Test error isolation**: Formic should never crash due to a plugin error
- **Check permissions**: Only request the permissions your plugin actually needs
- **Style with Tailwind**: Use Tailwind utility classes and Formic's CSS variables (`--text-primary`, `--bg-surface`, etc.) for consistent theming
