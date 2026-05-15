import { useCallback, useRef, useEffect, forwardRef, useImperativeHandle } from 'react'
import Terminal, { type TerminalHandle } from '../Terminal'
import type { TerminalTab } from '../../types/workspace'

export interface WorkspaceTerminalPanelHandle {
  sendToActiveTerminal: (command: string) => void
}

interface WorkspaceTerminalPanelProps {
  terminalTabs: TerminalTab[]
  activeTerminalTabId: string | null
  collapsed: boolean
  workspaceRoot: string
  onSetActiveTab: (id: string) => void
  onCloseTab: (id: string) => void
  onAddTab: (title: string, command?: string) => string
  onToggleCollapse: () => void
}

export default forwardRef<WorkspaceTerminalPanelHandle, WorkspaceTerminalPanelProps>(
  function WorkspaceTerminalPanel({
    terminalTabs,
    activeTerminalTabId,
    collapsed,
    workspaceRoot,
    onSetActiveTab,
    onCloseTab,
    onAddTab,
    onToggleCollapse,
  }, ref) {
    const terminalRefs = useRef<Map<string, TerminalHandle>>(new Map())
    const launchedCommands = useRef<Set<string>>(new Set())

    const handleNewTerminal = useCallback(() => {
      onAddTab('bash')
    }, [onAddTab])

    const setTerminalRef = useCallback((tabId: string, handle: TerminalHandle | null) => {
      if (handle) {
        terminalRefs.current.set(tabId, handle)
      } else {
        terminalRefs.current.delete(tabId)
      }
    }, [])

    useImperativeHandle(ref, () => ({
      sendToActiveTerminal: (command: string) => {
        if (!activeTerminalTabId) return
        const handle = terminalRefs.current.get(activeTerminalTabId)
        if (handle) {
          handle.sendCommand(command)
        }
      },
    }), [activeTerminalTabId])

    // Auto-launch commands after terminal connects
    useEffect(() => {
      for (const tab of terminalTabs) {
        if (tab.command && !launchedCommands.current.has(tab.id)) {
          const handle = terminalRefs.current.get(tab.id)
          if (handle) {
            launchedCommands.current.add(tab.id)
            setTimeout(() => {
              const cdCmd = workspaceRoot ? `cd ${workspaceRoot.replace(/ /g, '\\ ')} && clear && ` : ''
              handle.sendCommand(`${cdCmd}${tab.command}`)
            }, 500)
          }
        }
      }
    })

    return (
      <>
        <div className="workspace-terminal-header" onDoubleClick={onToggleCollapse}>
          <div className="workspace-terminal-tabs">
            {terminalTabs.map(tab => (
              <div
                key={tab.id}
                className={`workspace-terminal-tab ${tab.id === activeTerminalTabId ? 'active' : ''}`}
                onClick={() => onSetActiveTab(tab.id)}
              >
                <span>{tab.isAiCli ? '🤖 ' : '$ '}{tab.title}</span>
                <button
                  className="workspace-terminal-tab-close"
                  onClick={(e) => { e.stopPropagation(); onCloseTab(tab.id) }}
                >
                  ×
                </button>
              </div>
            ))}
            <button
              className="workspace-terminal-action-btn"
              onClick={handleNewTerminal}
              title="New terminal"
              style={{ marginLeft: 2 }}
            >
              +
            </button>
          </div>
          <div className="workspace-terminal-actions">
            <button
              className="workspace-terminal-action-btn"
              onClick={onToggleCollapse}
              title={collapsed ? 'Expand' : 'Collapse'}
            >
              {collapsed ? '▲' : '▼'}
            </button>
          </div>
        </div>
        {!collapsed && (
          <div className="workspace-terminal-content">
            {terminalTabs.map(tab => (
              <div
                key={tab.id}
                style={{
                  display: tab.id === activeTerminalTabId ? 'block' : 'none',
                  width: '100%',
                  height: '100%',
                }}
              >
                <Terminal
                  id={`workspace-term-${tab.id}`}
                  sessionName={tab.title}
                  ref={(handle) => setTerminalRef(tab.id, handle)}
                />
              </div>
            ))}
            {terminalTabs.length === 0 && (
              <div className="workspace-empty-state">
                <div>No terminals open</div>
                <button className="workspace-terminal-action-btn" onClick={handleNewTerminal}>
                  + New Terminal
                </button>
              </div>
            )}
          </div>
        )}
      </>
    )
  }
)
