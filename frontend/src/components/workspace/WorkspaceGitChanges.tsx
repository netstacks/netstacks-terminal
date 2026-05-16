import { useState, useCallback } from 'react'
import type { GitOps, GitFileStatus, GitBranchInfo, GitStatusCode } from '../../types/workspace'
import { showToast } from '../Toast'
import ContextMenu from '../ContextMenu'
import type { MenuItem } from '../ContextMenu'
import AITabInput from '../AITabInput'

interface WorkspaceGitChangesProps {
  gitOps: GitOps
  branch: GitBranchInfo | null
  statuses: GitFileStatus[]
  onRefresh: () => void
  onViewDiff: (filePath: string) => void
}

const STATUS_LABELS: Record<GitStatusCode, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  untracked: 'U',
  renamed: 'R',
  copied: 'C',
  clean: '',
}

export default function WorkspaceGitChanges({
  gitOps,
  branch,
  statuses,
  onRefresh,
  onViewDiff,
}: WorkspaceGitChangesProps) {
  const [commitMsg, setCommitMsg] = useState('')
  const [isCommitting, setIsCommitting] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ position: { x: number; y: number }; items: MenuItem[] } | null>(null)

  const staged = statuses.filter(s => s.staged)
  const unstaged = statuses.filter(s => !s.staged && s.status !== 'clean')

  const handleStageAll = useCallback(async () => {
    try {
      const paths = unstaged.map(s => s.path)
      if (paths.length === 0) return
      await gitOps.stage(paths)
      onRefresh()
    } catch (err) {
      showToast(`Stage failed: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error')
    }
  }, [gitOps, unstaged, onRefresh])

  const handleUnstageAll = useCallback(async () => {
    try {
      const paths = staged.map(s => s.path)
      if (paths.length === 0) return
      await gitOps.unstage(paths)
      onRefresh()
    } catch (err) {
      showToast(`Unstage failed: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error')
    }
  }, [gitOps, staged, onRefresh])

  const handleStageFile = useCallback(async (path: string) => {
    try {
      await gitOps.stage([path])
      onRefresh()
    } catch (err) {
      showToast(`Stage failed: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error')
    }
  }, [gitOps, onRefresh])

  const handleUnstageFile = useCallback(async (path: string) => {
    try {
      await gitOps.unstage([path])
      onRefresh()
    } catch (err) {
      showToast(`Unstage failed: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error')
    }
  }, [gitOps, onRefresh])

  const handleRevertFile = useCallback(async (path: string) => {
    try {
      await gitOps.revert([path])
      onRefresh()
      showToast('Reverted', 'success', 1500)
    } catch (err) {
      showToast(`Revert failed: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error')
    }
  }, [gitOps, onRefresh])

  const handleFileContextMenu = useCallback((e: React.MouseEvent, file: GitFileStatus, isStaged: boolean) => {
    e.preventDefault()
    e.stopPropagation()
    const items: MenuItem[] = [
      {
        id: 'view-diff',
        label: 'View Diff',
        action: () => onViewDiff(file.path),
      },
      { id: 'divider-1', label: '', divider: true, action: () => {} },
    ]
    if (isStaged) {
      items.push({
        id: 'unstage',
        label: 'Unstage',
        action: () => handleUnstageFile(file.path),
      })
    } else {
      items.push({
        id: 'stage',
        label: 'Stage',
        action: () => handleStageFile(file.path),
      })
      items.push({
        id: 'revert',
        label: 'Revert Changes',
        action: () => handleRevertFile(file.path),
      })
    }
    setContextMenu({ position: { x: e.clientX, y: e.clientY }, items })
  }, [onViewDiff, handleStageFile, handleUnstageFile, handleRevertFile])

  const handleCommit = useCallback(async (andPush: boolean) => {
    if (!commitMsg.trim()) return
    setIsCommitting(true)
    try {
      await gitOps.commit(commitMsg.trim())
      if (andPush) {
        await gitOps.push()
      }
      setCommitMsg('')
      onRefresh()
      showToast(andPush ? 'Committed & pushed' : 'Committed', 'success')
    } catch (err) {
      showToast(`Commit failed: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error')
    } finally {
      setIsCommitting(false)
    }
  }, [gitOps, commitMsg, onRefresh])

  const fileName = (path: string) => path.split('/').pop() || path

  const renderFile = (file: GitFileStatus, isStaged: boolean) => (
    <div
      key={`${isStaged ? 's' : 'u'}-${file.path}`}
      className="workspace-git-changes-file"
      onClick={() => onViewDiff(file.path)}
      onContextMenu={(e) => handleFileContextMenu(e, file, isStaged)}
    >
      <span className={`workspace-git-changes-file-status ${file.status}`}>
        {STATUS_LABELS[file.status]}
      </span>
      <span className="workspace-git-changes-file-name" title={file.path}>
        {fileName(file.path)}
      </span>
      <div className="workspace-git-changes-file-actions">
        {isStaged ? (
          <button
            className="workspace-git-changes-file-action-btn"
            onClick={(e) => { e.stopPropagation(); handleUnstageFile(file.path) }}
            title="Unstage"
          >
            −
          </button>
        ) : (
          <button
            className="workspace-git-changes-file-action-btn"
            onClick={(e) => { e.stopPropagation(); handleStageFile(file.path) }}
            title="Stage"
          >
            +
          </button>
        )}
      </div>
    </div>
  )

  const hasChanges = staged.length > 0 || unstaged.length > 0
  const canCommit = commitMsg.trim().length > 0 && staged.length > 0

  return (
    <div className="workspace-git-changes">
      {!hasChanges ? (
        <div className="workspace-git-changes-empty">
          {branch ? `On branch ${branch.name} — no changes` : 'No changes'}
        </div>
      ) : (
        <>
          {staged.length > 0 && (
            <div className="workspace-git-changes-section">
              <div className="workspace-git-changes-section-header">
                <span>Staged ({staged.length})</span>
                <button className="workspace-git-changes-section-btn" onClick={handleUnstageAll}>
                  Unstage All
                </button>
              </div>
              <div className="workspace-git-changes-file-list">
                {staged.map(f => renderFile(f, true))}
              </div>
            </div>
          )}

          {unstaged.length > 0 && (
            <div className="workspace-git-changes-section">
              <div className="workspace-git-changes-section-header">
                <span>Changes ({unstaged.length})</span>
                <button className="workspace-git-changes-section-btn" onClick={handleStageAll}>
                  Stage All
                </button>
              </div>
              <div className="workspace-git-changes-file-list">
                {unstaged.map(f => renderFile(f, false))}
              </div>
            </div>
          )}
        </>
      )}

      <div className="workspace-git-commit-form">
        <AITabInput
          as="textarea"
          className="workspace-git-commit-input"
          placeholder="Commit message... (Tab to generate)"
          value={commitMsg}
          onChange={e => setCommitMsg(e.target.value)}
          aiField="commit message"
          aiPlaceholder="Git commit message summarizing the staged changes"
          aiContext={{ files: staged.map(s => `${s.status}: ${s.path}`).join(', '), branch: branch?.name }}
          onAIValue={setCommitMsg}
          rows={3}
          onKeyDown={e => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canCommit) {
              e.preventDefault()
              handleCommit(false)
            }
          }}
        />
        <div className="workspace-git-commit-actions">
          <button
            className="workspace-git-commit-btn primary"
            disabled={!canCommit || isCommitting}
            onClick={() => handleCommit(false)}
          >
            Commit
          </button>
          <button
            className="workspace-git-commit-btn"
            disabled={!canCommit || isCommitting}
            onClick={() => handleCommit(true)}
          >
            Commit & Push
          </button>
        </div>
      </div>

      <ContextMenu
        position={contextMenu?.position ?? null}
        items={contextMenu?.items ?? []}
        onClose={() => setContextMenu(null)}
      />
    </div>
  )
}
