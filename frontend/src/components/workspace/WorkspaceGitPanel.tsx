import { useCallback } from 'react'
import WorkspaceGitChanges from './WorkspaceGitChanges'
import WorkspaceGitHistory from './WorkspaceGitHistory'
import WorkspaceGitBranches from './WorkspaceGitBranches'
import type { GitOps, GitFileStatus, GitBranchInfo, GitPanelTab } from '../../types/workspace'
import { showToast } from '../Toast'

interface WorkspaceGitPanelProps {
  gitOps: GitOps
  isGitRepo: boolean
  branch: GitBranchInfo | null
  statuses: GitFileStatus[]
  activeTab: GitPanelTab
  onSetTab: (tab: GitPanelTab) => void
  onRefresh: () => void
  onViewDiff: (filePath: string) => void
}

export default function WorkspaceGitPanel({
  gitOps,
  isGitRepo,
  branch,
  statuses,
  activeTab,
  onSetTab,
  onRefresh,
  onViewDiff,
}: WorkspaceGitPanelProps) {

  const handleInit = useCallback(async () => {
    try {
      await gitOps.init()
      onRefresh()
      showToast('Repository initialized', 'success')
    } catch (err) {
      showToast(`Init failed: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error')
    }
  }, [gitOps, onRefresh])

  if (!isGitRepo) {
    return (
      <div className="workspace-git-panel">
        <div className="workspace-git-not-repo">
          <span>Not a git repository</span>
          <button className="workspace-git-init-btn" onClick={handleInit}>
            Initialize Repository
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="workspace-git-panel">
      <div className="workspace-git-panel-tabs">
        <button
          className={`workspace-git-panel-tab ${activeTab === 'changes' ? 'active' : ''}`}
          onClick={() => onSetTab('changes')}
        >
          Changes
        </button>
        <button
          className={`workspace-git-panel-tab ${activeTab === 'history' ? 'active' : ''}`}
          onClick={() => onSetTab('history')}
        >
          History
        </button>
        <button
          className={`workspace-git-panel-tab ${activeTab === 'branches' ? 'active' : ''}`}
          onClick={() => onSetTab('branches')}
        >
          Branches
        </button>
      </div>
      <div className="workspace-git-panel-content">
        {activeTab === 'changes' && (
          <WorkspaceGitChanges
            gitOps={gitOps}
            branch={branch}
            statuses={statuses}
            onRefresh={onRefresh}
            onViewDiff={onViewDiff}
          />
        )}
        {activeTab === 'history' && (
          <WorkspaceGitHistory
            gitOps={gitOps}
            onViewDiff={onViewDiff}
          />
        )}
        {activeTab === 'branches' && (
          <WorkspaceGitBranches
            gitOps={gitOps}
            currentBranch={branch}
            onRefresh={onRefresh}
          />
        )}
      </div>
    </div>
  )
}
