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
import { getSidecarAuthToken } from '../api/localClient';

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

/**
 * POST /lsp/plugins/:id/install — start an install (returns 202 Accepted).
 * Then subscribe to install-progress SSE to track completion.
 */
export async function installPlugin(pluginId: string): Promise<void> {
  const apiClient = getClient();
  await apiClient.http.post(
    `/lsp/plugins/${encodeURIComponent(pluginId)}/install`,
    null,
    { baseURL: apiClient.baseUrl }
  );
}

/**
 * DELETE /lsp/plugins/:id — uninstall the plugin.
 */
export async function uninstallPlugin(pluginId: string): Promise<void> {
  const apiClient = getClient();
  await apiClient.http.delete(
    `/lsp/plugins/${encodeURIComponent(pluginId)}`,
    { baseURL: apiClient.baseUrl }
  );
}

/** Server-Sent Event payload from /lsp/plugins/:id/install-progress */
export interface InstallEvent {
  phase: 'downloading' | 'verifying' | 'extracting' | 'smoke-testing' | 'done' | 'error';
  bytesDownloaded?: number;
  totalBytes?: number | null;
  error?: string;
}

/**
 * Subscribe to install progress via SSE. Returns an unsubscribe function.
 * The browser EventSource auto-reconnects on transient failures; the
 * caller's onClose handler runs when the server sends `event: end` or
 * closes the stream after `done`.
 */
export function subscribeToInstallProgress(
  pluginId: string,
  onEvent: (e: InstallEvent) => void,
  onError: (err: Error) => void
): () => void {
  const apiClient = getClient();
  const token = encodeURIComponent(getSidecarAuthToken() ?? '');
  const url = `${apiClient.baseUrl}/lsp/plugins/${encodeURIComponent(pluginId)}/install-progress?token=${token}`;

  // SSE: browser EventSource doesn't support custom headers, so token rides as query param.
  const es = new EventSource(url);
  es.addEventListener('progress', (msg) => {
    try {
      onEvent(JSON.parse((msg as MessageEvent).data) as InstallEvent);
    } catch (e) {
      onError(new Error(`bad SSE payload: ${(e as Error).message}`));
    }
  });
  es.onerror = () => {
    onError(new Error('SSE connection failed'));
  };
  return () => es.close();
}
