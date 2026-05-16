import { useState, useCallback, useEffect } from 'react'
import type { WorkspaceConfig } from '../../types/workspace'
import { getClient } from '../../api/client'
import { showToast } from '../Toast'
import { confirmDialog } from '../ConfirmDialog'
import ScriptsPanel from '../ScriptsPanel'
import type { Script } from '../../api/scripts'

interface WorkspacesPanelProps {
  onOpenWorkspace: (config: WorkspaceConfig) => void
  onNewWorkspace: () => void
  openWorkspaceIds: Set<string>
  onOpenScript: (script: Script) => void
  onNewScript: () => void
  onAIGenerate: () => void
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
  onOpenScript,
  onNewScript,
  onAIGenerate,
}: WorkspacesPanelProps) {
  const [savedWorkspaces, setSavedWorkspaces] = useState<WorkspaceConfig[]>([])
  const [pyEngineCollapsed, setPyEngineCollapsed] = useState(false)
  const [wsCollapsed, setWsCollapsed] = useState(false)
  const [explorerCollapsed, setExplorerCollapsed] = useState(false)

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
    const ok = await confirmDialog({
      title: 'Delete saved workspace?',
      body: <>Remove the saved workspace <strong>{name}</strong>? Your git repository on disk is not touched.</>,
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!ok) return
    const updated = savedWorkspaces.filter(w => w.id !== id)
    try {
      await saveSavedWorkspaces(updated)
      setSavedWorkspaces(updated)
      showToast(`Deleted "${name}"`, 'success')
    } catch {
      showToast('Failed to delete workspace', 'error')
    }
  }, [savedWorkspaces])

  return (
    <div className="workspace-panel-sidebar">
      {/* ── Python Engine section ── */}
      <div
        className="workspace-panel-section-header"
        onClick={() => setPyEngineCollapsed(!pyEngineCollapsed)}
      >
        <span className="workspace-panel-section-toggle">{pyEngineCollapsed ? '▸' : '▾'}</span>
        <span>PYTHON ENGINE</span>
      </div>

      {!pyEngineCollapsed && (
        <div className="workspace-panel-list" style={{ flex: 'none', maxHeight: 'none' }}>
          <ScriptsPanel
            onOpenScript={onOpenScript}
            onNewScript={onNewScript}
            onAIGenerate={onAIGenerate}
          />
        </div>
      )}

      {/* ── Workspaces section ── */}
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
        <div className="workspace-panel-list" style={{ flex: explorerCollapsed ? 1 : undefined, maxHeight: explorerCollapsed ? 'none' : undefined }}>
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

      {/* ── Explorer section ── */}
      <div
        className="workspace-panel-section-header"
        onClick={() => setExplorerCollapsed(!explorerCollapsed)}
      >
        <span className="workspace-panel-section-toggle">{explorerCollapsed ? '▸' : '▾'}</span>
        <span>EXPLORER</span>
      </div>

      <div
        id="workspace-sidebar-explorer"
        className="workspace-sidebar-explorer-target"
        style={{ display: explorerCollapsed ? 'none' : undefined, flex: wsCollapsed ? 1 : undefined }}
      />
    </div>
  )
}
