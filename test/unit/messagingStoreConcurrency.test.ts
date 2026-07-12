import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  clearAllSessions,
  loadMessagingStore,
  updateMessagingStore,
  upsertSession,
} from '../../src/server/services/messagingStore.js';
import { getWorkspacePath, setWorkspacePath } from '../../src/server/utils/paths.js';

describe('messaging store mutation serialization', () => {
  let workspacePath: string;
  let savedWorkspacePath: string;

  before(async () => {
    savedWorkspacePath = getWorkspacePath();
    workspacePath = await mkdtemp(path.join(os.tmpdir(), 'formic-messaging-store-'));
    setWorkspacePath(workspacePath);
  });

  after(async () => {
    setWorkspacePath(savedWorkspacePath);
    await rm(workspacePath, { recursive: true, force: true });
  });

  it('preserves a webhook secret across concurrent session updates', async () => {
    const secret = 'concurrency-safe-secret';
    const operations: Array<Promise<unknown>> = [
      updateMessagingStore((store) => {
        store.telegramWebhookSecret = secret;
      }),
    ];

    for (let index = 0; index < 25; index++) {
      operations.push(upsertSession(
        'telegram',
        String(index),
        `user-${index}`,
        workspacePath,
        `User ${index}`,
      ));
    }

    await Promise.all(operations);

    const store = await loadMessagingStore();
    assert.equal(store.telegramWebhookSecret, secret);
    assert.equal(store.sessions.length, 25);
    assert.equal(new Set(store.sessions.map((session) => session.id)).size, 25);
  });

  it('preserves the webhook secret when clearing sessions', async () => {
    await clearAllSessions();
    const store = await loadMessagingStore();
    assert.equal(store.telegramWebhookSecret, 'concurrency-safe-secret');
    assert.deepStrictEqual(store.sessions, []);
  });

  it('persists messaging.json with owner-only permissions', async () => {
    const fileStat = await stat(path.join(workspacePath, '.formic', 'messaging.json'));
    assert.equal(fileStat.mode & 0o777, 0o600);
  });
});
