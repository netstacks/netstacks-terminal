import { useState, useEffect, useCallback, useRef } from 'react'
import type { GitOps, GitBranchInfo, BranchEntry } from '../../types/workspace'
import { showToast } from '../Toast'

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
    </div>
  )
}
