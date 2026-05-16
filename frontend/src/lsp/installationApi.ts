/**
 * REST API wrapper for LSP plugin installation endpoints.
 * Uses the existing API client pattern from `frontend/src/api/client.ts`.
 *
 * IMPORTANT: LSP routes are mounted at `/lsp/*` (NOT `/api/lsp/*`).
 * The `http` axios instance has baseURL = `${SERVER}/api`, so we override
 * with `baseURL: apiClient.baseUrl` per-request to hit `/lsp/plugins` directly.
 */

import type { LspPluginListItem } from './types';
import { getClient } from '../api/client';

/**
 * GET /lsp/plugins — list all plugins (built-in + user-added) with
 * computed install status. Used by the Settings UI (Phase 5) and the
 * useLspClient hook (next task) to decide whether to attempt a WS
 * connection or surface an install banner.
 */
export async function listPlugins(): Promise<LspPluginListItem[]> {
  const apiClient = getClient();

  // Override baseURL to hit /lsp/plugins instead of /api/lsp/plugins
  const { data } = await apiClient.http.get<LspPluginListItem[]>('/lsp/plugins', {
    baseURL: apiClient.baseUrl,
  });

  return data;
}
