import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { broadcastUsageUpdated, registerBoardConnection, unregisterBoardConnection } from '../../src/server/services/boardNotifier.js';

interface SentMessageSocket {
  readyState: number;
  messages: string[];
  send(data: string): void;
}

function socket(): SentMessageSocket {
  return {
    readyState: 1,
    messages: [],
    send(data: string): void {
      this.messages.push(data);
    },
  };
}

describe('boardNotifier usage updates', () => {
  it('broadcasts a global usage refresh with no task badge IDs for non-task usage', () => {
    const ws = socket();
    registerBoardConnection(ws as never);
    try {
      broadcastUsageUpdated([]);
    } finally {
      unregisterBoardConnection(ws as never);
    }
    assert.deepEqual(ws.messages.map(message => JSON.parse(message)), [{ type: 'usage-updated', taskIds: [] }]);
  });
});
