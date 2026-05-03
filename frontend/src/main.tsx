import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import './index.css';
import App from './App.tsx';
import VaultUnlockGate from './components/VaultUnlockGate';
import HostKeyPromptModal from './components/HostKeyPromptModal';
import TaskApprovalModal from './components/TaskApprovalModal';
import { TokenUsageProvider } from './contexts/TokenUsageContext';
import { initializeClient } from './api/client';
import { setSidecarAuthToken } from './api/localClient';
import { useCapabilitiesStore } from './stores/capabilitiesStore';
import PopoutTerminal from './components/PopoutTerminal';
import SharedTerminal from './components/SharedTerminal';

// Use locally bundled Monaco instead of CDN (required for Tauri CSP)
loader.config({ monaco });

// Configure Monaco web workers for Vite
// @ts-ignore - self.MonacoEnvironment is a global Monaco config
self.MonacoEnvironment = {
  getWorker(_: string, label: string) {
    if (label === 'json') {
      return new Worker(
        new URL('monaco-editor/esm/vs/language/json/json.worker.js', import.meta.url),
        { type: 'module' }
      );
    }
    if (label === 'xml') {
      return new Worker(
        new URL('monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url),
        { type: 'module' }
      );
    }
    return new Worker(
      new URL('monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url),
      { type: 'module' }
    );
  },
};

// Create TanStack Query client with sensible defaults
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000, // 5 minutes
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

// Bootstrap sidecar auth token (shared between main app and popout windows)
async function bootstrapSidecarToken() {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const { listen } = await import('@tauri-apps/api/event');

    const MAX_ATTEMPTS = 50;
    const POLL_INTERVAL_MS = 100;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const token = await invoke<string | null>('get_sidecar_token');
      if (token) {
        setSidecarAuthToken(token);
        console.log('[main] Sidecar auth token retrieved via IPC');
        break;
      }
      if (i < MAX_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      } else {
        console.warn('[main] Sidecar auth token not available after polling, continuing without');
      }
    }

    await listen<string>('sidecar-auth-token', (event) => {
      setSidecarAuthToken(event.payload);
    });
  } catch {
    // Not in Tauri — check URL param for testing (e.g. ?token=xxx)
    const urlToken = new URLSearchParams(window.location.search).get('token');
    if (urlToken) {
      setSidecarAuthToken(urlToken);
      console.log('[main] Auth token loaded from URL parameter (test mode)');
    } else {
      console.log('[main] Not in Tauri environment, skipping sidecar token');
    }
  }
}

// Bootstrap a popout terminal window (minimal startup — no full app init)
async function bootstrapPopout(params: URLSearchParams) {
  await bootstrapSidecarToken();
  await initializeClient();

  // NOTE: StrictMode intentionally double-invokes effects in dev to surface
  // non-idempotent side effects, but every SSH connect / SNMP poll / WS
  // subscribe in this app fires from useEffect — so dev runs were doubling
  // every real network call (and Peter's sshd was getting hammered). Prod
  // builds don't double-invoke regardless, so removing StrictMode here is
  // a dev-mode-only behavior change.
  createRoot(document.getElementById('root')!).render(
    <PopoutTerminal params={params} />
  );
}

// Bootstrap the full application
async function bootstrap() {
  await bootstrapSidecarToken();

  const result = await initializeClient();
  console.log(`[main] App mode: ${result.mode}, requires auth: ${result.requiresAuth}`);

  // In standalone mode, wait for the TLS cert to be installed into the OS trust
  // store before making any API calls. Tauri emits 'sidecar-tls-ready' once done.
  // Enterprise mode skips this — no local agent, no cert to install.
  if (result.mode === 'standalone') {
    // Skip outside Tauri (dev/test): @tauri-apps/api throws synchronously
    // if window.__TAURI_INTERNALS__ is undefined, and the rejection from
    // listen() inside the Promise executor below is unhandled — it would
    // surface as a pageerror. The cert wait is irrelevant in dev anyway.
    const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
    if (inTauri) {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        await Promise.race([
          new Promise<void>(resolve => {
            // Catch the listen() rejection so it doesn't escape as an unhandled rejection.
            listen('sidecar-tls-ready', () => resolve()).catch(() => resolve());
          }),
          new Promise<void>(resolve => setTimeout(resolve, 3000)),
        ]);
      } catch {
        // Not in Tauri (dev/test) — proceed immediately
      }
    }
  }

  // Populate capabilities before the app renders so all sidebar tabs are visible.
  // In standalone mode this resolves synchronously with STANDALONE_CAPABILITIES;
  // in enterprise mode it fetches from the Controller after login instead.
  if (result.mode !== 'enterprise') {
    await useCapabilitiesStore.getState().fetchCapabilities();
  }

  // See note in bootstrapPopout: StrictMode removed to stop dev double-fire
  // of network-bearing effects (SSH/SNMP/WebSockets).
  createRoot(document.getElementById('root')!).render(
    <QueryClientProvider client={queryClient}>
      <TokenUsageProvider>
        <VaultUnlockGate>
          <App />
          {/* AUDIT FIX (REMOTE-001): always-mounted modal that surfaces
              pending SSH host-key fingerprint prompts. */}
          <HostKeyPromptModal />
          {/* AUDIT FIX (EXEC-017): per-tool-call approval modal for
              background ReAct tasks. */}
          <TaskApprovalModal />
        </VaultUnlockGate>
      </TokenUsageProvider>
    </QueryClientProvider>
  );
}

// Bootstrap a shared terminal view (no auth, minimal UI)
function bootstrapShared(shareToken: string) {
  // Derive controller URL from current page URL
  // The share URL format is: {controller_url}/#share={token} or {controller_url}/terminal#share={token}
  const controllerUrl = window.location.origin;

  // See note in bootstrapPopout: StrictMode removed to stop dev double-fire.
  createRoot(document.getElementById('root')!).render(
    <SharedTerminal token={shareToken} controllerUrl={controllerUrl} />
  );
}

// Detect shared mode from URL fragment, popout window, or start full app
const params = new URLSearchParams(window.location.search);

// Check for #share={token} in URL fragment
const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
const shareToken = hashParams.get('share');

const startFn = shareToken
  ? () => { bootstrapShared(shareToken); return Promise.resolve(); }
  : params.get('popout') === 'true'
    ? () => bootstrapPopout(params)
    : bootstrap;

startFn().catch((error) => {
  console.error('[main] Failed to initialize app:', error);
  document.getElementById('root')!.innerHTML = `
    <div style="
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100vh;
      background: #1e1e1e;
      color: #cccccc;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    ">
      <h1>Failed to Start</h1>
      <p style="color: #f44336;">Error: ${error.message}</p>
      <p>Please restart the application.</p>
    </div>
  `;
});
