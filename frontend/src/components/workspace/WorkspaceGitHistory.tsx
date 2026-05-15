import type { GitOps } from '../../types/workspace'

interface WorkspaceGitHistoryProps {
  gitOps: GitOps
  onViewDiff: (filePath: string) => void
}

export default function WorkspaceGitHistory(_props: WorkspaceGitHistoryProps) {
  return <div style={{ padding: 8, color: 'var(--color-text-secondary)', fontSize: 12 }}>History tab — Task 5</div>
}
