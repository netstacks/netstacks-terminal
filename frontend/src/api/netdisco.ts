// API client for Netdisco source management
// Netdisco provides L2 topology discovery via CDP/LLDP neighbor data

import { getClient, getCurrentMode } from './client';

// Netdisco source configuration
export interface NetdiscoSource {
  id: string;
  name: string;
  url: string;
  auth_type: 'basic' | 'api_key';
  username: string | null;
  created_at: string;
  updated_at: string;
}

// Request to create a new Netdisco source
export interface NewNetdiscoSource {
  name: string;
  url: string;
  auth_type: 'basic' | 'api_key';
  username?: string;
  credential: string; // API key or password
}

// Request to update a Netdisco source
export interface UpdateNetdiscoSource {
  name?: string;
  url?: string;
  auth_type?: 'basic' | 'api_key';
  username?: string | null;
  credential?: string;
}

// Test connection response
export interface TestNetdiscoResponse {
  success: boolean;
  message: string;
}

// Netdisco device from API
export interface NetdiscoDevice {
  ip: string;
  dns?: string;
  name?: string;
  model?: string;
  os?: string;
  vendor?: string;
  serial?: string;
  contact?: string;
  location?: string;
  layers?: string;
  num_ports?: number;
  last_discover?: string;
}

// Netdisco neighbor/link from API
export interface NetdiscoNeighbor {
  local_ip: string;
  local_port: string;
  remote_ip: string;
  remote_port: string;
  remote_id?: string;
  remote_type?: string;
  protocol: string; // cdp, lldp, etc.
}

// Device link from report/devicelinks
export interface NetdiscoDeviceLink {
  left_ip: string;
  left_name?: string;
  left_port: string;
  right_ip: string;
  right_name?: string;
  right_port: string;
  protocol?: string;
}

// List all Netdisco sources
export async function listNetdiscoSources(): Promise<NetdiscoSource[]> {
  if (getCurrentMode() === 'enterprise') return [];
  const { data } = await getClient().http.get('/netdisco-sources');
  return data;
}

// Get a single Netdisco source by ID
export async function getNetdiscoSource(id: string): Promise<NetdiscoSource> {
  if (getCurrentMode() === 'enterprise') throw new Error('Netdisco sources are not available in enterprise mode');
  const { data } = await getClient().http.get(`/netdisco-sources/${id}`);
  return data;
}

// Create a new Netdisco source
export async function createNetdiscoSource(source: NewNetdiscoSource): Promise<NetdiscoSource> {
  if (getCurrentMode() === 'enterprise') throw new Error('Netdisco sources are not available in enterprise mode');
  try {
    const { data } = await getClient().http.post('/netdisco-sources', source);
    return data;
  } catch (err: unknown) {
    const axiosErr = err as { response?: { data?: { code?: string; error?: string } } };
    const responseData = axiosErr.response?.data;
    if (responseData?.code === 'VAULT_LOCKED') {
      throw new Error('Vault is locked. Go to Settings -> Security to unlock with your master password.');
    }
    throw new Error(responseData?.error || 'Failed to create Netdisco source');
  }
}

// Update an existing Netdisco source
export async function updateNetdiscoSource(id: string, update: UpdateNetdiscoSource): Promise<NetdiscoSource> {
  if (getCurrentMode() === 'enterprise') throw new Error('Netdisco sources are not available in enterprise mode');
  const { data } = await getClient().http.put(`/netdisco-sources/${id}`, update);
  return data;
}

// Delete a Netdisco source
export async function deleteNetdiscoSource(id: string): Promise<void> {
  if (getCurrentMode() === 'enterprise') throw new Error('Netdisco sources are not available in enterprise mode');
  await getClient().http.delete(`/netdisco-sources/${id}`);
}

// Test connection to an existing Netdisco source
export async function testNetdiscoSource(id: string): Promise<TestNetdiscoResponse> {
  if (getCurrentMode() === 'enterprise') return { success: false, message: 'Not available in enterprise mode' };
  try {
    const { data } = await getClient().http.post(`/netdisco-sources/${id}/test`);
    return data;
  } catch {
    return { success: false, message: 'Request failed' };
  }
}

// Test connection with URL and credentials (for new sources before creation)
export async function testNetdiscoConnection(
  url: string,
  authType: 'basic' | 'api_key',
  credential: string,
  username?: string
): Promise<TestNetdiscoResponse> {
  if (getCurrentMode() === 'enterprise') return { success: false, message: 'Not available in enterprise mode' };
  try {
    const { data } = await getClient().http.post('/netdisco/test', {
      url,
      auth_type: authType,
      username,
      credential,
    });
    return data;
  } catch {
    return { success: false, message: 'Request failed' };
  }
}

// Get all devices from Netdisco
export async function getNetdiscoDevices(sourceId: string): Promise<NetdiscoDevice[]> {
  if (getCurrentMode() === 'enterprise') return [];
  const { data } = await getClient().http.get(`/netdisco-sources/${sourceId}/devices`);
  return data;
}

// Get neighbors for a specific device
export async function getNetdiscoNeighbors(sourceId: string, deviceIp: string): Promise<NetdiscoNeighbor[]> {
  if (getCurrentMode() === 'enterprise') return [];
  const { data } = await getClient().http.get(`/netdisco-sources/${sourceId}/devices/${encodeURIComponent(deviceIp)}/neighbors`);
  return data;
}

// Get all device links (CDP/LLDP discovered connections)
export async function getNetdiscoDeviceLinks(sourceId: string): Promise<NetdiscoDeviceLink[]> {
  if (getCurrentMode() === 'enterprise') return [];
  const { data } = await getClient().http.get(`/netdisco-sources/${sourceId}/devicelinks`);
  return data;
}

// Search for devices by name/IP
export async function searchNetdiscoDevices(sourceId: string, query: string): Promise<NetdiscoDevice[]> {
  if (getCurrentMode() === 'enterprise') return [];
  const { data } = await getClient().http.get(`/netdisco-sources/${sourceId}/search`, {
    params: { q: query },
  });
  return data;
}
