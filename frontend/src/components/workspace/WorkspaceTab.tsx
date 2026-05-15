import { useState, useCallback, useRef } from 'react'
import { useWorkspace } from '../../hooks/useWorkspace'
import { useGitStatus } from '../../hooks/useGitStatus'
import WorkspaceFileExplorer from './WorkspaceFileExplorer'
import WorkspaceEditorArea from './WorkspaceEditorArea'
import WorkspaceTerminalPanel, { type WorkspaceTerminalPanelHandle } from './WorkspaceTerminalPanel'
import WorkspaceOutputPanel from './WorkspaceOutputPanel'
import WorkspaceGitPanel from './WorkspaceGitPanel'
import type { WorkspaceConfig } from '../../types/workspace'
import './WorkspaceTab.css'

interface WorkspaceTabProps {
  config: WorkspaceConfig
}

type PythonRunMode = 'native' | 'netstacks' | null

const RUNNABLE_EXTS: Record<string, (path: string) => string> = {
  py: (p) => `python3 "${p}"`,
  sh: (p) => `bash "${p}"`,
  bash: (p) => `bash "${p}"`,
  zsh: (p) => `zsh "${p}"`,
  js: (p) => `node "${p}"`,
  ts: (p) => `npx tsx "${p}"`,
}

export default function WorkspaceTab({ config }: WorkspaceTabProps) {
  const workspace = useWorkspace({ config })
  const { state, fileOps, gitOps } = workspace
  const git = useGitStatus({
    gitOps,
    pollIntervalMs: state.mode === 'remote' ? 10000 : 5000,
  })
  const terminalPanelRef = useRef<WorkspaceTerminalPanelHandle>(null)

  const [isResizingExplorer, setIsResizingExplorer] = useState(false)
  const explorerStartX = useRef(0)
  const explorerStartWidth = useRef(0)

  const [isResizingTerminal, setIsResizingTerminal] = useState(false)
  const terminalStartY = useRef(0)
  const terminalStartHeight = useRef(0)

  const [pythonRunMode, setPythonRunMode] = useState<PythonRunMode>(config.pythonRunMode || null)
  const [showRunModeDialog, setShowRunModeDialog] = useState(false)
  const [pendingRunPath, setPendingRunPath] = useState<string | null>(null)

  // Output panel state for Netstacks engine runs
  const [outputFilePath, setOutputFilePath] = useState<string | null>(null)
  const [showOutput, setShowOutput] = useState(false)
  // Zone 3 mode: 'terminal' or 'output'
  const [zone3Mode, setZone3Mode] = useState<'terminal' | 'output'>('terminal')

  const handleExplorerResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setIsResizingExplorer(true)
    explorerStartX.current = e.clientX
    explorerStartWidth.current = state.fileExplorerWidth
  }, [state.fileExplorerWidth])

  const handleTerminalResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setIsResizingTerminal(true)
    terminalStartY.current = e.clientY
    terminalStartHeight.current = state.terminalPanelHeight
  }, [state.terminalPanelHeight])

  const isResizing = isResizingExplorer || isResizingTerminal

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (isResizingExplorer) {
      workspace.setFileExplorerWidth(explorerStartWidth.current + (e.clientX - explorerStartX.current))
    }
    if (isResizingTerminal) {
      workspace.setTerminalPanelHeight(terminalStartHeight.current + (terminalStartY.current - e.clientY))
    }
  }, [isResizingExplorer, isResizingTerminal, workspace])

  const handleMouseUp = useCallback(() => {
    setIsResizingExplorer(false)
    setIsResizingTerminal(false)
  }, [])

  const handleFileOpen = useCallback((filePath: string, fileName: string) => {
    workspace.openInnerTab('code-editor', { filePath, title: fileName })
  }, [workspace])

  const handleViewDiff = useCallback((filePath: string) => {
    const fileName = filePath.split('/').pop() || 'diff'
    workspace.openInnerTab('diff', { filePath, title: `${fileName} (diff)` })
  }, [workspace])

  const handleViewBlame = useCallback((filePath: string) => {
    const fileName = filePath.split('/').pop() || 'blame'
    workspace.openInnerTab('blame', { filePath, title: `${fileName} (blame)` })
  }, [workspace])

  const executeRun = useCallback((filePath: string, mode: PythonRunMode) => {
    const ext = filePath.split('.').pop()?.toLowerCase() || ''
    const fileName = filePath.split('/').pop() || 'run'

    if (state.terminalPanelCollapsed) {
      workspace.toggleTerminalPanel()
    }

    if (ext === 'py' && mode === 'netstacks') {
      // Run through Netstacks engine — show output panel
      setOutputFilePath(filePath)
      setShowOutput(true)
      setZone3Mode('output')
    } else {
      // Run natively in terminal
      const buildCmd = RUNNABLE_EXTS[ext]
      if (buildCmd) {
        setZone3Mode('terminal')
        workspace.addTerminalTab(fileName, buildCmd(filePath))
      }
    }
  }, [state.terminalPanelCollapsed, workspace])

  const handleRunFile = useCallback((filePath: string) => {
    const ext = filePath.split('.').pop()?.toLowerCase() || ''

    if (ext === 'py' && pythonRunMode === null) {
      setPendingRunPath(filePath)
      setShowRunModeDialog(true)
      return
    }

    executeRun(filePath, pythonRunMode)
  }, [pythonRunMode, executeRun])

  const handleRunModeSelect = useCallback((mode: PythonRunMode) => {
    setPythonRunMode(mode)
    setShowRunModeDialog(false)
    if (pendingRunPath) {
      executeRun(pendingRunPath, mode)
      setPendingRunPath(null)
    }
  }, [pendingRunPath, executeRun])

  return (
    <div
      className={`workspace-tab ${isResizing ? 'resizing' : ''}`}
      onMouseMove={isResizing ? handleMouseMove : undefined}
      onMouseUp={isResizing ? handleMouseUp : undefined}
      onMouseLeave={isResizing ? handleMouseUp : undefined}
    >
      <div className="workspace-explorer" style={{ width: state.fileExplorerWidth }}>
        <div className="workspace-zone1-tabs">
          <button
            className={`workspace-zone1-tab ${state.zone1Tab === 'files' ? 'active' : ''}`}
            onClick={() => workspace.setZone1Tab('files')}
          >
            Files
          </button>
          <button
            className={`workspace-zone1-tab ${state.zone1Tab === 'git' ? 'active' : ''}`}
            onClick={() => workspace.setZone1Tab('git')}
          >
            Git
          </button>
        </div>
        {state.zone1Tab === 'files' ? (
          <WorkspaceFileExplorer
            rootPath={state.rootPath}
            mode={state.mode}
            fileOps={fileOps}
            expandedDirs={state.expandedDirs}
            selectedPath={state.selectedPath}
            gitBranch={git.branch}
            gitStatuses={git.statuses}
            isGitRepo={git.isGitRepo}
            onToggleDir={workspace.toggleDir}
            onSelectPath={workspace.setSelectedPath}
            onOpenFile={handleFileOpen}
            onRefreshGit={git.refresh}
            getFileStatus={git.getFileStatus}
            gitOps={gitOps}
            onViewDiff={handleViewDiff}
            onViewBlame={handleViewBlame}
          />
        ) : (
          <WorkspaceGitPanel
            gitOps={gitOps}
            isGitRepo={git.isGitRepo}
            branch={git.branch}
            statuses={git.statuses}
            activeTab={state.gitPanelTab}
            onSetTab={workspace.setGitPanelTab}
            onRefresh={git.refresh}
            onOpenFile={handleFileOpen}
            onViewDiff={handleViewDiff}
          />
        )}
      </div>

      <div className="workspace-resize-handle vertical" onMouseDown={handleExplorerResizeStart} />

      <div className="workspace-main">
        <div className="workspace-editor-area" style={{
          flex: state.terminalPanelCollapsed && !showOutput ? 1 : undefined,
          height: state.terminalPanelCollapsed && !showOutput ? '100%' : undefined,
        }}>
          <WorkspaceEditorArea
            innerTabs={state.innerTabs}
            activeInnerTabId={state.activeInnerTabId}
            fileOps={fileOps}
            gitOps={gitOps}
            onSetActiveTab={workspace.setActiveInnerTab}
            onCloseTab={workspace.closeInnerTab}
            onMarkModified={workspace.markInnerTabModified}
            onRunFile={handleRunFile}
          />
        </div>

        {(!state.terminalPanelCollapsed || showOutput) && (
          <div className="workspace-resize-handle horizontal" onMouseDown={handleTerminalResizeStart} />
        )}

        <div
          className={`workspace-terminal-panel ${state.terminalPanelCollapsed && !showOutput ? 'collapsed' : ''}`}
          style={{ height: state.terminalPanelCollapsed && !showOutput ? 28 : state.terminalPanelHeight }}
        >
          {/* Zone 3 tab switcher when both terminal and output exist */}
          {showOutput && (
            <div className="workspace-zone3-tabs">
              <button
                className={`workspace-zone3-tab ${zone3Mode === 'terminal' ? 'active' : ''}`}
                onClick={() => setZone3Mode('terminal')}
              >
                Terminal
              </button>
              <button
                className={`workspace-zone3-tab ${zone3Mode === 'output' ? 'active' : ''}`}
                onClick={() => setZone3Mode('output')}
              >
                Output
              </button>
              <div style={{ flex: 1 }} />
              <button
                className="workspace-terminal-action-btn"
                onClick={() => workspace.toggleTerminalPanel()}
                title={state.terminalPanelCollapsed ? 'Expand' : 'Collapse'}
              >
                {state.terminalPanelCollapsed ? '▲' : '▼'}
              </button>
            </div>
          )}

          <div style={{ display: zone3Mode === 'terminal' ? 'flex' : 'none', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
            <WorkspaceTerminalPanel
              ref={terminalPanelRef}
              terminalTabs={state.terminalTabs}
              activeTerminalTabId={state.activeTerminalTabId}
              collapsed={state.terminalPanelCollapsed && !showOutput}
              mode={state.mode}
              sessionId={state.sessionId}
              workspaceRoot={state.rootPath}
              onSetActiveTab={workspace.setActiveTerminalTab}
              onCloseTab={workspace.closeTerminalTab}
              onAddTab={workspace.addTerminalTab}
              onToggleCollapse={workspace.toggleTerminalPanel}
            />
          </div>

          {showOutput && zone3Mode === 'output' && (
            <WorkspaceOutputPanel
              filePath={outputFilePath}
              onClose={() => { setShowOutput(false); setZone3Mode('terminal') }}
            />
          )}
        </div>
      </div>

      {showRunModeDialog && (
        <div className="workspace-new-dialog-overlay" onClick={() => { setShowRunModeDialog(false); setPendingRunPath(null) }}>
          <div className="workspace-new-dialog" onClick={e => e.stopPropagation()} style={{ width: 400 }}>
            <h3>How should Python files run?</h3>
            <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-small)', margin: '0 0 16px' }}>
              This choice will be remembered for this workspace.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <button className="workspace-run-mode-option" onClick={() => handleRunModeSelect('native')}>
                <span className="workspace-run-mode-icon">🐍</span>
                <div>
                  <div className="workspace-run-mode-title">Native (python3)</div>
                  <div className="workspace-run-mode-desc">Run with system Python. You manage dependencies yourself.</div>
                </div>
              </button>
              <button className="workspace-run-mode-option" onClick={() => handleRunModeSelect('netstacks')}>
                <span className="workspace-run-mode-icon">⚡</span>
                <div>
                  <div className="workspace-run-mode-title">Netstacks Engine (UV)</div>
                  <div className="workspace-run-mode-desc">Auto-installs dependencies from imports. Uses UV + PEP 723.</div>
                </div>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
