import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { LocalFileOps, RemoteFileOps } from '../lib/fileOps'
import { AgentGitOps, RemoteGitOps } from '../lib/gitOps'
import { updateSavedWorkspace } from '../components/workspace/WorkspacesPanel'
import type {
  WorkspaceState,
  WorkspaceConfig,
  InnerTab,
  InnerTabType,
  FileOps,
  GitOps,
} from '../types/workspace'

interface UseWorkspaceOptions {
  config: WorkspaceConfig
}

interface UseWorkspaceReturn {
  state: WorkspaceState
  fileOps: FileOps
  gitOps: GitOps

  setFileExplorerWidth: (width: number) => void
  toggleDir: (path: string) => void
  setSelectedPath: (path: string | null) => void

  openInnerTab: (type: InnerTabType, opts: { filePath?: string; url?: string; title: string }) => void
  closeInnerTab: (id: string) => void
  setActiveInnerTab: (id: string) => void
  markInnerTabModified: (id: string, modified: boolean) => void

  setTerminalPanelHeight: (height: number) => void
  toggleTerminalPanel: () => void
  addTerminalTab: (title: string, command?: string) => string
  closeTerminalTab: (id: string) => void
  setActiveTerminalTab: (id: string) => void
}

function createInitialState(config: WorkspaceConfig): WorkspaceState {
  // Restore inner tabs from saved config
  const innerTabs: InnerTab[] = (config.openFiles || []).map((f, i) => ({
    id: crypto.randomUUID(),
    type: f.type,
    title: f.title,
    filePath: f.filePath,
    url: f.url,
    isModified: false,
  }))

  // Restore terminal tabs from saved config, or create default AI CLI tab
  const terminalSessions = config.terminalSessions || []
  const terminalTabs = terminalSessions.length > 0
    ? terminalSessions.map(t => ({
        id: crypto.randomUUID(),
        title: t.title,
        command: t.command,
        isAiCli: t.isAiCli,
      }))
    : config.autoLaunchAi && config.aiTool.tool !== 'none'
      ? [{
          id: crypto.randomUUID(),
          title: config.aiTool.tool === 'custom' ? 'AI CLI' : config.aiTool.tool,
          command: config.aiTool.tool === 'custom' ? config.aiTool.customCommand : config.aiTool.tool,
          isAiCli: true,
        }]
      : []

  const activeInnerTabId = config.activeFileIndex != null && innerTabs[config.activeFileIndex]
    ? innerTabs[config.activeFileIndex].id
    : innerTabs.length > 0 ? innerTabs[0].id : null

  const activeTerminalTabId = config.activeTerminalIndex != null && terminalTabs[config.activeTerminalIndex]
    ? terminalTabs[config.activeTerminalIndex].id
    : terminalTabs.length > 0 ? terminalTabs[0].id : null

  return {
    id: config.id,
    name: config.name,
    mode: config.mode,
    rootPath: config.rootPath,
    sessionId: config.sessionId,
    tunnels: [],
    aiTool: config.aiTool,
    autoLaunchAi: config.autoLaunchAi,
    fileExplorerWidth: config.fileExplorerWidth || 220,
    expandedDirs: new Set(config.expandedDirs || []),
    selectedPath: config.selectedPath || null,
    innerTabs,
    activeInnerTabId,
    terminalPanelHeight: config.terminalPanelHeight || 250,
    terminalPanelCollapsed: config.terminalPanelCollapsed || false,
    terminalTabs,
    activeTerminalTabId,
    gitBranch: null,
    gitStatus: [],
  }
}

function stateToConfig(state: WorkspaceState): WorkspaceConfig {
  return {
    id: state.id,
    name: state.name,
    mode: state.mode,
    rootPath: state.rootPath,
    sessionId: state.sessionId,
    aiTool: state.aiTool,
    autoLaunchAi: state.autoLaunchAi,
    fileExplorerWidth: state.fileExplorerWidth,
    terminalPanelHeight: state.terminalPanelHeight,
    terminalPanelCollapsed: state.terminalPanelCollapsed,
    expandedDirs: Array.from(state.expandedDirs),
    selectedPath: state.selectedPath,
    openFiles: state.innerTabs.map(t => ({
      type: t.type,
      title: t.title,
      filePath: t.filePath,
      url: t.url,
    })),
    activeFileIndex: state.activeInnerTabId
      ? state.innerTabs.findIndex(t => t.id === state.activeInnerTabId)
      : null,
    terminalSessions: state.terminalTabs.map(t => ({
      title: t.title,
      command: t.command,
      isAiCli: t.isAiCli,
    })),
    activeTerminalIndex: state.activeTerminalTabId
      ? state.terminalTabs.findIndex(t => t.id === state.activeTerminalTabId)
      : null,
  }
}

export function useWorkspace({ config }: UseWorkspaceOptions): UseWorkspaceReturn {
  const [state, setState] = useState<WorkspaceState>(() => createInitialState(config))
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const stateRef = useRef(state)
  stateRef.current = state

  const fileOps = useMemo<FileOps>(() => {
    if (config.mode === 'remote' && state.sftpConnectionId) {
      return new RemoteFileOps(state.sftpConnectionId)
    }
    return new LocalFileOps()
  }, [config.mode, state.sftpConnectionId])

  const gitOps = useMemo<GitOps>(() => {
    if (config.mode === 'remote' && config.sessionId) {
      return new RemoteGitOps(config.sessionId, config.rootPath)
    }
    return new AgentGitOps(config.rootPath)
  }, [config.mode, config.sessionId, config.rootPath])

  // Auto-save: debounced 1s after any state change
  useEffect(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      const cfg = stateToConfig(stateRef.current)
      updateSavedWorkspace(cfg).catch(() => {})
    }, 1000)
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [
    state.innerTabs,
    state.activeInnerTabId,
    state.terminalTabs,
    state.activeTerminalTabId,
    state.expandedDirs,
    state.selectedPath,
    state.fileExplorerWidth,
    state.terminalPanelHeight,
    state.terminalPanelCollapsed,
  ])

  // Save immediately on unmount
  useEffect(() => {
    return () => {
      const cfg = stateToConfig(stateRef.current)
      updateSavedWorkspace(cfg).catch(() => {})
    }
  }, [])

  const setFileExplorerWidth = useCallback((width: number) => {
    setState(s => ({ ...s, fileExplorerWidth: Math.max(150, Math.min(500, width)) }))
  }, [])

  const toggleDir = useCallback((path: string) => {
    setState(s => {
      const next = new Set(s.expandedDirs)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return { ...s, expandedDirs: next }
    })
  }, [])

  const setSelectedPath = useCallback((path: string | null) => {
    setState(s => ({ ...s, selectedPath: path }))
  }, [])

  const openInnerTab = useCallback((
    type: InnerTabType,
    opts: { filePath?: string; url?: string; title: string }
  ) => {
    setState(s => {
      const existing = s.innerTabs.find(t =>
        t.type === type && t.filePath === opts.filePath && t.url === opts.url
      )
      if (existing) {
        return { ...s, activeInnerTabId: existing.id }
      }
      const tab: InnerTab = {
        id: crypto.randomUUID(),
        type,
        title: opts.title,
        filePath: opts.filePath,
        url: opts.url,
        isModified: false,
      }
      return {
        ...s,
        innerTabs: [...s.innerTabs, tab],
        activeInnerTabId: tab.id,
      }
    })
  }, [])

  const closeInnerTab = useCallback((id: string) => {
    setState(s => {
      const idx = s.innerTabs.findIndex(t => t.id === id)
      const next = s.innerTabs.filter(t => t.id !== id)
      let nextActive = s.activeInnerTabId
      if (s.activeInnerTabId === id) {
        nextActive = next.length > 0
          ? next[Math.min(idx, next.length - 1)].id
          : null
      }
      return { ...s, innerTabs: next, activeInnerTabId: nextActive }
    })
  }, [])

  const setActiveInnerTab = useCallback((id: string) => {
    setState(s => ({ ...s, activeInnerTabId: id }))
  }, [])

  const markInnerTabModified = useCallback((id: string, modified: boolean) => {
    setState(s => ({
      ...s,
      innerTabs: s.innerTabs.map(t => t.id === id ? { ...t, isModified: modified } : t),
    }))
  }, [])

  const setTerminalPanelHeight = useCallback((height: number) => {
    setState(s => ({ ...s, terminalPanelHeight: Math.max(100, Math.min(600, height)) }))
  }, [])

  const toggleTerminalPanel = useCallback(() => {
    setState(s => ({ ...s, terminalPanelCollapsed: !s.terminalPanelCollapsed }))
  }, [])

  const addTerminalTab = useCallback((title: string, command?: string): string => {
    const id = crypto.randomUUID()
    setState(s => ({
      ...s,
      terminalTabs: [...s.terminalTabs, { id, title, command }],
      activeTerminalTabId: id,
    }))
    return id
  }, [])

  const closeTerminalTab = useCallback((id: string) => {
    setState(s => {
      const idx = s.terminalTabs.findIndex(t => t.id === id)
      const next = s.terminalTabs.filter(t => t.id !== id)
      let nextActive = s.activeTerminalTabId
      if (s.activeTerminalTabId === id) {
        nextActive = next.length > 0
          ? next[Math.min(idx, next.length - 1)].id
          : null
      }
      return { ...s, terminalTabs: next, activeTerminalTabId: nextActive }
    })
  }, [])

  const setActiveTerminalTab = useCallback((id: string) => {
    setState(s => ({ ...s, activeTerminalTabId: id }))
  }, [])

  return {
    state,
    fileOps,
    gitOps,
    setFileExplorerWidth,
    toggleDir,
    setSelectedPath,
    openInnerTab,
    closeInnerTab,
    setActiveInnerTab,
    markInnerTabModified,
    setTerminalPanelHeight,
    toggleTerminalPanel,
    addTerminalTab,
    closeTerminalTab,
    setActiveTerminalTab,
  }
}
