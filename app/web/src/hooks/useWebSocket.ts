import { useEffect, useRef, useState, useCallback } from 'react';
import type { ItemEvent, WsMessage } from '@agent-orch/shared';

export interface UseWebSocketOptions {
  itemId?: string;
  onEvent?: (event: ItemEvent) => void;
}

export function useWebSocket(options: UseWebSocketOptions) {
  const { itemId, onEvent } = options;
  const wsRef = useRef<WebSocket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<ItemEvent | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout>();

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      return;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      setIsConnected(true);

      // Subscribe to item if specified
      if (itemId) {
        ws.send(JSON.stringify({ type: 'subscribe', itemId }));
      }
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as WsMessage;

        if (message.type === 'event' && message.event) {
          setLastEvent(message.event);
          onEvent?.(message.event);
        }
      } catch (error) {
        console.error('Failed to parse WebSocket message:', error);
      }
    };

    ws.onclose = () => {
      setIsConnected(false);

      // Reconnect after 3 seconds
      reconnectTimeoutRef.current = setTimeout(() => {
        connect();
      }, 3000);
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };

    wsRef.current = ws;
  }, [itemId, onEvent]);

  const subscribe = useCallback((id: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'subscribe', itemId: id }));
    }
  }, []);

  const unsubscribe = useCallback((id: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'unsubscribe', itemId: id }));
    }
  }, []);

  useEffect(() => {
    connect();

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [connect]);

  // Subscribe to item changes
  useEffect(() => {
    if (isConnected && itemId) {
      subscribe(itemId);
      return () => {
        unsubscribe(itemId);
      };
    }
  }, [isConnected, itemId, subscribe, unsubscribe]);

  return {
    isConnected,
    lastEvent,
    subscribe,
    unsubscribe,
  };
}
