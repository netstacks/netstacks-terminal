/**
 * useAIAgent - Unified hook for AI agent interactions
 *
 * This hook can be used by all AI interaction points:
 * - AISidePanel (troubleshooting)
 * - AIInlineChat
 * - AIInlinePopup
 * - Future AI components
 *
 * It orchestrates the AI agent loop:
 * 1. Sends user message to AI with tool definitions
 * 2. When AI requests tool_use, executes tools locally
 * 3. Returns tool results to AI
 * 4. Loops until AI returns stop_reason: "end_turn"
 *
 * Tools are dynamically included based on what callbacks are provided.
 */

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { getAvailableTools, type AgentTool } from '../lib/agentTools';
import { getSettings } from './useSettings';
import { validateReadOnlyCommand, type ValidationResult } from '../lib/readOnlyFilter';
import { getClient } from '../api/client';
import { lookupOui, lookupDns, lookupWhois, lookupAsn } from '../api/lookup';
import { getTopologyTools, executeTopologyTool, isTopologyTool, type TopologyAICallbacks } from '../lib/topologyAITools';
import type { SessionContextEntry } from '../api/ai';
import type { NetBoxNeighbor } from '../api/netbox';
import { listNetBoxSources } from '../api/netboxSources';
import { useTokenUsageOptional, type AiProviderType as GlobalProviderType } from '../contexts/TokenUsageContext';
import {
  type AgentState,
  type AgentMessage,
  type PendingCommand,
  type AgentAutonomyLevel,
  createUserMessage,
  createThinkingMessage,
  createCommandResultMessage,
  createErrorMessage,
  createRecommendationMessage,
  type ConfigRecommendation,
} from '../api/agent';
import { listSessions as apiListSessions, listFolders as apiListFolders, type CliFlavor, type Session, type Folder } from '../api/sessions';
import { listEnterpriseSessionDefinitions, listUserFolders as apiListUserFolders } from '../api/enterpriseSessions';
import { getCurrentMode } from '../api/client';
import { useCapabilitiesStore } from '../stores/capabilitiesStore';
import { useAuthStore } from '../stores/authStore';
import { getModeSystemPrompt as getModeSystemPromptFn } from '../lib/aiModes';
import { getTopologyPrompt, DEFAULT_TOPOLOGY_PROMPT } from '../api/ai';
import type { Document, DocumentCategory } from '../api/docs';
import { listMcpServers, executeMcpTool, type McpServer } from '../api/mcp';
import { createTask, getTask } from '../api/tasks';
import { listAgentDefinitions, runAgentDefinition } from '../api/agentDefinitions';

// Re-export types for consumers
export type { AgentState, AgentMessage, PendingCommand, AgentAutonomyLevel };
export type { TopologyAICallbacks } from '../lib/topologyAITools';
export { TOPOLOGY_SYSTEM_PROMPT } from '../lib/topologyAITools';  // Re-export for consumers

// API types for agent-chat endpoint
interface AgentChatMessage {
  role: string;
  content: string | ContentBlock[];
}

interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
}

interface ToolUseResponse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

// Token usage from API
interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens?: number;
}

interface AgentChatResponse {
  text: string | null;
  tool_use: ToolUseResponse[];
  stop_reason: string | null;
  usage?: TokenUsage;
}

// SSE streaming event types from the backend
interface StreamEventContentDelta { type: 'content_delta'; text: string }
interface StreamEventToolUseStart { type: 'tool_use_start'; id: string; name: string }
interface StreamEventToolInputDelta { type: 'tool_input_delta'; delta: string }
interface StreamEventToolUseEnd { type: 'tool_use_end' }
interface StreamEventDone { type: 'done'; stop_reason: string | null; usage: { input_tokens: number; output_tokens: number; total_tokens?: number } | null }
interface StreamEventError { type: 'error'; message: string }

type StreamEvent = StreamEventContentDelta | StreamEventToolUseStart | StreamEventToolInputDelta | StreamEventToolUseEnd | StreamEventDone | StreamEventError

// Cumulative token usage tracking
export interface CumulativeTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requestCount: number;
}

// Session info for the agent
export interface AgentSession {
  id: string;
  name: string;
  host?: string;
  connected: boolean;
  cliFlavor?: CliFlavor;
}

// Change control analysis parameters (Phase 15)
export interface AnalyzeChangeDiffParams {
  before_output: string;
  after_output: string;
  change_description: string;
  device_type?: string;
}

export interface SuggestPreChecksParams {
  change_type: string;
  device_type: string;
  affected_interface?: string;
}

export interface ValidateChangeResultParams {
  expected_outcome: string;
  actual_output: string;
  elapsed_time_seconds?: number;
}

export interface ValidateChangeResult {
  valid: boolean;
  analysis: string;
}

// Session context callback parameters (Phase 14)
export interface AddSessionContextParams {
  issue: string;
  root_cause?: string;
  resolution?: string;
  commands?: string;
  ticket_ref?: string;
}

// NetBox import parameters (Phase 22)
export interface NetBoxImportParams {
  netbox_source_id: string;
  topology_id: string;
  site_slug?: string;
  include_connections?: boolean;
}

// NetBox import result (Phase 22)
export interface NetBoxImportResult {
  devicesCreated: number;
  connectionsCreated: number;
}

// MOP creation parameters
export interface CreateMopParams {
  name: string;
  description?: string;
  session_ids: string[];
  pre_checks: Array<{ command: string; description?: string; expected_output?: string }>;
  changes: Array<{ command: string; description?: string }>;
  post_checks: Array<{ command: string; description?: string; expected_output?: string }>;
  rollback?: Array<{ command: string; description?: string }>;
}

// MOP creation result
export interface CreateMopResult {
  changeId: string;
  changeName: string;
}

// Neighbor discovery types (Phase 22)
export interface NeighborParseResult {
  protocol: 'cdp' | 'lldp';
  neighbors: NeighborEntry[];
  deviceName?: string;
}

export interface NeighborEntry {
  localInterface: string;
  neighborName: string;
  neighborIp?: string;
  neighborInterface?: string;
  neighborPlatform?: string;
  protocol: 'cdp' | 'lldp';
}

export interface AddNeighborParams {
  topology_id: string;
  source_device_id: string;
  neighbor_name: string;
  neighbor_ip?: string;
  local_interface: string;
  remote_interface?: string;
  device_type?: string;
}

export interface AddNeighborResult {
  deviceId: string;
  connectionId: string;
}

// AI Provider type (must match AiProviderType from api/ai.ts)
export type AiProviderType = 'anthropic' | 'openai' | 'ollama' | 'openrouter' | 'litellm' | 'custom';

// Hook options - all callbacks are optional for maximum flexibility
export interface UseAIAgentOptions {
  // Session-related (optional)
  sessions?: AgentSession[];
  onExecuteCommand?: (sessionId: string, command: string) => Promise<string>;
  getTerminalContext?: (sessionId: string, lines?: number) => Promise<string>;
  onOpenSession?: (sessionId: string) => Promise<void>;

  // Autonomy level - defaults to 'safe-auto' for better UX
  autonomyLevel?: AgentAutonomyLevel;

  // AI Provider selection (optional - uses saved settings if not provided)
  provider?: AiProviderType;
  model?: string;

  // Document access callbacks (optional)
  onListDocuments?: (category?: DocumentCategory) => Promise<Document[]>;
  onReadDocument?: (documentId: string) => Promise<Document | null>;
  onSearchDocuments?: (query: string, category?: DocumentCategory) => Promise<Document[]>;
  onSaveDocument?: (path: string, content: string, category?: DocumentCategory, mode?: 'overwrite' | 'append', sessionId?: string) => Promise<{ id: string; name: string }>;

  // Change control callbacks (Phase 15)
  onAnalyzeChangeDiff?: (params: AnalyzeChangeDiffParams) => Promise<string>;
  onSuggestPreChecks?: (params: SuggestPreChecksParams) => Promise<string[]>;
  onValidateChangeResult?: (params: ValidateChangeResultParams) => Promise<ValidateChangeResult>;

  // Session context callbacks (Phase 14)
  onAddSessionContext?: (sessionId: string, params: AddSessionContextParams) => Promise<{ id: string }>;
  onListSessionContext?: (sessionId: string) => Promise<SessionContextEntry[]>;

  // NetBox topology callbacks (Phase 22)
  onNetBoxGetNeighbors?: (sourceId: string, deviceId: number) => Promise<NetBoxNeighbor[]>;
  onNetBoxImportTopology?: (params: NetBoxImportParams) => Promise<NetBoxImportResult>;

  // Neighbor discovery callbacks (Phase 22)
  onDiscoverNeighbors?: (sessionId: string, protocol: 'cdp' | 'lldp' | 'auto') => Promise<NeighborParseResult>;
  onAddNeighborToTopology?: (params: AddNeighborParams) => Promise<AddNeighborResult>;

  // MOP creation callback
  onCreateMop?: (params: CreateMopParams) => Promise<CreateMopResult>;

  // Topology refresh callback - called after update_topology_device succeeds
  onTopologyDeviceUpdated?: (topologyId: string) => void;

  // Topology AI tools callbacks (Phase 27-07)
  // When provided, enables AI to query/modify/analyze the active topology
  topologyCallbacks?: TopologyAICallbacks;

  // Active session context — the currently focused terminal tab
  activeSessionId?: string;
  activeSessionName?: string;

  // Script copilot context - when a script tab is active
  scriptContext?: {
    name: string;
    getContent: () => string;
  };

  // Interaction mode
  singleTurn?: boolean; // For popup-style interactions (stops after first response)

  // Initial messages (for continuing a conversation from popup/floating chat)
  initialMessages?: AgentMessage[];

  // AI mode for system prompt and tool filtering
  aiMode?: import('../lib/aiModes').AIMode;

  // Streaming mode — use SSE streaming instead of batch API
  streaming?: boolean;

  // UI navigation callbacks (executed locally, not via API)
  onNavigateToBackup?: (deviceId: string, deviceName: string, searchText?: string) => void;
  onNavigateToDevice?: (deviceId: string, deviceName: string) => void;
  onOpenTerminalSession?: (deviceName: string) => void;
  onNavigateToMop?: (mopId: string, mopName: string) => void;
  onNavigateToTopology?: (topologyName: string) => void;
  onNavigateToSettings?: (tab?: string) => void;
}

// Hook return type
export interface UseAIAgentReturn {
  messages: AgentMessage[];
  agentState: AgentState;
  pendingCommands: PendingCommand[];
  sendMessage: (content: string) => Promise<void>;
  approveCommands: () => void;
  rejectCommands: () => void;
  stopAgent: () => void;
  clearMessages: () => void;
  tokenUsage: CumulativeTokenUsage;
  resetTokenUsage: () => void;
}

// Truncate tool result content to prevent context overflow.
// ~4 chars per token, 30K chars ≈ 7,500 tokens — leaves room for tools + conversation.
const MAX_TOOL_RESULT_CHARS = 30000;
function truncateToolResult(content: string): string {
  if (content.length <= MAX_TOOL_RESULT_CHARS) return content;
  const truncated = content.slice(0, MAX_TOOL_RESULT_CHARS);
  return truncated + `\n\n[Output truncated — ${content.length} chars total, showing first ${MAX_TOOL_RESULT_CHARS}. Use search/filter parameters to narrow results.]`;
}

// Tool name mapping for Anthropic API compatibility
// Anthropic requires tool names to match [a-zA-Z0-9_-]{1,64}
// MCP tools use "mcp:{server_id}:{tool_name}" which contains colons and may exceed 64 chars
// We maintain a bidirectional map between sanitized names and original names
const toolNameMap = new Map<string, string>(); // sanitized -> original

function sanitizeToolName(name: string): string {
  // Non-MCP tools are already safe
  if (!name.startsWith('mcp:')) return name;

  // For MCP tools, create a short sanitized name: mcp_{index}_{tool_name}
  // Use the tool_name part only (after last colon), prefixed with mcp_
  const parts = name.split(':');
  const toolName = parts.slice(2).join('_');
  // Ensure unique by including a hash of the server ID
  const serverId = parts[1];
  const shortId = serverId.slice(0, 6);
  let sanitized = `mcp_${shortId}_${toolName}`.replace(/[^a-zA-Z0-9_-]/g, '_');
  // Truncate to 64 chars
  if (sanitized.length > 64) sanitized = sanitized.slice(0, 64);

  toolNameMap.set(sanitized, name);
  return sanitized;
}

function unsanitizeToolName(name: string): string {
  return toolNameMap.get(name) || name;
}

// Trim a JSON schema to reduce token count: keep only top-level property names,
// types, and descriptions. Strip nested objects, enums with many values, etc.
function trimSchema(properties: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!properties) return {};
  const trimmed: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(properties)) {
    if (val && typeof val === 'object') {
      const prop = val as Record<string, unknown>;
      const slim: Record<string, unknown> = {};
      if (prop.type) slim.type = prop.type;
      if (prop.description && typeof prop.description === 'string') {
        slim.description = (prop.description as string).slice(0, 200);
      }
      // For arrays, include items type but not full schema
      if (prop.type === 'array' && prop.items && typeof prop.items === 'object') {
        const items = prop.items as Record<string, unknown>;
        slim.items = { type: items.type || 'string' };
      }
      // For enums, keep only first 10 values
      if (Array.isArray(prop.enum)) {
        slim.enum = (prop.enum as unknown[]).slice(0, 10);
      }
      trimmed[key] = slim;
    } else {
      trimmed[key] = val;
    }
  }
  return trimmed;
}

// Convert tools to Anthropic format
function toolsToAnthropicFormat(tools: AgentTool[]): object[] {
  return tools.map(tool => {
    // Handle both AgentTool (parameters) and ToolDefinition (input_schema) formats
    const schema = tool.parameters || (tool as unknown as { input_schema: AgentTool['parameters'] }).input_schema;
    const isMcpTool = tool.name.startsWith('mcp:');

    // For MCP tools, trim schemas to reduce token count
    const properties = isMcpTool
      ? trimSchema(schema?.properties as Record<string, unknown> | undefined)
      : (schema?.properties || {});

    // Truncate MCP tool descriptions to save tokens
    const description = isMcpTool && tool.description.length > 300
      ? tool.description.slice(0, 300) + '...'
      : tool.description;

    return {
      name: sanitizeToolName(tool.name),
      description,
      input_schema: {
        type: schema?.type || 'object',
        properties,
        required: schema?.required || [],
      },
    };
  });
}

export function useAIAgent(options: UseAIAgentOptions = {}): UseAIAgentReturn {
  // Get global token tracker (optional - works without provider)
  const globalTokenTracker = useTokenUsageOptional();

  const {
    sessions = [],
    onExecuteCommand,
    getTerminalContext,
    onOpenSession,
    autonomyLevel = 'safe-auto', // Default to safe-auto for better UX
    provider,
    model,
    onListDocuments,
    onReadDocument,
    onSearchDocuments,
    onSaveDocument,
    // Change control callbacks (Phase 15)
    onAnalyzeChangeDiff,
    onSuggestPreChecks,
    onValidateChangeResult,
    // Session context callbacks (Phase 14)
    onAddSessionContext,
    onListSessionContext,
    // NetBox topology callbacks (Phase 22)
    onNetBoxGetNeighbors,
    onNetBoxImportTopology,
    // Neighbor discovery callbacks (Phase 22)
    onDiscoverNeighbors,
    onAddNeighborToTopology,
    // MOP creation callback
    onCreateMop,
    // Topology refresh callback
    onTopologyDeviceUpdated,
    // Topology AI tools callbacks (Phase 27-07)
    topologyCallbacks,
    // Active session context
    activeSessionId,
    activeSessionName,
    // Script copilot context
    scriptContext,
    singleTurn = false,
    initialMessages,
    // AI mode
    aiMode = 'operator',
    // Streaming mode
    streaming = false,
    // UI navigation callbacks
    onNavigateToBackup,
    onNavigateToDevice,
    onOpenTerminalSession,
    onNavigateToMop,
    onNavigateToTopology,
    onNavigateToSettings,
  } = options;

  const aiModeRef = useRef(aiMode);
  aiModeRef.current = aiMode;

  const onNavigateToBackupRef = useRef(onNavigateToBackup);
  onNavigateToBackupRef.current = onNavigateToBackup;
  const onNavigateToDeviceRef = useRef(onNavigateToDevice);
  onNavigateToDeviceRef.current = onNavigateToDevice;
  const onOpenTerminalSessionRef = useRef(onOpenTerminalSession);
  onOpenTerminalSessionRef.current = onOpenTerminalSession;
  const onNavigateToMopRef = useRef(onNavigateToMop);
  onNavigateToMopRef.current = onNavigateToMop;
  const onNavigateToTopologyRef = useRef(onNavigateToTopology);
  onNavigateToTopologyRef.current = onNavigateToTopology;
  const onNavigateToSettingsRef = useRef(onNavigateToSettings);
  onNavigateToSettingsRef.current = onNavigateToSettings;

  const [messages, setMessages] = useState<AgentMessage[]>(initialMessages || []);
  const [agentState, setAgentState] = useState<AgentState>('idle');
  const [pendingCommands, setPendingCommands] = useState<PendingCommand[]>([]);
  const [tokenUsage, setTokenUsage] = useState<CumulativeTokenUsage>({
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    requestCount: 0,
  });

  // Build initial conversation history from initial messages
  const buildInitialConversation = (): AgentChatMessage[] => {
    if (!initialMessages || initialMessages.length === 0) return [];
    // Rebuild conversation history from initial messages
    const history: AgentChatMessage[] = [];
    for (const msg of initialMessages) {
      if (msg.type === 'user') {
        history.push({ role: 'user', content: msg.content });
      } else if (msg.type === 'agent-thinking') {
        history.push({ role: 'assistant', content: msg.content });
      }
      // Note: tool results are already part of the conversation flow,
      // but for simplicity we just restore text messages
    }
    return history;
  };

  // Track conversation for AI - initialize from initial messages if provided
  const conversationRef = useRef<AgentChatMessage[]>(buildInitialConversation());
  // Track if we should stop the loop
  const stopRequestedRef = useRef(false);
  // AbortController for canceling in-flight requests
  const abortControllerRef = useRef<AbortController | null>(null);
  // Pending approval resolution
  const approvalResolverRef = useRef<{
    resolve: (approved: boolean) => void;
  } | null>(null);
  // Custom topology prompt loaded from backend settings
  const topologyPromptRef = useRef<string | null>(null);

  // Script context ref for stable access in callAgentApi
  const scriptContextRef = useRef(scriptContext);
  scriptContextRef.current = scriptContext;

  // Active session context refs for stable access in callAgentApi
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
  const activeSessionNameRef = useRef(activeSessionName);
  activeSessionNameRef.current = activeSessionName;

  // Update messages and conversation when initialMessages changes (for continuing from popup)
  // Auto-send if the last message is from the user (triggered by context menu actions)
  const autoSendTriggeredRef = useRef<string | null>(null);
  useEffect(() => {
    if (initialMessages && initialMessages.length > 0) {
      setMessages(initialMessages);
      // Rebuild conversation history
      const history: AgentChatMessage[] = [];
      for (const msg of initialMessages) {
        if (msg.type === 'user') {
          history.push({ role: 'user', content: msg.content });
        } else if (msg.type === 'agent-thinking') {
          history.push({ role: 'assistant', content: msg.content });
        }
      }
      conversationRef.current = history;

      // Auto-send: if last message is user and we haven't already sent it
      const lastMsg = initialMessages[initialMessages.length - 1];
      if (lastMsg?.type === 'user' && lastMsg.id !== autoSendTriggeredRef.current) {
        autoSendTriggeredRef.current = lastMsg.id;
        // Defer to next tick so state is settled
        setTimeout(() => {
          sendMessageRef.current?.(lastMsg.content);
        }, 100);
      }
    }
  }, [initialMessages]);

  // Load custom topology prompt from backend when topology tools are active
  useEffect(() => {
    if (topologyCallbacks) {
      getTopologyPrompt()
        .then(val => { topologyPromptRef.current = val; })
        .catch(() => { topologyPromptRef.current = null; });
    }
  }, [topologyCallbacks]);

  // Check if AI terminal mode (remote file tools) is enabled
  const [aiTerminalMode, setAiTerminalMode] = useState(false);
  useEffect(() => {
    if (getCurrentMode() === 'enterprise') return;
    getClient().http.get('/settings/ai.terminal_mode')
      .then((res) => {
        setAiTerminalMode(res.data?.value === 'true');
      })
      .catch(() => { /* not set, default false */ });
  }, []);

  // Fetch MCP tools from connected servers (standalone mode only)
  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
  const mcpServersRef = useRef<McpServer[]>([]);

  // Get disabled tools from settings - stabilize reference for memoization
  const disabledToolsKey = JSON.stringify(getSettings()['ai.disabledTools'] || []);

  // Build available tools based on what callbacks are provided
  const isEnterprise = getCurrentMode() === 'enterprise';
  const baseTools = useMemo(() => {
    const disabledTools: string[] = JSON.parse(disabledToolsKey);
    return getAvailableTools({
      hasSessions: sessions.length > 0,
      hasExecuteCommand: !!onExecuteCommand,
      hasTerminalContext: !!getTerminalContext,
      hasDocuments: !!(onListDocuments || onReadDocument || onSearchDocuments),
      hasSessionContext: !!(onAddSessionContext || onListSessionContext),
      hasChangeControl: !!(onAnalyzeChangeDiff || onSuggestPreChecks || onValidateChangeResult),
      hasNeighborDiscovery: !!(onDiscoverNeighbors || onAddNeighborToTopology),
      hasNetBoxTopology: !!(onNetBoxGetNeighbors || onNetBoxImportTopology),
      hasMopCreation: !!onCreateMop,
      hasMcpServers: mcpServers.length > 0,
      hasRemoteFiles: aiTerminalMode,
      hasBackupAnalysis: isEnterprise,
      hasUINavigation: !!(onNavigateToBackup || onNavigateToDevice || onNavigateToMop || onNavigateToTopology),
      isEnterprise,
    }, disabledTools);
  }, [
    sessions.length, onExecuteCommand, getTerminalContext,
    onListDocuments, onReadDocument, onSearchDocuments,
    onAddSessionContext, onListSessionContext,
    onAnalyzeChangeDiff, onSuggestPreChecks, onValidateChangeResult,
    onDiscoverNeighbors, onAddNeighborToTopology,
    onNetBoxGetNeighbors, onNetBoxImportTopology,
    onCreateMop, mcpServers.length, aiTerminalMode, isEnterprise, disabledToolsKey,
    onNavigateToBackup, onNavigateToDevice, onNavigateToMop, onNavigateToTopology,
  ]);

  useEffect(() => {
    if (getCurrentMode() === 'enterprise') return;
    if (!useCapabilitiesStore.getState().hasFeature('local_ai_tools')) return;
    let cancelled = false;

    // Refresh whenever called. Initial mount + every `mcp-state-changed` event
    // dispatched by api/mcp.ts after add/delete/connect/disconnect/tool-toggle.
    // Without this, toggling a tool in Settings → AI → MCP Servers wouldn't
    // reach the AI side panel until a full page reload, because mcpServers was
    // a one-shot fetch on mount.
    const fetchMcpServers = () => {
      listMcpServers()
        .then(servers => {
          if (cancelled) return;
          const connected = servers.filter(s => s.connected);
          setMcpServers(connected);
          mcpServersRef.current = connected;
        })
        .catch(() => { /* MCP servers unavailable */ });
    };

    fetchMcpServers();
    window.addEventListener('mcp-state-changed', fetchMcpServers);
    return () => {
      cancelled = true;
      window.removeEventListener('mcp-state-changed', fetchMcpServers);
    };
  }, []);

  // Convert MCP tools to AgentTool format (only enabled tools)
  const mcpTools: AgentTool[] = useMemo(() => {
    return mcpServers.flatMap(server => {
      const enabledTools = server.tools.filter(tool => tool.enabled);
      return enabledTools.map(tool => ({
        name: `mcp:${server.id}:${tool.name}`,
        description: `[MCP:${server.server_type} - ${server.name}] ${tool.description || tool.name}`,
        parameters: tool.input_schema as AgentTool['parameters'],
      }));
    });
  }, [mcpServers]);

  // Add topology AI tools when callbacks are provided (Phase 27-07)
  // These tools use a separate pattern with their own tool definitions.
  // In Personal Mode the local_ai_tools feature is always enabled.
  const aiToolsEnabled = useCapabilitiesStore.getState().hasFeature('local_ai_tools');
  const availableTools: AgentTool[] = useMemo(() => {
    if (!aiToolsEnabled) return [];
    return [
      ...(topologyCallbacks
        ? [...baseTools, ...getTopologyTools(topologyCallbacks) as unknown as AgentTool[]]
        : baseTools),
      ...mcpTools,
    ];
  }, [aiToolsEnabled, baseTools, mcpTools, topologyCallbacks]);

  // Add a message to the UI
  const addMessage = useCallback((message: AgentMessage) => {
    setMessages(prev => [...prev, message]);
  }, []);

  // Execute a tool locally
  const executeTool = useCallback(async (
    toolName: string,
    input: Record<string, unknown>
  ): Promise<{ content: string; is_error: boolean }> => {
    switch (toolName) {
      case 'list_sessions': {
        const filter = input.filter as string | undefined;
        const search = (input.search as string | undefined)?.toLowerCase();
        const isEnterprise = getCurrentMode() === 'enterprise';

        try {
          // Build open sessions lookup for connected status
          const openSessionIds = new Set(sessions.filter(s => s.connected).map(s => s.id));

          let enrichedSessions: Array<{
            id: string;
            name: string;
            host: string;
            folder: string;
            connected: boolean;
            cli_flavor: string;
            last_connected?: string | null;
            active_connections?: number;
          }>;

          if (isEnterprise) {
            // Enterprise mode: fetch from Controller API
            const [sessionResult, userFolders] = await Promise.all([
              listEnterpriseSessionDefinitions(),
              apiListUserFolders()
            ]);

            // Build folder name lookup
            const folderMap = new Map<string, { name: string; parent_id: string | null }>();
            for (const folder of userFolders) {
              folderMap.set(folder.id, { name: folder.name, parent_id: folder.parent_id });
            }

            const getFolderPath = (folderId: string | null): string => {
              if (!folderId) return 'Root';
              const parts: string[] = [];
              let currentId: string | null = folderId;
              while (currentId) {
                const folder = folderMap.get(currentId);
                if (folder) {
                  parts.unshift(folder.name);
                  currentId = folder.parent_id;
                } else {
                  break;
                }
              }
              return parts.length > 0 ? parts.join(' / ') : 'Root';
            };

            enrichedSessions = sessionResult.items.map(s => ({
              id: s.id,
              name: s.name,
              host: s.host,
              folder: getFolderPath(null), // Enterprise sessions use flat list for now
              connected: openSessionIds.has(s.id),
              cli_flavor: s.cli_flavor || 'auto',
              active_connections: s.active_connections,
            }));
          } else {
            // Personal mode: fetch from local sidecar API
            const [allSavedSessions, allFolders] = await Promise.all([
              apiListSessions(),
              apiListFolders()
            ]);

            // Build folder name lookup
            const folderMap = new Map<string, Folder>();
            for (const folder of allFolders) {
              folderMap.set(folder.id, folder);
            }

            const getFolderPath = (folderId: string | null): string => {
              if (!folderId) return 'Root';
              const parts: string[] = [];
              let currentId: string | null = folderId;
              while (currentId) {
                const folder = folderMap.get(currentId);
                if (folder) {
                  parts.unshift(folder.name);
                  currentId = folder.parent_id;
                } else {
                  break;
                }
              }
              return parts.length > 0 ? parts.join(' / ') : 'Root';
            };

            enrichedSessions = allSavedSessions.map((s: Session) => ({
              id: s.id,
              name: s.name,
              host: s.host,
              folder: getFolderPath(s.folder_id),
              connected: openSessionIds.has(s.id),
              cli_flavor: s.cli_flavor || 'auto',
              last_connected: s.last_connected_at,
            }));
          }

          // Apply filters
          if (filter === 'connected') {
            enrichedSessions = enrichedSessions.filter(s => s.connected);
          }

          // Apply search
          if (search) {
            enrichedSessions = enrichedSessions.filter(s =>
              s.name.toLowerCase().includes(search) ||
              s.host.toLowerCase().includes(search) ||
              s.folder.toLowerCase().includes(search)
            );
          }

          // Group by folder for readability
          const byFolder: Record<string, typeof enrichedSessions> = {};
          for (const session of enrichedSessions) {
            const folder = session.folder;
            if (!byFolder[folder]) byFolder[folder] = [];
            byFolder[folder].push(session);
          }

          // Limit output to prevent context overflow
          const MAX_SESSIONS_IN_RESULT = 50;
          const connectedSessions = enrichedSessions.filter(s => s.connected);
          const folderSummary = Object.entries(byFolder).map(([folder, sessions]) => ({
            folder,
            count: sessions.length,
            connected: sessions.filter(s => s.connected).length,
          }));

          if (enrichedSessions.length > MAX_SESSIONS_IN_RESULT) {
            // Too many sessions - return summary + connected + sample per folder
            const sampleByFolder: Record<string, typeof enrichedSessions> = {};
            for (const [folder, folderSessions] of Object.entries(byFolder)) {
              // Include connected sessions first, then up to 5 per folder
              const connected = folderSessions.filter(s => s.connected);
              const others = folderSessions.filter(s => !s.connected).slice(0, 5);
              sampleByFolder[folder] = [...connected, ...others];
            }

            return {
              content: JSON.stringify({
                total_sessions: enrichedSessions.length,
                connected_count: connectedSessions.length,
                note: `Showing summary — ${enrichedSessions.length} total sessions. Use the 'search' parameter to filter by name/host/folder.`,
                folder_summary: folderSummary,
                connected_sessions: connectedSessions.map(s => ({ id: s.id, name: s.name, host: s.host, folder: s.folder })),
                sample_by_folder: sampleByFolder,
              }, null, 2),
              is_error: false,
            };
          }

          return {
            content: JSON.stringify({
              total_sessions: enrichedSessions.length,
              connected_count: connectedSessions.length,
              folders: Object.keys(byFolder).sort(),
              sessions_by_folder: byFolder,
            }, null, 2),
            is_error: false,
          };
        } catch (err) {
          return {
            content: `Error fetching sessions: ${err instanceof Error ? err.message : 'Unknown error'}`,
            is_error: true,
          };
        }
      }

      case 'open_session': {
        const sessionId = input.session_id as string;

        if (!onOpenSession) {
          return {
            content: 'Session opening not available from this context. The user may need to manually open the session from the Sessions panel.',
            is_error: true
          };
        }

        try {
          await onOpenSession(sessionId);
          return {
            content: `Session opened. It may take a moment to connect. Use list_sessions to check connection status.`,
            is_error: false,
          };
        } catch (err) {
          return {
            content: `Error opening session: ${err instanceof Error ? err.message : 'Unknown error'}`,
            is_error: true,
          };
        }
      }

      case 'run_command': {
        const sessionId = input.session_id as string;
        let command = input.command as string;

        const session = sessions.find(s => s.id === sessionId);
        if (!session) {
          return { content: `Session ${sessionId} not found`, is_error: true };
        }
        if (!session.connected) {
          return { content: `Session ${session.name} is not connected`, is_error: true };
        }

        // AUDIT FIX (EXEC-002): client-side read-only pre-flight removed —
        // the backend's CommandFilter is the source of truth and consults the
        // server-side config-mode state. Locally validating against a
        // possibly-stale flag would either reject legitimate commands or
        // give false confidence.

        // Disable paging for AI-executed commands so output doesn't block
        const flavor = session.cliFlavor || 'auto';
        if (flavor === 'linux' || flavor === 'auto') {
          // Inline env vars disable pagers for most Unix tools (less, more, systemctl, git, etc.)
          command = `PAGER=cat SYSTEMD_PAGER= GIT_PAGER=cat LESS=-FRX ${command}`;
        } else if (flavor === 'juniper') {
          // Juniper: pipe through no-more to suppress paging
          if (!command.includes('| no-more')) {
            command = `${command} | no-more`;
          }
        }
        // Cisco IOS/NX-OS/Arista EOS: handled by system prompt (terminal length 0)
        // Palo Alto/Fortinet: handled by system prompt

        // Execute the command
        if (!onExecuteCommand) {
          return { content: 'Command execution not available', is_error: true };
        }

        try {
          const output = await onExecuteCommand(sessionId, command);
          return { content: output, is_error: false };
        } catch (err) {
          return {
            content: `Command failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
            is_error: true,
          };
        }
      }

      case 'ai_ssh_execute': {
        // AI SSH Execute - connects directly to device using saved session credentials
        const sessionId = input.session_id as string;
        const command = input.command as string;
        const timeoutSecs = (input.timeout_secs as number) || 30;

        // AUDIT FIX (EXEC-002): client-side pre-flight removed; backend's
        // CommandFilter at /api/ai/ssh-execute is the source of truth and
        // consults the server-side config-mode state.

        // Call backend endpoint — field name differs by mode
        try {
          const isEnterpriseMode = getCurrentMode() === 'enterprise';
          const response = await getClient().http.post('/ai/ssh-execute', {
            ...(isEnterpriseMode
              ? { session_definition_id: sessionId }
              : { session_id: sessionId }),
            command: command,
            timeout_secs: timeoutSecs,
          });

          const result = response.data;

          if (!result.success) {
            return {
              content: `Command failed: ${result.error || 'Unknown error'}\n\nOutput:\n${result.output}`,
              is_error: true,
            };
          }

          return {
            content: result.output,
            is_error: false,
          };
        } catch (err) {
          return {
            content: `SSH execution failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
            is_error: true,
          };
        }
      }

      case 'get_terminal_context': {
        const sessionId = input.session_id as string;
        const lines = (input.lines as number) || 50;

        const session = sessions.find(s => s.id === sessionId);
        if (!session) {
          return { content: `Session ${sessionId} not found`, is_error: true };
        }

        if (!getTerminalContext) {
          return { content: 'Terminal context not available', is_error: true };
        }

        try {
          const context = await getTerminalContext(sessionId, lines);
          return {
            content: JSON.stringify({
              sessionId,
              sessionName: session.name,
              cliFlavor: session.cliFlavor || 'auto',
              recentOutput: context,
            }, null, 2),
            is_error: false,
          };
        } catch (err) {
          return {
            content: `Failed to get context: ${err instanceof Error ? err.message : 'Unknown error'}`,
            is_error: true,
          };
        }
      }

      case 'recommend_config': {
        const sessionId = input.session_id as string;
        const issue = input.issue as string;
        const configSnippet = input.config_snippet as string;
        const explanation = input.explanation as string;

        const session = sessions.find(s => s.id === sessionId);
        const recommendation: ConfigRecommendation = {
          sessionId,
          sessionName: session?.name || sessionId,
          issue,
          configSnippet,
          explanation,
          timestamp: new Date(),
        };

        // Add recommendation message to UI
        addMessage(createRecommendationMessage(recommendation));

        return {
          content: 'Configuration recommendation displayed to user. Remember: You cannot execute configuration commands.',
          is_error: false,
        };
      }

      // Document access tools
      case 'list_documents': {
        const category = input.category as DocumentCategory | undefined;
        if (!onListDocuments) {
          return { content: 'Document access not available', is_error: true };
        }
        try {
          const docs = await onListDocuments(category);
          return {
            content: JSON.stringify(docs.map(d => ({
              id: d.id,
              name: d.name,
              category: d.category,
              content_type: d.content_type,
            })), null, 2),
            is_error: false,
          };
        } catch (err) {
          return {
            content: `Failed to list documents: ${err instanceof Error ? err.message : 'Unknown error'}`,
            is_error: true,
          };
        }
      }

      case 'read_document': {
        const documentId = input.document_id as string;
        if (!onReadDocument) {
          return { content: 'Document access not available', is_error: true };
        }
        try {
          const doc = await onReadDocument(documentId);
          if (!doc) {
            return { content: JSON.stringify({ error: 'Document not found' }), is_error: true };
          }
          return {
            content: JSON.stringify({
              id: doc.id,
              name: doc.name,
              category: doc.category,
              content_type: doc.content_type,
              content: doc.content,
            }, null, 2),
            is_error: false,
          };
        } catch (err) {
          return {
            content: `Failed to read document: ${err instanceof Error ? err.message : 'Unknown error'}`,
            is_error: true,
          };
        }
      }

      case 'search_documents': {
        const query = input.query as string;
        const category = input.category as DocumentCategory | undefined;
        if (!onSearchDocuments) {
          return { content: 'Document search not available', is_error: true };
        }
        try {
          const docs = await onSearchDocuments(query, category);
          return {
            content: JSON.stringify(docs.map(d => ({
              id: d.id,
              name: d.name,
              category: d.category,
              content_type: d.content_type,
            })), null, 2),
            is_error: false,
          };
        } catch (err) {
          return {
            content: `Failed to search documents: ${err instanceof Error ? err.message : 'Unknown error'}`,
            is_error: true,
          };
        }
      }

      case 'save_document': {
        const path = input.path as string;
        const content = input.content as string;
        const category = (input.category as DocumentCategory) || 'outputs';
        const mode = (input.mode as 'overwrite' | 'append') || 'overwrite';
        const sessionId = input.session_id as string | undefined;

        if (!onSaveDocument) {
          return { content: 'Document save not available', is_error: true };
        }

        try {
          const result = await onSaveDocument(path, content, category, mode, sessionId);
          return {
            content: JSON.stringify({
              success: true,
              document_id: result.id,
              document_name: result.name,
              path: path,
              mode: mode,
              bytes_saved: content.length,
            }, null, 2),
            is_error: false,
          };
        } catch (err) {
          return {
            content: `Failed to save document: ${err instanceof Error ? err.message : 'Unknown error'}`,
            is_error: true,
          };
        }
      }

      // Session context tools (Phase 14)
      case 'add_session_context': {
        if (!onAddSessionContext) {
          return { content: 'Session context not available in this context', is_error: true };
        }
        const session_id = input.session_id as string;
        const issue = input.issue as string;
        const root_cause = input.root_cause as string | undefined;
        const resolution = input.resolution as string | undefined;
        const commands = input.commands as string | undefined;
        const ticket_ref = input.ticket_ref as string | undefined;

        try {
          const result = await onAddSessionContext(session_id, {
            issue,
            root_cause,
            resolution,
            commands,
            ticket_ref,
          });
          return {
            content: JSON.stringify({
              success: true,
              context_id: result.id,
              message: 'Context saved successfully. This knowledge is now available for the team.',
            }, null, 2),
            is_error: false,
          };
        } catch (err) {
          return {
            content: `Failed to save session context: ${err instanceof Error ? err.message : 'Unknown error'}`,
            is_error: true,
          };
        }
      }

      case 'list_session_context': {
        if (!onListSessionContext) {
          return { content: 'Session context not available in this context', is_error: true };
        }
        const session_id = input.session_id as string;

        try {
          const contexts = await onListSessionContext(session_id);
          if (contexts.length === 0) {
            return {
              content: JSON.stringify({
                message: 'No saved context found for this device.',
                contexts: [],
              }, null, 2),
              is_error: false,
            };
          }
          return {
            content: JSON.stringify({
              message: `Found ${contexts.length} context entries for this device.`,
              contexts: contexts.map(ctx => ({
                id: ctx.id,
                issue: ctx.issue,
                root_cause: ctx.root_cause,
                resolution: ctx.resolution,
                commands: ctx.commands,
                ticket_ref: ctx.ticket_ref,
                author: ctx.author,
                created_at: ctx.created_at,
              })),
            }, null, 2),
            is_error: false,
          };
        } catch (err) {
          return {
            content: `Failed to list session context: ${err instanceof Error ? err.message : 'Unknown error'}`,
            is_error: true,
          };
        }
      }

      // Change control tools (Phase 15)
      case 'analyze_change_diff': {
        if (!onAnalyzeChangeDiff) {
          return { content: 'Change diff analysis not available in this context', is_error: true };
        }
        const before_output = input.before_output as string;
        const after_output = input.after_output as string;
        const change_description = input.change_description as string;
        const device_type = input.device_type as string | undefined;

        try {
          const analysis = await onAnalyzeChangeDiff({
            before_output,
            after_output,
            change_description,
            device_type,
          });
          return {
            content: JSON.stringify({ success: true, analysis }, null, 2),
            is_error: false,
          };
        } catch (err) {
          return {
            content: `Failed to analyze change diff: ${err instanceof Error ? err.message : 'Unknown error'}`,
            is_error: true,
          };
        }
      }

      case 'suggest_pre_checks': {
        if (!onSuggestPreChecks) {
          return { content: 'Pre-check suggestions not available in this context', is_error: true };
        }
        const change_type = input.change_type as string;
        const device_type = input.device_type as string;
        const affected_interface = input.affected_interface as string | undefined;

        try {
          const commands = await onSuggestPreChecks({
            change_type,
            device_type,
            affected_interface,
          });
          return {
            content: JSON.stringify({ success: true, commands }, null, 2),
            is_error: false,
          };
        } catch (err) {
          return {
            content: `Failed to suggest pre-checks: ${err instanceof Error ? err.message : 'Unknown error'}`,
            is_error: true,
          };
        }
      }

      case 'validate_change_result': {
        if (!onValidateChangeResult) {
          return { content: 'Change validation not available in this context', is_error: true };
        }
        const expected_outcome = input.expected_outcome as string;
        const actual_output = input.actual_output as string;
        const elapsed_time_seconds = input.elapsed_time_seconds as number | undefined;

        try {
          const result = await onValidateChangeResult({
            expected_outcome,
            actual_output,
            elapsed_time_seconds,
          });
          return {
            content: JSON.stringify(result, null, 2),
            is_error: false,
          };
        } catch (err) {
          return {
            content: `Failed to validate change result: ${err instanceof Error ? err.message : 'Unknown error'}`,
            is_error: true,
          };
        }
      }

      // Network lookup tools (Phase 19)
      case 'lookup_oui': {
        const mac_address = input.mac_address as string;
        try {
          const result = await lookupOui(mac_address);
          if (result.error) {
            return { content: `OUI lookup failed: ${result.error}`, is_error: true };
          }
          return {
            content: JSON.stringify({
              mac: result.mac,
              vendor: result.vendor || 'Unknown vendor',
            }, null, 2),
            is_error: false,
          };
        } catch (err) {
          return {
            content: `OUI lookup failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
            is_error: true,
          };
        }
      }

      case 'lookup_dns': {
        const query = input.query as string;
        try {
          const result = await lookupDns(query);
          if (result.error) {
            return { content: `DNS lookup failed: ${result.error}`, is_error: true };
          }
          return {
            content: JSON.stringify({
              query: result.query,
              type: result.query_type,
              results: result.results,
            }, null, 2),
            is_error: false,
          };
        } catch (err) {
          return {
            content: `DNS lookup failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
            is_error: true,
          };
        }
      }

      case 'lookup_whois': {
        const query = input.query as string;
        try {
          const result = await lookupWhois(query);
          if (result.error) {
            return { content: `WHOIS lookup failed: ${result.error}`, is_error: true };
          }
          return {
            content: JSON.stringify({
              query: result.query,
              summary: result.summary,
            }, null, 2),
            is_error: false,
          };
        } catch (err) {
          return {
            content: `WHOIS lookup failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
            is_error: true,
          };
        }
      }

      case 'lookup_asn': {
        const asn = input.asn as string;
        try {
          const result = await lookupAsn(asn);
          if (result.error) {
            return { content: `ASN lookup failed: ${result.error}`, is_error: true };
          }
          return {
            content: JSON.stringify({
              asn: result.asn,
              name: result.name,
              description: result.description,
              country: result.country,
            }, null, 2),
            is_error: false,
          };
        } catch (err) {
          return {
            content: `ASN lookup failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
            is_error: true,
          };
        }
      }

      // Neighbor discovery tools (Phase 22)
      case 'discover_neighbors': {
        if (!onDiscoverNeighbors) {
          return { content: 'Neighbor discovery not available in this context', is_error: true };
        }
        const session_id = input.session_id as string;
        const protocol = (input.protocol as 'cdp' | 'lldp' | 'auto') || 'auto';

        try {
          const result = await onDiscoverNeighbors(session_id, protocol);
          return {
            content: JSON.stringify({
              success: true,
              protocol: result.protocol,
              deviceName: result.deviceName,
              neighborCount: result.neighbors.length,
              neighbors: result.neighbors.map(n => ({
                neighborName: n.neighborName,
                neighborIp: n.neighborIp,
                localInterface: n.localInterface,
                neighborInterface: n.neighborInterface,
                neighborPlatform: n.neighborPlatform,
              })),
            }, null, 2),
            is_error: false,
          };
        } catch (err) {
          return {
            content: `Neighbor discovery failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
            is_error: true,
          };
        }
      }

      case 'add_neighbor_to_topology': {
        if (!onAddNeighborToTopology) {
          return { content: 'Add neighbor to topology not available in this context', is_error: true };
        }
        const topology_id = input.topology_id as string;
        const source_device_id = input.source_device_id as string;
        const neighbor_name = input.neighbor_name as string;
        const neighbor_ip = input.neighbor_ip as string | undefined;
        const local_interface = input.local_interface as string;
        const remote_interface = input.remote_interface as string | undefined;
        const device_type = input.device_type as string | undefined;

        try {
          const result = await onAddNeighborToTopology({
            topology_id,
            source_device_id,
            neighbor_name,
            neighbor_ip,
            local_interface,
            remote_interface,
            device_type,
          });
          return {
            content: JSON.stringify({
              success: true,
              deviceId: result.deviceId,
              connectionId: result.connectionId,
              message: `Added neighbor "${neighbor_name}" to topology and created connection.`,
            }, null, 2),
            is_error: false,
          };
        } catch (err) {
          return {
            content: `Failed to add neighbor to topology: ${err instanceof Error ? err.message : 'Unknown error'}`,
            is_error: true,
          };
        }
      }

      // NetBox topology tools (Phase 22)
      case 'netbox_get_neighbors': {
        if (!onNetBoxGetNeighbors) {
          return { content: 'NetBox neighbor query not available in this context', is_error: true };
        }
        const netbox_source_id = input.netbox_source_id as string;
        const netbox_device_id = input.netbox_device_id as number;

        try {
          const neighbors = await onNetBoxGetNeighbors(netbox_source_id, netbox_device_id);
          if (neighbors.length === 0) {
            return {
              content: JSON.stringify({
                message: 'No neighbors found for this device in NetBox.',
                neighbors: [],
              }, null, 2),
              is_error: false,
            };
          }
          return {
            content: JSON.stringify({
              message: `Found ${neighbors.length} neighbor(s) connected to this device.`,
              neighbors: neighbors.map(n => ({
                device_id: n.deviceId,
                device_name: n.deviceName,
                local_interface: n.localInterface,
                remote_interface: n.remoteInterface,
                cable_id: n.cableId,
                cable_label: n.cableLabel,
              })),
            }, null, 2),
            is_error: false,
          };
        } catch (err) {
          return {
            content: `NetBox neighbor query failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
            is_error: true,
          };
        }
      }

      case 'netbox_import_topology': {
        if (!onNetBoxImportTopology) {
          return { content: 'NetBox topology import not available in this context', is_error: true };
        }
        const netbox_source_id = input.netbox_source_id as string;
        const topology_id = input.topology_id as string;
        const site_slug = input.site_slug as string | undefined;
        const include_connections = (input.include_connections as boolean) ?? true;

        try {
          const result = await onNetBoxImportTopology({
            netbox_source_id,
            topology_id,
            site_slug,
            include_connections,
          });
          return {
            content: JSON.stringify({
              success: true,
              devices_created: result.devicesCreated,
              connections_created: result.connectionsCreated,
              message: `Successfully imported ${result.devicesCreated} devices and ${result.connectionsCreated} connections from NetBox.`,
            }, null, 2),
            is_error: false,
          };
        } catch (err) {
          return {
            content: `NetBox topology import failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
            is_error: true,
          };
        }
      }

      // Integration sources discovery tool
      case 'list_integration_sources': {
        try {
          const sources: { netbox: { id: string; name: string; url: string }[] } = {
            netbox: [],
          };
          try { sources.netbox = (await listNetBoxSources()).map(s => ({ id: s.id, name: s.name, url: s.url })); } catch { /* no sources */ }

          // Also report connected MCP servers — these provide tools the AI can call directly
          const mcpServersInfo = mcpServersRef.current.map(s => ({
            name: s.name,
            server_type: s.server_type,
            tools: s.tools.filter(t => t.enabled).map(t => ({
              tool_name: sanitizeToolName(`mcp:${s.id}:${t.name}`),
              description: t.description || t.name,
            })),
          }));

          return {
            content: JSON.stringify({
              message: 'Configured integration sources and MCP servers. For built-in integrations, use the source ID when calling integration tools. For MCP servers, call the MCP tools directly by their tool_name.',
              sources,
              mcp_servers: mcpServersInfo,
            }, null, 2),
            is_error: false,
          };
        } catch (err) {
          return {
            content: `Failed to list integration sources: ${err instanceof Error ? err.message : 'Unknown error'}`,
            is_error: true,
          };
        }
      }

      case 'update_topology_device': {
        // Update topology device with enrichment data
        const topologyId = input.topology_id as string;
        const deviceId = input.device_id as string;

        if (!topologyId || !deviceId) {
          return {
            content: 'topology_id and device_id are required',
            is_error: true,
          };
        }

        // Build update payload with only provided fields
        const updatePayload: Record<string, string> = {};
        const fieldNames = ['device_type', 'platform', 'version', 'model', 'serial', 'vendor', 'primary_ip', 'uptime', 'status', 'site', 'role', 'notes'];
        for (const field of fieldNames) {
          if (input[field]) {
            updatePayload[field] = input[field] as string;
          }
        }

        if (Object.keys(updatePayload).length === 0) {
          return {
            content: 'No fields provided to update',
            is_error: true,
          };
        }

        try {
          await getClient().http.put(`/topologies/${topologyId}/devices/${deviceId}/details`, updatePayload);

          // Trigger topology refresh so UI shows updated data
          console.log('[AI Agent] update_topology_device succeeded, calling onTopologyDeviceUpdated callback');
          if (onTopologyDeviceUpdated) {
            console.log('[AI Agent] Calling onTopologyDeviceUpdated with topologyId:', topologyId);
            onTopologyDeviceUpdated(topologyId);
          } else {
            console.warn('[AI Agent] onTopologyDeviceUpdated callback is NOT defined');
          }

          const fieldList = Object.keys(updatePayload).join(', ');
          return {
            content: `Successfully updated device ${deviceId} with: ${fieldList}`,
            is_error: false,
          };
        } catch (err) {
          return {
            content: `Device update failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
            is_error: true,
          };
        }
      }

      // MOP creation tool
      case 'create_mop': {
        if (!onCreateMop) {
          return { content: 'MOP creation not available in this context. Make sure you are using the AI from the Changes tab.', is_error: true };
        }

        const name = input.name as string;
        const description = input.description as string | undefined;
        const sessionIdsStr = input.session_ids as string;
        const preChecksStr = input.pre_checks as string;
        const changesStr = input.changes as string;
        const postChecksStr = input.post_checks as string;
        const rollbackStr = input.rollback as string | undefined;

        // Parse session IDs
        const sessionIds = sessionIdsStr.split(',').map(s => s.trim()).filter(s => s.length > 0);
        if (sessionIds.length === 0) {
          return { content: 'At least one session ID is required', is_error: true };
        }

        // Parse JSON arrays for steps
        let preChecks: Array<{ command: string; description?: string; expected_output?: string }>;
        let changes: Array<{ command: string; description?: string }>;
        let postChecks: Array<{ command: string; description?: string; expected_output?: string }>;
        let rollback: Array<{ command: string; description?: string }> | undefined;

        try {
          preChecks = JSON.parse(preChecksStr);
          changes = JSON.parse(changesStr);
          postChecks = JSON.parse(postChecksStr);
          if (rollbackStr) {
            rollback = JSON.parse(rollbackStr);
          }
        } catch (parseErr) {
          return {
            content: `Failed to parse step JSON arrays: ${parseErr instanceof Error ? parseErr.message : 'Invalid JSON'}. Make sure pre_checks, changes, and post_checks are valid JSON arrays.`,
            is_error: true,
          };
        }

        // Validate we have at least some steps
        if (preChecks.length === 0) {
          return { content: 'At least one pre_check command is required', is_error: true };
        }
        if (changes.length === 0) {
          return { content: 'At least one change command is required', is_error: true };
        }
        if (postChecks.length === 0) {
          return { content: 'At least one post_check command is required', is_error: true };
        }

        try {
          const result = await onCreateMop({
            name,
            description,
            session_ids: sessionIds,
            pre_checks: preChecks,
            changes,
            post_checks: postChecks,
            rollback,
          });

          return {
            content: JSON.stringify({
              success: true,
              change_id: result.changeId,
              change_name: result.changeName,
              message: `MOP "${result.changeName}" created successfully. The user can now review and execute it in the Changes tab.`,
              steps_created: {
                pre_checks: preChecks.length,
                changes: changes.length,
                post_checks: postChecks.length,
                rollback: rollback?.length || 0,
              },
              target_sessions: sessionIds.length,
            }, null, 2),
            is_error: false,
          };
        } catch (err) {
          return {
            content: `Failed to create MOP: ${err instanceof Error ? err.message : 'Unknown error'}`,
            is_error: true,
          };
        }
      }

      // MOP list/get/export/import tools
      case 'list_mops': {
        try {
          const { listChanges } = await import('../api/changes');
          const changes = await listChanges();
          const mops = changes.map(c => ({
            id: c.id,
            name: c.name,
            status: c.status,
            step_count: c.mop_steps?.length || 0,
            step_types: {
              pre_check: c.mop_steps?.filter(s => s.step_type === 'pre_check').length || 0,
              change: c.mop_steps?.filter(s => s.step_type === 'change').length || 0,
              post_check: c.mop_steps?.filter(s => s.step_type === 'post_check').length || 0,
              rollback: c.mop_steps?.filter(s => s.step_type === 'rollback').length || 0,
            },
            has_device_overrides: !!c.device_overrides && Object.keys(c.device_overrides).length > 0,
            created_by: c.created_by,
            created_at: c.created_at,
            updated_at: c.updated_at,
          }));
          return { content: JSON.stringify({ mops, count: mops.length }, null, 2), is_error: false };
        } catch (err) {
          return { content: `Failed to list MOPs: ${err instanceof Error ? err.message : 'Unknown error'}`, is_error: true };
        }
      }

      case 'get_mop': {
        const mopId = input.mop_id as string;
        if (!mopId) return { content: 'mop_id is required', is_error: true };
        try {
          const { getChange } = await import('../api/changes');
          const change = await getChange(mopId);
          return {
            content: JSON.stringify({
              id: change.id,
              name: change.name,
              description: change.description,
              status: change.status,
              steps: change.mop_steps,
              device_overrides: change.device_overrides,
              document_id: change.document_id,
              ai_analysis: change.ai_analysis,
              created_by: change.created_by,
              created_at: change.created_at,
              updated_at: change.updated_at,
              executed_at: change.executed_at,
              completed_at: change.completed_at,
            }, null, 2),
            is_error: false,
          };
        } catch (err) {
          return { content: `Failed to get MOP: ${err instanceof Error ? err.message : 'Unknown error'}`, is_error: true };
        }
      }

      case 'export_mop': {
        const exportMopId = input.mop_id as string;
        if (!exportMopId) return { content: 'mop_id is required', is_error: true };
        try {
          const { exportMopPackage } = await import('../lib/mopExport');
          const pkg = await exportMopPackage(exportMopId);
          return {
            content: JSON.stringify({
              message: `MOP "${pkg.mop.name}" exported successfully (${pkg.mop.steps.length} steps)`,
              package: pkg,
            }, null, 2),
            is_error: false,
          };
        } catch (err) {
          return { content: `Failed to export MOP: ${err instanceof Error ? err.message : 'Unknown error'}`, is_error: true };
        }
      }

      case 'import_mop': {
        const packageJson = input.package_json as string;
        if (!packageJson) return { content: 'package_json is required', is_error: true };
        try {
          const { parseMopPackageJson, importMopPackage } = await import('../lib/mopExport');
          const { package: pkg, warnings } = parseMopPackageJson(packageJson);
          const result = await importMopPackage(pkg);
          return {
            content: JSON.stringify({
              message: `MOP "${result.name}" imported successfully`,
              change_id: result.change_id,
              steps_imported: result.steps_imported,
              overrides_imported: result.overrides_imported,
              warnings: [...warnings, ...result.warnings],
            }, null, 2),
            is_error: false,
          };
        } catch (err) {
          return { content: `Failed to import MOP: ${err instanceof Error ? err.message : 'Unknown error'}`, is_error: true };
        }
      }

      // AI Memory tools
      case 'save_memory': {
        const { content, category } = input as { content: string; category: string };
        try {
          await getClient().http.post('/ai/memory', { content, category, source: 'ai' });
          return {
            content: `Memory saved: "${content}" [${category}]`,
            is_error: false,
          };
        } catch (err) {
          return {
            content: `Failed to save memory: ${err instanceof Error ? err.message : 'Unknown error'}`,
            is_error: true,
          };
        }
      }

      case 'recall_memories': {
        const { category } = input as { category?: string };
        try {
          const params = category ? `?category=${encodeURIComponent(category)}` : '';
          const res = await getClient().http.get(`/ai/memory${params}`);
          const memories = res.data?.memories || [];
          if (memories.length === 0) {
            return { content: 'No memories found.', is_error: false };
          }
          const formatted = memories.map((m: { category: string; content: string }) => `[${m.category}] ${m.content}`).join('\n');
          return {
            content: `Found ${memories.length} memories:\n${formatted}`,
            is_error: false,
          };
        } catch (err) {
          return {
            content: `Failed to recall memories: ${err instanceof Error ? err.message : 'Unknown error'}`,
            is_error: true,
          };
        }
      }

      case 'list_agent_definitions': {
        try {
          const agents = await listAgentDefinitions();
          if (agents.length === 0) {
            return { content: 'No agent definitions found. Use spawn_agent_task without agent_id to create a generic task.', is_error: false };
          }
          const formatted = agents
            .filter(a => a.enabled)
            .map(a => `- **${a.name}** (id: ${a.id})${a.description ? `: ${a.description}` : ''}`)
            .join('\n');
          return {
            content: `Available AI agents:\n${formatted}\n\nUse the agent's id with spawn_agent_task to delegate to a specialist.`,
            is_error: false,
          };
        } catch (err) {
          return { content: `Failed to list agents: ${err instanceof Error ? err.message : 'Unknown error'}`, is_error: true };
        }
      }

      case 'spawn_agent_task': {
        const { prompt, agent_id, timeout_seconds } = input as { prompt: string; agent_id?: string; timeout_seconds?: string };
        const timeout = parseInt(timeout_seconds || '300', 10) * 1000; // Convert to ms
        try {
          // Create the task — use agent definition if specified, otherwise generic
          const task = agent_id
            ? await runAgentDefinition(agent_id, prompt)
            : await createTask({ prompt });
          console.log(`[AI Agent] Spawned background task: ${task.id}${agent_id ? ` (agent: ${agent_id})` : ' (generic)'}`);

          // Poll for completion
          const startTime = Date.now();
          const pollInterval = 3000; // 3 seconds

          while (Date.now() - startTime < timeout) {
            await new Promise(resolve => setTimeout(resolve, pollInterval));

            try {
              const updated = await getTask(task.id);

              if (updated.status === 'completed') {
                // Parse result — may be JSON with answer field or plain text
                let resultText = updated.result_json || 'Task completed with no output.';
                try {
                  const parsed = JSON.parse(resultText);
                  resultText = parsed.answer || parsed.result || parsed.final_answer || resultText;
                } catch {
                  // result_json is already plain text
                }
                return {
                  content: `Background task completed (${task.id.slice(0, 8)}):\n\n${resultText}`,
                  is_error: false,
                };
              }

              if (updated.status === 'failed') {
                return {
                  content: `Background task failed: ${updated.error_message || 'Unknown error'}`,
                  is_error: true,
                };
              }

              if (updated.status === 'cancelled') {
                return {
                  content: 'Background task was cancelled by the user.',
                  is_error: true,
                };
              }

              // Still running — continue polling
            } catch {
              // Transient error fetching task status, continue polling
            }
          }

          // Timeout reached
          return {
            content: `Background task ${task.id.slice(0, 8)} is still running after ${Math.round(timeout / 1000)}s. Check the Agents panel for results. Task ID: ${task.id}`,
            is_error: false,
          };
        } catch (err) {
          return {
            content: `Failed to spawn background task: ${err instanceof Error ? err.message : 'Unknown error'}`,
            is_error: true,
          };
        }
      }

      // Remote file operation tools (AI Terminal Mode)
      case 'write_file': {
        try {
          const response = await getClient().http.post('/ai/write-file', {
            session_id: input.session_id as string,
            filepath: input.filepath as string,
            content: input.content as string,
          });
          const result = response.data;
          return { content: result.output || result.error || 'Unknown result', is_error: !result.success };
        } catch (err) {
          return { content: `write_file failed: ${err instanceof Error ? err.message : 'Unknown error'}`, is_error: true };
        }
      }

      case 'edit_file': {
        try {
          const response = await getClient().http.post('/ai/edit-file', {
            session_id: input.session_id as string,
            filepath: input.filepath as string,
            old_text: input.old_text as string,
            new_text: input.new_text as string,
          });
          const result = response.data;
          return { content: result.output || result.error || 'Unknown result', is_error: !result.success };
        } catch (err) {
          return { content: `edit_file failed: ${err instanceof Error ? err.message : 'Unknown error'}`, is_error: true };
        }
      }

      case 'patch_file': {
        try {
          const response = await getClient().http.post('/ai/patch-file', {
            session_id: input.session_id as string,
            filepath: input.filepath as string,
            sed_expression: input.sed_expression as string,
          });
          const result = response.data;
          return { content: result.output || result.error || 'Unknown result', is_error: !result.success };
        } catch (err) {
          return { content: `patch_file failed: ${err instanceof Error ? err.message : 'Unknown error'}`, is_error: true };
        }
      }

      // UI Navigation Tools (frontend-only)
      case 'navigate_to_backup': {
        const deviceId = input.device_id as string;
        const deviceName = input.device_name as string;
        const searchText = input.search_text as string | undefined;
        if (onNavigateToBackupRef.current) {
          onNavigateToBackupRef.current(deviceId, deviceName, searchText);
          return { content: `Opened backup history for ${deviceName}${searchText ? ` (searching for "${searchText}")` : ''}`, is_error: false };
        }
        return { content: 'Backup navigation not available in this context', is_error: false };
      }

      case 'navigate_to_device': {
        const deviceId = input.device_id as string;
        const deviceName = input.device_name as string;
        if (onNavigateToDeviceRef.current) {
          onNavigateToDeviceRef.current(deviceId, deviceName);
          return { content: `Opened device detail for ${deviceName}`, is_error: false };
        }
        return { content: 'Device navigation not available in this context', is_error: false };
      }

      case 'open_terminal_session': {
        const deviceName = input.device_name as string;
        if (onOpenTerminalSessionRef.current) {
          onOpenTerminalSessionRef.current(deviceName);
          return { content: `Opening terminal session to ${deviceName}`, is_error: false };
        }
        return { content: 'Terminal session not available in this context', is_error: false };
      }

      case 'navigate_to_mop': {
        const mopId = input.mop_id as string;
        const mopName = input.mop_name as string;
        if (onNavigateToMopRef.current) {
          onNavigateToMopRef.current(mopId, mopName);
          return { content: `Opened MOP: ${mopName}`, is_error: false };
        }
        return { content: 'MOP navigation not available in this context', is_error: false };
      }

      case 'navigate_to_topology': {
        const topologyName = input.topology_name as string;
        if (onNavigateToTopologyRef.current) {
          onNavigateToTopologyRef.current(topologyName);
          return { content: `Opened topology: ${topologyName}`, is_error: false };
        }
        return { content: 'Topology navigation not available in this context', is_error: false };
      }

      case 'navigate_to_settings': {
        const tab = input.tab as string | undefined;
        if (onNavigateToSettingsRef.current) {
          onNavigateToSettingsRef.current(tab);
          return { content: `Opened Settings${tab ? ` → ${tab}` : ''}`, is_error: false };
        }
        return { content: 'Settings navigation not available in this context', is_error: false };
      }

      default: {
        // Check if it's a topology tool (Phase 27-07)
        if (isTopologyTool(toolName) && topologyCallbacks) {
          return executeTopologyTool(toolName, input, topologyCallbacks);
        }
        // Check if it's an MCP tool (mcp:{server_id}:{tool_name})
        if (toolName.startsWith('mcp:')) {
          const parts = toolName.split(':');
          if (parts.length >= 3) {
            const serverId = parts[1];
            const mcpToolName = parts.slice(2).join(':');
            const server = mcpServersRef.current.find(s => s.id === serverId);
            const tool = server?.tools.find(t => t.name === mcpToolName);
            if (tool) {
              try {
                return await executeMcpTool(tool.id, input);
              } catch (e) {
                return { content: `MCP tool error: ${e instanceof Error ? e.message : String(e)}`, is_error: true };
              }
            }
            return { content: `MCP tool not found: ${mcpToolName} on server ${serverId}`, is_error: true };
          }
        }
        return { content: `Unknown tool: ${toolName}`, is_error: true };
      }
    }
  }, [sessions, onExecuteCommand, getTerminalContext, addMessage, onListDocuments, onReadDocument, onSearchDocuments, onSaveDocument, onAddSessionContext, onListSessionContext, onAnalyzeChangeDiff, onSuggestPreChecks, onValidateChangeResult, onDiscoverNeighbors, onAddNeighborToTopology, onNetBoxGetNeighbors, onNetBoxImportTopology, onCreateMop, onTopologyDeviceUpdated, topologyCallbacks]);

  // Wait for approval if needed
  const waitForApproval = useCallback(async (
    commands: Array<{ id: string; name: string; command: string; sessionId: string; validation: ValidationResult }>
  ): Promise<boolean> => {
    const pending: PendingCommand[] = commands.map(c => {
      const session = sessions.find(s => s.id === c.sessionId);
      return {
        id: c.id,
        command: c.command,
        sessionId: c.sessionId,
        sessionName: session?.name || c.sessionId,
        validation: c.validation,
      };
    });

    setPendingCommands(pending);
    setAgentState('waiting_approval');

    // Wait for user approval
    return new Promise((resolve) => {
      approvalResolverRef.current = { resolve };
    });
  }, [sessions]);

  // Call the agent-chat API
  const callAgentApi = useCallback(async (
    messages: AgentChatMessage[],
    tools: object[],
    signal?: AbortSignal
  ): Promise<AgentChatResponse> => {
    // Build request body - include provider/model if specified
    const settings = getSettings();
    const requestBody: {
      messages: AgentChatMessage[];
      tools: object[];
      provider?: string;
      model?: string;
      max_tokens?: number;
      system_prompt?: string;
    } = { messages, tools };

    // AUDIT FIX (EXEC-002): the legacy `allow_config_changes` request-body
    // field is no longer sent — the backend ignores it. Use
    // `enableAiConfigMode` from `api/ai.ts` to flip the server-side state.

    // Set mode-based system prompt as the default
    if (aiModeRef.current) {
      const isEnterprise = useCapabilitiesStore.getState().isEnterprise?.() ?? false;
      requestBody.system_prompt = getModeSystemPromptFn(aiModeRef.current, isEnterprise);
    }

    // Override with special context prompts when active
    if (scriptContextRef.current) {
      // Script copilot mode: provide script context and copilot instructions
      const sc = scriptContextRef.current;
      const scriptContent = sc.getContent();
      requestBody.system_prompt = `You are an AI copilot for a Python network automation script editor in NetStacks.
The user is editing a script called "${sc.name}".

Current script content:
\`\`\`python
${scriptContent}
\`\`\`

When suggesting code changes:
1. Output the COMPLETE updated script in a \`\`\`python code block
2. Briefly explain what you changed and why

IMPORTANT — NetStacks Script Execution Model:
- Scripts are executed with \`uv run --script\` which handles dependencies automatically via PEP 723 inline metadata
- If a script defines \`def main(...)\`, NetStacks automatically appends a caller that invokes main() with parameters from the UI. Do NOT add \`if __name__ == "__main__":\` blocks — they are unnecessary and will be ignored
- Parameters are passed via the NETSTACKS_ARGS environment variable (JSON), NOT via sys.argv or command-line arguments
- Simply define \`def main(param_name: type):\` and NetStacks handles the rest
- Scripts WITHOUT a main() function run top-to-bottom as normal Python
- Dependencies are declared via PEP 723 script metadata (# /// script / requires-python / dependencies). NetStacks auto-prepends default metadata (netmiko, napalm, etc.) if none is present

Guidelines:
- Use Python 3 with proper error handling
- For network automation, prefer netmiko, napalm, or paramiko
- Keep scripts practical and production-ready
- The script may receive device context via environment variables:
  NETSTACKS_DEVICE, NETSTACKS_DEVICE_HOST, NETSTACKS_DEVICE_NAME, NETSTACKS_DEVICE_TYPE, NETSTACKS_INPUT
- Be concise — network engineers appreciate direct answers
- You can also help with general questions about the script, debugging, optimization, etc.`;
    } else if (topologyCallbacks) {
      // When topology tools are active, append topology prompt to system prompt
      const topoPrompt = topologyPromptRef.current || DEFAULT_TOPOLOGY_PROMPT;
      requestBody.system_prompt = '\n\n' + topoPrompt;
    }

    // Inject active session context — tells the AI which terminal is focused
    // so "this device", "this server", etc. resolve to the right session
    if (activeSessionIdRef.current) {
      const sessionName = activeSessionNameRef.current || activeSessionIdRef.current;
      const sessionContext = `\n\nACTIVE SESSION CONTEXT:\n` +
        `The user is currently focused on terminal session "${sessionName}" (session ID: ${activeSessionIdRef.current}). ` +
        `When the user says "this", "this device", "this server", "this session", "it", or similar references, ` +
        `they are referring to this session. Use this session ID for get_terminal_context and execute_command ` +
        `calls unless the user explicitly specifies a different session. Do NOT ask the user which session ` +
        `they mean — use the active session automatically.`;
      requestBody.system_prompt = (requestBody.system_prompt || '') + sessionContext;
    }

    if (provider) {
      requestBody.provider = provider;
      // Get max tokens for this provider from settings
      const maxTokensKey = `ai.maxTokens.${provider}` as keyof typeof settings;
      const maxTokens = settings[maxTokensKey] as number;
      if (maxTokens && maxTokens > 0) {
        requestBody.max_tokens = maxTokens;
      }
    }
    if (model) {
      requestBody.model = model;
    }

    try {
      const response = await getClient().http.post('/ai/agent-chat', requestBody, { signal });
      return response.data;
    } catch (err: unknown) {
      // Extract error detail from response body if available
      const axiosErr = err as { response?: { data?: { error?: string }; status?: number } };
      if (axiosErr.response?.data?.error) {
        throw new Error(`AI provider error (${axiosErr.response.status}): ${axiosErr.response.data.error}`);
      }
      throw err;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- topologyCallbacks is stable per hook mount
  }, [provider, model]);

  // Call the agent-chat-stream API (SSE streaming variant)
  const callAgentApiStream = useCallback(async function* (
    messages: AgentChatMessage[],
    tools: object[],
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    // Build request body — SAME logic as callAgentApi
    const settings = getSettings();
    const requestBody: {
      messages: AgentChatMessage[];
      tools: object[];
      provider?: string;
      model?: string;
      max_tokens?: number;
      system_prompt?: string;
    } = { messages, tools };

    // AUDIT FIX (EXEC-002): the legacy `allow_config_changes` request-body
    // field is no longer sent — the backend ignores it. Use
    // `enableAiConfigMode` from `api/ai.ts` to flip the server-side state.

    // Set mode-based system prompt as the default
    if (aiModeRef.current) {
      const isEnterprise = useCapabilitiesStore.getState().isEnterprise?.() ?? false;
      requestBody.system_prompt = getModeSystemPromptFn(aiModeRef.current, isEnterprise);
    }

    // Override with special context prompts when active
    if (scriptContextRef.current) {
      // Script copilot mode: provide script context and copilot instructions
      const sc = scriptContextRef.current;
      const scriptContent = sc.getContent();
      requestBody.system_prompt = `You are an AI copilot for a Python network automation script editor in NetStacks.
The user is editing a script called "${sc.name}".

Current script content:
\`\`\`python
${scriptContent}
\`\`\`

When suggesting code changes:
1. Output the COMPLETE updated script in a \`\`\`python code block
2. Briefly explain what you changed and why

IMPORTANT — NetStacks Script Execution Model:
- Scripts are executed with \`uv run --script\` which handles dependencies automatically via PEP 723 inline metadata
- If a script defines \`def main(...)\`, NetStacks automatically appends a caller that invokes main() with parameters from the UI. Do NOT add \`if __name__ == "__main__":\` blocks — they are unnecessary and will be ignored
- Parameters are passed via the NETSTACKS_ARGS environment variable (JSON), NOT via sys.argv or command-line arguments
- Simply define \`def main(param_name: type):\` and NetStacks handles the rest
- Scripts WITHOUT a main() function run top-to-bottom as normal Python
- Dependencies are declared via PEP 723 script metadata (# /// script / requires-python / dependencies). NetStacks auto-prepends default metadata (netmiko, napalm, etc.) if none is present

Guidelines:
- Use Python 3 with proper error handling
- For network automation, prefer netmiko, napalm, or paramiko
- Keep scripts practical and production-ready
- The script may receive device context via environment variables:
  NETSTACKS_DEVICE, NETSTACKS_DEVICE_HOST, NETSTACKS_DEVICE_NAME, NETSTACKS_DEVICE_TYPE, NETSTACKS_INPUT
- Be concise — network engineers appreciate direct answers
- You can also help with general questions about the script, debugging, optimization, etc.`;
    } else if (topologyCallbacks) {
      // When topology tools are active, append topology prompt to system prompt
      const topoPrompt = topologyPromptRef.current || DEFAULT_TOPOLOGY_PROMPT;
      requestBody.system_prompt = '\n\n' + topoPrompt;
    }

    // Inject active session context — tells the AI which terminal is focused
    if (activeSessionIdRef.current) {
      const sessionName = activeSessionNameRef.current || activeSessionIdRef.current;
      const sessionContext = `\n\nACTIVE SESSION CONTEXT:\n` +
        `The user is currently focused on terminal session "${sessionName}" (session ID: ${activeSessionIdRef.current}). ` +
        `When the user says "this", "this device", "this server", "this session", "it", or similar references, ` +
        `they are referring to this session. Use this session ID for get_terminal_context and execute_command ` +
        `calls unless the user explicitly specifies a different session. Do NOT ask the user which session ` +
        `they mean — use the active session automatically.`;
      requestBody.system_prompt = (requestBody.system_prompt || '') + sessionContext;
    }

    if (provider) {
      requestBody.provider = provider;
      // Get max tokens for this provider from settings
      const maxTokensKey = `ai.maxTokens.${provider}` as keyof typeof settings;
      const maxTokens = settings[maxTokensKey] as number;
      if (maxTokens && maxTokens > 0) {
        requestBody.max_tokens = maxTokens;
      }
    }
    if (model) {
      requestBody.model = model;
    }

    // Use fetch for streaming (not Axios — Axios doesn't support ReadableStream)
    const client = getClient();
    const baseUrl = client.http.defaults.baseURL || `${client.baseUrl}/api`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    // Include auth token — Axios interceptors don't apply to fetch()
    // Standalone mode: sidecar JWT token; Enterprise mode: user access token
    if (client.mode === 'enterprise') {
      const accessToken = useAuthStore.getState().accessToken;
      if (accessToken) {
        headers['Authorization'] = `Bearer ${accessToken}`;
      }
    } else {
      // Standalone/professional mode — get sidecar auth token
      const { getSidecarAuthToken } = await import('../api/localClient');
      const sidecarToken = getSidecarAuthToken();
      if (sidecarToken) {
        headers['Authorization'] = `Bearer ${sidecarToken}`;
      }
    }

    const response = await fetch(`${baseUrl}/ai/agent-chat-stream`, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`AI provider error (${response.status}): ${errorText}`);
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('event:') || trimmed === ':') continue;
          if (trimmed.startsWith('data: ')) {
            try {
              const event: StreamEvent = JSON.parse(trimmed.slice(6));
              yield event;
            } catch {
              /* skip unparseable SSE data */
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- topologyCallbacks is stable per hook mount
  }, [provider, model]);

  // Main agent loop
  const runAgentLoop = useCallback(async () => {
    const tools = toolsToAnthropicFormat(availableTools);
    console.log(`[AI Agent] Starting loop with ${tools.length} tools`);

    // Create AbortController for this agent loop
    abortControllerRef.current = new AbortController();
    const signal = abortControllerRef.current.signal;

    while (!stopRequestedRef.current) {
      setAgentState('thinking');

      try {
        // Truncate conversation if it exceeds the max messages limit
        const maxMessages = getSettings()['ai.maxConversationMessages'] || 20;
        if (maxMessages > 0 && conversationRef.current.length > maxMessages) {
          console.log(`[AI Agent] Truncating conversation from ${conversationRef.current.length} to ${maxMessages} messages`);
          // Keep the most recent messages, but ensure we don't break
          // tool_use/tool_result pairs. The Anthropic API requires that every
          // tool_result in a user message references a tool_use_id from the
          // immediately preceding assistant message. A naive slice can orphan
          // tool_result blocks, causing a 400 error.
          let sliceStart = conversationRef.current.length - maxMessages;
          const msgs = conversationRef.current;
          // Walk forward from the slice point to find a safe boundary.
          // A safe boundary is where the message at sliceStart is NOT a user
          // message containing tool_result blocks (which would be orphaned).
          while (sliceStart < msgs.length - 1) {
            const msg = msgs[sliceStart];
            if (msg.role === 'user' && Array.isArray(msg.content)) {
              const hasToolResult = msg.content.some(
                (block: ContentBlock) => block.type === 'tool_result'
              );
              if (hasToolResult) {
                // This user message has tool_results that reference a tool_use
                // in the previous (now-truncated) assistant message. Skip it.
                sliceStart++;
                continue;
              }
            }
            break;
          }
          conversationRef.current = msgs.slice(sliceStart);
        }

        console.log('[AI Agent] Calling API with', conversationRef.current.length, 'messages and', tools.length, 'tools');
        const response = await callAgentApi(conversationRef.current, tools, signal);

        // Check if stop was requested while waiting for API response
        if (stopRequestedRef.current) {
          console.log('[AI Agent] Stop requested after API response, breaking loop');
          setAgentState('idle');
          break;
        }
        console.log(`[AI Agent] Response: stop=${response.stop_reason}, tools=${response.tool_use.length}, tokens=${response.usage?.total_tokens || 0}`);

        // Track token usage if available
        if (response.usage) {
          const inputTokens = response.usage.input_tokens;
          const outputTokens = response.usage.output_tokens;
          const totalTokens = response.usage.total_tokens || (inputTokens + outputTokens);

          // Track in local state (per-session)
          setTokenUsage(prev => ({
            inputTokens: prev.inputTokens + inputTokens,
            outputTokens: prev.outputTokens + outputTokens,
            totalTokens: prev.totalTokens + totalTokens,
            requestCount: prev.requestCount + 1,
          }));

          // Track in global state (across platform)
          if (globalTokenTracker && provider) {
            globalTokenTracker.trackUsage(provider as GlobalProviderType, {
              inputTokens,
              outputTokens,
              totalTokens,
            });
          }
        }

        // Add any text response to messages
        if (response.text) {
          addMessage(createThinkingMessage(response.text));
        }

        // Add assistant response to conversation history
        // IMPORTANT: This must happen BEFORE the end_turn check so text-only
        // responses are included in history for subsequent messages.
        const assistantContent: ContentBlock[] = [];
        if (response.text) {
          assistantContent.push({ type: 'text', text: response.text });
        }
        for (const toolUse of response.tool_use) {
          assistantContent.push({
            type: 'tool_use',
            id: toolUse.id,
            name: toolUse.name, // Keep sanitized name for API
            input: toolUse.input,
          });
        }
        if (assistantContent.length > 0) {
          conversationRef.current.push({
            role: 'assistant',
            content: assistantContent,
          });
        }

        // Check if we're done (end_turn, no tools, or single-turn mode)
        if (response.stop_reason === 'end_turn' || response.tool_use.length === 0 || singleTurn) {
          console.log('[AI Agent] Stopping loop - stop_reason:', response.stop_reason, 'tool_use count:', response.tool_use.length, 'singleTurn:', singleTurn);
          setAgentState('idle');
          break;
        }

        // Process tool calls
        const toolResults: ContentBlock[] = [];

        // Unsanitize tool names for local execution (mcp_id_name -> mcp:id:name)
        for (const tu of response.tool_use) {
          tu.name = unsanitizeToolName(tu.name);
        }

        // Check if any commands need approval
        const commandToolCalls = response.tool_use.filter(t => t.name === 'run_command');

        if (commandToolCalls.length > 0 && autonomyLevel !== 'safe-auto') {
          // Need approval for commands
          const commandsToApprove = commandToolCalls.map(t => {
            const sessionId = t.input.session_id as string;
            const command = t.input.command as string;
            const session = sessions.find(s => s.id === sessionId);
            return {
              id: t.id,
              name: t.name,
              command,
              sessionId,
              validation: validateReadOnlyCommand(command, session?.cliFlavor),
            };
          });

          const approved = await waitForApproval(commandsToApprove);

          if (!approved || stopRequestedRef.current) {
            // User rejected - add rejection results
            for (const cmd of commandsToApprove) {
              toolResults.push({
                type: 'tool_result',
                tool_use_id: cmd.id,
                content: 'User rejected this command execution.',
                is_error: true,
              });
            }

            // Still need to process non-command tools
            for (const toolUse of response.tool_use) {
              if (toolUse.name !== 'run_command') {
                const result = await executeTool(toolUse.name, toolUse.input);
                toolResults.push({
                  type: 'tool_result',
                  tool_use_id: toolUse.id,
                  content: truncateToolResult(result.content),
                  is_error: result.is_error,
                });
              }
            }
          } else {
            // Approved - execute all tools
            setAgentState('executing');

            for (const toolUse of response.tool_use) {
              if (stopRequestedRef.current) break;

              const result = await executeTool(toolUse.name, toolUse.input);

              // Add command result message for run_command
              if (toolUse.name === 'run_command') {
                const sessionId = toolUse.input.session_id as string;
                const command = toolUse.input.command as string;
                const session = sessions.find(s => s.id === sessionId);
                addMessage(createCommandResultMessage(
                  command,
                  result.content,
                  sessionId,
                  session?.name || sessionId
                ));
              }

              toolResults.push({
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: truncateToolResult(result.content),
                is_error: result.is_error,
              });
            }
          }
        } else {
          // Auto-execute (safe-auto mode or no commands)
          setAgentState('executing');

          for (const toolUse of response.tool_use) {
            if (stopRequestedRef.current) break;

            const result = await executeTool(toolUse.name, toolUse.input);

            // Add command result message for run_command
            if (toolUse.name === 'run_command') {
              const sessionId = toolUse.input.session_id as string;
              const command = toolUse.input.command as string;
              const session = sessions.find(s => s.id === sessionId);
              addMessage(createCommandResultMessage(
                command,
                result.content,
                sessionId,
                session?.name || sessionId
              ));
            }

            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: truncateToolResult(result.content),
              is_error: result.is_error,
            });
          }
        }

        // Add tool results as user message
        conversationRef.current.push({
          role: 'user',
          content: toolResults,
        });

        // Clear pending commands
        setPendingCommands([]);

      } catch (err) {
        // Handle abort gracefully (user clicked stop)
        if (err instanceof Error && err.name === 'AbortError') {
          console.log('[AI Agent] Request aborted by user');
          setAgentState('idle');
          break;
        }
        const errorMsg = err instanceof Error ? err.message : 'Unknown error';
        addMessage(createErrorMessage(`Agent error: ${errorMsg}`));
        setAgentState('error');
        break;
      }
    }

    // Cleanup
    stopRequestedRef.current = false;
    abortControllerRef.current = null;
  }, [callAgentApi, executeTool, waitForApproval, addMessage, autonomyLevel, sessions, availableTools, singleTurn]);

  // Streaming variant of the agent loop — uses SSE events for progressive text rendering
  const runAgentLoopStreaming = useCallback(async () => {
    const tools = toolsToAnthropicFormat(availableTools);
    console.log(`[AI Agent] Starting streaming loop with ${tools.length} tools`);

    // Create AbortController for this agent loop
    abortControllerRef.current = new AbortController();
    const signal = abortControllerRef.current.signal;

    while (!stopRequestedRef.current) {
      setAgentState('thinking');

      try {
        // Truncate conversation if it exceeds the max messages limit
        const maxMessages = getSettings()['ai.maxConversationMessages'] || 20;
        if (maxMessages > 0 && conversationRef.current.length > maxMessages) {
          console.log(`[AI Agent] Truncating conversation from ${conversationRef.current.length} to ${maxMessages} messages`);
          let sliceStart = conversationRef.current.length - maxMessages;
          const msgs = conversationRef.current;
          while (sliceStart < msgs.length - 1) {
            const msg = msgs[sliceStart];
            if (msg.role === 'user' && Array.isArray(msg.content)) {
              const hasToolResult = msg.content.some(
                (block: ContentBlock) => block.type === 'tool_result'
              );
              if (hasToolResult) {
                sliceStart++;
                continue;
              }
            }
            break;
          }
          conversationRef.current = msgs.slice(sliceStart);
        }

        console.log('[AI Agent] Calling streaming API with', conversationRef.current.length, 'messages and', tools.length, 'tools');

        // Create a streaming message for progressive rendering
        const streamingMsg = createThinkingMessage('');
        addMessage(streamingMsg);
        const streamMsgId = streamingMsg.id;

        let fullText = '';
        let stopReason: string | null = null;
        let usage: { input_tokens: number; output_tokens: number; total_tokens?: number } | null = null;

        // Accumulated tool calls from the stream
        interface StreamToolCall {
          id: string;
          name: string;
          inputJson: string;
        }
        const pendingToolCalls: StreamToolCall[] = [];
        let currentToolCall: StreamToolCall | null = null;

        // Consume the SSE stream
        for await (const event of callAgentApiStream(conversationRef.current, tools, signal)) {
          if (stopRequestedRef.current) break;

          switch (event.type) {
            case 'content_delta':
              fullText += event.text;
              setMessages(prev => prev.map(m =>
                m.id === streamMsgId ? { ...m, content: fullText } : m
              ));
              break;

            case 'tool_use_start':
              currentToolCall = { id: event.id, name: event.name, inputJson: '' };
              break;

            case 'tool_input_delta':
              if (currentToolCall) {
                currentToolCall.inputJson += event.delta;
              }
              break;

            case 'tool_use_end':
              if (currentToolCall) {
                pendingToolCalls.push(currentToolCall);
                currentToolCall = null;
              }
              break;

            case 'done':
              stopReason = event.stop_reason;
              usage = event.usage;
              break;

            case 'error':
              throw new Error(event.message);
          }
        }

        // Check if stop was requested while streaming
        if (stopRequestedRef.current) {
          console.log('[AI Agent] Stop requested during streaming, breaking loop');
          setAgentState('idle');
          break;
        }

        // If empty text, remove the streaming placeholder; otherwise finalize it
        if (!fullText) {
          setMessages(prev => prev.filter(m => m.id !== streamMsgId));
        }

        console.log(`[AI Agent] Stream complete: stop=${stopReason}, tools=${pendingToolCalls.length}, tokens=${usage?.total_tokens || 0}`);

        // Track token usage if available
        if (usage) {
          const inputTokens = usage.input_tokens;
          const outputTokens = usage.output_tokens;
          const totalTokens = usage.total_tokens || (inputTokens + outputTokens);

          setTokenUsage(prev => ({
            inputTokens: prev.inputTokens + inputTokens,
            outputTokens: prev.outputTokens + outputTokens,
            totalTokens: prev.totalTokens + totalTokens,
            requestCount: prev.requestCount + 1,
          }));

          if (globalTokenTracker && provider) {
            globalTokenTracker.trackUsage(provider as GlobalProviderType, {
              inputTokens,
              outputTokens,
              totalTokens,
            });
          }
        }

        // Build assistant content blocks for conversation history
        const assistantContent: ContentBlock[] = [];
        if (fullText) {
          assistantContent.push({ type: 'text', text: fullText });
        }

        // Parse tool call inputs and build tool_use content blocks
        const parsedToolUses: ToolUseResponse[] = [];
        for (const tc of pendingToolCalls) {
          let input: Record<string, unknown> = {};
          try {
            input = JSON.parse(tc.inputJson);
          } catch {
            /* empty or malformed JSON — use empty object */
          }
          assistantContent.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name, // Keep sanitized name for API
            input,
          });
          parsedToolUses.push({ id: tc.id, name: tc.name, input });
        }

        if (assistantContent.length > 0) {
          conversationRef.current.push({
            role: 'assistant',
            content: assistantContent,
          });
        }

        // Check if we're done (end_turn, no tools, or single-turn mode)
        if (stopReason === 'end_turn' || parsedToolUses.length === 0 || singleTurn) {
          console.log('[AI Agent] Stopping streaming loop - stop_reason:', stopReason, 'tool_use count:', parsedToolUses.length, 'singleTurn:', singleTurn);
          setAgentState('idle');
          break;
        }

        // Process tool calls — identical logic to non-streaming runAgentLoop
        const toolResults: ContentBlock[] = [];

        // Unsanitize tool names for local execution (mcp_id_name -> mcp:id:name)
        for (const tu of parsedToolUses) {
          tu.name = unsanitizeToolName(tu.name);
        }

        // Check if any commands need approval
        const commandToolCalls = parsedToolUses.filter(t => t.name === 'run_command');

        if (commandToolCalls.length > 0 && autonomyLevel !== 'safe-auto') {
          // Need approval for commands
          const commandsToApprove = commandToolCalls.map(t => {
            const sessionId = t.input.session_id as string;
            const command = t.input.command as string;
            const session = sessions.find(s => s.id === sessionId);
            return {
              id: t.id,
              name: t.name,
              command,
              sessionId,
              validation: validateReadOnlyCommand(command, session?.cliFlavor),
            };
          });

          const approved = await waitForApproval(commandsToApprove);

          if (!approved || stopRequestedRef.current) {
            // User rejected - add rejection results
            for (const cmd of commandsToApprove) {
              toolResults.push({
                type: 'tool_result',
                tool_use_id: cmd.id,
                content: 'User rejected this command execution.',
                is_error: true,
              });
            }

            // Still need to process non-command tools
            for (const toolUse of parsedToolUses) {
              if (toolUse.name !== 'run_command') {
                const result = await executeTool(toolUse.name, toolUse.input);
                toolResults.push({
                  type: 'tool_result',
                  tool_use_id: toolUse.id,
                  content: truncateToolResult(result.content),
                  is_error: result.is_error,
                });
              }
            }
          } else {
            // Approved - execute all tools
            setAgentState('executing');

            for (const toolUse of parsedToolUses) {
              if (stopRequestedRef.current) break;

              const result = await executeTool(toolUse.name, toolUse.input);

              // Add command result message for run_command
              if (toolUse.name === 'run_command') {
                const sessionId = toolUse.input.session_id as string;
                const command = toolUse.input.command as string;
                const session = sessions.find(s => s.id === sessionId);
                addMessage(createCommandResultMessage(
                  command,
                  result.content,
                  sessionId,
                  session?.name || sessionId
                ));
              }

              toolResults.push({
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: truncateToolResult(result.content),
                is_error: result.is_error,
              });
            }
          }
        } else {
          // Auto-execute (safe-auto mode or no commands)
          setAgentState('executing');

          for (const toolUse of parsedToolUses) {
            if (stopRequestedRef.current) break;

            const result = await executeTool(toolUse.name, toolUse.input);

            // Add command result message for run_command
            if (toolUse.name === 'run_command') {
              const sessionId = toolUse.input.session_id as string;
              const command = toolUse.input.command as string;
              const session = sessions.find(s => s.id === sessionId);
              addMessage(createCommandResultMessage(
                command,
                result.content,
                sessionId,
                session?.name || sessionId
              ));
            }

            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: truncateToolResult(result.content),
              is_error: result.is_error,
            });
          }
        }

        // Add tool results as user message
        conversationRef.current.push({
          role: 'user',
          content: toolResults,
        });

        // Clear pending commands
        setPendingCommands([]);

      } catch (err) {
        // Handle abort gracefully (user clicked stop)
        if (err instanceof Error && err.name === 'AbortError') {
          console.log('[AI Agent] Streaming request aborted by user');
          setAgentState('idle');
          break;
        }
        const errorMsg = err instanceof Error ? err.message : 'Unknown error';
        addMessage(createErrorMessage(`Agent error: ${errorMsg}`));
        setAgentState('error');
        break;
      }
    }

    // Cleanup
    stopRequestedRef.current = false;
    abortControllerRef.current = null;
  }, [callAgentApiStream, executeTool, waitForApproval, addMessage, autonomyLevel, sessions, availableTools, singleTurn, provider, globalTokenTracker]);

  // Send a new message to the agent
  const sendMessage = useCallback(async (content: string) => {
    console.log('[AI Agent] sendMessage called with:', content.slice(0, 100));
    if (!content.trim()) {
      console.log('[AI Agent] Blocked: empty content');
      return;
    }
    if (agentState === 'thinking' || agentState === 'executing') {
      console.log('[AI Agent] Blocked: agent busy, state =', agentState);
      return;
    }

    console.log('[AI Agent] Proceeding with message');
    // Add user message to UI
    addMessage(createUserMessage(content));

    // Add to conversation
    conversationRef.current.push({
      role: 'user',
      content: content,
    });

    // Start the agent loop
    if (streaming) {
      await runAgentLoopStreaming();
    } else {
      await runAgentLoop();
    }
  }, [agentState, addMessage, runAgentLoop, runAgentLoopStreaming, streaming]);

  // Ref for auto-send to access sendMessage
  const sendMessageRef = useRef(sendMessage);
  sendMessageRef.current = sendMessage;

  // Approve pending commands
  const approveCommands = useCallback(() => {
    if (approvalResolverRef.current) {
      approvalResolverRef.current.resolve(true);
      approvalResolverRef.current = null;
    }
    setPendingCommands([]);
  }, []);

  // Reject pending commands
  const rejectCommands = useCallback(() => {
    if (approvalResolverRef.current) {
      approvalResolverRef.current.resolve(false);
      approvalResolverRef.current = null;
    }
    setPendingCommands([]);
    setAgentState('idle');
  }, []);

  // Stop the agent
  const stopAgent = useCallback(() => {
    console.log('[AI Agent] Stop requested');
    stopRequestedRef.current = true;

    // Abort any in-flight fetch request
    if (abortControllerRef.current) {
      console.log('[AI Agent] Aborting in-flight request');
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }

    // Resolve any pending approval
    if (approvalResolverRef.current) {
      approvalResolverRef.current.resolve(false);
      approvalResolverRef.current = null;
    }

    setPendingCommands([]);
    setAgentState('idle');
  }, []);

  // Clear all messages
  const clearMessages = useCallback(() => {
    setMessages([]);
    conversationRef.current = [];
    setPendingCommands([]);
    setAgentState('idle');
  }, []);

  // Reset token usage counter
  const resetTokenUsage = useCallback(() => {
    setTokenUsage({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      requestCount: 0,
    });
  }, []);

  return {
    messages,
    agentState,
    pendingCommands,
    sendMessage,
    approveCommands,
    rejectCommands,
    stopAgent,
    clearMessages,
    tokenUsage,
    resetTokenUsage,
  };
}
