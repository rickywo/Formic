import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { createTask, getTask, updateTask } from '../../src/server/services/store.js';
import { setWorkspacePath } from '../../src/server/utils/paths.js';
import { taskRoutes } from '../../src/server/routes/tasks.js';
import { refreshEngineConfig } from '../../src/server/services/engineConfig.js';

let workspacePath: string;

beforeEach(async () => {
  workspacePath = await mkdtemp(path.join(os.tmpdir(), 'formic-wl-test-'));
  await mkdir(path.join(workspacePath, '.formic'), { recursive: true });
  setWorkspacePath(workspacePath);
  await refreshEngineConfig();
});

afterEach(async () => {
  await rm(workspacePath, { recursive: true, force: true });
});

describe('PUT /api/tasks/:id whitelist and validation', () => {
  it('rejects unknown field "pid" with 400', async () => {
    const task = await createTask({ title: 'Whitelist test', context: 'ctx' });
    assert.ok(task);

    const fastify = Fastify({ logger: false, ajv: { customOptions: { removeAdditional: false } } });
    await fastify.register(taskRoutes);

    const res = await fastify.inject({
      method: 'PUT',
      url: `/api/tasks/${task.id}`,
      payload: { pid: 9999 },
    });

    assert.equal(res.statusCode, 400, `expected 400, got ${res.statusCode}: ${res.body}`);
    // Verify the task's pid was NOT overwritten
    const t = await getTask(task.id);
    assert.ok(t);
    assert.notEqual(t!.pid, 9999, 'pid should not be 9999');
  });

  it('rejects unknown field "retryCount" with 400', async () => {
    const task = await createTask({ title: 'Retry count test', context: 'ctx' });
    assert.ok(task);

    const fastify = Fastify({ logger: false, ajv: { customOptions: { removeAdditional: false } } });
    await fastify.register(taskRoutes);

    const res = await fastify.inject({
      method: 'PUT',
      url: `/api/tasks/${task.id}`,
      payload: { retryCount: 5 },
    });

    assert.equal(res.statusCode, 400, `expected 400, got ${res.statusCode}: ${res.body}`);
    const t = await getTask(task.id);
    assert.ok(t);
    assert.notEqual(t!.retryCount, 5, 'retryCount should not be 5');
  });

  it('rejects unknown field "agentLogs" with 400', async () => {
    const task = await createTask({ title: 'Agent logs test', context: 'ctx' });
    assert.ok(task);

    const fastify = Fastify({ logger: false, ajv: { customOptions: { removeAdditional: false } } });
    await fastify.register(taskRoutes);

    const res = await fastify.inject({
      method: 'PUT',
      url: `/api/tasks/${task.id}`,
      payload: { agentLogs: ['fake'] },
    });

    assert.equal(res.statusCode, 400, `expected 400, got ${res.statusCode}: ${res.body}`);
    const t = await getTask(task.id);
    assert.ok(t);
    assert.notDeepEqual(t!.agentLogs, ['fake'], 'agentLogs should not be overwritten');
  });

  it('rejects invalid status "bogus" with 400', async () => {
    const task = await createTask({ title: 'Invalid status test', context: 'ctx' });
    assert.ok(task);

    const fastify = Fastify({ logger: false, ajv: { customOptions: { removeAdditional: false } } });
    await fastify.register(taskRoutes);

    const res = await fastify.inject({
      method: 'PUT',
      url: `/api/tasks/${task.id}`,
      payload: { status: 'bogus' },
    });

    assert.equal(res.statusCode, 400, `expected 400, got ${res.statusCode}: ${res.body}`);
    const body = JSON.parse(res.body);
    // Fastify schema validation returns { statusCode, error, message } or
    // our handler returns { error: 'Invalid status: ...' } — either format is fine.
    const hasError = !!(body.error || body.message);
    assert.ok(hasError, `expected error in response: ${res.body}`);
  });

  it('rejects invalid priority "urgent" with 400', async () => {
    const task = await createTask({ title: 'Invalid priority test', context: 'ctx' });
    assert.ok(task);

    const fastify = Fastify({ logger: false, ajv: { customOptions: { removeAdditional: false } } });
    await fastify.register(taskRoutes);

    const res = await fastify.inject({
      method: 'PUT',
      url: `/api/tasks/${task.id}`,
      payload: { priority: 'urgent' },
    });

    assert.equal(res.statusCode, 400, `expected 400, got ${res.statusCode}: ${res.body}`);
  });

  it('rejects invalid type "epic" with 400', async () => {
    const task = await createTask({ title: 'Invalid type test', context: 'ctx' });
    assert.ok(task);

    const fastify = Fastify({ logger: false, ajv: { customOptions: { removeAdditional: false } } });
    await fastify.register(taskRoutes);

    const res = await fastify.inject({
      method: 'PUT',
      url: `/api/tasks/${task.id}`,
      payload: { type: 'epic' },
    });

    assert.equal(res.statusCode, 400, `expected 400, got ${res.statusCode}: ${res.body}`);
  });

  it('accepts valid partial update with allowed fields (200)', async () => {
    const task = await createTask({ title: 'Partial update test', context: 'ctx', priority: 'medium' });
    assert.ok(task);

    const fastify = Fastify({ logger: false, ajv: { customOptions: { removeAdditional: false } } });
    await fastify.register(taskRoutes);

    const res = await fastify.inject({
      method: 'PUT',
      url: `/api/tasks/${task.id}`,
      payload: { title: 'Updated Title', priority: 'high' },
    });

    assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
    const data = JSON.parse(res.body);
    assert.equal(data.title, 'Updated Title');
    assert.equal(data.priority, 'high');
  });

  it('accepts valid status update (200)', async () => {
    const task = await createTask({ title: 'Status update test', context: 'ctx' });
    assert.ok(task);
    assert.equal(task.status, 'todo');

    const fastify = Fastify({ logger: false, ajv: { customOptions: { removeAdditional: false } } });
    await fastify.register(taskRoutes);

    const res = await fastify.inject({
      method: 'PUT',
      url: `/api/tasks/${task.id}`,
      payload: { status: 'review' },
    });

    assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
    const data = JSON.parse(res.body);
    assert.equal(data.status, 'review');
  });

  it('accepts valid type update (200)', async () => {
    const task = await createTask({ title: 'Type update test', context: 'ctx' });
    assert.ok(task);

    const fastify = Fastify({ logger: false, ajv: { customOptions: { removeAdditional: false } } });
    await fastify.register(taskRoutes);

    const res = await fastify.inject({
      method: 'PUT',
      url: `/api/tasks/${task.id}`,
      payload: { type: 'quick' },
    });

    assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
    const data = JSON.parse(res.body);
    assert.equal(data.type, 'quick');
  });

  it('accepts yieldReason update (200)', async () => {
    const task = await createTask({ title: 'Yield reason test', context: 'ctx' });
    assert.ok(task);

    const fastify = Fastify({ logger: false, ajv: { customOptions: { removeAdditional: false } } });
    await fastify.register(taskRoutes);

    const res = await fastify.inject({
      method: 'PUT',
      url: `/api/tasks/${task.id}`,
      payload: { yieldReason: 'test-reason' },
    });

    assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
    const data = JSON.parse(res.body);
    assert.equal(data.yieldReason, 'test-reason');
  });

  it('store-level updateTask still accepts internal fields (route whitelist is the guard)', async () => {
    // Verify that the whitelist restriction is at the route layer only;
    // internal callers can still use updateTask() with the full UpdateTaskInput.
    const task = await createTask({ title: 'Internal update test', context: 'ctx' });
    assert.ok(task);

    const updated = await updateTask(task.id, { retryCount: 3, pid: 1234, workflowStep: 'brief' });
    assert.ok(updated);
    assert.equal(updated!.retryCount, 3);
    assert.equal(updated!.pid, 1234);
    assert.equal(updated!.workflowStep, 'brief');
  });
});
