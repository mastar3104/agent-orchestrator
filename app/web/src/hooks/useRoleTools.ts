import { useCallback, useEffect, useState } from 'react';
import type { GlobalRoleToolOverrides } from '@agent-orch/shared';
import * as api from '../api/roleTools';

export function useRoleTools() {
  const [roleTools, setRoleTools] = useState<GlobalRoleToolOverrides>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const result = await api.getRoleTools();
      setRoleTools(result.roleTools);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load role tools');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const update = async (data: GlobalRoleToolOverrides) => {
    const result = await api.updateRoleTools({ roleTools: data });
    setRoleTools(result.roleTools);
    return result.roleTools;
  };

  return {
    roleTools,
    loading,
    error,
    refresh,
    update,
  };
}
