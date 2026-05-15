import { useState } from 'react'
import WorkspaceCodeEditor from './WorkspaceCodeEditor'
import WorkspaceBrowser from './WorkspaceBrowser'
import WorkspaceDiffViewer from './WorkspaceDiffViewer'
import WorkspaceBlameViewer from './WorkspaceBlameViewer'
import WorkspaceMarkdownPreview from './WorkspaceMarkdownPreview'
import type { InnerTab, FileOps, GitOps } from '../../types/workspace'

const RUNNABLE_EXTS = new Set(['py', 'sh', 'bash', 'zsh', 'js', 'ts'])

interface WorkspaceEditorAreaProps {
  innerTabs: InnerTab[]
  activeInnerTabId: string | null
  fileOps: FileOps
  gitOps: GitOps | null
  onSetActiveTab: (id: string) => void
  onCloseTab: (id: string) => void
  onMarkModified: (id: string, modified: boolean) => void
  onRunFile: (filePath: string) => void
  onCollapse?: () => void
}

export default function WorkspaceEditorArea({
  innerTabs,
  activeInnerTabId,
  fileOps,
  gitOps,
  onSetActiveTab,
  onCloseTab,
  onMarkModified,
  onRunFile,
  onCollapse,
}: WorkspaceEditorAreaProps) {
  const [previewTabs, setPreviewTabs] = useState<Set<string>>(new Set())

  if (innerTabs.length === 0) {
    return (
      <div className="workspace-empty-state">
        <div className="workspace-empty-state-icon">📝</div>
        <div>Open a file from the explorer</div>
      </div>
    )
  }

  const activeTab = innerTabs.find(t => t.id === activeInnerTabId) || innerTabs[0]
  const activeExt = activeTab.filePath?.split('.').pop()?.toLowerCase() || ''
  const canRun = activeTab.type === 'code-editor' && activeTab.filePath && RUNNABLE_EXTS.has(activeExt)
  const isMdFile = activeTab.type === 'code-editor' && activeTab.filePath && (activeExt === 'md' || activeExt === 'markdown')
  const isPreview = previewTabs.has(activeTab.id)

  const renderTabContent = (tab: InnerTab) => {
    switch (tab.type) {
      case 'code-editor':
        if (isPreview && tab.id === activeTab.id && tab.filePath) {
          return (
            <WorkspaceMarkdownPreview
              key={`preview-${tab.id}`}
              filePath={tab.filePath}
              fileOps={fileOps}
            />
          )
        }
        return (
          <WorkspaceCodeEditor
            key={tab.id}
            filePath={tab.filePath!}
            fileOps={fileOps}
            isModified={tab.isModified || false}
            onModifiedChange={(modified) => onMarkModified(tab.id, modified)}
            onRunFile={onRunFile}
          />
        )
      case 'browser':
        return (
          <WorkspaceBrowser
            key={tab.id}
            initialUrl={tab.url || 'about:blank'}
          />
        )
      case 'diff':
        if (!tab.filePath || !gitOps) return null
        return (
          <WorkspaceDiffViewer
            key={tab.id}
            filePath={tab.filePath}
            gitOps={gitOps}
          />
        )
      case 'blame':
        if (!tab.filePath || !gitOps) return null
        return (
          <WorkspaceBlameViewer
            key={tab.id}
            filePath={tab.filePath}
            gitOps={gitOps}
          />
        )
      default:
        return null
    }
  }

  return (
    <>
      <div className="workspace-inner-tab-bar" onDoubleClick={onCollapse}>
        <div className="workspace-inner-tab-list">
          {innerTabs.map(tab => (
            <div
              key={tab.id}
              className={`workspace-inner-tab ${tab.id === activeTab.id ? 'active' : ''}`}
              onClick={() => onSetActiveTab(tab.id)}
            >
              {tab.isModified && <span className="workspace-inner-tab-modified" />}
              <span>{tab.title}</span>
              <button
                className="workspace-inner-tab-close"
                onClick={(e) => { e.stopPropagation(); onCloseTab(tab.id) }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        {canRun && (
          <button
            className="workspace-run-btn"
            onClick={() => onRunFile(activeTab.filePath!)}
            title={`Run ${activeTab.title}`}
          >
            <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
              <path d="M8 5v14l11-7z" />
            </svg>
          </button>
        )}
        {isMdFile && (
          <button
            className="workspace-terminal-action-btn"
            onClick={() => setPreviewTabs(prev => {
              const next = new Set(prev)
              if (next.has(activeTab.id)) next.delete(activeTab.id)
              else next.add(activeTab.id)
              return next
            })}
            title={isPreview ? 'Edit' : 'Preview'}
            style={{ fontSize: 12, padding: '0 6px' }}
          >
            {isPreview ? '✏️' : '👁'}
          </button>
        )}
        {onCollapse && (
          <button
            className="workspace-terminal-action-btn"
            onClick={onCollapse}
            title="Collapse editor"
          >
            ▲
          </button>
        )}
      </div>
      <div className="workspace-inner-tab-content">
        {renderTabContent(activeTab)}
      </div>
    </>
  )
}
