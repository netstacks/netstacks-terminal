import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import './AISidePanel.css'
import MarkdownViewer from './MarkdownViewer'
import ContextMenu from './ContextMenu'
import type { MenuItem } from './ContextMenu'
import { useContextMenu } from '../hooks/useContextMenu'
import { PromoteToTaskDialog } from './PromoteToTaskDialog'
import { useAIAgent, type AgentSession, type AgentMessage, type AddSessionContextParams, type NeighborParseResult, type AddNeighborParams, type AddNeighborResult, type NetBoxImportParams, type NetBoxImportResult, type CreateMopParams, type CreateMopResult } from '../hooks/useAIAgent'
import { useAgentTasks } from '../hooks/useAgentTasks'
import type { AgentAutonomyLevel } from '../api/agent'
import type { CliFlavor } from '../api/sessions'
import type { Document, DocumentCategory } from '../api/docs'
import type { SessionContextEntry, AiProviderType } from '../api/ai'
import { hasAiApiKey, checkOllamaStatus, fetchOllamaModels, getAiStatus, getAiConfig } from '../api/ai'
import { getCurrentMode } from '../api/client'
import { useSettings } from '../hooks/useSettings'
import { useMode } from '../hooks/useMode'
import { isOnboarded } from '../api/aiEngineerProfile'
import { NeighborParser } from '../lib/neighborParser'
import { createConnection } from '../api/topology'
import type { Device as TopologyDevice } from '../types/topology'
import type { NetBoxNeighbor } from '../api/netbox'

// Re-export for App.tsx
export type { AgentMessage }

interface AISidePanelProps {
  isOpen: boolean
  onClose: () => void
  /** Increment to trigger expand (for Cmd+Shift+I when collapsed) */
  expandTrigger?: number
  /** Available sessions for the AI agent - includes connection status */
  availableSessions?: Array<{
    id: string
    name: string
    connected?: boolean
    cliFlavor?: CliFlavor
  }>
  /** Callback when command needs to be executed - runs in the terminal so user can see it */
  onExecuteCommand?: (sessionId: string, command: string) => Promise<string>
  /** Callback to get terminal output context */
  getTerminalContext?: (sessionId: string, lines?: number) => Promise<string>
  /** Callback to open a saved session (opens terminal tab and connects) */
  onOpenSession?: (sessionId: string) => Promise<void>
  /** Callback to list documents by category */
  onListDocuments?: (category?: DocumentCategory) => Promise<Document[]>
  /** Callback to read document content by ID */
  onReadDocument?: (documentId: string) => Promise<Document | null>
  /** Callback to search documents by name/content */
  onSearchDocuments?: (query: string, category?: DocumentCategory) => Promise<Document[]>
  /** Callback to save/create a document */
  onSaveDocument?: (path: string, content: string, category?: DocumentCategory, mode?: 'overwrite' | 'append', sessionId?: string) => Promise<{ id: string; name: string }>
  /** Initial messages to continue a conversation from popup/floating chat */
  initialMessages?: AgentMessage[]
  /** Callback to add session context (tribal knowledge) */
  onAddSessionContext?: (sessionId: string, params: AddSessionContextParams) => Promise<{ id: string }>
  /** Callback to list session context entries */
  onListSessionContext?: (sessionId: string) => Promise<SessionContextEntry[]>
  /** Default pinned state from settings */
  defaultPinned?: boolean
  /** Topology context for neighbor discovery (Phase 22) */
  topologyContext?: {
    topologyId: string
    devices: TopologyDevice[]
    onRefresh: () => void
  }
  /** NetBox topology callbacks (Phase 22) */
  onNetBoxGetNeighbors?: (sourceId: string, deviceId: number) => Promise<NetBoxNeighbor[]>
  onNetBoxImportTopology?: (params: NetBoxImportParams) => Promise<NetBoxImportResult>
  /** Callback when AI updates a topology device - triggers refresh */
  onTopologyDeviceUpdated?: (topologyId: string) => void
  /** MOP creation callback */
  onCreateMop?: (params: CreateMopParams) => Promise<CreateMopResult>
  /** External prompt to send (e.g., from AI Discover button) - increment counter to re-trigger same prompt */
  externalPrompt?: { prompt: string; counter: number }
  // Troubleshooting session capture (Phase 26)
  /** Callback to capture AI chat messages for troubleshooting session */
  onTroubleshootingCapture?: (type: 'ai-chat', content: string) => void
  /** Whether troubleshooting session is active */
  isTroubleshootingActive?: boolean
  /** Whether to capture AI conversations (from session settings) */
  captureAIConversations?: boolean
  /** Callback when collapsed state changes */
  onCollapsedChange?: (collapsed: boolean) => void
  /** Currently focused session ID (from active terminal tab) — auto-tracks active tab */
  focusedSessionId?: string
  /** Currently focused session name (for display/context) */
  focusedSessionName?: string
  /** Script copilot context - when a script tab is active */
  scriptContext?: {
    name: string
    getContent: () => string
    onApplyCode: (code: string) => void
  }
  /** UI navigation callbacks for AI tools */
  onNavigateToBackup?: (deviceId: string, deviceName: string, searchText?: string) => void
  onNavigateToDevice?: (deviceId: string, deviceName: string) => void
  onOpenTerminalSession?: (deviceName: string) => void
  onNavigateToMop?: (mopId: string, mopName: string) => void
  onNavigateToTopology?: (topologyName: string) => void
  onNavigateToSettings?: (tab?: string) => void
  /** Whether to render in overlay mode (floating, full-screen backdrop) */
  isOverlay?: boolean
  /** Callback when overlay state changes */
  onOverlayChange?: (isOverlay: boolean) => void
}

type AutonomyLevel = 'manual' | 'approve-all' | 'safe-auto'
type AgentState = 'idle' | 'thinking' | 'executing' | 'waiting_approval' | 'error'

interface DisplayMessage {
  id: string
  type: 'user' | 'agent' | 'command-request' | 'command-result' | 'error' | 'system'
  content: string
  timestamp: Date
  command?: string
  sessionId?: string
  sessionName?: string
  output?: string
}

const STATE_LABELS: Record<AgentState, string> = {
  idle: 'Ready',
  thinking: 'Analyzing...',
  executing: 'Running...',
  waiting_approval: 'Needs Approval',
  error: 'Error',
}

const QUICK_ACTIONS = [
  { id: 'connectivity', label: 'Check Connectivity', icon: 'wifi', prompt: 'Check network connectivity and diagnose any issues' },
  { id: 'resources', label: 'System Resources', icon: 'cpu', prompt: 'Check system resources like CPU, memory, and disk usage' },
  { id: 'logs', label: 'Recent Errors', icon: 'alert', prompt: 'Find and analyze recent error logs' },
  { id: 'services', label: 'Service Status', icon: 'server', prompt: 'Check the status of running services' },
]

const SCRIPT_QUICK_ACTIONS = [
  { id: 'explain', label: 'Explain Script', icon: 'info', prompt: 'Explain what this script does, step by step' },
  { id: 'improve', label: 'Improve Script', icon: 'star', prompt: 'Suggest improvements to this script for better reliability and readability' },
  { id: 'fix', label: 'Fix / Harden', icon: 'shield', prompt: 'Add proper error handling, input validation, and make this script production-ready' },
  { id: 'add-comments', label: 'Add Comments', icon: 'comment', prompt: 'Add clear, helpful comments to this script' },
]

const AISidePanel = ({
  isOpen,
  onClose,
  expandTrigger,
  availableSessions = [],
  onExecuteCommand,
  getTerminalContext,
  onOpenSession,
  onListDocuments,
  onReadDocument,
  onSearchDocuments,
  onSaveDocument,
  initialMessages,
  onAddSessionContext,
  onListSessionContext,
  defaultPinned = true,
  topologyContext,
  onNetBoxGetNeighbors,
  onNetBoxImportTopology,
  onTopologyDeviceUpdated,
  onCreateMop,
  externalPrompt,
  onTroubleshootingCapture,
  isTroubleshootingActive,
  captureAIConversations,
  onCollapsedChange,
  focusedSessionId,
  focusedSessionName: _focusedSessionName,
  scriptContext,
  onNavigateToBackup,
  onNavigateToDevice,
  onOpenTerminalSession,
  onNavigateToMop,
  onNavigateToTopology,
  onNavigateToSettings,
  isOverlay = false,
  onOverlayChange,
}: AISidePanelProps) => {
  // Panel state
  const [width, setWidth] = useState(380)
  const [isResizing, setIsResizing] = useState(false)
  const [isCollapsed, setIsCollapsed] = useState(false)
  const [isPinned, setIsPinned] = useState(defaultPinned)
  const [aiTabY, setAiTabY] = useState(100) // vertical position of collapsed AI tab

  // Overlay mode state
  const [overlayPos, setOverlayPos] = useState({ x: 0, y: 0 })
  const [overlaySize, setOverlaySize] = useState({ width: 700, height: 500 })
  const [isOverlayDragging, setIsOverlayDragging] = useState(false)
  const [isOverlayResizing, setIsOverlayResizing] = useState(false)
  const overlayDragOffset = useRef({ x: 0, y: 0 })
  const overlayResizeStart = useRef({ x: 0, y: 0, width: 0, height: 0 })

  // Notify parent of collapsed state changes (skip initial mount)
  const prevCollapsed = useRef(isCollapsed)
  useEffect(() => {
    if (prevCollapsed.current !== isCollapsed) {
      prevCollapsed.current = isCollapsed
      onCollapsedChange?.(isCollapsed)
    }
  }, [isCollapsed, onCollapsedChange])

  // Center overlay when entering overlay mode
  useEffect(() => {
    if (isOverlay) {
      setOverlayPos({
        x: Math.max(40, (window.innerWidth - overlaySize.width) / 2),
        y: Math.max(40, (window.innerHeight - overlaySize.height) / 2),
      })
    }
  }, [isOverlay]) // eslint-disable-line react-hooks/exhaustive-deps

  // Unified AI state
  const [input, setInput] = useState('')
  const [autonomyLevel, setAutonomyLevel] = useState<AutonomyLevel>('safe-auto')
  const [selectedSession, setSelectedSession] = useState<string>('')
  const [aiMode, setAiMode] = useState<import('../lib/aiModes').AIMode>('operator')

  // Get default provider from settings
  const { settings: appSettings } = useSettings()

  // Provider/Model selection (two separate dropdowns)
  const [selectedProvider, setSelectedProvider] = useState<AiProviderType>('anthropic')
  const [selectedModel, setSelectedModel] = useState<string>('')
  const [availableModels, setAvailableModels] = useState<{ value: string; label: string }[]>([])
  const [providerConfigured, setProviderConfigured] = useState<Record<AiProviderType, boolean>>({
    anthropic: false,
    openai: false,
    openrouter: false,
    ollama: false,
    litellm: false,
    custom: false,
  })

  // AI Engineer onboarding detection (standalone mode only)
  const [onboardingNeeded, setOnboardingNeeded] = useState(false)
  const { isEnterprise } = useMode()

  // Re-check onboarding when panel becomes visible (catches profile changes from settings)
  useEffect(() => {
    if (isEnterprise) return
    isOnboarded().then(completed => {
      setOnboardingNeeded(!completed)
    })
  }, [isEnterprise, isOpen])

  // Promote to task dialog state
  const [showPromoteDialog, setShowPromoteDialog] = useState(false)
  const { createTask } = useAgentTasks()
  const msgContextMenu = useContextMenu()

  // Convert availableSessions to AgentSession format
  const agentSessions: AgentSession[] = useMemo(() =>
    availableSessions.map(s => ({
      id: s.id,
      name: s.name,
      connected: s.connected ?? true,
      cliFlavor: s.cliFlavor,
    })),
    [availableSessions]
  )

  // Neighbor discovery callback (Phase 22)
  // Runs CDP or LLDP command, parses output, returns neighbor info
  const handleDiscoverNeighbors = useCallback(async (
    sessionId: string,
    protocol: 'cdp' | 'lldp' | 'auto'
  ): Promise<NeighborParseResult> => {
    if (!onExecuteCommand) {
      throw new Error('Command execution not available')
    }

    // Look up session to get CLI flavor
    const session = availableSessions.find(s => s.id === sessionId)
    const cliFlavor = session?.cliFlavor || 'auto'

    // Disable paging based on device type
    // Different vendors use different commands to disable terminal paging
    // For 'auto' mode, we skip paging commands and rely on | no-more pipe instead
    // to avoid sending wrong commands that clutter the terminal
    if (cliFlavor !== 'auto') {
      try {
        switch (cliFlavor) {
          case 'cisco-ios':
          case 'cisco-nxos':
          case 'arista-eos':
            // Cisco IOS, NX-OS, and Arista EOS all use this command
            await onExecuteCommand(sessionId, 'terminal length 0')
            break
          case 'juniper-junos':
            // Juniper uses screen-length in operational mode
            await onExecuteCommand(sessionId, 'set cli screen-length 0')
            break
          case 'paloalto':
            // Palo Alto PAN-OS
            await onExecuteCommand(sessionId, 'set cli pager off')
            break
          case 'fortinet':
            // Fortinet FortiOS - disable output paging
            await onExecuteCommand(sessionId, 'config system console')
            await onExecuteCommand(sessionId, 'set output standard')
            await onExecuteCommand(sessionId, 'end')
            break
        }
      } catch {
        // Ignore paging command errors - device may already have paging disabled
      }
    }

    // Helper to append no-more pipe for commands
    // For auto mode and Juniper, always use | no-more since it's the safest option
    const addNoPager = (cmd: string): string => {
      if (cliFlavor === 'juniper-junos' || cliFlavor === 'auto') {
        // Juniper and auto mode - | no-more is widely supported
        return `${cmd} | no-more`
      }
      if (cliFlavor === 'fortinet') {
        return `${cmd} | grep -v "^--More--"`
      }
      return cmd
    }

    // Determine command based on protocol
    let output = ''
    let detectedProtocol: 'cdp' | 'lldp' = 'cdp'

    if (protocol === 'auto' || protocol === 'cdp') {
      try {
        output = await onExecuteCommand(sessionId, addNoPager('show cdp neighbors detail'))
        if (NeighborParser.isCdpOutput(output)) {
          detectedProtocol = 'cdp'
        } else if (protocol === 'auto') {
          // CDP didn't work, try LLDP
          output = await onExecuteCommand(sessionId, addNoPager('show lldp neighbors detail'))
          detectedProtocol = 'lldp'
        }
      } catch {
        if (protocol === 'auto') {
          // Try LLDP as fallback
          output = await onExecuteCommand(sessionId, addNoPager('show lldp neighbors detail'))
          detectedProtocol = 'lldp'
        } else {
          throw new Error('CDP command failed')
        }
      }
    } else if (protocol === 'lldp') {
      output = await onExecuteCommand(sessionId, addNoPager('show lldp neighbors detail'))
      detectedProtocol = 'lldp'
    }

    // Parse the output
    const parseResult = NeighborParser.parse(output)

    return {
      protocol: detectedProtocol,
      neighbors: parseResult.neighbors,
      deviceName: parseResult.deviceName,
    }
  }, [onExecuteCommand, availableSessions])

  // Add neighbor to topology callback (Phase 22)
  // NOTE: This only creates connections between existing devices on the map.
  // If a neighbor is discovered that's not on the map, we report it but don't add it.
  const handleAddNeighborToTopology = useCallback(async (
    params: AddNeighborParams
  ): Promise<AddNeighborResult> => {
    if (!topologyContext) {
      throw new Error('No topology context available')
    }

    // Check if neighbor device already exists on the map
    // Try to match by name (case-insensitive) or by IP
    const existingDevice = topologyContext.devices.find(d => {
      const nameMatch = d.name.toLowerCase() === params.neighbor_name.toLowerCase()
      const ipMatch = params.neighbor_ip && d.primaryIp === params.neighbor_ip
      return nameMatch || ipMatch
    })

    if (!existingDevice) {
      // Device not on the map - report this but don't add it
      throw new Error(
        `Neighbor "${params.neighbor_name}"${params.neighbor_ip ? ` (${params.neighbor_ip})` : ''} ` +
        `is not on this topology map. Only devices with active SSH sessions can be shown.`
      )
    }

    // Create connection between source and existing neighbor
    const connection = await createConnection(topologyContext.topologyId, {
      source_device_id: params.source_device_id,
      target_device_id: existingDevice.id,
      source_interface: params.local_interface,
      target_interface: params.remote_interface,
    })

    // Refresh topology to show new connection
    topologyContext.onRefresh()

    return {
      deviceId: existingDevice.id,
      connectionId: connection.id,
    }
  }, [topologyContext])

  // Use the unified AI agent hook
  const {
    messages: agentMessages,
    agentState,
    pendingCommands,
    sendMessage,
    approveCommands,
    rejectCommands,
    stopAgent,
    clearMessages,
    tokenUsage,
    resetTokenUsage,
  } = useAIAgent({
    sessions: agentSessions,
    onExecuteCommand,
    getTerminalContext,
    onOpenSession,
    autonomyLevel: autonomyLevel as AgentAutonomyLevel,
    // Pass selected provider/model to the hook
    provider: selectedProvider,
    model: selectedModel,
    onListDocuments,
    onReadDocument,
    onSearchDocuments,
    onSaveDocument,
    initialMessages,
    // Session context callbacks (Phase 14)
    onAddSessionContext,
    onListSessionContext,
    // Neighbor discovery callbacks (Phase 22)
    onDiscoverNeighbors: topologyContext ? handleDiscoverNeighbors : undefined,
    onAddNeighborToTopology: topologyContext ? handleAddNeighborToTopology : undefined,
    // NetBox topology callbacks (Phase 22)
    onNetBoxGetNeighbors,
    onNetBoxImportTopology,
    // Netdisco topology callbacks (Phase 22)
    // MOP creation callback
    onCreateMop,
    // Topology refresh callback
    onTopologyDeviceUpdated,
    // Active session context — tells the AI which session is focused
    activeSessionId: selectedSession,
    activeSessionName: availableSessions.find(s => s.id === selectedSession)?.name,
    // Script copilot context
    scriptContext: scriptContext ? { name: scriptContext.name, getContent: scriptContext.getContent } : undefined,
    // AI mode for system prompt and tool filtering
    aiMode,
    // UI navigation callbacks
    onNavigateToBackup,
    onNavigateToDevice,
    onOpenTerminalSession,
    onNavigateToMop,
    onNavigateToTopology,
    onNavigateToSettings,
    // Streaming mode — active when overlay is open
    streaming: isOverlay,
  })

  // Convert agent messages to DisplayMessage format for display
  const displayMessages: DisplayMessage[] = useMemo(() => {
    if (agentMessages.length === 0) {
      return [{
        id: 'system-welcome',
        type: 'system',
        content: onboardingNeeded
          ? 'Welcome! I\'d like to get to know how you work so I can be more helpful. Type "hi" or anything to start a quick setup conversation.'
          : 'AI Assistant ready. Ask a question or use a quick action below.',
        timestamp: new Date(),
      }]
    }

    return agentMessages.map((msg): DisplayMessage => {
      // Direct type mappings; all others become 'agent'
      const type: DisplayMessage['type'] =
        msg.type === 'user' ? 'user' :
        msg.type === 'command-result' ? 'command-result' :
        msg.type === 'error' ? 'error' :
        'agent'

      return {
        id: msg.id,
        type,
        content: msg.content,
        timestamp: msg.timestamp,
        command: msg.command,
        sessionId: msg.sessionId,
        sessionName: msg.sessionName,
        output: msg.output,
      }
    })
  }, [agentMessages, onboardingNeeded])

  // Refs
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const messagesRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  // Update isPinned when default setting changes
  useEffect(() => {
    setIsPinned(defaultPinned)
  }, [defaultPinned])

  // Auto-track focused tab — when user switches terminal tabs, update selected session
  useEffect(() => {
    if (focusedSessionId && availableSessions.some(s => s.id === focusedSessionId)) {
      setSelectedSession(focusedSessionId)
    }
  }, [focusedSessionId, availableSessions])

  // Auto-select first session if none selected
  useEffect(() => {
    if (availableSessions.length > 0 && !selectedSession) {
      setSelectedSession(availableSessions[0].id)
    }
  }, [availableSessions, selectedSession])

  // Load AI provider configuration on mount
  useEffect(() => {
    const loadProviderConfig = async () => {
      try {
        const enabledProviders: AiProviderType[] = appSettings['ai.enabledProviders'] || ['anthropic']
        const isEnabled = (type: AiProviderType) => enabledProviders.includes(type)

        let configured: Record<AiProviderType, boolean>
        let ollamaModels: { value: string; label: string }[] = []

        if (getCurrentMode() === 'enterprise') {
          // Enterprise mode: query Controller for centrally configured providers
          const status = await getAiStatus()
          const providerTypes = new Set(status.providers.map(p => p.type))
          configured = {
            anthropic: providerTypes.has('anthropic'),
            openai: providerTypes.has('openai'),
            openrouter: providerTypes.has('openrouter'),
            ollama: providerTypes.has('ollama'),
            litellm: providerTypes.has('litellm'),
            custom: providerTypes.has('custom'),
          }
        } else {
          // Personal mode: check vault for API keys (only for enabled providers)
          const [hasAnthropic, hasOpenAI] = await Promise.all([
            isEnabled('anthropic') ? hasAiApiKey('anthropic') : Promise.resolve(false),
            isEnabled('openai') ? hasAiApiKey('openai') : Promise.resolve(false),
          ])

          // Check Ollama only if enabled
          let ollamaRunning = false
          if (isEnabled('ollama')) {
            try {
              const status = await checkOllamaStatus()
              ollamaRunning = status.running
              if (ollamaRunning) {
                ollamaModels = await fetchOllamaModels()
              }
            } catch {
              // Ollama not available
            }
          }

          // Check custom provider: has API key OR uses OAuth2 auth
          let customConfigured = false
          if (isEnabled('custom')) {
            const hasKey = await hasAiApiKey('custom')
            if (hasKey) {
              customConfigured = true
            } else {
              // Check if OAuth2 is configured (doesn't need a static key upfront)
              try {
                const cfg = await getAiConfig()
                if (cfg?.provider === 'custom' && cfg.auth_mode === 'oauth2') {
                  customConfigured = true
                }
              } catch { /* ignore */ }
            }
          }

          configured = {
            anthropic: isEnabled('anthropic') && hasAnthropic,
            openai: isEnabled('openai') && hasOpenAI,
            openrouter: isEnabled('openrouter') && await hasAiApiKey('openrouter'),
            ollama: isEnabled('ollama') && ollamaRunning,
            litellm: isEnabled('litellm'), // LiteLLM doesn't need API key
            custom: customConfigured,
          }
        }
        setProviderConfigured(configured)

        // Use default provider from settings, or first configured provider
        const defaultProvider = appSettings['ai.defaultProvider']
        let initialProvider: AiProviderType = defaultProvider

        // If default provider isn't configured, fall back to first configured one
        if (!configured[defaultProvider]) {
          if (configured.anthropic) initialProvider = 'anthropic'
          else if (configured.openai) initialProvider = 'openai'
          else if (configured.openrouter) initialProvider = 'openrouter'
          else if (configured.ollama) initialProvider = 'ollama'
          else if (configured.litellm) initialProvider = 'litellm'
          else if (configured.custom) initialProvider = 'custom'
        }

        setSelectedProvider(initialProvider)

        // Load models from settings for selected provider
        const getModelsFromSettings = (provider: AiProviderType): { value: string; label: string }[] => {
          const key = `ai.models.${provider}` as keyof typeof appSettings
          const modelList = (appSettings[key] as string[]) || []
          return modelList.map(m => ({ value: m, label: m }))
        }

        // Set available models for selected provider
        let models: { value: string; label: string }[] = []
        if (initialProvider === 'ollama' && ollamaModels.length > 0) {
          models = ollamaModels
        } else if (initialProvider === 'custom') {
          // Custom provider: get model from backend config (not localStorage)
          try {
            const cfg = await getAiConfig()
            if (cfg?.provider === 'custom' && cfg.model) {
              models = [{ value: cfg.model, label: cfg.model }]
            }
          } catch { /* ignore */ }
        } else {
          models = getModelsFromSettings(initialProvider)
        }

        // Select first model if available
        if (models.length > 0) {
          setSelectedModel(models[0].value)
        }

        setAvailableModels(models)
      } catch (err) {
        console.error('Failed to load AI provider config:', err)
      }
    }
    loadProviderConfig()
  }, [appSettings])

  // Update available models when provider changes
  useEffect(() => {
    const updateModels = async () => {
      // Helper to get models from settings
      const getModelsFromSettings = (provider: AiProviderType): { value: string; label: string }[] => {
        const key = `ai.models.${provider}` as keyof typeof appSettings
        const modelList = (appSettings[key] as string[]) || []
        return modelList.map(m => ({ value: m, label: m }))
      }

      const enabledProviders: AiProviderType[] = appSettings['ai.enabledProviders'] || ['anthropic']
      let models: { value: string; label: string }[] = []
      if (selectedProvider === 'ollama' && enabledProviders.includes('ollama')) {
        try {
          const fetched = await fetchOllamaModels()
          // For Ollama, use fetched models, fall back to configured models in settings
          models = fetched.length > 0 ? fetched : getModelsFromSettings('ollama')
        } catch {
          models = getModelsFromSettings('ollama')
        }
      } else if (selectedProvider === 'custom') {
        // Custom provider: get model from backend config
        try {
          const cfg = await getAiConfig()
          if (cfg?.provider === 'custom' && cfg.model) {
            models = [{ value: cfg.model, label: cfg.model }]
          }
        } catch { /* ignore */ }
      } else {
        models = getModelsFromSettings(selectedProvider)
      }

      setAvailableModels(models)
      // Auto-select first model if current model not in list
      if (models.length > 0 && !models.find(m => m.value === selectedModel)) {
        setSelectedModel(models[0].value)
      }
    }
    updateModels()
  }, [selectedProvider, appSettings]) // Re-run when provider or settings change

  // Focus input when opened
  useEffect(() => {
    if (isOpen && !isCollapsed) {
      setTimeout(() => {
        inputRef.current?.focus()
      }, 100)
    }
  }, [isOpen, isCollapsed])

  // Expand when trigger changes (Cmd+I pressed)
  useEffect(() => {
    if (isOpen && expandTrigger) {
      setIsCollapsed(false)
      setTimeout(() => {
        inputRef.current?.focus()
      }, 100)
    }
  }, [expandTrigger, isOpen])

  // ESC to collapse, click outside to auto-collapse when unpinned
  useEffect(() => {
    if (!isOpen || isCollapsed) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (isOverlay) {
          onOverlayChange?.(false)
        } else {
          setIsCollapsed(true)
        }
      }
    }

    const handleClickOutside = (e: MouseEvent) => {
      // In overlay mode, the backdrop handles click-outside — don't also collapse
      if (isOverlay) return
      if (!isPinned && panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setIsCollapsed(true)
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    document.addEventListener('mousedown', handleClickOutside)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isOpen, isCollapsed, isPinned, isOverlay, onOverlayChange])

  // Scroll to bottom on new messages
  useEffect(() => {
    if (messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight
    }
  }, [displayMessages])

  // Capture AI chat messages for troubleshooting session (Phase 26)
  // We track the last captured message count to only capture new messages
  const lastCapturedCountRef = useRef(0)
  useEffect(() => {
    // Only capture if troubleshooting is active and AI capture is enabled
    if (!isTroubleshootingActive || !captureAIConversations || !onTroubleshootingCapture) {
      return
    }

    // Capture any new messages since last time
    const newMessages = agentMessages.slice(lastCapturedCountRef.current)
    for (const msg of newMessages) {
      // Format message for capture
      const role = msg.type === 'user' ? 'User' : 'AI'
      const captureContent = `[${role}] ${msg.content}`
      onTroubleshootingCapture('ai-chat', captureContent)
    }

    // Update last captured count
    lastCapturedCountRef.current = agentMessages.length
  }, [agentMessages, isTroubleshootingActive, captureAIConversations, onTroubleshootingCapture])

  // Handle resize
  useEffect(() => {
    if (!isResizing) return

    const handleMouseMove = (e: MouseEvent) => {
      const newWidth = window.innerWidth - e.clientX
      setWidth(Math.max(320, Math.min(650, newWidth)))
    }

    const handleMouseUp = () => setIsResizing(false)

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isResizing])

  // Message handlers
  const handleSubmit = useCallback(async (e?: React.FormEvent) => {
    e?.preventDefault()
    if (!input.trim() || agentState === 'thinking' || agentState === 'executing') return

    const userMessage = input.trim()
    setInput('')

    // Send message through the agent hook - it handles the agentic loop
    await sendMessage(userMessage)
  }, [input, agentState, sendMessage])

  const handleQuickAction = useCallback((prompt: string) => {
    setInput(prompt)
    setTimeout(() => inputRef.current?.focus(), 50)
  }, [])

  // Handle promoting chat to background task
  const handlePromoteToTask = useCallback(async (prompt: string) => {
    const task = await createTask(prompt)
    console.log('[AISidePanel] Created background task:', task.id)
  }, [createTask])

  // Overlay drag handlers
  const handleOverlayDragStart = useCallback((e: React.MouseEvent) => {
    setIsOverlayDragging(true)
    overlayDragOffset.current = {
      x: e.clientX - overlayPos.x,
      y: e.clientY - overlayPos.y,
    }
    e.preventDefault()
  }, [overlayPos])

  useEffect(() => {
    if (!isOverlayDragging) return
    const handleMouseMove = (e: MouseEvent) => {
      setOverlayPos({
        x: Math.max(0, Math.min(window.innerWidth - overlaySize.width, e.clientX - overlayDragOffset.current.x)),
        y: Math.max(0, Math.min(window.innerHeight - overlaySize.height, e.clientY - overlayDragOffset.current.y)),
      })
    }
    const handleMouseUp = () => setIsOverlayDragging(false)
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isOverlayDragging, overlaySize])

  // Overlay resize handlers
  const handleOverlayResizeStart = useCallback((e: React.MouseEvent) => {
    setIsOverlayResizing(true)
    overlayResizeStart.current = {
      x: e.clientX,
      y: e.clientY,
      width: overlaySize.width,
      height: overlaySize.height,
    }
    e.preventDefault()
    e.stopPropagation()
  }, [overlaySize])

  useEffect(() => {
    if (!isOverlayResizing) return
    const handleMouseMove = (e: MouseEvent) => {
      const maxW = window.innerWidth - 80
      const maxH = window.innerHeight - 80
      setOverlaySize({
        width: Math.max(400, Math.min(maxW, overlayResizeStart.current.width + e.clientX - overlayResizeStart.current.x)),
        height: Math.max(300, Math.min(maxH, overlayResizeStart.current.height + e.clientY - overlayResizeStart.current.y)),
      })
    }
    const handleMouseUp = () => setIsOverlayResizing(false)
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isOverlayResizing])

  // Overlay dock/pop-out handlers
  const handleDock = useCallback(() => {
    onOverlayChange?.(false)
  }, [onOverlayChange])

  const handlePopOut = useCallback(() => {
    onOverlayChange?.(true)
  }, [onOverlayChange])

  // Handle external prompts (e.g., from AI Discover button)
  const lastExternalPromptCounter = useRef(0)
  useEffect(() => {
    if (externalPrompt && externalPrompt.counter !== lastExternalPromptCounter.current) {
      lastExternalPromptCounter.current = externalPrompt.counter
      // Only send if not busy
      if (agentState !== 'thinking' && agentState !== 'executing') {
        sendMessage(externalPrompt.prompt)
      }
    }
  }, [externalPrompt, agentState, sendMessage])

  // Use hook functions directly - no need for wrapper callbacks

  const isAgentBusy = agentState === 'thinking' || agentState === 'executing'

  const showPanel = isOpen && !isCollapsed

  // Context menu for chat messages
  const handleMessageContextMenu = useCallback((e: React.MouseEvent, msg: DisplayMessage) => {
    const items: MenuItem[] = []
    const selection = window.getSelection()?.toString() || ''

    // Copy selected text first (most common action)
    if (selection) {
      items.push({
        id: 'copy-selection',
        label: 'Copy',
        shortcut: '\u2318C',
        action: () => navigator.clipboard.writeText(selection)
      })
    }

    // Message-type-specific actions
    if (msg.type === 'user') {
      items.push({ id: 'copy-message', label: 'Copy Message', action: () => navigator.clipboard.writeText(msg.content) })
    } else if (msg.type === 'agent') {
      items.push(
        { id: 'copy-message', label: 'Copy Message', action: () => navigator.clipboard.writeText(msg.content) },
        { id: 'copy-markdown', label: 'Copy as Markdown', action: () => navigator.clipboard.writeText(msg.content) },
      )
    } else if (msg.type === 'command-request') {
      items.push({ id: 'copy-command', label: 'Copy Command', action: () => navigator.clipboard.writeText(msg.command || msg.content) })
    } else if (msg.type === 'command-result') {
      items.push({ id: 'copy-output', label: 'Copy Output', action: () => navigator.clipboard.writeText(msg.output || msg.content) })
    } else if (msg.type === 'system' || msg.type === 'error') {
      items.push({ id: 'copy-message', label: 'Copy Message', action: () => navigator.clipboard.writeText(msg.content) })
    }

    if (items.length > 0) {
      msgContextMenu.open(e, items)
    }
  }, [msgContextMenu])

  return (
    <>
      {/* Collapsed tab view — draggable vertically */}
      {isOpen && isCollapsed && !isOverlay && (
        <div
          className="ai-side-panel-tab"
          style={{ top: aiTabY }}
          onClick={() => setIsCollapsed(false)}
          onMouseDown={(e) => {
            e.preventDefault()
            const startY = e.clientY
            const startTop = aiTabY
            const onMove = (me: MouseEvent) => {
              const newY = Math.max(40, Math.min(window.innerHeight - 60, startTop + me.clientY - startY))
              setAiTabY(newY)
            }
            const onUp = () => {
              document.removeEventListener('mousemove', onMove)
              document.removeEventListener('mouseup', onUp)
            }
            document.addEventListener('mousemove', onMove)
            document.addEventListener('mouseup', onUp)
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="18" height="18">
            <path d="M12 2L2 7l10 5 10-5-10-5z" />
            <path d="M2 17l10 5 10-5" />
            <path d="M2 12l10 5 10-5" />
          </svg>
          <span>AI</span>
          {agentState !== 'idle' && (
            <span className={`ai-side-panel-tab-status ${agentState}`} />
          )}
          {displayMessages.length > 1 && (
            <span className="ai-side-panel-tab-badge">
              {displayMessages.length - 1}
            </span>
          )}
        </div>
      )}

      {isOverlay && showPanel && (
        <div className="ai-overlay-backdrop" onClick={handleDock} />
      )}

      <div
        ref={panelRef}
        data-testid="ai-panel"
        className={`ai-side-panel ${isResizing || isOverlayDragging || isOverlayResizing ? 'resizing' : ''} ${!isPinned && !isOverlay ? 'floating' : ''} ${!showPanel ? 'closed' : ''} ${isOverlay ? 'overlay-mode' : ''}`}
        style={isOverlay ? {
          left: overlayPos.x,
          top: overlayPos.y,
          width: overlaySize.width,
          height: overlaySize.height,
        } : {
          width: showPanel ? width : 0,
        }}
      >
      {/* Resize handle */}
      <div
        className="ai-side-panel-resize"
        onMouseDown={() => setIsResizing(true)}
      />

      {/* Header */}
      <div
        className={`ai-side-panel-header ${isOverlay ? 'overlay-draggable' : ''}`}
        onMouseDown={isOverlay ? handleOverlayDragStart : undefined}
        style={isOverlay ? { cursor: isOverlayDragging ? 'grabbing' : 'grab' } : undefined}
      >
        <div className="ai-side-panel-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="16" height="16">
            <path d="M12 2L2 7l10 5 10-5-10-5z" />
            <path d="M2 17l10 5 10-5" />
            <path d="M2 12l10 5 10-5" />
          </svg>
          <span>AI Assistant</span>
          {agentState !== 'idle' && (
            <div className="ai-side-panel-agent-status">
              <div className={`ai-side-panel-status-dot ${agentState}`} />
              <span>{STATE_LABELS[agentState]}</span>
            </div>
          )}
        </div>
        {/* Token Usage Display */}
        {tokenUsage.requestCount > 0 && (
          <div className="ai-side-panel-token-usage" title={`In: ${tokenUsage.inputTokens.toLocaleString()} | Out: ${tokenUsage.outputTokens.toLocaleString()} | Requests: ${tokenUsage.requestCount}`}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
            <span className="ai-token-count">{tokenUsage.totalTokens.toLocaleString()}</span>
            <button
              className="ai-token-reset"
              onClick={resetTokenUsage}
              title="Reset token counter"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="10" height="10">
                <polyline points="23 4 23 10 17 10" />
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
            </button>
          </div>
        )}
        <div className="ai-side-panel-actions">
          {displayMessages.length > 1 && (
            <>
              <button
                className="ai-side-panel-btn"
                onClick={() => setShowPromoteDialog(true)}
                title="Promote to background task"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="14" height="14">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
              </button>
              <button
                className="ai-side-panel-btn"
                onClick={clearMessages}
                title="New chat"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="14" height="14">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </button>
            </>
          )}
          {/* Pop-out / Dock button */}
          {isOverlay ? (
            <button className="ai-side-panel-btn" onClick={handleDock} title="Dock to side panel (Esc)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="14" height="14">
                <polyline points="9 21 3 21 3 15" />
                <polyline points="15 3 21 3 21 9" />
                <line x1="3" y1="21" x2="10" y2="14" />
                <line x1="14" y1="10" x2="21" y2="3" />
              </svg>
            </button>
          ) : (
            <button className="ai-side-panel-btn" onClick={handlePopOut} title="Pop out to overlay (Cmd+Shift+A)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="14" height="14">
                <polyline points="15 3 21 3 21 9" />
                <polyline points="9 21 3 21 3 15" />
                <line x1="21" y1="3" x2="14" y2="10" />
                <line x1="3" y1="21" x2="10" y2="14" />
              </svg>
            </button>
          )}
          {!isOverlay && (
            <button
              className={`ai-side-panel-btn ${isPinned ? 'pinned' : ''}`}
              onClick={() => setIsPinned(!isPinned)}
              title={isPinned ? 'Unpin (auto-collapse)' : 'Pin (stay open)'}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="14" height="14">
                <path d="M12 17v5" />
                <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4.76z" />
              </svg>
            </button>
          )}
          {!isOverlay && (
            <button
              className="ai-side-panel-btn"
              onClick={() => setIsCollapsed(true)}
              title="Collapse (Esc)"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="14" height="14">
                <polyline points="13 17 18 12 13 7" />
                <polyline points="6 17 11 12 6 7" />
              </svg>
            </button>
          )}
          <button
            className="ai-side-panel-btn"
            onClick={onClose}
            title="Close (Cmd+Shift+I)"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="14" height="14">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>

      {/* Quick Actions */}
      <div className="ai-side-panel-quick-actions" data-testid="ai-quick-actions">
        <div className="ai-side-panel-quick-actions-label">{scriptContext ? 'Script Copilot' : 'Quick Actions'}</div>
        <div className="ai-side-panel-quick-actions-grid">
          {(scriptContext ? SCRIPT_QUICK_ACTIONS : QUICK_ACTIONS).map(action => (
            <button
              key={action.id}
              className="ai-side-panel-quick-action"
              onClick={() => handleQuickAction(action.prompt)}
              disabled={isAgentBusy}
            >
              {action.icon === 'wifi' && (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                  <path d="M5 12.55a11 11 0 0 1 14.08 0" />
                  <path d="M1.42 9a16 16 0 0 1 21.16 0" />
                  <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
                  <line x1="12" y1="20" x2="12.01" y2="20" />
                </svg>
              )}
              {action.icon === 'cpu' && (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                  <rect x="4" y="4" width="16" height="16" rx="2" ry="2" />
                  <rect x="9" y="9" width="6" height="6" />
                  <line x1="9" y1="1" x2="9" y2="4" />
                  <line x1="15" y1="1" x2="15" y2="4" />
                  <line x1="9" y1="20" x2="9" y2="23" />
                  <line x1="15" y1="20" x2="15" y2="23" />
                  <line x1="20" y1="9" x2="23" y2="9" />
                  <line x1="20" y1="14" x2="23" y2="14" />
                  <line x1="1" y1="9" x2="4" y2="9" />
                  <line x1="1" y1="14" x2="4" y2="14" />
                </svg>
              )}
              {action.icon === 'alert' && (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                  <line x1="12" y1="9" x2="12" y2="13" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
              )}
              {action.icon === 'server' && (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                  <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
                  <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
                  <line x1="6" y1="6" x2="6.01" y2="6" />
                  <line x1="6" y1="18" x2="6.01" y2="18" />
                </svg>
              )}
              {action.icon === 'info' && (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="16" x2="12" y2="12" />
                  <line x1="12" y1="8" x2="12.01" y2="8" />
                </svg>
              )}
              {action.icon === 'star' && (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                </svg>
              )}
              {action.icon === 'shield' && (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                </svg>
              )}
              {action.icon === 'comment' && (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                  <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
                </svg>
              )}
              <span>{action.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Messages */}
      <div className="ai-side-panel-messages" data-testid="ai-messages" ref={messagesRef}>
        {displayMessages.map(msg => (
          <div key={msg.id} className={`ai-side-panel-message message-${msg.type}`} onContextMenu={(e) => handleMessageContextMenu(e, msg)}>
            {msg.type === 'system' && (
              <div className="ai-side-panel-system-message">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="16" x2="12" y2="12" />
                  <line x1="12" y1="8" x2="12.01" y2="8" />
                </svg>
                {msg.content}
              </div>
            )}
            {msg.type === 'user' && (
              <div className="ai-side-panel-message-content">{msg.content}</div>
            )}
            {msg.type === 'agent' && (
              <div className="ai-side-panel-message-content">
                <MarkdownViewer content={msg.content} />
                {/* Streaming cursor — show on the last agent message while thinking */}
                {isOverlay && isAgentBusy && msg.id === displayMessages[displayMessages.length - 1]?.id && (
                  <span className="ai-streaming-cursor" />
                )}
                {scriptContext && (() => {
                  // Extract python code blocks and show "Apply to Script" buttons
                  const codeBlockRegex = /```(?:python)?\n([\s\S]*?)```/g
                  const codeBlocks: string[] = []
                  let match
                  while ((match = codeBlockRegex.exec(msg.content)) !== null) {
                    codeBlocks.push(match[1].trim())
                  }
                  if (codeBlocks.length > 0) {
                    return (
                      <div className="ai-side-panel-script-actions">
                        {codeBlocks.map((code, i) => (
                          <button
                            key={i}
                            className="ai-side-panel-apply-code-btn"
                            onClick={() => scriptContext.onApplyCode(code)}
                          >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                            {codeBlocks.length === 1 ? 'Apply to Script' : `Apply Block ${i + 1}`}
                          </button>
                        ))}
                      </div>
                    )
                  }
                  return null
                })()}
              </div>
            )}
            {msg.type === 'command-request' && (
              <div className="ai-side-panel-command-message">
                <div className="ai-side-panel-command-header warning">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                    <polyline points="4 17 10 11 4 5" />
                    <line x1="12" y1="19" x2="20" y2="19" />
                  </svg>
                  <span>Command Request</span>
                  {msg.sessionName && <span className="ai-side-panel-command-session">on {msg.sessionName}</span>}
                </div>
                <code className="ai-side-panel-code command">{msg.command}</code>
                {msg.content && <div className="ai-side-panel-command-note">{msg.content}</div>}
              </div>
            )}
            {msg.type === 'command-result' && (
              <div className="ai-side-panel-command-inline">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                  <polyline points="22 4 12 14.01 9 11.01" />
                </svg>
                {msg.command && <code>{msg.command}</code>}
                {msg.sessionName && <span className="ai-cmd-session">{msg.sessionName}</span>}
              </div>
            )}
            {msg.type === 'error' && (
              <div className="ai-side-panel-error">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                {msg.content}
              </div>
            )}
          </div>
        ))}

        {/* Pending Approval */}
        {pendingCommands.length > 0 && (
          <div className="ai-side-panel-pending">
            <div className="ai-side-panel-pending-header">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              <span>Approval Required</span>
              <span className="ai-side-panel-pending-count">({pendingCommands.length})</span>
            </div>
            <div className="ai-side-panel-pending-commands">
              {pendingCommands.map(cmd => (
                <div key={cmd.id} className="ai-side-panel-pending-command">
                  <div className="ai-side-panel-pending-session">{cmd.sessionName}</div>
                  <code className="ai-side-panel-pending-code">{cmd.command}</code>
                </div>
              ))}
            </div>
            <div className="ai-side-panel-pending-buttons">
              <button className="ai-side-panel-pending-btn approve" onClick={approveCommands}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                Approve{pendingCommands.length > 1 ? ' All' : ''}
              </button>
              <button className="ai-side-panel-pending-btn reject" onClick={rejectCommands}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
                Reject
              </button>
            </div>
          </div>
        )}

        {/* Processing indicator */}
        {isAgentBusy && (
          <div className="ai-side-panel-message assistant">
            <div className="ai-side-panel-loading">
              <span></span>
              <span></span>
              <span></span>
            </div>
          </div>
        )}
      </div>

      {/* Input - Cursor Style */}
      <div className="ai-input-container">
        <form onSubmit={handleSubmit}>
          {/* Text Input */}
          <textarea
            ref={inputRef}
            className="ai-input-textarea" data-testid="ai-input"
            placeholder={isAgentBusy ? 'Agent is working...' : 'Describe what to troubleshoot...'}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleSubmit()
              }
            }}
            disabled={isAgentBusy}
            rows={isOverlay ? 2 : 1}
          />

          {/* Bottom Bar */}
          <div className="ai-input-bottom-bar">
            {/* Left: Selectors */}
            <div className="ai-input-selectors">
              {/* AI Mode */}
              <div className="ai-text-selector">
                <select
                  value={aiMode}
                  onChange={e => {
                    const mode = e.target.value as import('../lib/aiModes').AIMode
                    setAiMode(mode)
                    // Set default autonomy for the mode
                    const modeDefaults: Record<string, AutonomyLevel> = {
                      chat: 'manual', operator: 'safe-auto', troubleshoot: 'safe-auto', copilot: 'manual'
                    }
                    setAutonomyLevel(modeDefaults[mode] || 'safe-auto')
                  }}
                  disabled={isAgentBusy}
                  title="AI operating mode"
                >
                  <option value="operator">Operator</option>
                  <option value="troubleshoot">Troubleshoot</option>
                  <option value="copilot">Copilot</option>
                  <option value="chat">Chat</option>
                </select>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="10" height="10">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </div>

              {/* Provider */}
              <div className="ai-text-selector provider-selector">
                <select
                  value={selectedProvider}
                  onChange={e => setSelectedProvider(e.target.value as AiProviderType)}
                  disabled={isAgentBusy}
                >
                  {providerConfigured.anthropic && (
                    <option value="anthropic">Anthropic</option>
                  )}
                  {providerConfigured.openai && (
                    <option value="openai">OpenAI</option>
                  )}
                  {providerConfigured.openrouter && (
                    <option value="openrouter">OpenRouter</option>
                  )}
                  {providerConfigured.ollama && (
                    <option value="ollama">Ollama</option>
                  )}
                  {providerConfigured.litellm && (
                    <option value="litellm">LiteLLM</option>
                  )}
                  {providerConfigured.custom && (
                    <option value="custom">Custom</option>
                  )}
                  {!providerConfigured.anthropic && !providerConfigured.openai && !providerConfigured.openrouter && !providerConfigured.ollama && !providerConfigured.litellm && !providerConfigured.custom && (
                    <option value="" disabled>No AI</option>
                  )}
                </select>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="10" height="10">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </div>

              {/* Model */}
              <div className="ai-text-selector model-selector">
                <select
                  value={selectedModel}
                  onChange={e => setSelectedModel(e.target.value)}
                  disabled={isAgentBusy || availableModels.length === 0}
                >
                  {availableModels.map(m => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                  {availableModels.length === 0 && (
                    <option value="" disabled>No models</option>
                  )}
                </select>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="10" height="10">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </div>

              {/* Session */}
              <div className="ai-icon-selector" title={availableSessions.find(s => s.id === selectedSession)?.name || 'Select session'}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                  <rect x="2" y="3" width="20" height="14" rx="2" />
                  <path d="M8 21h8" />
                  <path d="M12 17v4" />
                </svg>
                <select
                  value={selectedSession}
                  onChange={e => setSelectedSession(e.target.value)}
                  disabled={isAgentBusy}
                >
                  {availableSessions.length === 0 ? (
                    <option value="">No sessions</option>
                  ) : (
                    availableSessions.map(session => (
                      <option key={session.id} value={session.id}>
                        {session.name}
                      </option>
                    ))
                  )}
                </select>
              </div>
            </div>

            {/* Right: Send or Stop */}
            {isAgentBusy ? (
              <button
                type="button"
                className="ai-send-btn ai-stop-btn" data-testid="ai-send"
                onClick={stopAgent}
                title="Stop generating"
              >
                <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
                  <rect x="6" y="6" width="12" height="12" rx="2" />
                </svg>
              </button>
            ) : (
              <button
                type="submit"
                className="ai-send-btn"
                disabled={!input.trim()}
                title="Send (Enter)"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
                  <path d="M22 2L11 13" />
                  <path d="M22 2L15 22L11 13L2 9L22 2Z" />
                </svg>
              </button>
            )}
          </div>
        </form>
      </div>
      {isOverlay && (
          <div className="ai-overlay-resize-handle" onMouseDown={handleOverlayResizeStart}>
            <svg viewBox="0 0 24 24" fill="currentColor" width="10" height="10">
              <path d="M22 22H20V20H22V22ZM22 18H20V16H22V18ZM18 22H16V20H18V22ZM22 14H20V12H22V14ZM18 18H16V16H18V18ZM14 22H12V20H14V22Z" />
            </svg>
          </div>
        )}
    </div>

    {/* Promote to Background Task Dialog */}
    {showPromoteDialog && (
      <PromoteToTaskDialog
        messages={agentMessages}
        onClose={() => setShowPromoteDialog(false)}
        onPromote={handlePromoteToTask}
      />
    )}
    <ContextMenu position={msgContextMenu.position} items={msgContextMenu.items} onClose={msgContextMenu.close} />
    </>
  )
}

export default AISidePanel
