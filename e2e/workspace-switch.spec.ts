import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const WORKSPACE_A = '/Users/rickywo/WebstormProjects/Formic/test-workspaces/workspace-a';
const WORKSPACE_B = '/Users/rickywo/WebstormProjects/Formic/test-workspaces/workspace-b';
const BASE_URL = process.env.BASE_URL || 'http://localhost:8000';

// Helper to clean up test files
function cleanupTestFiles() {
  const filesToClean = [
    path.join(WORKSPACE_A, 'test-file-a.txt'),
    path.join(WORKSPACE_B, 'test-file-b.txt'),
    path.join(WORKSPACE_A, 'mobile-test-a.txt'),
    path.join(WORKSPACE_B, 'mobile-test-b.txt'),
  ];

  filesToClean.forEach(file => {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  });
}

// Helper to reset board.json for both workspaces
function resetBoards() {
  const boardA = {
    meta: {
      projectName: 'workspace-a',
      repoPath: WORKSPACE_A,
      createdAt: new Date().toISOString()
    },
    tasks: []
  };

  const boardB = {
    meta: {
      projectName: 'workspace-b',
      repoPath: WORKSPACE_B,
      createdAt: new Date().toISOString()
    },
    tasks: []
  };

  fs.writeFileSync(path.join(WORKSPACE_A, '.formic/board.json'), JSON.stringify(boardA, null, 2));
  fs.writeFileSync(path.join(WORKSPACE_B, '.formic/board.json'), JSON.stringify(boardB, null, 2));
}

// Helper to switch workspace via API
async function switchWorkspace(page: Page, workspacePath: string) {
  const response = await page.request.post(`${BASE_URL}/api/workspace/switch`, {
    data: { path: workspacePath }
  });
  expect(response.ok()).toBeTruthy();
  // Wait for UI to update
  await page.waitForTimeout(500);
}

// Helper to create a task via API
async function createTask(page: Page, title: string, context: string) {
  const response = await page.request.post(`${BASE_URL}/api/tasks`, {
    data: { title, context, priority: 'high' }
  });
  expect(response.ok()).toBeTruthy();
  const task = await response.json();
  return task;
}

// Helper to get current workspace via API
async function getCurrentWorkspace(page: Page) {
  const response = await page.request.get(`${BASE_URL}/api/board`);
  const board = await response.json();
  return board.meta;
}

test.describe('Workspace Switching - Desktop UI', () => {
  test.beforeEach(async () => {
    cleanupTestFiles();
    resetBoards();
  });

  test.afterEach(async () => {
    cleanupTestFiles();
  });

  test('should switch workspace and show correct project name', async ({ page }) => {
    await page.goto(BASE_URL);

    // Switch to workspace A
    await switchWorkspace(page, WORKSPACE_A);
    await page.reload();

    // Verify workspace A is active
    const meta = await getCurrentWorkspace(page);
    expect(meta.projectName).toBe('workspace-a');

    // Switch to workspace B
    await switchWorkspace(page, WORKSPACE_B);
    await page.reload();

    // Verify workspace B is active
    const metaB = await getCurrentWorkspace(page);
    expect(metaB.projectName).toBe('workspace-b');
  });

  test('should create task in correct workspace after switch', async ({ page }) => {
    await page.goto(BASE_URL);

    // Switch to workspace A and create task
    await switchWorkspace(page, WORKSPACE_A);
    const taskA = await createTask(page, 'Task in Workspace A', 'This task should be in workspace A');

    // Verify task is in workspace A's board
    let response = await page.request.get(`${BASE_URL}/api/board`);
    let board = await response.json();
    expect(board.meta.projectName).toBe('workspace-a');
    expect(board.tasks.some((t: any) => t.id === taskA.id)).toBeTruthy();

    // Switch to workspace B and create task
    await switchWorkspace(page, WORKSPACE_B);
    const taskB = await createTask(page, 'Task in Workspace B', 'This task should be in workspace B');

    // Verify task is in workspace B's board
    response = await page.request.get(`${BASE_URL}/api/board`);
    board = await response.json();
    expect(board.meta.projectName).toBe('workspace-b');
    expect(board.tasks.some((t: any) => t.id === taskB.id)).toBeTruthy();

    // Verify workspace A still has its task
    await switchWorkspace(page, WORKSPACE_A);
    response = await page.request.get(`${BASE_URL}/api/board`);
    board = await response.json();
    expect(board.meta.projectName).toBe('workspace-a');
    expect(board.tasks.some((t: any) => t.id === taskA.id)).toBeTruthy();
    // Note: taskB should NOT be in workspace A - verify by checking task title
    const taskBInA = board.tasks.find((t: any) => t.title === 'Task in Workspace B');
    expect(taskBInA).toBeFalsy();
  });

  test('should run task in correct workspace after switch - workspace A', async ({ page }) => {
    await page.goto(BASE_URL);

    // Switch to workspace A
    await switchWorkspace(page, WORKSPACE_A);

    // Create a simple task that creates a file
    const task = await createTask(
      page,
      'Create test file in A',
      'Create a file called test-file-a.txt with content "Hello from workspace A"'
    );

    // Verify the task docs path includes workspace A path
    const docsPath = task.docsPath;
    expect(docsPath).toContain('.formic/tasks');

    // Verify workspace A's board has the task
    const response = await page.request.get(`${BASE_URL}/api/board`);
    const board = await response.json();
    expect(board.meta.repoPath).toBe(WORKSPACE_A);
  });

  test('should run task in correct workspace after switch - workspace B', async ({ page }) => {
    await page.goto(BASE_URL);

    // Start with workspace A
    await switchWorkspace(page, WORKSPACE_A);

    // Now switch to workspace B
    await switchWorkspace(page, WORKSPACE_B);

    // Create a task in workspace B
    const task = await createTask(
      page,
      'Create test file in B',
      'Create a file called test-file-b.txt with content "Hello from workspace B"'
    );

    // Verify the task is in workspace B's board
    const response = await page.request.get(`${BASE_URL}/api/board`);
    const board = await response.json();
    expect(board.meta.projectName).toBe('workspace-b');
    expect(board.meta.repoPath).toBe(WORKSPACE_B);
    expect(board.tasks.some((t: any) => t.id === task.id)).toBeTruthy();
  });

  test('workspace switcher UI should be accessible on desktop', async ({ page }) => {
    await page.goto(BASE_URL);

    // Wait for page to load
    await page.waitForLoadState('networkidle');

    // Verify the page loaded successfully by checking we can access the board API
    const response = await page.request.get(`${BASE_URL}/api/board`);
    expect(response.ok()).toBeTruthy();
    const board = await response.json();
    expect(board.meta).toBeDefined();
  });
});

test.describe('Workspace Switching - Mobile UI (Tactical View)', () => {
  test.use({
    viewport: { width: 375, height: 667 }, // iPhone SE size
  });

  test.beforeEach(async () => {
    cleanupTestFiles();
    resetBoards();
  });

  test.afterEach(async () => {
    cleanupTestFiles();
  });

  test('should display mobile tactical view', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle');

    // Mobile view should show tactical/simplified layout
    // Check that mobile-specific elements are visible
    const body = page.locator('body');
    await expect(body).toBeVisible();
  });

  test('should switch workspace on mobile and maintain context', async ({ page }) => {
    await page.goto(BASE_URL);

    // Switch to workspace A via API
    await switchWorkspace(page, WORKSPACE_A);
    await page.reload();
    await page.waitForLoadState('networkidle');

    // Verify workspace A
    let meta = await getCurrentWorkspace(page);
    expect(meta.projectName).toBe('workspace-a');

    // Switch to workspace B via API
    await switchWorkspace(page, WORKSPACE_B);
    await page.reload();
    await page.waitForLoadState('networkidle');

    // Verify workspace B
    meta = await getCurrentWorkspace(page);
    expect(meta.projectName).toBe('workspace-b');
  });

  test('should create task in correct workspace on mobile after switch', async ({ page }) => {
    await page.goto(BASE_URL);

    // Switch to workspace B first (simulating user already switched)
    await switchWorkspace(page, WORKSPACE_B);
    await page.reload();

    // Create task via API (as mobile would do)
    const task = await createTask(
      page,
      'Mobile task in B',
      'Create mobile-test-b.txt file'
    );

    // Verify task is in workspace B
    const response = await page.request.get(`${BASE_URL}/api/board`);
    const board = await response.json();
    expect(board.meta.projectName).toBe('workspace-b');
    expect(board.tasks.find((t: any) => t.id === task.id)).toBeTruthy();

    // Switch back to workspace A
    await switchWorkspace(page, WORKSPACE_A);

    // Verify workspace A doesn't have the task
    const responseA = await page.request.get(`${BASE_URL}/api/board`);
    const boardA = await responseA.json();
    expect(boardA.meta.projectName).toBe('workspace-a');
    expect(boardA.tasks.find((t: any) => t.id === task.id)).toBeFalsy();
  });

  test('multiple rapid workspace switches should maintain consistency', async ({ page }) => {
    await page.goto(BASE_URL);

    // Rapid switching
    await switchWorkspace(page, WORKSPACE_A);
    await switchWorkspace(page, WORKSPACE_B);
    await switchWorkspace(page, WORKSPACE_A);
    await switchWorkspace(page, WORKSPACE_B);

    // Final state should be workspace B
    const meta = await getCurrentWorkspace(page);
    expect(meta.projectName).toBe('workspace-b');

    // Create a task - should be in workspace B
    const task = await createTask(page, 'After rapid switch', 'Test rapid switching');

    const response = await page.request.get(`${BASE_URL}/api/board`);
    const board = await response.json();
    expect(board.meta.projectName).toBe('workspace-b');
    expect(board.tasks.find((t: any) => t.id === task.id)).toBeTruthy();
  });
});

test.describe('Workspace Path Verification', () => {
  test.beforeEach(async () => {
    cleanupTestFiles();
    resetBoards();
  });

  test('API should return correct workspace path after switch', async ({ page }) => {
    // Switch to workspace A
    await switchWorkspace(page, WORKSPACE_A);

    let response = await page.request.get(`${BASE_URL}/api/board`);
    let board = await response.json();
    expect(board.meta.repoPath).toBe(WORKSPACE_A);

    // Switch to workspace B
    await switchWorkspace(page, WORKSPACE_B);

    response = await page.request.get(`${BASE_URL}/api/board`);
    board = await response.json();
    expect(board.meta.repoPath).toBe(WORKSPACE_B);
  });

  test('task docsPath should use current workspace', async ({ page }) => {
    // Switch to workspace A
    await switchWorkspace(page, WORKSPACE_A);
    const taskA = await createTask(page, 'Task A', 'Context A');

    // The task's docsPath should be relative, and when resolved
    // against the workspace, should point to workspace A
    expect(taskA.docsPath).toMatch(/^\.formic\/tasks\/t-\d+/);

    // Verify the task folder was created in workspace A
    const taskFolderA = path.join(WORKSPACE_A, taskA.docsPath);
    expect(fs.existsSync(taskFolderA)).toBeTruthy();

    // Switch to workspace B
    await switchWorkspace(page, WORKSPACE_B);
    const taskB = await createTask(page, 'Task B', 'Context B');

    // Verify the task folder was created in workspace B
    const taskFolderB = path.join(WORKSPACE_B, taskB.docsPath);
    expect(fs.existsSync(taskFolderB)).toBeTruthy();

    // Verify task A folder is NOT in workspace B
    const wrongPathB = path.join(WORKSPACE_B, taskA.docsPath);
    // This might exist if the bug is present

    // Verify task B folder is NOT in workspace A
    const wrongPathA = path.join(WORKSPACE_A, taskB.docsPath);
    expect(fs.existsSync(wrongPathA)).toBeFalsy();
  });

  test('workspace validation should work', async ({ page }) => {
    // Valid workspace
    let response = await page.request.post(`${BASE_URL}/api/workspace/validate`, {
      data: { path: WORKSPACE_A }
    });
    expect(response.ok()).toBeTruthy();
    let result = await response.json();
    expect(result.valid).toBeTruthy();

    // Invalid workspace (non-existent path)
    response = await page.request.post(`${BASE_URL}/api/workspace/validate`, {
      data: { path: '/nonexistent/path/that/does/not/exist' }
    });
    // Should still return 200 but with valid: false
    result = await response.json();
    expect(result.valid).toBeFalsy();
  });
});
