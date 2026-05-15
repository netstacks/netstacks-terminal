import { useState, useCallback, useEffect } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { listSessions } from '../../api/sessions'
import type { WorkspaceConfig, WorkspaceMode, AiToolType } from '../../types/workspace'

interface WorkspaceNewDialogProps {
  sessions?: { id: string; name: string }[]
  onSubmit: (config: WorkspaceConfig) => void
  onCancel: () => void
}

const AI_TOOLS: { value: AiToolType; label: string }[] = [
  { value: 'claude', label: 'Claude Code' },
  { value: 'aider', label: 'Aider' },
  { value: 'opencode', label: 'OpenCode' },
  { value: 'kimicode', label: 'KimiCode' },
  { value: 'none', label: 'None' },
  { value: 'custom', label: 'Custom...' },
]

export default function WorkspaceNewDialog({
  sessions: initialSessions,
  onSubmit,
  onCancel,
}: WorkspaceNewDialogProps) {
  const [sessions, setSessions] = useState(initialSessions || [])
  const [mode, setMode] = useState<WorkspaceMode>('local')
  const [localPath, setLocalPath] = useState('')
  const [remoteSessionId, setRemoteSessionId] = useState(sessions[0]?.id || '')

  useEffect(() => {
    if (sessions.length === 0) {
      listSessions().then(all => {
        const mapped = all.map((s: any) => ({ id: s.id, name: s.name }))
        setSessions(mapped)
        if (mapped.length > 0) setRemoteSessionId(mapped[0].id)
      }).catch(() => {})
    }
  }, [])
  const [remotePath, setRemotePath] = useState('')
  const [aiTool, setAiTool] = useState<AiToolType>('claude')
  const [customCommand, setCustomCommand] = useState('')
  const [autoLaunch, setAutoLaunch] = useState(true)

  const handleBrowse = useCallback(async () => {
    const selected = await open({ directory: true, multiple: false })
    if (selected && typeof selected === 'string') {
      setLocalPath(selected)
    }
  }, [])

  const handleSubmit = useCallback(() => {
    const rootPath = mode === 'local' ? localPath : remotePath
    if (!rootPath.trim()) return

    const name = rootPath.split('/').filter(Boolean).pop() || 'workspace'

    const config: WorkspaceConfig = {
      id: crypto.randomUUID(),
      name,
      mode,
      rootPath: rootPath.trim(),
      sessionId: mode === 'remote' ? remoteSessionId : undefined,
      aiTool: { tool: aiTool, customCommand: aiTool === 'custom' ? customCommand : undefined },
      autoLaunchAi: autoLaunch,
      fileExplorerWidth: 220,
      terminalPanelHeight: 250,
      terminalPanelCollapsed: false,
      expandedDirs: [],
      selectedPath: null,
      openFiles: [],
      activeFileIndex: null,
      terminalSessions: [],
      activeTerminalIndex: null,
    }

    onSubmit(config)
  }, [mode, localPath, remotePath, remoteSessionId, aiTool, customCommand, autoLaunch, onSubmit])

  const isValid = mode === 'local' ? localPath.trim().length > 0 : (remotePath.trim().length > 0 && remoteSessionId)

  return (
    <div className="workspace-new-dialog-overlay" onClick={onCancel}>
      <div className="workspace-new-dialog" onClick={e => e.stopPropagation()}>
        <h3>New Workspace</h3>

        <div className="workspace-new-dialog-field">
          <span className="workspace-new-dialog-label">Mode</span>
          <div className="workspace-new-dialog-radio-group">
            <label className="workspace-new-dialog-radio">
              <input type="radio" checked={mode === 'local'} onChange={() => setMode('local')} />
              Local Directory
            </label>
            <label className="workspace-new-dialog-radio">
              <input type="radio" checked={mode === 'remote'} onChange={() => setMode('remote')} />
              Remote Server
            </label>
          </div>
        </div>

        {mode === 'local' ? (
          <div className="workspace-new-dialog-field">
            <span className="workspace-new-dialog-label">Directory</span>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                className="workspace-new-dialog-input"
                value={localPath}
                onChange={e => setLocalPath(e.target.value)}
                placeholder="/path/to/project"
              />
              <button className="workspace-new-dialog-btn" onClick={handleBrowse}>Browse</button>
            </div>
          </div>
        ) : (
          <>
            <div className="workspace-new-dialog-field">
              <span className="workspace-new-dialog-label">SSH Session</span>
              <select
                className="workspace-new-dialog-select"
                value={remoteSessionId}
                onChange={e => setRemoteSessionId(e.target.value)}
              >
                {sessions.map(s => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
                {sessions.length === 0 && <option value="">No sessions available</option>}
              </select>
            </div>
            <div className="workspace-new-dialog-field">
              <span className="workspace-new-dialog-label">Remote Path</span>
              <input
                className="workspace-new-dialog-input"
                value={remotePath}
                onChange={e => setRemotePath(e.target.value)}
                placeholder="/home/user/project"
              />
            </div>
          </>
        )}

        <div className="workspace-new-dialog-field">
          <span className="workspace-new-dialog-label">AI Coding Tool</span>
          <select
            className="workspace-new-dialog-select"
            value={aiTool}
            onChange={e => setAiTool(e.target.value as AiToolType)}
          >
            {AI_TOOLS.map(t => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </div>

        {aiTool === 'custom' && (
          <div className="workspace-new-dialog-field">
            <span className="workspace-new-dialog-label">Custom Command</span>
            <input
              className="workspace-new-dialog-input"
              value={customCommand}
              onChange={e => setCustomCommand(e.target.value)}
              placeholder="e.g. aider --model claude-3.5-sonnet"
            />
          </div>
        )}

        <div className="workspace-new-dialog-field">
          <label className="workspace-new-dialog-checkbox">
            <input type="checkbox" checked={autoLaunch} onChange={e => setAutoLaunch(e.target.checked)} />
            Auto-launch AI tool on open
          </label>
        </div>

        <div className="workspace-new-dialog-actions">
          <button className="workspace-new-dialog-btn" onClick={onCancel}>Cancel</button>
          <button
            className="workspace-new-dialog-btn primary"
            onClick={handleSubmit}
            disabled={!isValid}
          >
            Open Workspace
          </button>
        </div>
      </div>
    </div>
  )
}
