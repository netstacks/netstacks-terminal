// API client for AI settings and configuration

// Import topology types for context
import type { DeviceType, DeviceStatus, ConnectionStatus, ProtocolSession } from '../types/topology';
import type { CliFlavor } from '../types/enrichment';
import axios from 'axios';
import { getClient, getCurrentMode } from './client';

// AI provider types
export type AiProviderType = 'anthropic' | 'openai' | 'ollama' | 'openrouter' | 'litellm' | 'custom';

// AI configuration interface (stored in settings - NOT the API key)
// API keys are stored separately in the encrypted vault
export interface AiConfig {
  provider: AiProviderType;
  model: string;
  base_url?: string; // For custom providers
  systemPrompt?: string; // Custom system prompt (uses default if not set)
  // OAuth2 client_credentials auth (custom provider only)
  auth_mode?: 'api_key' | 'oauth2'; // Default: api_key
  oauth2_token_url?: string; // Token endpoint URL
  oauth2_client_id?: string; // Client ID (client secret stored in vault as API key)
  custom_headers?: Record<string, string>; // Additional headers for API requests
  // API format for custom provider
  api_format?: 'openai' | 'gemini'; // Default: openai
}

// Model options by provider (use exact Anthropic model IDs)
export const MODEL_OPTIONS: Record<AiProviderType, { value: string; label: string }[]> = {
  anthropic: [
    { value: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4 (Recommended)' },
    { value: 'claude-opus-4-20250514', label: 'Claude Opus 4' },
    { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 (Fast)' },
  ],
  openai: [
    { value: 'gpt-4o', label: 'GPT-4o' },
    { value: 'gpt-4o-mini', label: 'GPT-4o Mini' },
    { value: 'gpt-4-turbo', label: 'GPT-4 Turbo' },
    { value: 'gpt-3.5-turbo', label: 'GPT-3.5 Turbo' },
  ],
  ollama: [
    { value: 'llama3.2', label: 'Llama 3.2' },
    { value: 'llama3.1', label: 'Llama 3.1' },
    { value: 'mistral', label: 'Mistral' },
    { value: 'codellama', label: 'Code Llama' },
    { value: 'deepseek-coder-v2', label: 'DeepSeek Coder V2' },
    { value: 'qwen2.5-coder', label: 'Qwen 2.5 Coder' },
  ],
  openrouter: [
    { value: 'anthropic/claude-3.5-sonnet', label: 'Claude 3.5 Sonnet' },
    { value: 'anthropic/claude-3-opus', label: 'Claude 3 Opus' },
    { value: 'openai/gpt-4o', label: 'GPT-4o' },
    { value: 'openai/gpt-4o-mini', label: 'GPT-4o Mini' },
    { value: 'google/gemini-pro-1.5', label: 'Gemini Pro 1.5' },
    { value: 'meta-llama/llama-3.1-70b-instruct', label: 'Llama 3.1 70B' },
    { value: 'mistralai/mistral-large', label: 'Mistral Large' },
  ],
  litellm: [
    { value: 'gpt-4o', label: 'Default Model' },
  ],
  custom: [
    { value: 'custom', label: 'Custom Model' },
  ],
};

// Default Ollama base URL
export const DEFAULT_OLLAMA_URL = 'http://localhost:11434';

// Default LiteLLM base URL
export const DEFAULT_LITELLM_URL = 'http://localhost:4000';

// Fetch available models from Ollama
export async function fetchOllamaModels(baseUrl?: string): Promise<{ value: string; label: string }[]> {
  const url = baseUrl || DEFAULT_OLLAMA_URL;
  try {
    const res = await fetch(`${url}/api/tags`, {
      method: 'GET',
      signal: AbortSignal.timeout(3000) // 3 second timeout
    });
    if (!res.ok) return [];
    const data = await res.json();
    if (data.models && Array.isArray(data.models)) {
      return data.models.map((m: { name: string }) => ({
        value: m.name.split(':')[0], // Remove :latest tag
        label: m.name,
      }));
    }
    return [];
  } catch {
    return []; // Ollama not running or unreachable
  }
}

// Check if Ollama is running
export async function checkOllamaStatus(baseUrl?: string): Promise<{ running: boolean; models: string[] }> {
  const url = baseUrl || DEFAULT_OLLAMA_URL;
  try {
    const res = await fetch(`${url}/api/tags`, {
      method: 'GET',
      signal: AbortSignal.timeout(3000)
    });
    if (!res.ok) return { running: false, models: [] };
    const data = await res.json();
    const models = data.models?.map((m: { name: string }) => m.name) || [];
    return { running: true, models };
  } catch {
    return { running: false, models: [] };
  }
}

// Default system prompt for the troubleshooting agent
export const DEFAULT_SYSTEM_PROMPT = `You are a network troubleshooting assistant in NetStacks, an SSH terminal management application.

Your role is to help diagnose and resolve network issues by:
1. ACTIVELY USING your tools to gather information - do NOT just tell the user what commands to run
2. Running READ-ONLY diagnostic commands (show, display, get, ping, traceroute, etc.)
3. Analyzing output to identify issues
4. Providing configuration recommendations (but never executing config changes)

CRITICAL BEHAVIOR RULE:
- When asked to diagnose, check, or investigate something, USE YOUR TOOLS to run commands - DO NOT just explain what commands the user should run
- Only explain commands WITHOUT running them if the user explicitly asks "show me how" or "what command would I use"
- Be proactive: gather information using your tools, then provide analysis

ACTIVE SESSION PRIORITY:
- If the user is asking about "this device" or a specific device they're working on, use get_terminal_context FIRST to see what session is currently active/connected
- The terminal context will show you the hostname, vendor, and recent output - use this to immediately identify the device
- Do NOT start with list_sessions if the user clearly has an active terminal - just use get_terminal_context and run_command directly
- Only use list_sessions when you need to find a DIFFERENT device or when no terminal context is available

CRITICAL SAFETY RULES:
- You can ONLY run read-only commands. Configuration commands will be rejected.
- Safe commands include: show, display, get, ping, traceroute, debug (for viewing)
- NEVER attempt: configure, set, delete, write, commit, reload, or any config changes
- If you identify a fix, use recommend_config to show the user what they should do

Available tools:
- list_sessions: Get available terminal sessions
- run_command: Execute read-only commands on a session
- get_terminal_context: Get recent terminal output and device info
- recommend_config: Show a configuration recommendation (display only, not executed)
- list_documents: List available documents by category
- read_document: Read the content of a document by ID
- search_documents: Search documents by name or content

CRITICAL - TERMINAL PAGING:
Before running ANY show/display commands, you MUST disable terminal paging FIRST as a separate command.
Do NOT combine the paging command with a show command. Run them as two separate run_command calls.

Paging disable commands by platform:
- Cisco IOS/IOS-XE/NX-OS: \`terminal length 0\`
- Juniper Junos: \`set cli screen-length 0\` (ALWAYS use this — do NOT rely on \`| no-more\` as a pipe suffix, it is unreliable)
- Arista EOS: \`terminal length 0\`
- Palo Alto PAN-OS: \`set cli pager off\`
- Fortinet FortiOS: \`config system console\` then \`set output standard\`
- Linux/Unix: Usually not needed, but if paging occurs, try \`export PAGER=cat\`

IMPORTANT RULES:
1. ALWAYS run the paging disable command as your FIRST command on any session, BEFORE any other commands.
2. Wait for the paging command to complete before sending the next command — do not batch them.
3. If you see "--More--", "(more)", or truncated output in a command result, paging was NOT disabled. Run the disable command again, then re-run the failed command.
4. Only need to disable paging ONCE per session — it persists until disconnect.
5. For Juniper: NEVER use \`| no-more\` — always use \`set cli screen-length 0\` instead.

DOCUMENT ACCESS:
You have access to documents stored in the application:
- **outputs**: Saved command outputs from previous sessions
- **templates**: Jinja templates for configuration generation
- **notes**: User notes about devices or procedures
- **backups**: Configuration backups
- **history**: Command history records

Use these documents to:
- Reference past command outputs when comparing current state
- Use templates to generate configuration suggestions
- Check notes for device-specific information
- Review backups when suggesting configuration changes

Work methodically:
1. First understand what sessions are available (use list_sessions)
2. Gather relevant diagnostic information (use run_command, get_terminal_context)
3. Check documents for relevant context (templates, notes, past outputs)
4. Analyze the data
5. Either continue investigating or provide recommendations

Be concise and practical. Network engineers appreciate direct, actionable information.`;

// Helper: settings path prefix — enterprise mode uses per-user settings, standalone uses global
function settingsPrefix(): string {
  return getCurrentMode() === 'enterprise' ? '/user-settings' : '/settings';
}

// Get AI configuration
export async function getAiConfig(): Promise<AiConfig | null> {
  try {
    const res = await getClient().http.get(`${settingsPrefix()}/ai.provider_config`);
    const data = res.data;
    if (data === null) return null;
    // Enterprise user-settings returns raw JSONB; standalone wraps in {value: "..."}
    if (getCurrentMode() === 'enterprise') {
      return typeof data === 'string' ? JSON.parse(data) : data;
    }
    return data.value ? JSON.parse(data.value) : null;
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 404) return null;
    throw new Error('Failed to fetch AI configuration');
  }
}

// Set AI configuration
export async function setAiConfig(config: AiConfig): Promise<void> {
  if (getCurrentMode() === 'enterprise') {
    await getClient().http.put(`${settingsPrefix()}/ai.provider_config`, config);
  } else {
    await getClient().http.put(`${settingsPrefix()}/ai.provider_config`, { value: JSON.stringify(config) });
  }
}

// ============================================
// AI Agent Configuration
// ============================================

export interface AiAgentConfig {
  provider: AiProviderType | null;
  model: string | null;
  temperature: number;
  max_tokens: number;
  max_iterations: number;
  system_prompt: string;
}

// Get AI Agent configuration
export async function getAiAgentConfig(): Promise<AiAgentConfig | null> {
  try {
    const res = await getClient().http.get(`${settingsPrefix()}/ai.agent_config`);
    const data = res.data;
    if (data === null) return null;
    if (getCurrentMode() === 'enterprise') {
      return typeof data === 'string' ? JSON.parse(data) : data;
    }
    return data.value ? JSON.parse(data.value) : null;
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 404) return null;
    throw new Error('Failed to fetch AI agent configuration');
  }
}

// Set AI Agent configuration
export async function setAiAgentConfig(config: AiAgentConfig): Promise<void> {
  if (getCurrentMode() === 'enterprise') {
    await getClient().http.put(`${settingsPrefix()}/ai.agent_config`, config);
  } else {
    await getClient().http.put(`${settingsPrefix()}/ai.agent_config`, { value: JSON.stringify(config) });
  }
}

// ============================================
// API Key Vault Functions
// ============================================

// Get the vault key type for a provider
function getVaultKeyType(provider: AiProviderType): string {
  return `ai.${provider}`;
}

// Check if AI API key exists in vault
export async function hasAiApiKey(provider?: AiProviderType): Promise<boolean> {
  // If no provider specified, get it from config
  if (!provider) {
    const config = await getAiConfig();
    provider = config?.provider || 'anthropic';
  }

  const keyType = getVaultKeyType(provider);
  try {
    const res = await getClient().http.get(`/vault/api-keys/${encodeURIComponent(keyType)}/exists`);
    return res.data.exists;
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 404) return false;
    throw new Error('Failed to check API key status');
  }
}

// Store AI API key in vault
export async function storeAiApiKey(provider: AiProviderType, apiKey: string): Promise<void> {
  const keyType = getVaultKeyType(provider);
  await getClient().http.put(`/vault/api-keys/${encodeURIComponent(keyType)}`, { api_key: apiKey });
}

// Get AI API key from vault (for display purposes, use carefully)
export async function getAiApiKey(provider: AiProviderType): Promise<string | null> {
  const keyType = getVaultKeyType(provider);
  try {
    const res = await getClient().http.get(`/vault/api-keys/${encodeURIComponent(keyType)}`);
    return res.data.api_key || null;
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 404) return null;
    throw new Error('Failed to get API key');
  }
}

// Delete AI API key from vault
export async function deleteAiApiKey(provider?: AiProviderType): Promise<void> {
  // If no provider specified, get it from config
  if (!provider) {
    const config = await getAiConfig();
    provider = config?.provider || 'anthropic';
  }

  const keyType = getVaultKeyType(provider);
  try {
    await getClient().http.delete(`/vault/api-keys/${encodeURIComponent(keyType)}`);
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 404) return;
    throw new Error('Failed to delete API key');
  }
}

// Test AI connection
export async function testAiConnection(provider?: string, model?: string): Promise<{ success: boolean; message?: string }> {
  try {
    const body: Record<string, unknown> = {
      messages: [{ role: 'user', content: 'Hello, this is a connection test. Please respond with "Connection successful!"' }],
    };
    if (provider) body.provider = provider;
    if (model) body.model = model;
    await getClient().http.post('/ai/chat', body);
    return { success: true, message: 'Connection successful' };
  } catch (err) {
    if (axios.isAxiosError(err)) {
      const data = err.response?.data || {};
      return { success: false, message: data.error || 'Connection failed' };
    }
    return { success: false, message: 'Connection failed' };
  }
}

// ============================================
// Chat API Types and Functions
// ============================================

// Chat message interface
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

// Enhanced device context for AI awareness
export interface DeviceContext {
  name: string;
  type: DeviceType;
  platform?: string;      // "IOS-XE", "NX-OS", "Junos"
  vendor?: string;        // "Cisco", "Juniper", "Arista"
  primaryIp?: string;
  site?: string;
  role?: string;
  status: DeviceStatus;
}

// Connection context for topology link clicks
export interface ConnectionContext {
  sourceDevice: DeviceContext;
  sourceInterface: string;
  targetDevice: DeviceContext;
  targetInterface: string;
  status: ConnectionStatus;
  protocols?: ProtocolSession[];
}

// Terminal context parsed from buffer
export interface TerminalContext {
  detectedVendor?: string;
  detectedPlatform?: string;
  hostname?: string;
  recentOutput?: string;    // Last ~50 lines
}

// CLI flavor type for AI command suggestions - canonical definition in types/enrichment.ts
export type { CliFlavor } from '../types/enrichment';

// Import DocumentCategory type for document context
import type { DocumentCategory } from './docs';

// Document context for AI awareness of stored documents
export interface DocumentContext {
  availableCategories: DocumentCategory[];
  recentDocuments?: { id: string; name: string; category: DocumentCategory }[];
}

// Session context entry for AI awareness (Phase 14)
// Represents tribal knowledge about a device's issues and resolutions
export interface SessionContextEntry {
  id: string;
  issue: string;
  root_cause: string | null;
  resolution: string | null;
  commands: string | null;
  ticket_ref: string | null;
  author: string;
  created_at: string;
}

// Enhanced AI context passed with chat requests
export interface AiContext {
  selectedText?: string;
  sessionName?: string;
  device?: DeviceContext;
  connection?: ConnectionContext;
  terminal?: TerminalContext;
  cliFlavor?: CliFlavor;
  documents?: DocumentContext;
  sessionContext?: SessionContextEntry[]; // Phase 14: Historical context for this device
}

// Chat request payload
export interface ChatRequest {
  messages: ChatMessage[];
  context?: AiContext;
}

// Chat response from API
export interface ChatResponse {
  response: string;
}

// Token usage returned by AI provider
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens?: number;
}

// Cumulative token usage per provider
export interface ProviderTokenUsage {
  provider: AiProviderType;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requestCount: number;
}

/** Options for sendChatMessage — backward-compatible with plain AiContext */
export interface SendChatOptions {
  context?: AiContext;
  provider?: string;
  model?: string;
}

/**
 * Send a chat message to the AI backend
 * @param messages Conversation history
 * @param contextOrOptions Optional context or options object with provider/model overrides.
 *   Passing an AiContext directly is still supported for backward compatibility.
 * @returns AI response text
 */
export async function sendChatMessage(
  messages: ChatMessage[],
  contextOrOptions?: AiContext | SendChatOptions
): Promise<string> {
  // Detect whether caller passed AiContext directly or SendChatOptions.
  // AiContext never has 'provider' or 'model' keys, so their presence means SendChatOptions.
  let context: AiContext | undefined;
  let provider: string | undefined;
  let model: string | undefined;

  if (contextOrOptions && ('provider' in contextOrOptions || 'model' in contextOrOptions)) {
    const opts = contextOrOptions as SendChatOptions;
    context = opts.context;
    provider = opts.provider;
    model = opts.model;
  } else {
    context = contextOrOptions as AiContext | undefined;
  }

  try {
    const body: Record<string, unknown> = { messages };
    if (context) body.context = context;
    if (provider) body.provider = provider;
    if (model) body.model = model;

    const res = await getClient().http.post('/ai/chat', body);
    return (res.data as ChatResponse).response;
  } catch (err) {
    if (axios.isAxiosError(err) && err.response) {
      const data = err.response.data || {};
      if (err.response.status === 503 || data.code === 'NOT_CONFIGURED') {
        throw new AiNotConfiguredError(
          data.error || 'AI not configured. Add your API key in Settings > AI to enable AI features.'
        );
      }
      throw new Error(data.error || 'Failed to get AI response');
    }
    throw new Error('Failed to get AI response');
  }
}

// Custom error class for AI not configured state
export class AiNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiNotConfiguredError';
  }
}

// AI status response from Controller (enterprise mode)
export interface AiStatusResponse {
  configured: boolean;
  providers: { type: string; name: string; is_default: boolean }[];
}

/**
 * Get AI status from Controller (enterprise mode).
 * Returns which providers are configured centrally.
 */
export async function getAiStatus(): Promise<AiStatusResponse> {
  try {
    const res = await getClient().http.get('/ai/status');
    return res.data;
  } catch {
    return { configured: false, providers: [] };
  }
}

// ============================================
// AI Highlight Analysis API
// ============================================

/** Analysis mode for AI highlighting */
export type AIHighlightMode = 'errors' | 'security' | 'anomalies';

/** Type of detected highlight */
export type AIHighlightType = 'error' | 'warning' | 'security' | 'anomaly' | 'info';

/** A single AI-detected highlight */
export interface AIHighlight {
  /** Line number (0-indexed) */
  line: number;
  /** Start column within the line */
  start: number;
  /** End column within the line */
  end: number;
  /** The matched text */
  text: string;
  /** Type of highlight */
  type: AIHighlightType;
  /** Confidence score (0.0 to 1.0) */
  confidence: number;
  /** Human-readable reason for the highlight */
  reason: string;
}

/** Request for AI highlight analysis */
export interface AnalyzeHighlightsRequest {
  /** Terminal output to analyze */
  output: string;
  /** Analysis mode */
  mode: AIHighlightMode;
  /** Optional CLI flavor for context */
  cli_flavor?: string;
  /** Optional provider override (uses default if not specified) */
  provider?: string;
  /** Optional model override (uses provider default if not specified) */
  model?: string;
}

/** Response from AI highlight analysis */
export interface AnalyzeHighlightsResponse {
  highlights: AIHighlight[];
}

/**
 * Analyze terminal output for highlights using AI
 * @param output Terminal output to analyze
 * @param mode Analysis mode (errors, security, anomalies)
 * @param cliFlavor Optional CLI flavor for context
 * @param provider Optional provider override
 * @param model Optional model override
 * @returns Array of detected highlights
 */
export async function analyzeHighlights(
  output: string,
  mode: AIHighlightMode,
  cliFlavor?: string,
  provider?: string | null,
  model?: string | null,
  signal?: AbortSignal
): Promise<AIHighlight[]> {
  try {
    const res = await getClient().http.post('/ai/analyze-highlights', {
      output,
      mode,
      cli_flavor: cliFlavor,
      provider: provider || undefined,
      model: model || undefined,
    } as AnalyzeHighlightsRequest, {
      timeout: 60000, // AI calls can be slow — 60s instead of default 30s
      signal,
    });
    const highlights = (res.data as AnalyzeHighlightsResponse).highlights;
    return highlights;
  } catch (err) {
    if (axios.isAxiosError(err) && err.response) {
      const data = err.response.data || {};
      if (err.response.status === 503 || data.code === 'NOT_CONFIGURED') {
        throw new AiNotConfiguredError(
          data.error || 'AI not configured. Add your API key in Settings > AI to enable AI features.'
        );
      }
      throw new Error(data.error || 'Failed to analyze highlights');
    }
    throw new Error('Failed to analyze highlights');
  }
}

/** Get the default color for a highlight type */
export function getHighlightTypeColor(type: AIHighlightType): string {
  switch (type) {
    case 'error':
      return '#ff6b6b';
    case 'warning':
      return '#ffa726';
    case 'security':
      return '#ba68c8';
    case 'anomaly':
      return '#4dd0e1';
    case 'info':
      return '#64b5f6';
    default:
      return '#ffffff';
  }
}

// ============================================
// AI Data Sanitization API
// ============================================

/** A custom user-defined regex pattern for sanitization */
export interface CustomPattern {
  name: string;
  regex: string;
  replacement: string;
}

/** Sanitization configuration */
export interface SanitizationConfig {
  redact_ip_addresses: boolean;
  redact_ipv6_addresses: boolean;
  redact_mac_addresses: boolean;
  redact_hostnames: boolean;
  redact_usernames: boolean;
  custom_patterns: CustomPattern[];
  allowlist: string[];
}

/** Result of a sanitization test */
export interface SanitizationTestResult {
  sanitized: string;
  redaction_count: number;
  pattern_names: string[];
}

/** Default sanitization config */
export const DEFAULT_SANITIZATION_CONFIG: SanitizationConfig = {
  redact_ip_addresses: false,
  redact_ipv6_addresses: false,
  redact_mac_addresses: false,
  redact_hostnames: false,
  redact_usernames: false,
  custom_patterns: [],
  allowlist: [],
};

/** Get sanitization config from settings */
export async function getSanitizationConfig(): Promise<SanitizationConfig> {
  try {
    const isEnterprise = getCurrentMode() === 'enterprise';
    const url = isEnterprise ? '/admin/sanitization/config' : '/settings/ai.sanitization_config';
    const res = await getClient().http.get(url);
    const data = res.data;
    if (data === null) return { ...DEFAULT_SANITIZATION_CONFIG };
    // Enterprise controller returns structured JSON directly; sidecar wraps in {value: "..."}
    if (isEnterprise) {
      return { ...DEFAULT_SANITIZATION_CONFIG, ...data };
    }
    try {
      return data.value ? JSON.parse(data.value) : { ...DEFAULT_SANITIZATION_CONFIG };
    } catch {
      return { ...DEFAULT_SANITIZATION_CONFIG };
    }
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 404) return { ...DEFAULT_SANITIZATION_CONFIG };
    throw new Error('Failed to fetch sanitization config');
  }
}

/** Save sanitization config to settings */
export async function setSanitizationConfig(config: SanitizationConfig): Promise<void> {
  const isEnterprise = getCurrentMode() === 'enterprise';
  if (isEnterprise) {
    // Controller expects structured JSON with field names matching UpdateSanitizationConfig
    await getClient().http.put('/admin/sanitization/config', {
      redact_ip_addresses: config.redact_ip_addresses,
      redact_ipv6_addresses: config.redact_ipv6_addresses,
      redact_mac_addresses: config.redact_mac_addresses,
      redact_hostnames: config.redact_hostnames,
      redact_usernames: config.redact_usernames,
      custom_patterns: config.custom_patterns,
      allowlist: config.allowlist,
    });
  } else {
    await getClient().http.put('/settings/ai.sanitization_config', { value: JSON.stringify(config) });
  }
}

/** Test sanitization on arbitrary text */
export async function testSanitization(text: string): Promise<SanitizationTestResult> {
  try {
    const res = await getClient().http.post('/ai/sanitization/test', { text });
    return res.data;
  } catch (err) {
    if (axios.isAxiosError(err) && err.response) {
      throw new Error(err.response.data?.error || 'Failed to test sanitization');
    }
    throw new Error('Failed to test sanitization');
  }
}

/**
 * Format AI context into human-readable summary lines for UI display
 * Used by Plan 09-06 (Collapsible Context UI)
 * @param context The AI context to format
 * @returns Array of summary lines suitable for display
 */
export function formatContextSummary(context: AiContext): string[] {
  const lines: string[] = [];

  // Device context
  if (context.device) {
    const d = context.device;
    lines.push(`Device: ${d.name} (${d.vendor || d.type})`);
    if (d.primaryIp) lines.push(`IP: ${d.primaryIp}`);
    if (d.platform) lines.push(`Platform: ${d.platform}`);
    if (d.site) lines.push(`Site: ${d.site}`);
    if (d.role) lines.push(`Role: ${d.role}`);
    lines.push(`Status: ${d.status}`);
  }

  // Connection context
  if (context.connection) {
    const c = context.connection;
    lines.push(`Link: ${c.sourceDevice.name} (${c.sourceInterface}) <-> ${c.targetDevice.name} (${c.targetInterface})`);
    lines.push(`Status: ${c.status}`);
    if (c.protocols?.length) {
      lines.push(`Protocols: ${c.protocols.map(p => `${p.protocol}:${p.state}`).join(', ')}`);
    }
  }

  // Terminal context
  if (context.terminal) {
    if (context.terminal.detectedVendor) {
      lines.push(`Vendor: ${context.terminal.detectedVendor}`);
    }
    if (context.terminal.detectedPlatform) {
      lines.push(`Platform: ${context.terminal.detectedPlatform}`);
    }
    if (context.terminal.hostname) {
      lines.push(`Hostname: ${context.terminal.hostname}`);
    }
  }

  // Selected text (truncated)
  if (context.selectedText) {
    const truncated = context.selectedText.length > 50
      ? `${context.selectedText.substring(0, 50)}...`
      : context.selectedText;
    lines.push(`Selected: "${truncated}"`);
  }

  // Session name
  if (context.sessionName) {
    lines.push(`Session: ${context.sessionName}`);
  }

  // CLI flavor
  if (context.cliFlavor && context.cliFlavor !== 'auto') {
    const flavorNames: Record<string, string> = {
      'linux': 'Linux/Unix',
      'cisco-ios': 'Cisco IOS/IOS-XE',
      'cisco-nxos': 'Cisco NX-OS',
      'juniper': 'Juniper Junos',
      'arista': 'Arista EOS',
      'paloalto': 'Palo Alto PAN-OS',
      'fortinet': 'Fortinet FortiOS',
    };
    lines.push(`CLI Type: ${flavorNames[context.cliFlavor] || context.cliFlavor}`);
  }

  // Session context / Team Knowledge (Phase 14)
  if (context.sessionContext && context.sessionContext.length > 0) {
    lines.push('');
    lines.push('Team Knowledge:');
    for (const ctx of context.sessionContext.slice(0, 3)) { // Show top 3
      const date = new Date(ctx.created_at).toLocaleDateString();
      lines.push(`  - ${ctx.issue} (${ctx.author}, ${date})`);
      if (ctx.root_cause) {
        lines.push(`    Root cause: ${ctx.root_cause}`);
      }
      if (ctx.ticket_ref) {
        lines.push(`    Ticket: ${ctx.ticket_ref}`);
      }
    }
    if (context.sessionContext.length > 3) {
      lines.push(`  ... and ${context.sessionContext.length - 3} more entries`);
    }
  }

  return lines;
}

// ============================================
// Change Control AI Context (Phase 15-05)
// ============================================

/** Phase of the change execution workflow */
export type ChangePhase = 'planning' | 'pre_checks' | 'change' | 'post_checks' | 'review';

/** MOP step counts for change context */
export interface MopStepCounts {
  preChecks: number;
  changeSteps: number;
  postChecks: number;
  rollbackSteps: number;
}

/** Active change information for AI context */
export interface ActiveChangeInfo {
  id: string;
  name: string;
  description?: string;
  status: string;
  currentPhase: ChangePhase;
  mopSteps: MopStepCounts;
}

/** Snapshot preview for AI context */
export interface SnapshotPreview {
  capturedAt: string;
  commandCount: number;
  outputPreview: string; // First 500 chars
}

/** Step execution history entry */
export interface ExecutionHistoryEntry {
  command: string;
  output: string;
  timestamp: string;
  status: 'passed' | 'failed';
}

/** Change Control context for AI awareness */
export interface ChangeControlContext {
  activeChange?: ActiveChangeInfo;
  preSnapshot?: SnapshotPreview;
  postSnapshot?: SnapshotPreview;
  executionHistory?: ExecutionHistoryEntry[];
}

/**
 * Generate a system prompt section for change control awareness
 * This makes the AI aware of the current change context and its role as a co-pilot
 * @param context The change control context
 * @returns System prompt string to append to base prompt
 */
export function getChangeControlSystemPrompt(context: ChangeControlContext): string {
  if (!context.activeChange) return '';

  const change = context.activeChange;
  const mop = change.mopSteps;

  let prompt = `
## Active Change Control Session

You are assisting with a network change: "${change.name}"
${change.description ? `Description: ${change.description}` : ''}

Current Phase: ${change.currentPhase}
MOP has: ${mop.preChecks} pre-checks, ${mop.changeSteps} change steps, ${mop.postChecks} post-checks, ${mop.rollbackSteps} rollback steps

`;

  // Add snapshot status
  if (context.preSnapshot) {
    prompt += `Pre-snapshot: Captured at ${context.preSnapshot.capturedAt} (${context.preSnapshot.commandCount} commands)\n`;
  } else {
    prompt += `Pre-snapshot: Not captured yet\n`;
  }

  if (context.postSnapshot) {
    prompt += `Post-snapshot: Captured at ${context.postSnapshot.capturedAt} (${context.postSnapshot.commandCount} commands)\n`;
  } else {
    prompt += `Post-snapshot: Not captured yet\n`;
  }

  // Add recent execution history if available
  if (context.executionHistory && context.executionHistory.length > 0) {
    const recent = context.executionHistory.slice(-5);
    prompt += `\nRecent Execution History:\n`;
    for (const entry of recent) {
      prompt += `- ${entry.command} [${entry.status}] at ${entry.timestamp}\n`;
    }
  }

  // Add role-specific guidance
  prompt += `
Your role as Change Control Co-Pilot:
- Be proactive in identifying potential issues
- Analyze outputs for expected vs unexpected changes
- Flag concerns clearly with severity (info/warning/critical)
- Suggest additional verification when appropriate
- Keep responses concise and actionable
- Focus on what the engineer needs to know right now

Phase-Specific Guidance:
`;

  switch (change.currentPhase) {
    case 'planning':
      prompt += `- Suggest appropriate pre-checks based on the change type
- Validate MOP completeness (pre-checks, change steps, post-checks, rollback)
- Warn about potential risks or impacts
`;
      break;
    case 'pre_checks':
      prompt += `- Explain what each pre-check command will show
- Highlight what to look for in the output
- Suggest additional baseline captures if needed
`;
      break;
    case 'change':
      prompt += `- Analyze each command output as it executes
- Flag any errors, warnings, or unexpected results immediately
- Provide confidence level on whether to proceed or pause
- Watch for signs that indicate rollback may be needed
`;
      break;
    case 'post_checks':
      prompt += `- Compare post-check results against pre-check baseline
- Identify any metric changes (counters, states, neighbors)
- Suggest additional verification if something looks off
`;
      break;
    case 'review':
      prompt += `- Provide comprehensive before/after analysis
- Clearly state whether the change was successful
- Highlight any unexpected changes that occurred
- Recommend completion or rollback with justification
`;
      break;
  }

  return prompt;
}

/**
 * Build a complete change control context from change data
 * @param change The change object
 * @param snapshots Array of snapshots
 * @param currentPhase Current execution phase
 * @returns ChangeControlContext for AI
 */
export function buildChangeControlContext(
  change: {
    id: string;
    name: string;
    description?: string;
    status: string;
    mop_steps: Array<{ step_type: string; command: string; output?: string; status: string; executed_at?: string }>;
  },
  snapshots: Array<{ snapshot_type: string; commands: string[]; output: string; captured_at: string }>,
  currentPhase: ChangePhase
): ChangeControlContext {
  // Count MOP steps by type
  const mopSteps: MopStepCounts = {
    preChecks: change.mop_steps.filter(s => s.step_type === 'pre_check').length,
    changeSteps: change.mop_steps.filter(s => s.step_type === 'change').length,
    postChecks: change.mop_steps.filter(s => s.step_type === 'post_check').length,
    rollbackSteps: change.mop_steps.filter(s => s.step_type === 'rollback').length,
  };

  // Find snapshots
  const preSnap = snapshots.find(s => s.snapshot_type === 'pre');
  const postSnap = snapshots.find(s => s.snapshot_type === 'post');

  // Build execution history from executed steps
  const executionHistory: ExecutionHistoryEntry[] = change.mop_steps
    .filter(s => s.executed_at && (s.status === 'passed' || s.status === 'failed'))
    .map(s => ({
      command: s.command,
      output: s.output || '',
      timestamp: s.executed_at!,
      status: s.status as 'passed' | 'failed',
    }))
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  return {
    activeChange: {
      id: change.id,
      name: change.name,
      description: change.description,
      status: change.status,
      currentPhase,
      mopSteps,
    },
    preSnapshot: preSnap ? {
      capturedAt: preSnap.captured_at,
      commandCount: preSnap.commands.length,
      outputPreview: preSnap.output.slice(0, 500),
    } : undefined,
    postSnapshot: postSnap ? {
      capturedAt: postSnap.captured_at,
      commandCount: postSnap.commands.length,
      outputPreview: postSnap.output.slice(0, 500),
    } : undefined,
    executionHistory: executionHistory.length > 0 ? executionHistory : undefined,
  };
}

// ============================================
// Centralized Prompt Defaults & Settings API
// ============================================

/** Default AI Discovery prompt (topology enrichment) */
export const DEFAULT_AI_DISCOVERY_PROMPT = `# Topology Enrichment Task

**GOAL: Enrich the EXISTING topology with operational data - NOT discover new devices.**

Your job is to gather rich operational data to enhance device details.

## Available Data Sources

Query ALL available external sources for device information:
- LibreNMS: Device details, ports, health metrics
- NetBox: Site, role, rack location, serial numbers
- Netdisco: L2 topology, switch ports, VLANs

## Terminal Sessions

**CRITICAL: Disable paging FIRST on each session before running any show commands!**
- Cisco/Arista: \`terminal length 0\`
- Juniper: \`set cli screen-length 0\` (do NOT use \`| no-more\`)
- Palo Alto: \`set cli pager off\`
Run this as a SEPARATE command and wait for it to complete before proceeding.

Then gather:
- Device version/model: \`show version\`
- Interface status: \`show interfaces status\` or \`show ip interface brief\`
- BGP summary: \`show ip bgp summary\`
- OSPF neighbors: \`show ip ospf neighbor\`
- CPU/Memory: \`show processes cpu\` or equivalent

## Update the Topology

After gathering data, use \`update_topology_device\` to persist findings.

**RULES:**
- Do NOT try to discover new devices - enrich existing ones
- ALWAYS disable paging first (use the correct command for the vendor)
- Query BOTH LibreNMS AND NetBox if available
- Be creative - gather interesting operational metrics!`;

/** Default Topology Canvas AI prompt */
export const DEFAULT_TOPOLOGY_PROMPT = `You have access to topology tools for querying and modifying the network topology.
All modifications are automatically tracked and can be undone by the user.

When modifying the topology:
- Execute changes directly - no approval needed
- User can undo any change via the history panel or Cmd+Z
- Describe what you're doing as you do it

Available capabilities:
- Query devices, connections, and find paths between devices
- Add/remove/update/move devices and connections
- Analyze for single points of failure (SPOF), redundancy, and best practices
- Add annotations and highlights
- Export to PNG/SVG/JSON

Device types: router, switch, firewall, server, cloud, access-point, load-balancer, wan-optimizer, voice-gateway, wireless-controller, storage, virtual, sd-wan, iot, unknown

When asked to build or create a topology:
1. Add devices using topology_add_device (positions auto-calculated if not specified)
2. Add connections using topology_add_connection
3. Use meaningful device names indicating role/location

When asked to analyze:
- Use topology_analyze with type 'spof' to find single points of failure
- Use topology_analyze with type 'redundancy' to check path redundancy
- Use topology_path to find routes between devices`;

/** Default Script Generation prompt */
export const DEFAULT_SCRIPT_PROMPT = `You are a network automation script generator. Generate Python scripts for network operations.

Output format:
1. First, output the Python script in a code block
2. Then, provide a brief explanation of what the script does

Guidelines:
- Use Python 3
- Include proper error handling
- Add comments explaining key sections
- Use subprocess for running CLI commands
- Use netmiko or paramiko for SSH when needed
- Follow network automation best practices
- Keep scripts practical and production-ready`;

/** Default Agent Tasks (Background) prompt */
export const DEFAULT_AGENT_PROMPT = 'You are a network automation assistant. You help users gather information from network devices using SSH commands. You have access to tools for querying devices and executing read-only commands. Be concise and focus on the task at hand.';

/** Default AI Copilot prompt — used for real-time terminal output analysis */
// --- Discovery prompt (ai.discovery_prompt) ---

export async function getDiscoveryPrompt(): Promise<string | null> {
  try {
    const prefix = settingsPrefix();
    const res = await getClient().http.get(`${prefix}/ai.discovery_prompt`);
    const data = res.data;
    if (data === null) return null;
    if (getCurrentMode() === 'enterprise') {
      // Enterprise user-settings returns raw JSONB string
      return typeof data === 'string' && data.trim() ? data : null;
    }
    const val = data.value ?? null;
    return val && val.trim() ? val : null;
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 404) return null;
    return null;
  }
}

export async function setDiscoveryPrompt(prompt: string | null): Promise<void> {
  const prefix = settingsPrefix();
  if (!prompt || !prompt.trim()) {
    try { await getClient().http.delete(`${prefix}/ai.discovery_prompt`); } catch { /* ok */ }
  } else {
    if (getCurrentMode() === 'enterprise') {
      await getClient().http.put(`${prefix}/ai.discovery_prompt`, prompt);
    } else {
      await getClient().http.put(`${prefix}/ai.discovery_prompt`, { value: prompt });
    }
  }
}

// --- Topology prompt (ai.topology_prompt) ---

export async function getTopologyPrompt(): Promise<string | null> {
  try {
    const prefix = settingsPrefix();
    const res = await getClient().http.get(`${prefix}/ai.topology_prompt`);
    const data = res.data;
    if (data === null) return null;
    if (getCurrentMode() === 'enterprise') {
      return typeof data === 'string' && data.trim() ? data : null;
    }
    const val = data.value ?? null;
    return val && val.trim() ? val : null;
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 404) return null;
    return null;
  }
}

export async function setTopologyPrompt(prompt: string | null): Promise<void> {
  const prefix = settingsPrefix();
  if (!prompt || !prompt.trim()) {
    try { await getClient().http.delete(`${prefix}/ai.topology_prompt`); } catch { /* ok */ }
  } else {
    if (getCurrentMode() === 'enterprise') {
      await getClient().http.put(`${prefix}/ai.topology_prompt`, prompt);
    } else {
      await getClient().http.put(`${prefix}/ai.topology_prompt`, { value: prompt });
    }
  }
}

// --- Script prompt (ai.script_prompt) ---

export async function getScriptPrompt(): Promise<string | null> {
  try {
    const prefix = settingsPrefix();
    const res = await getClient().http.get(`${prefix}/ai.script_prompt`);
    const data = res.data;
    if (data === null) return null;
    if (getCurrentMode() === 'enterprise') {
      return typeof data === 'string' && data.trim() ? data : null;
    }
    const val = data.value ?? null;
    return val && val.trim() ? val : null;
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 404) return null;
    return null;
  }
}

export async function setScriptPrompt(prompt: string | null): Promise<void> {
  const prefix = settingsPrefix();
  if (!prompt || !prompt.trim()) {
    try { await getClient().http.delete(`${prefix}/ai.script_prompt`); } catch { /* ok */ }
  } else {
    if (getCurrentMode() === 'enterprise') {
      await getClient().http.put(`${prefix}/ai.script_prompt`, prompt);
    } else {
      await getClient().http.put(`${prefix}/ai.script_prompt`, { value: prompt });
    }
  }
}

// ============================================
// AI Memory API
// ============================================

export interface AiMemory {
  id: string;
  content: string;
  category: string;
  source: string;
  created_at: string;
  updated_at: string;
}

export async function listAiMemories(category?: string): Promise<AiMemory[]> {
  const params = category ? `?category=${encodeURIComponent(category)}` : '';
  const res = await getClient().http.get(`/ai/memory${params}`);
  return res.data?.memories || [];
}

export async function createAiMemory(content: string, category: string = 'general'): Promise<AiMemory> {
  const res = await getClient().http.post('/ai/memory', { content, category, source: 'user' });
  return res.data;
}

export async function updateAiMemory(id: string, content: string, category: string): Promise<void> {
  await getClient().http.put(`/ai/memory/${id}`, { content, category });
}

export async function deleteAiMemory(id: string): Promise<void> {
  await getClient().http.delete(`/ai/memory/${id}`);
}

// === AI Config Mode (AUDIT FIX EXEC-002) ===
//
// Config mode used to be a client-side checkbox (`ai.allowConfigChanges`)
// that the agent-chat request body forwarded as `allow_config_changes`. The
// backend now ignores that field entirely and consults a server-side flag
// gated on a fresh master-password unlock with a short TTL. These three
// functions drive the new flow.

export interface ConfigModeStatus {
  enabled: boolean;
  /** RFC3339 timestamp when the override expires. null when disabled. */
  expires_at: string | null;
  /** Wall-clock seconds until expiry. null when disabled. */
  seconds_remaining: number | null;
}

/**
 * Turn AI config mode on. Requires the user to re-supply the master password
 * (proof-of-presence). The override expires server-side after ~5 min.
 */
export async function enableAiConfigMode(masterPassword: string): Promise<ConfigModeStatus> {
  const { data } = await getClient().http.post('/ai/config-mode/enable', {
    master_password: masterPassword,
  });
  return data;
}

/** Turn AI config mode off immediately. */
export async function disableAiConfigMode(): Promise<ConfigModeStatus> {
  const { data } = await getClient().http.post('/ai/config-mode/disable');
  return data;
}

/** Read current state — frontend should poll this every 10-30 s while
 *  config mode is shown to keep the countdown live. */
export async function getAiConfigModeStatus(): Promise<ConfigModeStatus> {
  const { data } = await getClient().http.get('/ai/config-mode/status');
  return data;
}
