import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createTask, getAllTasks, updateTask } from '../../src/server/services/store.js';
import { setWorkspacePath } from '../../src/server/utils/paths.js';

let workspacePath: string;

beforeEach(async () => {
  workspacePath = await mkdtemp(path.join(os.tmpdir(), 'formic-boardmutex-test-'));
  await mkdir(path.join(workspacePath, '.formic'), { recursive: true });
  setWorkspacePath(workspacePath);
});

afterEach(async () => {
  await rm(workspacePath, { recursive: true, force: true });
});

describe('withBoard mutation mutex', () => {
  it('persists all 50 concurrent updateTask calls against distinct tasks with no lost updates', async () => {
    const TASK_COUNT = 50;

    const tasks = [];
    for (let i = 0; i < TASK_COUNT; i++) {
      tasks.push(await createTask({ title: `Task ${i}`, context: 'ctx' }));
    }

    // Fire all 50 updateTask calls concurrently (not sequentially awaited) so their
    // load -> mutate -> save cycles genuinely race against each other. Without a
    // whole-cycle mutex (withBoard), two calls can both load the same on-disk
    // snapshot and the later save silently erases the earlier one's change.
    await Promise.all(
      tasks.map((task, index) =>
        updateTask(task.id, { title: `Updated ${index}`, priority: 'high' })
      )
    );

    const finalTasks = await getAllTasks();
    const finalById = new Map(finalTasks.map(t => [t.id, t]));

    for (let i = 0; i < TASK_COUNT; i++) {
      const finalTask = finalById.get(tasks[i].id);
      assert.ok(finalTask, `task ${tasks[i].id} must still exist`);
      assert.equal(finalTask.title, `Updated ${i}`, `task ${tasks[i].id} must reflect its own concurrent update`);
      assert.equal(finalTask.priority, 'high', `task ${tasks[i].id} priority update must not be lost`);
    }
  });
});
