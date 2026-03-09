// Demo mode fetch interceptor.
// Monkey-patches window.fetch to serve all /api/... routes from local in-memory state.
// Must be loaded AFTER mockData.js and BEFORE the application script.

(function () {
  if (typeof window.FORMIC_MOCK_DATA === 'undefined') {
    console.error('[Demo] mockData.js must be loaded before mockApi.js');
    return;
  }

  // ── Local mutable state ──────────────────────────────────────────────────
  const state = {
    board: JSON.parse(JSON.stringify(window.FORMIC_MOCK_DATA.board)),
  };

  // Auto-increment for new task IDs in demo
  let nextTaskSeq = 1000;

  // Active log-stream intervals keyed by task ID
  const logIntervals = {};

  // ── Helpers ─────────────────────────────────────────────────────────────

  function makeResponse(body, status) {
    const json = JSON.stringify(body);
    return new Response(json, {
      status: status || 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  function findTask(id) {
    return state.board.tasks.find(function (t) { return t.id === id; });
  }

  function taskIndex(id) {
    return state.board.tasks.findIndex(function (t) { return t.id === id; });
  }

  function notifyBoardChange() {
    // The app calls loadBoard() (which now returns our state) and re-renders.
    // We fire a small synthetic event so the app's polling / manual refresh picks it up.
    // Most paths just call loadBoard() directly, so no extra work is needed here.
  }

  function startLogStream(taskId) {
    if (logIntervals[taskId]) return;
    const streams = window.FORMIC_MOCK_DATA.MOCK_LOG_STREAMS || {};
    const lines = (streams[taskId] || []).slice();
    if (lines.length === 0) return;

    let i = 0;
    logIntervals[taskId] = setInterval(function () {
      const task = findTask(taskId);
      if (!task) {
        clearInterval(logIntervals[taskId]);
        delete logIntervals[taskId];
        return;
      }
      if (i < lines.length) {
        task.agentLogs = (task.agentLogs || []).concat([lines[i]]);
        i++;
      } else {
        // Stream finished — transition to review
        clearInterval(logIntervals[taskId]);
        delete logIntervals[taskId];
        task.status = 'review';
        task.workflowStep = 'complete';
        task.pid = null;
        task.completedAt = new Date().toISOString();
        task.progress = 100;
      }
    }, 150);
  }

  // ── Route handlers ───────────────────────────────────────────────────────

  function handleGetBoard() {
    return makeResponse(state.board);
  }

  function handleGetTask(id) {
    const task = findTask(id);
    if (!task) return makeResponse({ error: 'Not found' }, 404);
    return makeResponse(task);
  }

  function handleCreateTask(body) {
    const now = new Date().toISOString();
    const id = 'demo-new-' + (nextTaskSeq++);
    const task = Object.assign({
      id,
      status: 'todo',
      priority: 'medium',
      type: 'standard',
      agentLogs: [],
      pid: null,
      workflowStep: 'pending',
      workflowLogs: {},
      progress: 0,
      createdAt: now,
      queuedAt: null,
      startedAt: null,
      completedAt: null,
      childTaskIds: [],
      parentGoalId: null,
      dependsOn: [],
      dependsOnResolved: [],
      hasManualSubtasks: false,
      retryCount: 0,
      safePointCommit: null,
      fixForTaskId: null,
      docsPath: '',
      context: '',
      title: '',
    }, body || {}, { id, createdAt: now });
    state.board.tasks.push(task);
    return makeResponse(task, 201);
  }

  function handleUpdateTask(id, body) {
    const idx = taskIndex(id);
    if (idx === -1) return makeResponse({ error: 'Not found' }, 404);
    state.board.tasks[idx] = Object.assign({}, state.board.tasks[idx], body || {});
    return makeResponse(state.board.tasks[idx]);
  }

  function handleDeleteTask(id) {
    const idx = taskIndex(id);
    if (idx === -1) return makeResponse({ error: 'Not found' }, 404);
    state.board.tasks.splice(idx, 1);
    return makeResponse({ success: true });
  }

  function handleRunTask(id) {
    const task = findTask(id);
    if (!task) return makeResponse({ error: 'Not found' }, 404);

    if (task.status === 'blocked') {
      return makeResponse(
        { error: 'Demo mode — this task is blocked' },
        400
      );
    }

    task.status = 'running';
    task.workflowStep = 'execute';
    task.startedAt = task.startedAt || new Date().toISOString();
    task.pid = 99999;
    task.progress = task.progress || 10;

    startLogStream(id);

    return makeResponse({ success: true });
  }

  function handleStopTask(id) {
    const task = findTask(id);
    if (!task) return makeResponse({ error: 'Not found' }, 404);

    if (logIntervals[id]) {
      clearInterval(logIntervals[id]);
      delete logIntervals[id];
    }

    task.status = 'todo';
    task.workflowStep = 'pending';
    task.pid = null;
    task.progress = 0;

    return makeResponse({ success: true });
  }

  function handleQueueTask(id) {
    const task = findTask(id);
    if (!task) return makeResponse({ error: 'Not found' }, 404);
    task.status = 'queued';
    task.queuedAt = new Date().toISOString();
    return makeResponse({ success: true });
  }

  function handleGetChildren(id) {
    const task = findTask(id);
    if (!task) return makeResponse({ children: [] });
    const childIds = task.childTaskIds || [];
    const children = childIds.map(function (cid) { return findTask(cid); }).filter(Boolean);
    return makeResponse({ children });
  }

  function handleGetSubtasks(id) {
    void id;
    return makeResponse({ subtasks: [] });
  }

  function handleSubtaskCompletion(id) {
    void id;
    return makeResponse({ subtasks: [] });
  }

  function handleWorkspaceInfo() {
    return makeResponse({
      projectName: 'stripe-demo',
      repoPath: '/demo',
      currentBranch: 'main',
      hasUncommittedChanges: false,
      agentType: 'demo',
      agentCommand: 'demo',
      version: '1.0.0-demo',
    });
  }

  // ── Fetch patch ──────────────────────────────────────────────────────────

  window.__originalFetch = window.fetch;

  window.fetch = async function (url, opts) {
    if (!window.FORMIC_IS_DEMO) {
      return window.__originalFetch(url, opts);
    }

    const urlStr = typeof url === 'string' ? url : (url instanceof Request ? url.url : String(url));
    const method = (opts && opts.method) ? opts.method.toUpperCase() : 'GET';

    // Only intercept /api/... routes
    if (!urlStr.startsWith('/api/')) {
      return window.__originalFetch(url, opts);
    }

    // Parse request body if present
    let body = null;
    if (opts && opts.body) {
      try { body = JSON.parse(opts.body); } catch (_) { body = opts.body; }
    }

    // ── Route matching ───────────────────────────────────────────────────
    // GET /api/board
    if (method === 'GET' && urlStr === '/api/board') {
      return handleGetBoard();
    }

    // POST /api/tasks (create)
    if (method === 'POST' && urlStr === '/api/tasks') {
      return handleCreateTask(body);
    }

    // Task-specific routes: /api/tasks/:id[/action]
    const taskMatch = urlStr.match(/^\/api\/tasks\/([^/]+)(\/(.+))?$/);
    if (taskMatch) {
      const taskId = taskMatch[1];
      const action = taskMatch[3] || '';

      if (method === 'GET' && !action) return handleGetTask(taskId);
      if ((method === 'PUT' || method === 'PATCH') && !action) return handleUpdateTask(taskId, body);
      if (method === 'DELETE' && !action) return handleDeleteTask(taskId);
      if (method === 'POST' && action === 'run') return handleRunTask(taskId);
      if (method === 'POST' && action === 'stop') return handleStopTask(taskId);
      if (method === 'POST' && action === 'queue') return handleQueueTask(taskId);
      if (method === 'GET' && action === 'children') return handleGetChildren(taskId);
      if (method === 'GET' && action === 'subtasks') return handleGetSubtasks(taskId);
      if (method === 'GET' && action === 'subtasks/completion') return handleSubtaskCompletion(taskId);
      if (method === 'POST' && action === 'subtasks/completion') return handleSubtaskCompletion(taskId);

      // Unknown task sub-route: safe no-op
      return makeResponse({});
    }

    // Workspace routes
    if (urlStr === '/api/workspace/info') return handleWorkspaceInfo();
    if (urlStr === '/api/workspace/switch') return makeResponse({ success: true });
    if (urlStr === '/api/workspace/validate') return makeResponse({ valid: true, path: '/demo' });

    // Config routes — return safe defaults
    if (urlStr.startsWith('/api/config')) return makeResponse({});

    // Assistant routes — silently no-op
    if (urlStr.startsWith('/api/assistant')) return makeResponse({});

    // Lease routes — no-op
    if (urlStr.startsWith('/api/leases')) return makeResponse({});

    // Memory / tools routes — no-op
    if (urlStr.startsWith('/api/memory') || urlStr.startsWith('/api/tools')) {
      return makeResponse({});
    }

    // Catch-all: safe no-op for any other /api/ route
    return makeResponse({});
  };
})();
