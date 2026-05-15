import { useState, useEffect, useCallback, useRef } from 'react'
import type { GitOps, GitBranchInfo, BranchEntry } from '../../types/workspace'
import { showToast } from '../Toast'
import ContextMenu from '../ContextMenu'
import type { MenuItem } from '../ContextMenu'

interface WorkspaceGitBranchesProps {
  gitOps: GitOps
  currentBranch: GitBranchInfo | null
  onRefresh: () => void
}

export default function WorkspaceGitBranches({
  gitOps,
  currentBranch,
  onRefresh,
}: WorkspaceGitBranchesProps) {
  const [branches, setBranches] = useState<BranchEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [showNewBranch, setShowNewBranch] = useState(false)
  const [newBranchName, setNewBranchName] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const [contextMenu, setContextMenu] = useState<{ position: { x: number; y: number }; items: MenuItem[] } | null>(null)

  const fetchBranches = useCallback(async () => {
    setLoading(true)
    try {
      const result = await gitOps.listBranches()
      setBranches(result)
    } catch {
      setBranches([])
    } finally {
      setLoading(false)
    }
  }, [gitOps])

  useEffect(() => {
    fetchBranches()
  }, [fetchBranches])

  useEffect(() => {
    if (showNewBranch && inputRef.current) {
      inputRef.current.focus()
    }
  }, [showNewBranch])

  const handleSwitch = useCallback(async (name: string) => {
    if (name === currentBranch?.name) return
    try {
      await gitOps.switchBranch(name)
      onRefresh()
      fetchBranches()
      showToast(`Switched to ${name}`, 'success')
    } catch (err) {
      showToast(`Switch failed: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error')
    }
  }, [gitOps, currentBranch, onRefresh, fetchBranches])

  const handleCreateBranch = useCallback(async () => {
    const name = newBranchName.trim()
    if (!name) return
    try {
      await gitOps.createBranch(name)
      await gitOps.switchBranch(name)
      setNewBranchName('')
      setShowNewBranch(false)
      onRefresh()
      fetchBranches()
      showToast(`Created and switched to ${name}`, 'success')
    } catch (err) {
      showToast(`Create failed: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error')
    }
  }, [gitOps, newBranchName, onRefresh, fetchBranches])

  const handleDeleteBranch = useCallback(async (name: string) => {
    try {
      await gitOps.deleteBranch(name)
      fetchBranches()
      showToast(`Deleted ${name}`, 'success')
    } catch (err) {
      showToast(`Delete failed: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error')
    }
  }, [gitOps, fetchBranches])

  const handleMerge = useCallback(async (name: string) => {
    try {
      await gitOps.merge(name)
      onRefresh()
      fetchBranches()
      showToast(`Merged ${name} into ${currentBranch?.name || 'current'}`, 'success')
    } catch (err) {
      showToast(`Merge failed: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error')
    }
  }, [gitOps, onRefresh, fetchBranches, currentBranch])

  const handleBranchContextMenu = useCallback((e: React.MouseEvent, branch: BranchEntry) => {
    e.preventDefault()
    e.stopPropagation()
    const items: MenuItem[] = []

    if (branch.isCurrent) {
      items.push({
        id: 'current',
        label: 'Current Branch',
        disabled: true,
        action: () => {},
      })
    } else {
      items.push({
        id: 'switch',
        label: 'Switch to Branch',
        action: () => handleSwitch(branch.name),
      })
      items.push({
        id: 'merge',
        label: `Merge into ${currentBranch?.name || 'current'}`,
        action: () => handleMerge(branch.name),
      })
      items.push({ id: 'divider-1', label: '', divider: true, action: () => {} })
      items.push({
        id: 'delete',
        label: 'Delete Branch',
        action: () => handleDeleteBranch(branch.name),
      })
    }
    setContextMenu({ position: { x: e.clientX, y: e.clientY }, items })
  }, [handleSwitch, handleMerge, handleDeleteBranch, currentBranch])

  const localBranches = branches.filter(b => !b.isRemote)
  const remoteBranches = branches.filter(b => b.isRemote)

  if (loading) {
    return <div className="workspace-git-branches-loading">Loading branches...</div>
  }

  return (
    <div className="workspace-git-branches">
      <div className="workspace-git-branches-header">
        <span>Branches</span>
        <button
          className="workspace-git-branches-new-btn"
          onClick={() => setShowNewBranch(!showNewBranch)}
        >
          + New
        </button>
      </div>

      {showNewBranch && (
        <div className="workspace-git-new-branch-form">
          <input
            ref={inputRef}
            className="workspace-git-new-branch-input"
            placeholder="branch-name"
            value={newBranchName}
            onChange={e => setNewBranchName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') handleCreateBranch()
              if (e.key === 'Escape') { setShowNewBranch(false); setNewBranchName('') }
            }}
          />
          <button
            className="workspace-git-new-branch-submit"
            disabled={!newBranchName.trim()}
            onClick={handleCreateBranch}
          >
            Create
          </button>
        </div>
      )}

      <div className="workspace-git-branches-list">
        <div className="workspace-git-branches-section-label">Local</div>
        {localBranches.map(b => (
          <div
            key={b.name}
            className={`workspace-git-branches-item ${b.isCurrent ? 'current' : ''}`}
            onClick={() => handleSwitch(b.name)}
            onContextMenu={(e) => handleBranchContextMenu(e, b)}
          >
            <span className="workspace-git-branches-item-indicator" />
            <span className="workspace-git-branches-item-name">{b.name}</span>
            {b.upstream && (
              <span className="workspace-git-branches-item-upstream">{b.upstream}</span>
            )}
          </div>
        ))}

        {remoteBranches.length > 0 && (
          <>
            <div className="workspace-git-branches-section-label">Remote</div>
            {remoteBranches.map(b => (
              <div
                key={b.name}
                className="workspace-git-branches-item"
              >
                <span className="workspace-git-branches-item-indicator" />
                <span className="workspace-git-branches-item-name">{b.name}</span>
              </div>
            ))}
          </>
        )}
      </div>

      <ContextMenu
        position={contextMenu?.position ?? null}
        items={contextMenu?.items ?? []}
        onClose={() => setContextMenu(null)}
      />
    </div>
  )
}
