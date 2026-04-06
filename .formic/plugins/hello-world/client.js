/**
 * Hello World Plugin — Client Entry
 *
 * Demonstrates client-side plugin capabilities:
 * - Registering a right-sidebar panel via FormicPluginAPI.addPanel()
 * - Reading board state with FormicPluginAPI.getState()
 * - Subscribing to real-time events with FormicPluginAPI.onEvent()
 * - Fetching plugin settings from the REST API
 *
 * Uses the IIFE pattern since index.html loads plugins as classic <script> tags.
 */
(function helloWorldClientPlugin() {
  'use strict';

  const API = window.FormicPluginAPI;
  if (!API) {
    console.error('[Plugin:hello-world] FormicPluginAPI not available');
    return;
  }

  /** Resolve a setting value that may be a schema object or a plain value */
  function resolveSettingValue(raw, fallback) {
    if (raw === undefined || raw === null) return fallback;
    if (typeof raw === 'object' && raw !== null && 'default' in raw) {
      return raw.default !== undefined ? raw.default : fallback;
    }
    return raw;
  }

  /** Fetch plugin settings from the server */
  async function fetchSettings() {
    try {
      const res = await fetch('/api/plugins/hello-world/settings');
      if (!res.ok) return { greeting: 'Hello from Formic!', showTaskCount: true };
      const data = await res.json();
      const settings = data.settings || {};
      return {
        greeting: resolveSettingValue(settings.greeting, 'Hello from Formic!'),
        showTaskCount: resolveSettingValue(settings.showTaskCount, true),
      };
    } catch {
      return { greeting: 'Hello from Formic!', showTaskCount: true };
    }
  }

  /** Count tasks from board state */
  function getTaskCount() {
    try {
      const state = API.getState();
      return state.tasks ? state.tasks.length : 0;
    } catch {
      return 0;
    }
  }

  /** Render the panel content */
  async function renderContent(container) {
    const settings = await fetchSettings();
    const taskCount = getTaskCount();

    container.innerHTML = '';

    // Greeting section
    const greetingEl = document.createElement('div');
    greetingEl.style.cssText = 'padding: 8px 0; font-size: 14px; color: var(--text-primary, #e0e0e0);';
    greetingEl.textContent = settings.greeting;
    greetingEl.dataset.role = 'greeting';
    container.appendChild(greetingEl);

    // Task count section
    if (settings.showTaskCount) {
      const countEl = document.createElement('div');
      countEl.style.cssText = 'padding: 6px 0; font-size: 12px; color: var(--text-secondary, #999);';
      countEl.dataset.role = 'task-count';
      countEl.textContent = taskCount === 1 ? '1 task on board' : taskCount + ' tasks on board';
      container.appendChild(countEl);
    }

    // Plugin info
    const infoEl = document.createElement('div');
    infoEl.style.cssText = 'padding: 8px 0; font-size: 11px; color: var(--text-muted, #666); border-top: 1px solid var(--border-color, #333); margin-top: 8px;';
    infoEl.textContent = 'Sample plugin v1.0.0';
    container.appendChild(infoEl);
  }

  // Register the right-sidebar panel
  API.addPanel('right-sidebar', {
    id: 'hello-world-panel',
    title: '👋 Hello World',
    render: function (body) {
      // Initial render
      renderContent(body);

      // Subscribe to board updates to refresh task count
      API.onEvent('board-updated', function () {
        renderContent(body);
      });
    },
  });
})();
