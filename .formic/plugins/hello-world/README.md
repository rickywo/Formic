# Hello World Plugin

A sample plugin demonstrating the Formic plugin system. Use this as a reference when building your own plugins.

## Features

- **Server Route**: `GET /api/plugins/hello-world/hello` — returns a configurable greeting with timestamp
- **Client Panel**: Right-sidebar panel showing the greeting and live task count
- **Settings**: Configurable `greeting` text and `showTaskCount` toggle
- **Event Subscription**: Listens to `board-updated` events to refresh the task count in real time

## Directory Structure

```
.formic/plugins/hello-world/
├── manifest.json   # Plugin metadata, permissions, and settings schema
├── server.js       # Server-side Fastify plugin (ESM export default)
├── client.js       # Client-side UI script (IIFE pattern)
└── README.md       # This file
```

## Configuration

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `greeting` | string | `"Hello from Formic!"` | Custom greeting text displayed in the panel and API response |
| `showTaskCount` | boolean | `true` | Whether to show the current task count in the panel |

### Changing Settings

Use the Formic UI (Settings → Plugins tab) or the REST API:

```bash
# Read settings
curl http://localhost:8000/api/plugins/hello-world/settings

# Update greeting
curl -X PUT http://localhost:8000/api/plugins/hello-world/settings \
  -H "Content-Type: application/json" \
  -d '{"greeting": "Welcome to Formic!"}'
```

## API

### Server Route

```
GET /api/plugins/hello-world/hello
```

**Response:**
```json
{
  "greeting": "Hello from Formic!",
  "timestamp": 1712345678901
}
```

## How It Works

### Server Side (`server.js`)

The server entry exports a default async function that receives a scoped Fastify instance. Routes registered on this instance are automatically prefixed with `/api/plugins/hello-world/`.

```js
export default async function helloWorldPlugin(fastify) {
  fastify.get('/hello', async () => {
    return { greeting: '...', timestamp: Date.now() };
  });
}
```

### Client Side (`client.js`)

The client entry uses an IIFE (Immediately Invoked Function Expression) pattern since Formic loads plugin scripts as classic `<script>` tags. It uses `window.FormicPluginAPI` to register UI panels and subscribe to events.

```js
(function() {
  const API = window.FormicPluginAPI;
  API.addPanel('right-sidebar', {
    id: 'my-panel',
    title: 'My Panel',
    render: function(body) { /* ... */ }
  });
})();
```

## Permissions

This plugin requests the following permissions:

- `tasks:read` — Read board and task data
- `events:subscribe` — Subscribe to internal events
- `ui:panel` — Mount UI panels in the sidebar
- `config:read` — Read plugin configuration/settings
