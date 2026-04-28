/**
 * MCP (Model Context Protocol) Server API
 *
 * Provides functions to manage MCP server connections and tool discovery.
 */

import { getClient } from './client';

export interface McpTool {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  input_schema: Record<string, unknown>;
}

export interface McpServer {
  id: string;
  name: string;
  transport_type: 'stdio' | 'sse';
  command: string;
  args: string[];
  url: string | null;
  auth_type: 'none' | 'bearer' | 'api-key';
  server_type: string;
  enabled: boolean;
  connected: boolean;
  tools: McpTool[];
}

export interface AddMcpServerRequest {
  name: string;
  transport_type: 'stdio' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  auth_type?: string;
  auth_token?: string;
  server_type?: string;
}

/**
 * List all configured MCP servers
 */
export async function listMcpServers(): Promise<McpServer[]> {
  const { data } = await getClient().http.get('/mcp/servers');
  return Array.isArray(data) ? data : [];
}

/**
 * Add a new MCP server configuration.
 *
 * AUDIT FIX (CRYPTO-002): when an `auth_token` is supplied, the backend
 * requires the vault to be unlocked so it can encrypt the token before
 * storing it. We surface that error code with a friendlier message so the
 * UI can prompt the user to unlock first.
 */
export async function addMcpServer(req: AddMcpServerRequest): Promise<McpServer> {
  try {
    const { data } = await getClient().http.post('/mcp/servers', req);
    return data;
  } catch (err: unknown) {
    const axiosErr = err as { response?: { data?: { error?: string; code?: string } } };
    if (axiosErr.response?.data?.code === 'VAULT_LOCKED') {
      throw new Error(
        'Unlock the vault before saving an MCP auth token — tokens are stored encrypted.',
      );
    }
    throw new Error(axiosErr.response?.data?.error || 'Failed to add MCP server');
  }
}

/**
 * Delete an MCP server configuration
 */
export async function deleteMcpServer(id: string): Promise<void> {
  try {
    await getClient().http.delete(`/mcp/servers/${id}`);
  } catch (err: unknown) {
    const axiosErr = err as { response?: { data?: { error?: string } } };
    throw new Error(axiosErr.response?.data?.error || 'Failed to delete MCP server');
  }
}

/**
 * Connect to an MCP server and discover tools.
 *
 * AUDIT FIX (CRYPTO-002): if the MCP server has an encrypted auth token
 * and the vault is locked, the backend returns 403 VAULT_LOCKED. Surface
 * with a clear message so the UI can prompt for unlock.
 */
export async function connectMcpServer(id: string): Promise<McpServer> {
  try {
    const { data } = await getClient().http.post(`/mcp/servers/${id}/connect`);
    return data;
  } catch (err: unknown) {
    const axiosErr = err as { response?: { data?: { error?: string; code?: string } } };
    if (axiosErr.response?.data?.code === 'VAULT_LOCKED') {
      throw new Error(
        'Unlock the vault before connecting to this MCP server — its auth token is encrypted.',
      );
    }
    throw new Error(axiosErr.response?.data?.error || 'Failed to connect to MCP server');
  }
}

/**
 * Disconnect from an MCP server
 */
export async function disconnectMcpServer(id: string): Promise<void> {
  try {
    await getClient().http.post(`/mcp/servers/${id}/disconnect`);
  } catch (err: unknown) {
    const axiosErr = err as { response?: { data?: { error?: string } } };
    throw new Error(axiosErr.response?.data?.error || 'Failed to disconnect from MCP server');
  }
}

/**
 * Set MCP tool enabled status (per-tool approval)
 */
export async function setMcpToolEnabled(toolId: string, enabled: boolean): Promise<void> {
  try {
    await getClient().http.put(`/mcp/tools/${toolId}/enabled`, { enabled });
  } catch (err: unknown) {
    const axiosErr = err as { response?: { data?: { error?: string } } };
    throw new Error(axiosErr.response?.data?.error || 'Failed to update tool enabled status');
  }
}

/**
 * Execute an MCP tool
 */
export async function executeMcpTool(
  toolId: string,
  arguments_: Record<string, unknown>
): Promise<{ content: string; is_error: boolean }> {
  try {
    const { data } = await getClient().http.post(`/mcp/tools/${toolId}/execute`, { arguments: arguments_ });
    return data;
  } catch (err: unknown) {
    const axiosErr = err as { response?: { data?: { error?: string } } };
    throw new Error(axiosErr.response?.data?.error || 'Failed to execute MCP tool');
  }
}
