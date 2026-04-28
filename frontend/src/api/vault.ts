// API client for vault operations (API key management and vault locking)

import { getClient, getCurrentMode } from './client';

// API key types supported by the vault
export type ApiKeyType = 'anthropic' | 'openai' | 'netbox' | 'netdisco' | 'librenms' | 'smtp';

// Display-friendly labels for each API key type
export const API_KEY_LABELS: Record<ApiKeyType, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  netbox: 'NetBox',
  netdisco: 'Netdisco',
  librenms: 'LibreNMS',
  smtp: 'SMTP',
};

/**
 * Retrieve an API key from the vault.
 * Returns null if the key doesn't exist (404 response).
 */
export async function getApiKey(keyType: ApiKeyType): Promise<{ value: string } | null> {
  if (getCurrentMode() === 'enterprise') return null;
  try {
    const { data } = await getClient().http.get(`/vault/api-keys/${keyType}`);
    return data;
  } catch (err: unknown) {
    const axiosErr = err as { response?: { status?: number } };
    if (axiosErr.response?.status === 404) {
      return null;
    }
    throw new Error(`Failed to get ${API_KEY_LABELS[keyType]} API key`);
  }
}

/**
 * Store or update an API key in the vault.
 */
export async function storeApiKey(keyType: ApiKeyType, value: string): Promise<void> {
  if (getCurrentMode() === 'enterprise') throw new Error('Local vault is not available in enterprise mode');
  await getClient().http.put(`/vault/api-keys/${keyType}`, { value });
}

/**
 * Delete an API key from the vault.
 */
export async function deleteApiKey(keyType: ApiKeyType): Promise<void> {
  if (getCurrentMode() === 'enterprise') throw new Error('Local vault is not available in enterprise mode');
  await getClient().http.delete(`/vault/api-keys/${keyType}`);
}

/**
 * Lock the vault, requiring the master password to unlock again.
 */
export async function lockVault(): Promise<void> {
  if (getCurrentMode() === 'enterprise') throw new Error('Local vault is not available in enterprise mode');
  await getClient().http.post('/vault/lock');
}
