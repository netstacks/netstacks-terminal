import { useState, useCallback, useEffect, useRef } from 'react'
import type { WorkspaceConfig } from '../../types/workspace'
import { getClient } from '../../api/client'
import { showToast } from '../Toast'

interface WorkspacesPanelProps {
  onOpenWorkspace: (config: WorkspaceConfig) => void
  onNewWorkspace: () => void
  openWorkspaceIds: Set<string>
}

export async function loadSavedWorkspaces(): Promise<WorkspaceConfig[]> {
  try {
    const { data } = await getClient().http.get('/settings/workspaces')
    if (typeof data === 'string') return JSON.parse(data)
    if (Array.isArray(data)) return data
    if (data?.value) return typeof data.value === 'string' ? JSON.parse(data.value) : data.value
    return []
  } catch {
    return []
  }
}

async function saveSavedWorkspaces(workspaces: WorkspaceConfig[]): Promise<void> {
  await getClient().http.put('/settings/workspaces', JSON.stringify(workspaces))
}

export async function addSavedWorkspace(config: WorkspaceConfig): Promise<void> {
  const existing = await loadSavedWorkspaces()
  if (!existing.find(w => w.id === config.id)) {
    existing.push(config)
    await saveSavedWorkspaces(existing)
  }
}

export async function updateSavedWorkspace(config: WorkspaceConfig): Promise<void> {
  const existing = await loadSavedWorkspaces()
  const idx = existing.findIndex(w => w.id === config.id)
  if (idx >= 0) {
    existing[idx] = config
  } else {
    existing.push(config)
  }
  await saveSavedWorkspaces(existing)
}

export default function WorkspacesPanel({
  onOpenWorkspace,
  onNewWorkspace,
  openWorkspaceIds,
}: WorkspacesPanelProps) {
  const [savedWorkspaces, setSavedWorkspaces] = useState<WorkspaceConfig[]>([])
  const [wsCollapsed, setWsCollapsed] = useState(false)
  const [explorerCollapsed, setExplorerCollapsed] = useState(false)
  const [wsHeight, setWsHeight] = useState(140)
  const [isResizing, setIsResizing] = useState(false)
  const resizeStartY = useRef(0)
  const resizeStartHeight = useRef(0)

  const load = useCallback(async () => {
    setSavedWorkspaces(await loadSavedWorkspaces())
  }, [])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    load()
  }, [openWorkspaceIds.size, load])

  const deleteWorkspace = useCallback(async (id: string, name: string) => {
    const updated = savedWorkspaces.filter(w => w.id !== id)
    try {
      await saveSavedWorkspaces(updated)
      setSavedWorkspaces(updated)
      showToast(`Deleted "${name}"`, 'success', 1500)
    } catch {
      showToast('Failed to delete workspace', 'error')
    }
  }, [savedWorkspaces])

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setIsResizing(true)
    resizeStartY.current = e.clientY
    resizeStartHeight.current = wsHeight
  }, [wsHeight])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isResizing) return
    setWsHeight(Math.max(60, Math.min(400, resizeStartHeight.current + (e.clientY - resizeStartY.current))))
  }, [isResizing])

  const handleMouseUp = useCallback(() => {
    setIsResizing(false)
  }, [])

  return (
    <div
      className="workspace-panel-sidebar"
      onMouseMove={isResizing ? handleMouseMove : undefined}
      onMouseUp={isResizing ? handleMouseUp : undefined}
      onMouseLeave={isResizing ? handleMouseUp : undefined}
    >
      {/* ── Workspaces section (collapsible) ── */}
      <div
        className="workspace-panel-section-header"
        onClick={() => setWsCollapsed(!wsCollapsed)}
      >
        <span className="workspace-panel-section-toggle">{wsCollapsed ? '▸' : '▾'}</span>
        <span>WORKSPACES</span>
        <button
          className="workspace-panel-section-btn"
          onClick={(e) => { e.stopPropagation(); onNewWorkspace() }}
          title="New Workspace"
        >
          +
        </button>
      </div>

      {!wsCollapsed && (
        <div className="workspace-panel-list" style={{ height: wsHeight, overflow: 'auto' }}>
          {savedWorkspaces.length === 0 && (
            <div className="workspace-panel-empty">
              <p>No saved workspaces</p>
              <button className="workspace-panel-add-btn" onClick={onNewWorkspace}>
                + New Workspace
              </button>
            </div>
          )}
          {savedWorkspaces.map(ws => {
            const isOpen = openWorkspaceIds.has(ws.id)
            return (
              <div
                key={ws.id}
                className={`workspace-panel-item ${isOpen ? 'active' : ''}`}
                onClick={() => onOpenWorkspace(ws)}
              >
                <span className="workspace-panel-item-icon">
                  {ws.mode === 'remote' ? '📡' : '📁'}
                </span>
                <div className="workspace-panel-item-info">
                  <span className="workspace-panel-item-name">{ws.name}</span>
                  <span className="workspace-panel-item-path">{ws.rootPath}</span>
                </div>
                {isOpen && (
                  <span className="workspace-panel-item-badge">open</span>
                )}
                <button
                  className="workspace-panel-item-delete"
                  onClick={(e) => { e.stopPropagation(); deleteWorkspace(ws.id, ws.name) }}
                  title="Delete"
                >
                  ×
                </button>
              </div>
            )
          })}
        </div>
      )}

      {/* ── Resize handle ── */}
      {!wsCollapsed && !explorerCollapsed && (
        <div
          className="workspace-panel-resize-handle"
          onMouseDown={handleResizeStart}
        />
      )}

      {/* ── Explorer section (collapsible) ── */}
      <div
        className="workspace-panel-section-header"
        onClick={() => setExplorerCollapsed(!explorerCollapsed)}
      >
        <span className="workspace-panel-section-toggle">{explorerCollapsed ? '▸' : '▾'}</span>
        <span>EXPLORER</span>
      </div>

      {!explorerCollapsed && (
        <div id="workspace-sidebar-explorer" className="workspace-sidebar-explorer-target" />
      )}
    </div>
  )
}
