import { useState, useEffect, useCallback } from 'react';

// AI provider type (matches api/ai.ts)
export type AiProviderType = 'anthropic' | 'openai' | 'ollama' | 'openrouter' | 'litellm' | 'custom';

export interface AppSettings {
  // Appearance
  fontSize: number;
  fontFamily: string;

  // Terminal
  'terminal.defaultTheme': string;
  'terminal.copyOnSelect': boolean;
  'terminal.fontWeight': string;
  'terminal.lineNumbers': boolean;

  // AI Features
  'ai.inlineSuggestions': boolean;
  'ai.nextStepSuggestions': boolean;
  'ai.defaultProvider': AiProviderType;
  'ai.enabledProviders': AiProviderType[];

  // AI Copilot provider/model override (null = use default)
  'ai.copilot.provider': AiProviderType | null;
  'ai.copilot.model': string | null;

  // AI Tools - list of disabled tool names
  'ai.disabledTools': string[];

  // AI Context Management - limit conversation history to prevent context overflow
  'ai.maxConversationMessages': number;

  // Per-provider model lists - user-configured models for each provider
  'ai.models.anthropic': string[];
  'ai.models.openai': string[];
  'ai.models.openrouter': string[];
  'ai.models.ollama': string[];
  'ai.models.litellm': string[];
  'ai.models.custom': string[];

  // Per-provider max tokens (0 = no limit / use provider default)
  'ai.maxTokens.anthropic': number;
  'ai.maxTokens.openai': number;
  'ai.maxTokens.openrouter': number;
  'ai.maxTokens.ollama': number;
  'ai.maxTokens.litellm': number;
  'ai.maxTokens.custom': number;

  // AI Agent settings
  'ai.agent.provider': AiProviderType | null; // null = use default provider
  'ai.agent.model': string | null; // null = use default model for provider
  'ai.agent.temperature': number; // 0.0 - 1.0
  'ai.agent.maxTokens': number; // Max tokens per response
  'ai.agent.maxIterations': number; // Max ReAct loop iterations
  'ai.agent.systemPrompt': string; // Custom system prompt

  // AUDIT FIX (EXEC-002): `ai.allowConfigChanges` was removed in favour of
  // server-side state controlled via `enableAiConfigMode`/`disableAiConfigMode`
  // in `api/ai.ts`. Use the new `useAiConfigMode` hook instead of reading
  // this setting.

  // Detection (Phase 19)
  'detection.highlighting': boolean;

  // Command Safety (Phase 24)
  'commandSafety.enabled': boolean;

  // AUDIT FIX (REMOTE-002): `ssh.hostKeyChecking` removed. Strict host-key
  // checking is always on; per-session opt-in is the only escape hatch.
}

const defaultSettings: AppSettings = {
  // Appearance
  fontSize: 13,
  fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif",

  // Terminal
  'terminal.defaultTheme': 'default',
  'terminal.copyOnSelect': false,
  'terminal.fontWeight': 'normal',
  'terminal.lineNumbers': false,

  // AI Features
  'ai.inlineSuggestions': true,
  'ai.nextStepSuggestions': true,
  'ai.defaultProvider': 'anthropic',
  'ai.enabledProviders': ['anthropic'],

  // AI Copilot provider/model (null = use default provider)
  'ai.copilot.provider': null,
  'ai.copilot.model': null,

  // AI Tools - all enabled by default (empty array = no disabled tools)
  'ai.disabledTools': [],

  // AI Context Management - 0 means unlimited
  'ai.maxConversationMessages': 20,

  // Per-provider model lists - start empty, user adds their own
  'ai.models.anthropic': [],
  'ai.models.openai': [],
  'ai.models.openrouter': [],
  'ai.models.ollama': [],
  'ai.models.litellm': [],
  'ai.models.custom': [],

  // Per-provider max tokens (0 = no limit / use provider default)
  'ai.maxTokens.anthropic': 4096,
  'ai.maxTokens.openai': 4096,
  'ai.maxTokens.openrouter': 4096,
  'ai.maxTokens.ollama': 0,
  'ai.maxTokens.litellm': 4096,
  'ai.maxTokens.custom': 4096,

  // AI Agent settings
  'ai.agent.provider': null,
  'ai.agent.model': null,
  'ai.agent.temperature': 0.7,
  'ai.agent.maxTokens': 4096,
  'ai.agent.maxIterations': 15,
  'ai.agent.systemPrompt': 'You are a network automation assistant. You help users gather information from network devices using SSH commands. You have access to tools for querying devices and executing read-only commands. Be concise and focus on the task at hand.',

  // (AUDIT FIX EXEC-002) ai.allowConfigChanges removed — see above.

  // Detection (Phase 19)
  'detection.highlighting': true,

  // Command Safety (Phase 24)
  'commandSafety.enabled': true,

  // (AUDIT FIX REMOTE-002) ssh.hostKeyChecking removed — see above.
};

const STORAGE_KEY = 'netstacks-settings';

// Custom event for cross-component settings sync
export const SETTINGS_CHANGED_EVENT = 'netstacks:settingsChanged';

function loadSettings(): AppSettings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return { ...defaultSettings, ...JSON.parse(stored) };
    }
  } catch (e) {
    console.warn('Failed to load settings:', e);
  }
  return defaultSettings;
}

function saveSettings(settings: AppSettings): void {
  try {
    globalSettings = settings; // Keep singleton in sync for getSettings() callers
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    // Dispatch custom event to notify other hook instances
    window.dispatchEvent(new CustomEvent(SETTINGS_CHANGED_EVENT, { detail: settings }));
  } catch (e) {
    console.warn('Failed to save settings:', e);
  }
}

export function useSettings() {
  const [settings, setSettings] = useState<AppSettings>(loadSettings);

  // Listen for settings changes from other hook instances
  useEffect(() => {
    const handleSettingsChanged = (e: Event) => {
      const customEvent = e as CustomEvent<AppSettings>;
      setSettings(customEvent.detail);
    };
    window.addEventListener(SETTINGS_CHANGED_EVENT, handleSettingsChanged);
    return () => window.removeEventListener(SETTINGS_CHANGED_EVENT, handleSettingsChanged);
  }, []);

  // Save to localStorage when settings change (but don't trigger event recursively)
  const updateSetting = useCallback(<K extends keyof AppSettings>(
    key: K,
    value: AppSettings[K]
  ) => {
    setSettings(prev => {
      const newSettings = { ...prev, [key]: value };
      saveSettings(newSettings);
      return newSettings;
    });
  }, []);

  const resetSettings = useCallback(() => {
    setSettings(defaultSettings);
    saveSettings(defaultSettings);
  }, []);

  return {
    settings,
    updateSetting,
    resetSettings,
  };
}

// Singleton for non-hook access
let globalSettings: AppSettings = loadSettings();

export function getSettings(): AppSettings {
  return globalSettings;
}

export function setGlobalSettings(settings: AppSettings): void {
  globalSettings = settings;
  saveSettings(settings);
}
