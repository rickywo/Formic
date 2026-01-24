import type { FastifyInstance } from 'fastify';
import type { SocketStream } from '@fastify/websocket';
import {
  registerAssistantConnection,
  unregisterAssistantConnection,
  getAssistantSession,
  getMessageHistory,
  sendUserMessage,
} from '../services/assistantManager.js';
import {
  registerBoardConnection,
  unregisterBoardConnection,
} from '../services/boardNotifier.js';

export async function assistantWebSocket(fastify: FastifyInstance): Promise<void> {
  fastify.get('/ws/assistant', { websocket: true }, async (connection: SocketStream) => {
    const socket = connection.socket;

    console.log('[AssistantWS] New connection established');

    // Register this connection for broadcasts
    registerAssistantConnection(socket);
    registerBoardConnection(socket);

    // Send current status and history on connect
    const session = getAssistantSession();
    socket.send(JSON.stringify({ type: 'status', session }));

    const history = getMessageHistory();
    if (history.length > 0) {
      socket.send(JSON.stringify({ type: 'history', messages: history }));
    }

    // Handle incoming messages from client
    socket.on('message', (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());

        if (message.type === 'message' && message.content) {
          // Send user message to the assistant process
          const sent = sendUserMessage(message.content);
          if (!sent) {
            socket.send(JSON.stringify({
              type: 'error',
              error: 'Assistant is not running. Start a session first.',
            }));
          }
        }
      } catch (error) {
        console.error('[AssistantWS] Failed to parse message:', error);
      }
    });

    // Handle disconnection
    socket.on('close', () => {
      console.log('[AssistantWS] Connection closed');
      unregisterAssistantConnection(socket);
      unregisterBoardConnection(socket);
    });

    socket.on('error', (error) => {
      console.error('[AssistantWS] Socket error:', error);
      unregisterAssistantConnection(socket);
      unregisterBoardConnection(socket);
    });
  });
}
