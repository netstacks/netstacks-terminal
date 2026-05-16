import { useState, useCallback, useEffect } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { listSessions } from '../../api/sessions'
import { AgentGitOps } from '../../lib/gitOps'
import { LocalFileOps } from '../../lib/fileOps'
import { getClient } from '../../api/client'
import { showToast } from '../Toast'
import type { WorkspaceConfig, AiToolType } from '../../types/workspace'

type DialogMode = 'local' | 'remote' | 'clone'

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
  { value: 'netstacks-agent', label: 'NetStacks Agent' },
  { value: 'none', label: 'None' },
  { value: 'custom', label: 'Custom...' },
]

export default function WorkspaceNewDialog({
  sessions: initialSessions,
  onSubmit,
  onCancel,
}: WorkspaceNewDialogProps) {
  const [sessions, setSessions] = useState(initialSessions || [])
  const [mode, setMode] = useState<DialogMode>('local')
  const [localPath, setLocalPath] = useState('')
  const [remoteSessionId, setRemoteSessionId] = useState(sessions[0]?.id || '')
  const [cloneUrl, setCloneUrl] = useState('')
  const [clonePath, setClonePath] = useState('')
  const [cloning, setCloning] = useState(false)

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
  const [launchArgs, setLaunchArgs] = useState('')
  const [autoLaunch, setAutoLaunch] = useState(true)
  const [gitCheck, setGitCheck] = useState<{
    checking: boolean
    isRepo: boolean
    branch: string | null
    isEmpty: boolean
  } | null>(null)
  const [initGit, setInitGit] = useState(false)

  const handleBrowse = useCallback(async () => {
    const selected = await open({ directory: true, multiple: false })
    if (selected && typeof selected === 'string') {
      setLocalPath(selected)
    }
  }, [])

  useEffect(() => {
    if (mode !== 'local' || !localPath.trim()) {
      setGitCheck(null)
      setInitGit(false)
      return
    }
    const timer = setTimeout(async () => {
      setGitCheck({ checking: true, isRepo: false, branch: null, isEmpty: false })
      try {
        const ops = new AgentGitOps(localPath.trim())
        const isRepo = await ops.isRepo()
        let branch: string | null = null
        if (isRepo) {
          const branchInfo = await ops.branch()
          branch = branchInfo?.name ?? null
        }
        const fileOps = new LocalFileOps()
        let isEmpty = false
        try {
          const entries = await fileOps.readDir(localPath.trim())
          isEmpty = entries.length === 0
        } catch {
          isEmpty = false
        }
        setGitCheck({ checking: false, isRepo, branch, isEmpty })
      } catch {
        setGitCheck(null)
      }
    }, 500)
    return () => clearTimeout(timer)
  }, [localPath, mode])

  const handleSubmit = useCallback(async () => {
    if (mode === 'clone') {
      if (!cloneUrl.trim() || !clonePath.trim()) return
      setCloning(true)
      try {
        // Derive repo name from URL for destination subdirectory
        const repoName = cloneUrl.trim().split('/').pop()?.replace(/\.git$/, '') || 'repo'
        const fullPath = `${clonePath.trim()}/${repoName}`

        await getClient().http.post('/workspace/git/clone', {
          url: cloneUrl.trim(),
          destination: fullPath,
        })

        const name = repoName
        const config: WorkspaceConfig = {
          id: crypto.randomUUID(),
          name,
          mode: 'local',
          rootPath: fullPath,
          aiTool: { tool: aiTool, customCommand: aiTool === 'custom' ? customCommand : undefined, launchArgs: launchArgs.trim() || undefined },
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
      } catch (err) {
        showToast(`Clone failed: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error')
      } finally {
        setCloning(false)
      }
      return
    }

    const rootPath = mode === 'local' ? localPath : remotePath
    if (!rootPath.trim()) return

    const name = rootPath.split('/').filter(Boolean).pop() || 'workspace'

    if (initGit && mode === 'local') {
      try {
        const ops = new AgentGitOps(rootPath.trim())
        await ops.init()
      } catch {
        // Init may fail if already a repo — continue anyway
      }
    }

    const config: WorkspaceConfig = {
      id: crypto.randomUUID(),
      name,
      mode,
      rootPath: rootPath.trim(),
      sessionId: mode === 'remote' ? remoteSessionId : undefined,
      aiTool: { tool: aiTool, customCommand: aiTool === 'custom' ? customCommand : undefined, launchArgs: launchArgs.trim() || undefined },
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
  }, [mode, localPath, remotePath, remoteSessionId, aiTool, customCommand, launchArgs, autoLaunch, initGit, cloneUrl, clonePath, cloning, onSubmit])

  const isValid = mode === 'local'
    ? localPath.trim().length > 0
    : mode === 'remote'
    ? (remotePath.trim().length > 0 && remoteSessionId)
    : (cloneUrl.trim().length > 0 && clonePath.trim().length > 0)

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
            <label className="workspace-new-dialog-radio">
              <input type="radio" checked={mode === 'clone'} onChange={() => setMode('clone')} />
              Clone Repository
            </label>
          </div>
        </div>

        {mode === 'local' && (
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
        )}

        {mode === 'local' && gitCheck && (
          <div className="workspace-new-dialog-git-status">
            {gitCheck.checking ? (
              <span style={{ color: 'var(--color-text-secondary)' }}>Checking directory...</span>
            ) : gitCheck.isRepo ? (
              <div className="workspace-new-dialog-git-ok">
                ✓ Git repository{gitCheck.branch ? ` on branch "${gitCheck.branch}"` : ''}
              </div>
            ) : gitCheck.isEmpty ? (
              <div className="workspace-new-dialog-git-empty">
                <span>Empty directory</span>
                <label className="workspace-new-dialog-checkbox">
                  <input type="checkbox" checked={initGit} onChange={e => setInitGit(e.target.checked)} />
                  Initialize as git repository
                </label>
              </div>
            ) : (
              <div className="workspace-new-dialog-git-warn">
                <span>Not a git repository</span>
                <label className="workspace-new-dialog-checkbox">
                  <input type="checkbox" checked={initGit} onChange={e => setInitGit(e.target.checked)} />
                  Initialize as git repository
                </label>
              </div>
            )}
          </div>
        )}

        {mode === 'remote' && (
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

        {mode === 'clone' && (
          <>
            <div className="workspace-new-dialog-field">
              <span className="workspace-new-dialog-label">Repository URL</span>
              <input
                className="workspace-new-dialog-input"
                value={cloneUrl}
                onChange={e => setCloneUrl(e.target.value)}
                placeholder="https://github.com/user/repo.git"
              />
            </div>
            <div className="workspace-new-dialog-field">
              <span className="workspace-new-dialog-label">Clone to Directory</span>
              <div style={{ display: 'flex', gap: '8px' }}>
                <input
                  className="workspace-new-dialog-input"
                  value={clonePath}
                  onChange={e => setClonePath(e.target.value)}
                  placeholder="/path/to/clone/into"
                />
                <button className="workspace-new-dialog-btn" onClick={async () => {
                  const selected = await open({ directory: true, multiple: false })
                  if (selected && typeof selected === 'string') setClonePath(selected)
                }}>Browse</button>
              </div>
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

        {aiTool !== 'custom' && aiTool !== 'none' && aiTool !== 'netstacks-agent' && (
          <div className="workspace-new-dialog-field">
            <span className="workspace-new-dialog-label">Launch Arguments</span>
            <input
              className="workspace-new-dialog-input"
              value={launchArgs}
              onChange={e => setLaunchArgs(e.target.value)}
              placeholder="e.g. --dangerously-skip-permissions --continue"
            />
            <span style={{ fontSize: 10, color: 'var(--color-text-secondary)', marginTop: 2, display: 'block' }}>
              Full command: cd &lt;workspace&gt; &amp;&amp; clear &amp;&amp; {aiTool} {launchArgs || ''}
            </span>
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
            disabled={!isValid || cloning}
          >
            {cloning ? 'Cloning...' : mode === 'clone' ? 'Clone & Open' : 'Open Workspace'}
          </button>
        </div>
      </div>
    </div>
  )
}
