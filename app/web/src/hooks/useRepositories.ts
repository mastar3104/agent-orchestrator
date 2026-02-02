import { useState, useEffect, useCallback } from 'react';
import type { GitRepository, CreateRepositoryRequest, UpdateRepositoryRequest } from '@agent-orch/shared';
import * as api from '../api/repositories';

export function useRepositoryList() {
  const [repositories, setRepositories] = useState<GitRepository[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const result = await api.listRepositories();
      setRepositories(result.repositories);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load repositories');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const create = async (data: CreateRepositoryRequest) => {
    const result = await api.createRepository(data);
    await refresh();
    return result.repository;
  };

  const update = async (id: string, data: UpdateRepositoryRequest) => {
    const result = await api.updateRepository(id, data);
    await refresh();
    return result.repository;
  };

  const remove = async (id: string) => {
    await api.deleteRepository(id);
    await refresh();
  };

  return {
    repositories,
    loading,
    error,
    refresh,
    create,
    update,
    remove,
  };
}

export function useRepository(id: string | undefined) {
  const [repository, setRepository] = useState<GitRepository | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!id) return;

    try {
      setLoading(true);
      setError(null);
      const result = await api.getRepository(id);
      setRepository(result.repository);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load repository');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const update = async (data: UpdateRepositoryRequest) => {
    if (!id) return;
    const result = await api.updateRepository(id, data);
    setRepository(result.repository);
    return result.repository;
  };

  return {
    repository,
    loading,
    error,
    refresh,
    update,
  };
}
