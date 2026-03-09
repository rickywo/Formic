# Formic Codebase - Quick Reference Card

## 🎯 Five Key Functions You Need

### 1️⃣ `executeVerifyStep(taskId)` — Verification After Execution
- **File:** `src/server/services/workflow.ts:687`
- **Returns:** `{ success: boolean, stderrLines: string[] }`
- **Behavior:** Runs `engineConfig.verifyCommand` in workspace; skips if `skipVerify=true` or command not set
- **Used by:** `executeQuickTask()` and `executeFullWorkflow()` on execute success

### 2️⃣ `executeQuickTask(taskId)` — Quick Execute (No Brief/Plan)
- **File:** `src/server/services/workflow.ts:949`
- **Returns:** `{ pid: number }` (immediately, async execution)
- **Pipeline:** `refreshEngineConfig()` → execute step → verify → critic+retry
- **Used by:** Queue processor, task routes

### 3️⃣ `executeFullWorkflow(taskId)` — Full Pipeline
- **File:** `src/server/services/workflow.ts:1156`
- **Returns:** `{ pid: number }` (immediately, async execution)
- **Pipeline:** `refreshEngineConfig()` → brief → plan → acquire leases → execute → verify → collision detect
- **Used by:** Queue processor, task routes

### 4️⃣ `refreshEngineConfig()` — Load Config From Disk
- **File:** `src/server/services/engineConfig.ts:33`
- **Signature:** `async refreshEngineConfig(): Promise<void>`
- **Effect:** Syncs `engineConfig` singleton from `~/.formic/config.json`
- **Called at:** Start of each `executeFullWorkflow()`, `executeQuickTask()`, queue poll

### 5️⃣ `showToast(message, type)` — UI Notifications
- **File:** `src/client/index.html:7700`
- **Params:** `message: string, type: 'success' | 'error'`
- **Behavior:** Creates toast, auto-removes after 4s + 300ms fade-out
- **Usage:** `showToast('Settings saved', 'success')`

---

## ⚙️ EngineConfig — Runtime Settings

### Interface Shape
```typescript
{
  maxConcurrentTasks: number,    // How many tasks can run simultaneously
  verifyCommand: string,          // Shell command to verify (e.g., "npm run test")
  skipVerify: boolean,            // If true, skip verification entirely
  leaseDurationMs: number,        // How long to hold file locks (default: 5 min)
  watchdogIntervalMs: number,     // Task watchdog check interval (default: 30 sec)
  maxYieldCount: number,          // Max times task can yield before reset (default: 50)
  queuePollIntervalMs: number,    // How often to check queue (default: 5 sec)
  maxExecuteIterations: number,   // Max iterations for execute loop (default: 5)
  stepTimeoutMs: number,          // Max time per step (default: 100 min)
}
```

### Key Fields for Verification
- **`verifyCommand`**: Command string (splits on spaces), e.g., `"npm run test --verbose"`
- **`skipVerify`**: Boolean flag; if true, `executeVerifyStep()` returns `{ success: true, stderrLines: [] }` immediately

### Default Values
```typescript
const defaults = {
  maxConcurrentTasks: 1,
  verifyCommand: '',
  skipVerify: false,
  leaseDurationMs: 300000,       // 5 min
  watchdogIntervalMs: 30000,     // 30 sec
  maxYieldCount: 50,
  queuePollIntervalMs: 5000,     // 5 sec
  maxExecuteIterations: 5,
  stepTimeoutMs: 6000000,        // 100 min
};
```

---

## 🎛️ UI Control Functions

### `toggleSkipVerify(checked)` — Checkbox Handler
```javascript
// Line 9252, index.html
function toggleSkipVerify(checked) {
  window.configStore.setSetting('skipVerify', !checked);
}
// HTML: <input type="checkbox" id="skip-verify" onchange="toggleSkipVerify(this.checked)">
// Note: Logic inverts checkbox value (unchecked → skipVerify=true)
```

### `saveVerifyCommand()` — Text Input Handler
```javascript
// Line 9247, index.html
function saveVerifyCommand() {
  const value = document.getElementById('verify-command').value.trim();
  window.configStore.setSetting('verifyCommand', value);
}
// HTML: <input id="verify-command" onchange="saveVerifyCommand()" onblur="saveVerifyCommand()">
```

---

## 💾 Settings Persistence Flow

```
┌─ User updates UI (checkbox or text input)
│
├─ JavaScript calls: window.configStore.setSetting(key, value)
│
├─ Client-side: _cache.settings[key] = value (instant)
│
├─ Async HTTP: PUT /api/config/settings/{key} with { value }
│
├─ Server receives, updates: config.settings[key] = value
│
└─ Server saves to disk: ~/.formic/config.json
```

**Key Point:** Updates are optimistic (UI responds immediately), server persistence is async

---

## 📁 Configuration File

**Location:** `~/.formic/config.json`

**Structure:**
```json
{
  "version": 1,
  "workspaces": [...],
  "activeWorkspaceId": "ws-uuid-...",
  "settings": {
    "maxConcurrentSessions": 1,
    "theme": "dark",
    "notificationsEnabled": true,
    "projectBriefCollapsed": false,
    "verifyCommand": "npm run test",
    "skipVerify": false,
    "maxExecuteIterations": 5,
    "stepTimeoutMs": 6000000,
    "queuePollIntervalMs": 5000,
    "maxYieldCount": 50,
    "leaseDurationMs": 300000,
    "watchdogIntervalMs": 30000
  }
}
```

---

## 📋 Kanban Development Guideline

**File Location:** `{workspace-path}/kanban-development-guideline.md`

**Status:** ❌ **Does not exist in current project**

**What it does (if present):**
- Loaded by `loadProjectGuidelines()` function (workflow.ts:37-59)
- Optional file; gracefully handled as empty string if missing
- Content gets prepended to all workflow prompts with `## Project Development Guidelines` header

**Code Reference:**
```typescript
const GUIDELINE_FILENAME = 'kanban-development-guideline.md';  // workflow.ts:31

async function loadProjectGuidelines(): Promise<string> {
  const guidelinePath = path.join(getWorkspacePath(), GUIDELINE_FILENAME);
  if (!existsSync(guidelinePath)) {
    return '';  // No error, just empty
  }
  // ... loads and formats content ...
}
```

---

## 🎨 Toast Styling & Behavior

### CSS Classes
- **`.toast-container`**: Absolute positioned, top-right corner
- **`.toast`**: Base styling, receives animations
- **`.toast.success`**: Green theme with ✓ icon
- **`.toast.error`**: Red theme with ✕ icon
- **`.toast-out`**: Fade-out animation class

### Animation Timeline
1. Create toast element
2. **0-300ms**: Slide in + fade (`animation: toast-in 0.3s ease`)
3. **300-4000ms**: Visible
4. **4000ms**: Add `.toast-out` class
5. **4000-4300ms**: Slide out + fade (`animation: toast-out 0.3s ease forwards`)
6. **4300ms**: Remove from DOM

### Usage Examples
```javascript
showToast('Configuration saved successfully', 'success');
showToast('Failed to update verify command', 'error');
```

---

## 🔄 Workflow Execution Flow

### Quick Task Flow
```
executeQuickTask()
├─ refreshEngineConfig()
├─ Load guidelines
├─ Create git safe-point
├─ runWorkflowStep('execute', prompt)
│  └─ Spawns agent process
├─ executeVerifyStep()
│  ├─ If skipVerify=true → { success: true }
│  ├─ If no verifyCommand → { success: true }
│  └─ Else → spawn verifyCommand
├─ If verify fails: executeCriticAndRetry()
└─ Update status to 'review'
```

### Full Workflow Flow
```
executeFullWorkflow()
├─ refreshEngineConfig()
├─ Create git safe-point
├─ runWorkflowStep('brief') → buildBriefPrompt()
├─ runWorkflowStep('plan') → buildPlanPrompt()
├─ executeDeclareAndAcquireLeases()
│  └─ If unavailable → yield task (requeue)
├─ executeWithIterativeLoop('execute')
├─ detectCollisions() on shared files
├─ executeVerifyStep()
│  └─ If fails → executeCriticAndRetry()
├─ releaseLeases() [in finally block]
└─ Update status to 'review'
```

---

## 🔗 API Endpoints (Config Management)

| Endpoint | Method | Body | Purpose |
|----------|--------|------|---------|
| `/api/config` | GET | — | Fetch full config |
| `/api/config/settings/{key}` | PUT | `{ value }` | Update setting |
| `/api/config/workspaces` | POST | `{ path, name?, color? }` | Add workspace |
| `/api/config/workspaces/{id}` | DELETE | — | Remove workspace |
| `/api/config/active-workspace` | PUT | `{ workspaceId }` | Set active workspace |

---

## 🚀 Quick Implementation Checklist

- [ ] Understand `EngineConfig` loads from `~/.formic/config.json`
- [ ] Know `refreshEngineConfig()` must be called before workflows start
- [ ] Remember `skipVerify=true` bypasses verification completely
- [ ] `verifyCommand` is shell-parsed by spaces: `"npm run test"` → `["npm", "run", "test"]`
- [ ] UI updates are optimistic (cache first, persist async)
- [ ] Toasts auto-dismiss after 4s with 300ms fade-out
- [ ] Guideline file is optional (graceful no-op if missing)
- [ ] Both `executeQuickTask()` and `executeFullWorkflow()` return `{ pid }` immediately (async)
- [ ] Leases are released in `finally` block (guaranteed)
- [ ] Collisions detected BEFORE lease release

---

**Full Documentation:** See `FORMIC_CODEBASE_SPEC.md`
