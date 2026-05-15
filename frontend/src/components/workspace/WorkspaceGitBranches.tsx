import type { GitOps, GitBranchInfo } from '../../types/workspace'

interface WorkspaceGitBranchesProps {
  gitOps: GitOps
  currentBranch: GitBranchInfo | null
  onRefresh: () => void
}

export default function WorkspaceGitBranches(_props: WorkspaceGitBranchesProps) {
  return <div style={{ padding: 8, color: 'var(--color-text-secondary)', fontSize: 12 }}>Branches tab — Task 6</div>
}
