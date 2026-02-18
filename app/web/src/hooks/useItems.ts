import { useState, useEffect, useCallback } from 'react';
import type { ItemSummary, ItemDetail, CreateItemRequest } from '@agent-orch/shared';
import * as api from '../api/client';

export function useItemList() {
  const [items, setItems] = useState<ItemSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const result = await api.listItems();
      setItems(result.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load items');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const create = async (data: CreateItemRequest) => {
    const result = await api.createItem(data);
    await refresh();
    return result.item;
  };

  const remove = async (id: string) => {
    await api.deleteItem(id);
    await refresh();
  };

  return {
    items,
    loading,
    error,
    refresh,
    create,
    remove,
  };
}

export function useItem(id: string | undefined) {
  const [item, setItem] = useState<ItemDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reviewReceiveError, setReviewReceiveError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!id) return;

    try {
      setLoading(true);
      setError(null);
      const result = await api.getItem(id);
      setItem(result.item);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load item');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const startPlanner = async () => {
    if (!id) return;
    await api.startPlanner(id);
    await refresh();
  };

  const startWorkers = async () => {
    if (!id) return;
    await api.startWorkers(id);
    await refresh();
  };

  const stopAgent = async (agentId: string) => {
    if (!id) return;
    await api.stopAgent(id, agentId);
    await refresh();
  };

  const startReviewReceive = async (repoName?: string) => {
    if (!id) return;
    setReviewReceiveError(null);
    try {
      await api.startReviewReceive(id, repoName);
      await refresh();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to start review receive';
      setReviewReceiveError(message);
    }
  };

  return {
    item,
    loading,
    error,
    refresh,
    startPlanner,
    startWorkers,
    stopAgent,
    startReviewReceive,
    reviewReceiveError,
  };
}
