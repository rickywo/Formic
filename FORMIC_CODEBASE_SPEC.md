# Formic Project - Codebase Analysis & Specification

## 1. Tech Stack

**Runtime & Build:**
- Node.js >= 20.0.0
- TypeScript 5.5.3
- ESM module system

**Core Dependencies:**
- **Fastify 4.26.0** - HTTP server framework
- **@fastify/websocket 9.0.0** - WebSocket support
- **@fastify/static 7.0.0** - Static file serving
- **Framer Motion 12.35.1** - Animation library

**Dev Dependencies:**
- tsx 4.7.0 - TypeScript executor
- @playwright/test 1.58.0 - E2E testing
- @types/node 20.11.0, @types/ws 8.18.1

**Project Type:** Local-first agent orchestration and execution environment for AI coding tasks with Kanban board UI.

---

## 2. Key Functions & Implementations

### 2.1 executeVerifyStep()
**File:** `/Users/WTHX38/WebstormProjects/Formic/src/server/services/workflow.ts` (lines 687-760)

**Purpose:** Runs a verification command against the workspace after task execution.

**Function Signature:**
```typescript
async function executeVerifyStep(taskId: string): Promise<{ success: boolean; stderrLines: string[] }>;
```

**Behavior:**
- Returns `{ success: true, stderrLines: [] }` immediately if `engineConfig.skipVerify` is true OR `engineConfig.verifyCommand` is not set
- Updates task status to `'verifying'`
- Updates workflow step to `'verify'`
- Spawns verification command in workspace using `spawn()` (splits command string by spaces: `parts[0]` = cmd, `parts.slice(1)` = args)
- Streams stdout/stderr to task connections via WebSocket
- Maintains log buffers (max 100 lines each for stdout and stderr)
- Appends verification logs to workflow
- Returns `{ success: false, stderrLines }` if process fails or exits with non-zero code

**Key Code:**
```typescript
async function executeVerifyStep(taskId: string): Promise<{ success: boolean; stderrLines: string[] }> {
  if (engineConfig.skipVerify || !engineConfig.verifyCommand) {
    console.log('[Verifier] Skipping verification (skipVerify or no verifyCommand)');
    return { success: true, stderrLines: [] };
  }

  await updateTaskStatus(taskId, 'verifying', null);
  await updateWorkflowStep(taskId, 'verify');

  broadcastToTask(taskId, {
    type: 'stdout',
    data: '\n========== Starting VERIFY step ==========\n',
    timestamp: new Date().toISOString(),
  });

  const parts = engineConfig.verifyCommand.split(' ');
  const cmd = parts[0];
  const args = parts.slice(1);
  const logBuffer: string[] = [];
  const stderrLines: string[] = [];

  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, {
        cwd: getWorkspacePath(),
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.log(`[Verifier] Failed to spawn verification command: ${message}`);
      resolve({ success: false, stderrLines: [message] });
      return;
    }

    // ... stdout/stderr listeners ...
    
    child.on('close', async (code) => {
      await appendWorkflowLogs(taskId, 'verify', logBuffer);
      // ... broadcast completion ...
      resolve({ success: code === 0, stderrLines });
    });
  });
}
```

---

### 2.2 executeQuickTask()
**File:** `/Users/WTHX38/WebstormProjects/Formic/src/server/services/workflow.ts` (lines 949-1030)

**Purpose:** Executes a quick task that skips brief/plan stages and runs execute directly.

**Function Signature:**
```typescript
export async function executeQuickTask(taskId: string): Promise<{ pid: number }>;
```

**Behavior:**
1. Fetches task from store
2. **Calls `refreshEngineConfig()`** to sync config from file
3. Checks if workflow is already running for taskId
4. Creates git safe-point for rollback support
5. Loads project development guidelines from `kanban-development-guideline.md`
6. Builds quick execute prompt using `buildQuickExecutePrompt(task, guidelines)`
7. Updates task status to `'running'`
8. Broadcasts start message
9. Spawns execute step workflow asynchronously:
   - Uses `runWorkflowStep()` to run the prompt
   - Stores in `activeWorkflows` map
10. After execute completes:
    - Deletes from `activeWorkflows`
    - Releases leases
    - If success: runs `executeVerifyStep()` → if verify fails, runs `executeCriticAndRetry()` → else marks complete and broadcasts
    - If failure: resets status to `'todo'`
11. **Returns immediately with `{ pid: startPid }`** (async execution)

**Key Code Snippet:**
```typescript
export async function executeQuickTask(taskId: string): Promise<{ pid: number }> {
  const task = await getTask(taskId);
  if (!task) {
    throw new Error(`Task ${taskId} not found`);
  }
  await refreshEngineConfig();

  if (activeWorkflows.has(taskId)) {
    throw new Error('A workflow is already running for this task');
  }

  // ... load guidelines, build prompt ...
  
  await updateTaskStatus(taskId, 'running', null);
  await updateWorkflowStep(taskId, 'execute');

  const startPid = process.pid;

  (async () => {
    const success = await new Promise<boolean>((resolve) => {
      const child = runWorkflowStep(taskId, 'execute', prompt, (success) => {
        resolve(success);
      });

      if (child.pid) {
        activeWorkflows.set(taskId, { process: child, currentStep: 'execute' });
      }
    });

    activeWorkflows.delete(taskId);
    releaseLeases(taskId);

    if (success) {
      const verifyResult = await executeVerifyStep(taskId);
      if (!verifyResult.success) {
        await executeCriticAndRetry(taskId, verifyResult.stderrLines);
        return;
      }
      // ... mark complete ...
    } else {
      await updateTaskStatus(taskId, 'todo', null);
    }
  })();

  return { pid: startPid };
}
```

---

### 2.3 executeFullWorkflow() (aka runWorkflow)
**File:** `/Users/WTHX38/WebstormProjects/Formic/src/server/services/workflow.ts` (lines 1156-1344)

**Purpose:** Executes the full workflow pipeline: brief → plan → execute → verify.

**Function Signature:**
```typescript
export async function executeFullWorkflow(taskId: string): Promise<{ pid: number }>;
```

**Behavior:**
1. Fetches task from store
2. **Calls `refreshEngineConfig()`** to sync config from file
3. Checks if workflow already running
4. Defines `runStep()` async helper for sequential step execution
5. Returns `{ pid: startPid }` immediately (async execution)
6. Spawns async workflow runner:
   - Creates git safe-point
   - **Step 1: Brief** - tries skill file, fallbacks to `buildBriefPromptFallback(task, guidelines)`
   - **Step 2: Plan** - tries skill file, fallbacks to `buildPlanPromptFallback(task, guidelines)`
   - **Step 2.5: Declare + Acquire Leases** - calls `executeDeclareAndAcquireLeases()`, yields if leases unavailable
   - **Step 3: Execute** - runs `executeWithIterativeLoop(taskId, task)` with lease protection
   - **Step 4: Verify** - calls `executeVerifyStep()`, runs critic+retry if fails
   - Detects file collisions before releasing leases
   - Updates status to `'review'` on complete success

**Key Code Snippet:**
```typescript
export async function executeFullWorkflow(taskId: string): Promise<{ pid: number }> {
  const task = await getTask(taskId);
  if (!task) {
    throw new Error(`Task ${taskId} not found`);
  }
  await refreshEngineConfig();

  const runStep = async (step: 'brief' | 'plan' | 'execute'): Promise<boolean> => {
    // ... prompt building from skill or fallback ...
    
    await updateTaskStatus(taskId, status, null);
    await updateWorkflowStep(taskId, step);

    return new Promise((resolve) => {
      const child = runWorkflowStep(taskId, step, prompt, (success) => {
        resolve(success);
      });

      if (child.pid) {
        activeWorkflows.set(taskId, { process: child, currentStep: step });
      }
    });
  };

  const startPid = process.pid;

  (async () => {
    await createSafePoint(taskId);

    const briefSuccess = await runStep('brief');
    if (!briefSuccess) {
      activeWorkflows.delete(taskId);
      await updateTaskStatus(taskId, 'todo', null);
      return;
    }

    const planSuccess = await runStep('plan');
    if (!planSuccess) {
      activeWorkflows.delete(taskId);
      await updateTaskStatus(taskId, 'todo', null);
      return;
    }

    // ... declare & acquire leases ...
    const leasesAcquired = await executeDeclareAndAcquireLeases(taskId, currentTaskForDeclare);
    if (!leasesAcquired) {
      activeWorkflows.delete(taskId);
      // ... yield with yieldCount increment ...
      await updateTaskStatus(taskId, 'queued', null);
      return;
    }

    try {
      const executeResult = await executeWithIterativeLoop(taskId, currentTask);
      activeWorkflows.delete(taskId);

      if (currentTask.declaredFiles?.shared && currentTask.declaredFiles.shared.length > 0) {
        const conflicts = await detectCollisions(taskId, getWorkspacePath());
        // ... record conflicts ...
      }

      if (executeResult.success) {
        const latestTask = await getTask(taskId);
        if (latestTask && latestTask.status === 'running') {
          const verifyResult = await executeVerifyStep(taskId);
          if (!verifyResult.success) {
            await executeCriticAndRetry(taskId, verifyResult.stderrLines);
          } else {
            await updateWorkflowStep(taskId, 'complete');
            await updateTaskStatus(taskId, 'review', null);
            broadcastTaskCompleted(taskId);
            internalEvents.emit(TASK_COMPLETED, taskId);
            void runReflectionStep(taskId);
          }
        }
      } else {
        const latestTask = await getTask(taskId);
        if (latestTask && latestTask.status === 'running') {
          await updateTaskStatus(taskId, 'todo', null);
        }
      }
    } finally {
      releaseLeases(taskId);
    }
  })();

  return { pid: startPid };
}
```

---

### 2.4 refreshEngineConfig()
**File:** `/Users/WTHX38/WebstormProjects/Formic/src/server/services/engineConfig.ts` (lines 33-45)

**Purpose:** Refreshes the in-memory engine config from disk store.

**Function Signature:**
```typescript
export async function refreshEngineConfig(): Promise<void>;
```

**Behavior:**
- Loads config from `configStore.loadConfig()` (reads from `~/.formic/config.json`)
- Updates the singleton `engineConfig` object with values from `config.settings`
- Used at start of top-level operations (workflow execution, queue poll, watchdog scan)

**Code:**
```typescript
export async function refreshEngineConfig(): Promise<void> {
  const config = await loadConfig();
  const s = config.settings;
  engineConfig.maxConcurrentTasks = s.maxConcurrentSessions ?? 1;
  engineConfig.verifyCommand = s.verifyCommand ?? '';
  engineConfig.skipVerify = s.skipVerify ?? false;
  engineConfig.leaseDurationMs = s.leaseDurationMs ?? 300000;
  engineConfig.watchdogIntervalMs = s.watchdogIntervalMs ?? 30000;
  engineConfig.maxYieldCount = s.maxYieldCount ?? 50;
  engineConfig.queuePollIntervalMs = s.queuePollIntervalMs ?? 5000;
  engineConfig.maxExecuteIterations = s.maxExecuteIterations ?? 5;
  engineConfig.stepTimeoutMs = s.stepTimeoutMs ?? 6000000;
}
```

---

## 3. UI Functions (Client-Side)

### 3.1 toggleSkipVerify(checked: boolean)
**File:** `/Users/WTHX38/WebstormProjects/Formic/src/client/index.html` (lines 9252-9254)

**HTML Binding:** `<input type="checkbox" id="skip-verify" onchange="toggleSkipVerify(this.checked)">`

**Function:**
```javascript
function toggleSkipVerify(checked) {
  window.configStore.setSetting('skipVerify', !checked);
}
```

**Behavior:**
- Takes boolean from checkbox input
- Calls `window.configStore.setSetting('skipVerify', !checked)` (note: inverts the value)
- Updates cache immediately and persists to server via `PUT /api/config/settings/skipVerify`

---

### 3.2 saveVerifyCommand()
**File:** `/Users/WTHX38/WebstormProjects/Formic/src/client/index.html` (lines 9247-9249)

**HTML Binding:** `<input ... id="verify-command" onchange="saveVerifyCommand()" onblur="saveVerifyCommand()">`

**Function:**
```javascript
function saveVerifyCommand() {
  const value = document.getElementById('verify-command').value.trim();
  window.configStore.setSetting('verifyCommand', value);
}
```

**Behavior:**
- Gets trimmed value from `#verify-command` input element
- Calls `window.configStore.setSetting('verifyCommand', value)`
- Updates cache immediately and persists to server via `PUT /api/config/settings/verifyCommand`

---

### 3.3 showToast(message: string, type: 'success' | 'error')
**File:** `/Users/WTHX38/WebstormProjects/Formic/src/client/index.html` (lines 7700-7720)

**Function:**
```javascript
function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <span class="toast-icon">${type === 'success' ? '✓' : '✕'}</span>
    <span>${message}</span>
  `;

  container.appendChild(toast);

  // Auto-remove after 4 seconds
  setTimeout(() => {
    toast.classList.add('toast-out');
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}
```

**Toast Styling (CSS):**
- Container: `.toast-container` (absolute positioned, top-right area, z-index stacking)
- Toast elements: `.toast` with `animation: toast-in 0.3s ease` on entrance
- Success: `.toast.success` with green icon (✓)
- Error: `.toast.error` with red icon (✕)
- Exit animation: `.toast.toast-out` with `animation: toast-out 0.3s ease forwards`
- Auto-removes after 4000ms + 300ms animation

**CSS Animations:**
- `toast-in`: slides/fades in over 0.3s
- `toast-out`: slides/fades out over 0.3s

---

## 4. EngineConfig Shape

**Type Definition:** `/Users/WTHX38/WebstormProjects/Formic/src/server/services/engineConfig.ts` (lines 9-19)

```typescript
export interface EngineConfig {
  maxConcurrentTasks: number;
  verifyCommand: string;
  skipVerify: boolean;
  leaseDurationMs: number;
  watchdogIntervalMs: number;
  maxYieldCount: number;
  queuePollIntervalMs: number;
  maxExecuteIterations: number;
  stepTimeoutMs: number;
}
```

**Singleton Instance Defaults:**
```typescript
export const engineConfig: EngineConfig = {
  maxConcurrentTasks: 1,
  verifyCommand: '',
  skipVerify: false,
  leaseDurationMs: 300000,         // 5 minutes
  watchdogIntervalMs: 30000,       // 30 seconds
  maxYieldCount: 50,
  queuePollIntervalMs: 5000,       // 5 seconds
  maxExecuteIterations: 5,
  stepTimeoutMs: 6000000,          // 100 minutes
};
```

**Key Fields Relevant to Verify:**
- **`verifyCommand`** (string): Shell command to run for verification (e.g., `"npm run test"`)
- **`skipVerify`** (boolean): If true, verification step is completely bypassed

**Persisted In:** `~/.formic/config.json` under `settings` key

---

## 5. Configuration Persistence

**Client-Side Flow:**
1. User updates setting in UI (checkbox or text input)
2. JavaScript calls `window.configStore.setSetting(key, value)`
3. Value updates in-memory cache immediately
4. Async HTTP `PUT /api/config/settings/{key}` sent to server
5. Server receives, updates `~/.formic/config.json`, responds

**Server-Side Store:** `/Users/WTHX38/WebstormProjects/Formic/src/server/services/configStore.ts`

**Full Settings Structure (ConfigSettings):**
```typescript
{
  maxConcurrentSessions: 1,
  theme: 'dark',
  notificationsEnabled: true,
  projectBriefCollapsed: false,
  verifyCommand: '',
  skipVerify: false,
  maxExecuteIterations: 5,
  stepTimeoutMs: 6000000,
  queuePollIntervalMs: 5000,
  maxYieldCount: 50,
  leaseDurationMs: 300000,
  watchdogIntervalMs: 30000,
}
```

---

## 6. Kanban Development Guideline

**Status:** ❌ **File does NOT exist in project**

**Expected Location:** `{workspace-path}/kanban-development-guideline.md`

**Reference in Code:**
- Constant defined in workflow.ts line 31: `const GUIDELINE_FILENAME = 'kanban-development-guideline.md';`
- Loaded by `loadProjectGuidelines()` function (lines 37-59) which checks `existsSync(guidelinePath)`
- If file exists, content is prepended to prompts with header: `## Project Development Guidelines`
- If missing, returns empty string (non-blocking)

**Loading Function:**
```typescript
async function loadProjectGuidelines(): Promise<string> {
  const guidelinePath = path.join(getWorkspacePath(), GUIDELINE_FILENAME);

  if (!existsSync(guidelinePath)) {
    return '';
  }

  try {
    const content = await readFile(guidelinePath, 'utf-8');
    return `
## Project Development Guidelines
The following guidelines MUST be followed for all code changes in this project:

${content}

---
END OF GUIDELINES
`;
  } catch (error) {
    console.warn('[Workflow] Failed to load project guidelines:', error);
    return '';
  }
}
```

---

## 7. Toast/Warning Patterns Used in index.html

**Pattern 1: Success Toast**
```javascript
showToast('Settings saved successfully', 'success');
```

**Pattern 2: Error Toast**
```javascript
showToast('Failed to update settings', 'error');
```

**Toast Behavior:**
- Auto-dismisses after 4 seconds
- Can stack multiple toasts
- Positioned in top-right corner via `.toast-container`
- Uses CSS animations for smooth entrance/exit

**Where Used:** Settings changes, API responses, form submissions

---

## 8. Configuration API Endpoints

(Inferred from client-side `configStore.js`)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/config` | GET | Fetch full config |
| `/api/config/settings/{key}` | PUT | Update single setting |
| `/api/config/workspaces` | POST | Add workspace |
| `/api/config/workspaces/{id}` | DELETE | Remove workspace |
| `/api/config/active-workspace` | PUT | Set active workspace |
| `/api/config/migrate` | POST | One-time localStorage migration |

---

## Summary Table

| Component | Location | Key Purpose |
|-----------|----------|-------------|
| **executeVerifyStep()** | workflow.ts:687 | Run verification command after execution |
| **executeQuickTask()** | workflow.ts:949 | Execute task (skip brief/plan) |
| **executeFullWorkflow()** | workflow.ts:1156 | Execute full pipeline (brief→plan→execute→verify) |
| **refreshEngineConfig()** | engineConfig.ts:33 | Reload config from disk |
| **toggleSkipVerify()** | index.html:9252 | UI checkbox for skipping verification |
| **saveVerifyCommand()** | index.html:9247 | UI input for verification command |
| **showToast()** | index.html:7700 | Display notification messages |
| **EngineConfig** | engineConfig.ts:9 | Runtime settings interface |
| **kanban-development-guideline.md** | Workspace root | Optional project guidelines file |

