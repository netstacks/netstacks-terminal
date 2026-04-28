import { useState, useEffect, useCallback } from 'react';
import { useAuthStore } from '../stores/authStore';
import { useCapabilitiesStore } from '../stores/capabilitiesStore';

export interface UseResourceListReturn<T> {
  templates: T[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useResourceList<T>(
  fetchFn: (orgId: string) => Promise<T[]>,
  options?: { pluginName?: string; label?: string },
): UseResourceListReturn<T> {
  const [templates, setTemplates] = useState<T[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const user = useAuthStore((state) => state.user);
  const orgId = user?.org_id || '00000000-0000-0000-0000-000000000000';

  const pluginName = options?.pluginName;
  const label = options?.label || 'resources';
  const hasPlugin = useCapabilitiesStore((s) => s.hasPlugin)(pluginName || '');
  const shouldCheck = !!pluginName;

  const fetchData = useCallback(async () => {
    if (shouldCheck && !hasPlugin) {
      setTemplates([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await fetchFn(orgId);
      setTemplates(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : `Failed to load ${label}`;
      setError(message);
      console.error(`[useResourceList] Error fetching ${label}:`, err);
    } finally {
      setLoading(false);
    }
  }, [orgId, hasPlugin, shouldCheck, fetchFn, label]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return { templates, loading, error, refresh: fetchData };
}
