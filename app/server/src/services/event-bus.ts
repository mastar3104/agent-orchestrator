import { EventEmitter } from 'events';
import type { ItemEvent } from '@agent-orch/shared';

export interface EventBusPayload {
  itemId: string;
  event: ItemEvent;
}

class EventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100);
  }

  publish(itemId: string, event: ItemEvent): void {
    this.emit('event', { itemId, event });
  }

  subscribe(callback: (payload: EventBusPayload) => void): () => void {
    this.on('event', callback);
    return () => this.off('event', callback);
  }

  subscribeToItem(itemId: string, callback: (event: ItemEvent) => void): () => void {
    const handler = (payload: EventBusPayload) => {
      if (payload.itemId === itemId) {
        callback(payload.event);
      }
    };
    this.on('event', handler);
    return () => this.off('event', handler);
  }
}

export const eventBus = new EventBus();
