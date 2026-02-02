import type { FastifyPluginAsync } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import type { WsMessage, WsSubscribeMessage, WsUnsubscribeMessage } from '@agent-orch/shared';
import { eventBus, type EventBusPayload } from '../services/event-bus';

interface ClientState {
  subscriptions: Set<string>;
  unsubscribe?: () => void;
}

export const wsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/ws', { websocket: true }, (socket: WebSocket) => {
    const clientState: ClientState = {
      subscriptions: new Set(),
    };

    // Setup event bus subscription
    const handleEvent = (payload: EventBusPayload) => {
      if (clientState.subscriptions.has(payload.itemId)) {
        const message: WsMessage = {
          type: 'event',
          itemId: payload.itemId,
          event: payload.event,
        };
        socket.send(JSON.stringify(message));
      }
    };

    clientState.unsubscribe = eventBus.subscribe(handleEvent);

    // Send connected message
    socket.send(
      JSON.stringify({
        type: 'connected',
      } as WsMessage)
    );

    // Handle incoming messages
    socket.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
      try {
        const message = JSON.parse(data.toString()) as WsMessage;

        switch (message.type) {
          case 'subscribe': {
            const subMsg = message as WsSubscribeMessage;
            if (subMsg.itemId) {
              clientState.subscriptions.add(subMsg.itemId);
              fastify.log.info({ itemId: subMsg.itemId }, 'Client subscribed');
            }
            break;
          }
          case 'unsubscribe': {
            const unsubMsg = message as WsUnsubscribeMessage;
            if (unsubMsg.itemId) {
              clientState.subscriptions.delete(unsubMsg.itemId);
              fastify.log.info({ itemId: unsubMsg.itemId }, 'Client unsubscribed');
            }
            break;
          }
        }
      } catch (error) {
        fastify.log.error({ error }, 'Failed to parse WebSocket message');
        socket.send(
          JSON.stringify({
            type: 'error',
            error: 'Invalid message format',
          } as WsMessage)
        );
      }
    });

    // Cleanup on close
    socket.on('close', () => {
      if (clientState.unsubscribe) {
        clientState.unsubscribe();
      }
      clientState.subscriptions.clear();
    });

    // Handle errors
    socket.on('error', (error: Error) => {
      fastify.log.error({ error }, 'WebSocket error');
      if (clientState.unsubscribe) {
        clientState.unsubscribe();
      }
    });
  });
};
