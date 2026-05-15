import { useState, useEffect, useCallback } from 'react'
import type { GitOps, CommitInfo } from '../../types/workspace'
import ContextMenu from '../ContextMenu'
import type { MenuItem } from '../ContextMenu'
import { showToast } from '../Toast'

interface WorkspaceGitHistoryProps {
  gitOps: GitOps
  onViewDiff: (filePath: string) => void
}

function formatRelativeDate(dateStr: string): string {
  try {
    const date = new Date(dateStr)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffMins = Math.floor(diffMs / 60000)
    if (diffMins < 1) return 'just now'
    if (diffMins < 60) return `${diffMins}m ago`
    const diffHours = Math.floor(diffMins / 60)
    if (diffHours < 24) return `${diffHours}h ago`
    const diffDays = Math.floor(diffHours / 24)
    if (diffDays < 30) return `${diffDays}d ago`
    if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo ago`
    return `${Math.floor(diffDays / 365)}y ago`
  } catch {
    return dateStr.slice(0, 10)
  }
}

export default function WorkspaceGitHistory({ gitOps }: WorkspaceGitHistoryProps) {
  const [commits, setCommits] = useState<CommitInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [contextMenu, setContextMenu] = useState<{ position: { x: number; y: number }; items: MenuItem[] } | null>(null)

  const fetchLog = useCallback(async () => {
    setLoading(true)
    try {
      const result = await gitOps.log(50)
      setCommits(result)
    } catch {
      setCommits([])
    } finally {
      setLoading(false)
    }
  }, [gitOps])

  const handleCommitContextMenu = useCallback((e: React.MouseEvent, commit: CommitInfo) => {
    e.preventDefault()
    e.stopPropagation()
    const items: MenuItem[] = [
      {
        id: 'copy-hash',
        label: 'Copy Hash',
        action: () => {
          navigator.clipboard.writeText(commit.hash)
          showToast('Hash copied', 'info', 1500)
        },
      },
      {
        id: 'copy-short-hash',
        label: 'Copy Short Hash',
        action: () => {
          navigator.clipboard.writeText(commit.shortHash)
          showToast('Short hash copied', 'info', 1500)
        },
      },
    ]
    setContextMenu({ position: { x: e.clientX, y: e.clientY }, items })
  }, [])

  useEffect(() => {
    fetchLog()
  }, [fetchLog])

  if (loading) {
    return <div className="workspace-git-history-loading">Loading history...</div>
  }

  if (commits.length === 0) {
    return <div className="workspace-git-history-empty">No commits yet</div>
  }

  return (
    <div className="workspace-git-history">
      <div className="workspace-git-history-list">
        {commits.map(commit => (
          <div
            key={commit.hash}
            className="workspace-git-history-item"
            onContextMenu={(e) => handleCommitContextMenu(e, commit)}
          >
            <div className="workspace-git-history-item-top">
              <span className="workspace-git-history-hash">{commit.shortHash}</span>
              <span className="workspace-git-history-message">{commit.message}</span>
              {commit.branches.length > 0 && (
                <div className="workspace-git-history-branches">
                  {commit.branches.slice(0, 2).map(b => (
                    <span key={b} className="workspace-git-history-badge">{b}</span>
                  ))}
                </div>
              )}
            </div>
            <div className="workspace-git-history-item-bottom">
              <span className="workspace-git-history-author">{commit.author}</span>
              <span className="workspace-git-history-date">{formatRelativeDate(commit.date)}</span>
            </div>
          </div>
        ))}
      </div>
      <ContextMenu
        position={contextMenu?.position ?? null}
        items={contextMenu?.items ?? []}
        onClose={() => setContextMenu(null)}
      />
    </div>
  )
}
