import { loadAppConfig, getAppMode } from '../lib/appConfig';
import type { NetStacksClient, ClientInitResult } from '../types/api';
import type { AppMode } from '../types/config';
import { createLocalClient } from './localClient';
import { createControllerClient } from './controllerClient';

// Singleton client instance
let clientInstance: NetStacksClient | null = null;
let currentMode: AppMode | null = null;

/**
 * Initialize the API client based on app configuration.
 * Must be called once at app startup before any API calls.
 *
 * @returns Client instance and initialization info
 */
export async function initializeClient(): Promise<ClientInitResult> {
  if (clientInstance) {
    console.log('[client] Already initialized, returning existing client');
    return {
      client: clientInstance,
      mode: currentMode!,
      requiresAuth: currentMode === 'enterprise',
    };
  }

  // Load configuration to determine mode
  const config = await loadAppConfig();
  currentMode = getAppMode(config);

  console.log('[client] Initializing in mode:', currentMode);

  if (currentMode === 'enterprise' && config.controllerUrl) {
    console.log('[client] Creating Controller client for:', config.controllerUrl);
    clientInstance = createControllerClient(config.controllerUrl);

    // Informational health check — logs connectivity status for debugging
    // Does NOT block initialization; app still loads regardless
    clientInstance.http.get('../health').catch((err: unknown) => {
      const error = err as { code?: string; message?: string };
      console.error(
        `[client] Failed to connect to Controller at ${config.controllerUrl} — check URL and certificate configuration`,
        error.code || error.message || ''
      );
    });
  } else {
    console.log('[client] Creating Local Agent client (standalone mode)');
    clientInstance = createLocalClient();
  }

  return {
    client: clientInstance,
    mode: currentMode,
    requiresAuth: currentMode === 'enterprise',
  };
}

/**
 * Get the initialized API client.
 * Throws if called before initializeClient().
 */
export function getClient(): NetStacksClient {
  if (!clientInstance) {
    throw new Error(
      'API client not initialized. Call initializeClient() at app startup.'
    );
  }
  return clientInstance;
}

/**
 * Check if client has been initialized.
 */
export function isClientInitialized(): boolean {
  return clientInstance !== null;
}

/**
 * Get current app mode.
 * Returns null if client not initialized.
 */
export function getCurrentMode(): AppMode | null {
  return currentMode;
}

/**
 * Reset client (for testing only).
 * App must be restarted after mode change.
 * IMPORTANT: This function is restricted to test environment only
 * to prevent runtime mode switching (AUTH-06).
 */
export function _resetClientForTesting(): void {
  if (import.meta.env.MODE !== 'test') {
    throw new Error('resetClient is only available in test environment — mode changes require app restart');
  }
  clientInstance = null;
  currentMode = null;
}

// Re-export types for convenience
export type { NetStacksClient, ClientInitResult } from '../types/api';
export type { AppMode } from '../types/config';
