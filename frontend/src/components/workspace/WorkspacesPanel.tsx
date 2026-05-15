import { useState, useCallback, useEffect } from 'react'
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

  const load = useCallback(async () => {
    setSavedWorkspaces(await loadSavedWorkspaces())
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Re-load when openWorkspaceIds changes (a new workspace was just opened)
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

  return (
    <div className="workspace-panel-sidebar">
      <div className="workspace-panel-header">
        <span>Workspaces</span>
        <button
          className="workspace-explorer-header-btn"
          onClick={onNewWorkspace}
          title="New Workspace"
        >
          +
        </button>
      </div>
      <div className="workspace-panel-list">
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
    </div>
  )
}
