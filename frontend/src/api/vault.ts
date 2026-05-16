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

/**
 * Rotate the master password. Vault must be unlocked. Every stored
 * credential / token / API key / secure note is re-encrypted under the
 * new key atomically; on any failure the vault stays on the old password.
 */
export async function changeMasterPassword(
  oldPassword: string,
  newPassword: string,
): Promise<void> {
  if (getCurrentMode() === 'enterprise') throw new Error('Local vault is not available in enterprise mode');
  await getClient().http.put('/vault/password', {
    old_password: oldPassword,
    new_password: newPassword,
  });
}

/**
 * Wipe every vault-encrypted value and reset the master-password marker.
 * After this call vault_status reports has_master_password=false; the
 * caller can set a fresh password. Requires the current password.
 */
export async function wipeVault(confirmPassword: string): Promise<void> {
  if (getCurrentMode() === 'enterprise') throw new Error('Local vault is not available in enterprise mode');
  await getClient().http.post('/vault/wipe', {
    confirm_password: confirmPassword,
  });
}

// === Biometric (Touch ID) unlock ===

export interface BiometricStatus {
  /** Whether the running build supports biometric unlock (macOS today). */
  supported: boolean;
  /** Whether a keychain entry currently exists. */
  enrolled: boolean;
  /** User-facing toggle (only true when both setting=on AND keychain entry exists). */
  enabled: boolean;
}

const DISABLED_BIOMETRIC_STATUS: BiometricStatus = {
  supported: false,
  enrolled: false,
  enabled: false,
};

/**
 * Check whether Touch ID unlock is available on this device. Does NOT trigger
 * the biometric prompt — safe to call on any screen including the locked one.
 */
export async function getBiometricStatus(): Promise<BiometricStatus> {
  if (getCurrentMode() === 'enterprise') return DISABLED_BIOMETRIC_STATUS;
  try {
    const { data } = await getClient().http.get('/vault/biometric/status');
    return data;
  } catch {
    return DISABLED_BIOMETRIC_STATUS;
  }
}

/**
 * Enroll Touch ID: stores the master password in the OS keychain behind a
 * biometric access-control flag. Verifies the password by unlocking first.
 */
export async function enableBiometric(password: string): Promise<void> {
  if (getCurrentMode() === 'enterprise') {
    throw new Error('Biometric unlock is not available in enterprise mode');
  }
  await getClient().http.post('/vault/biometric/enable', { password });
}

/**
 * Unlock the vault using Touch ID. Triggers the system biometric prompt;
 * resolves on success, throws on cancel or failure (caller falls back to
 * password input).
 */
export async function unlockVaultWithBiometric(): Promise<void> {
  if (getCurrentMode() === 'enterprise') {
    throw new Error('Biometric unlock is not available in enterprise mode');
  }
  await getClient().http.post('/vault/biometric/unlock');
}

/**
 * Remove the biometric enrollment from this device.
 */
export async function disableBiometric(): Promise<void> {
  if (getCurrentMode() === 'enterprise') return;
  await getClient().http.delete('/vault/biometric');
}
