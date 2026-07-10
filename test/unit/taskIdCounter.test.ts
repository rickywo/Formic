import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createTask, deleteTask } from '../../src/server/services/store.js';
import { setWorkspacePath } from '../../src/server/utils/paths.js';

let workspacePath: string;

beforeEach(async () => {
  workspacePath = await mkdtemp(path.join(os.tmpdir(), 'formic-taskid-test-'));
  await mkdir(path.join(workspacePath, '.formic'), { recursive: true });
  setWorkspacePath(workspacePath);
});

afterEach(async () => {
  await rm(workspacePath, { recursive: true, force: true });
});

describe('persistent task ID counter', () => {
  it('never reuses an ID after the highest-numbered task is deleted', async () => {
    const t1 = await createTask({ title: 'First', context: 'ctx' });
    const t2 = await createTask({ title: 'Second', context: 'ctx' });
    const t3 = await createTask({ title: 'Third', context: 'ctx' });

    assert.equal(t1.id, 't-1');
    assert.equal(t2.id, 't-2');
    assert.equal(t3.id, 't-3');

    const deleted = await deleteTask(t3.id);
    assert.equal(deleted, true);

    const t4 = await createTask({ title: 'Fourth', context: 'ctx' });
    assert.equal(t4.id, 't-4');

    const tasksDir = path.join(workspacePath, '.formic', 'tasks');
    const folders = await readdir(tasksDir);
    // The new task must get its own distinct folder — no folder name collision with the
    // deleted t-3 folder, even though (unrelatedly) the docs folder itself may persist on disk.
    assert.notEqual(t4.docsPath, t3.docsPath, 'new task must not reuse the deleted task docsPath');
    assert.equal(folders.some(f => f.startsWith('t-4_')), true, 'new task folder t-4 must exist');
  });
});
