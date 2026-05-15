import type { GitOps, GitFileStatus, GitBranchInfo } from '../../types/workspace'

interface WorkspaceGitChangesProps {
  gitOps: GitOps
  branch: GitBranchInfo | null
  statuses: GitFileStatus[]
  onRefresh: () => void
  onOpenFile: (filePath: string, fileName: string) => void
  onViewDiff: (filePath: string) => void
}

export default function WorkspaceGitChanges(_props: WorkspaceGitChangesProps) {
  return <div style={{ padding: 8, color: 'var(--color-text-secondary)', fontSize: 12 }}>Changes tab — Task 4</div>
}
