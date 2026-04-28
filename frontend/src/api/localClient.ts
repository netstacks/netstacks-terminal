import axios from 'axios';
import type { NetStacksClient } from '../types/api';
import { appendTokenToWsUrl } from './wsHelpers';

// Standalone mode connects to local agent on localhost:8080
const LOCAL_AGENT_URL = 'http://localhost:8080';

// Auth token for standalone mode - set by Tauri event, never persisted
let sidecarAuthToken: string | null = null;

export function setSidecarAuthToken(token: string): void {
  sidecarAuthToken = token;
  console.log('[LocalClient] Auth token set');
}

export function getSidecarAuthToken(): string | null {
  return sidecarAuthToken;
}

/**
 * Create API client for standalone Personal Mode (local agent).
 * Auth token set by Tauri event at startup.
 * Personal Mode is open-source and full-featured — no tier gating.
 */
export function createLocalClient(): NetStacksClient {
  const http = axios.create({
    baseURL: `${LOCAL_AGENT_URL}/api`,
    headers: {
      'Content-Type': 'application/json',
    },
    timeout: 30000, // 30 second timeout
  });

  // Add request interceptor for auth token
  http.interceptors.request.use((config) => {
    const token = getSidecarAuthToken();
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  });

  // Add response interceptor for error logging
  http.interceptors.response.use(
    (response) => response,
    (error) => {
      console.error('[LocalClient] API error:', error.message);
      return Promise.reject(error);
    }
  );

  return {
    http,
    mode: 'standalone',
    hasEnterpriseFeatures: false,
    baseUrl: LOCAL_AGENT_URL,

    wsUrl(path: string): string {
      const base = `ws://localhost:8080${path}`;
      const token = getSidecarAuthToken();
      return token ? appendTokenToWsUrl(base, token) : base;
    },

    wsUrlWithAuth(path: string): string {
      // In standalone mode wsUrl already includes the token
      return this.wsUrl(path);
    },
  };
}
