# Phase 3: Git Panel — Zone 1 Sidebar

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Git panel to Zone 1 sidebar with Files/Git tab switching, a Changes tab (staged/unstaged file lists + commit form), a History tab (commit list), and a Branches tab (branch list + create/switch).

**Architecture:** Zone 1 gets a tab bar (Files | Git) mirroring the Zone 3 tab pattern already in WorkspaceTab.css. The Git panel is a container with three sub-tabs rendered by focused child components. Each child receives `gitOps` and `git` status data as props. State for the active Zone 1 tab and Git sub-tab is persisted in workspace config via the existing auto-save mechanism.

**Tech Stack:** React, TypeScript, existing `GitOps` interface, existing `useGitStatus` hook, existing CSS variable system.

---

## File Structure

| Action | Path | Responsibility |
|--------|------|----------------|
| Modify | `frontend/src/types/workspace.ts` | Add `zone1Tab` and `gitPanelTab` to state/config types |
| Modify | `frontend/src/hooks/useWorkspace.ts` | Add `zone1Tab`/`gitPanelTab` state + setter, persist in config |
| Modify | `frontend/src/components/workspace/WorkspaceTab.tsx` | Zone 1 tab bar, conditional rendering of explorer vs git panel |
| Modify | `frontend/src/components/workspace/WorkspaceTab.css` | Zone 1 tab bar + all git panel styles |
| Create | `frontend/src/components/workspace/WorkspaceGitPanel.tsx` | Container with Changes/History/Branches sub-tab navigation |
| Create | `frontend/src/components/workspace/WorkspaceGitChanges.tsx` | Staged/unstaged file lists + commit form |
| Create | `frontend/src/components/workspace/WorkspaceGitHistory.tsx` | Commit list view |
| Create | `frontend/src/components/workspace/WorkspaceGitBranches.tsx` | Branch list + create/switch |

---

### Task 1: Add Zone 1 tab state to workspace types and hook

**Files:**
- Modify: `frontend/src/types/workspace.ts`
- Modify: `frontend/src/hooks/useWorkspace.ts`

- [ ] **Step 1: Add types**

In `frontend/src/types/workspace.ts`, add these type aliases after the `InnerTabType` line:

```typescript
export type Zone1Tab = 'files' | 'git'
export type GitPanelTab = 'changes' | 'history' | 'branches'
```

Add to `WorkspaceState` (after `selectedPath`):

```typescript
  zone1Tab: Zone1Tab
  gitPanelTab: GitPanelTab
```

Add to `WorkspaceConfig` (after `selectedPath`):

```typescript
  zone1Tab?: Zone1Tab
  gitPanelTab?: GitPanelTab
```

- [ ] **Step 2: Update useWorkspace**

In `frontend/src/hooks/useWorkspace.ts`:

Import the new types:

```typescript
import type {
  WorkspaceState,
  WorkspaceConfig,
  InnerTab,
  InnerTabType,
  FileOps,
  GitOps,
  Zone1Tab,
  GitPanelTab,
} from '../types/workspace'
```

In `UseWorkspaceReturn`, add:

```typescript
  setZone1Tab: (tab: Zone1Tab) => void
  setGitPanelTab: (tab: GitPanelTab) => void
```

In `createInitialState`, add to the return object (after `selectedPath`):

```typescript
    zone1Tab: config.zone1Tab || 'files',
    gitPanelTab: config.gitPanelTab || 'changes',
```

In `stateToConfig`, add (after `selectedPath`):

```typescript
    zone1Tab: state.zone1Tab,
    gitPanelTab: state.gitPanelTab,
```

In `useWorkspace`, add the setters (after `setSelectedPath`):

```typescript
  const setZone1Tab = useCallback((tab: Zone1Tab) => {
    setState(s => ({ ...s, zone1Tab: tab }))
  }, [])

  const setGitPanelTab = useCallback((tab: GitPanelTab) => {
    setState(s => ({ ...s, gitPanelTab: tab }))
  }, [])
```

Add to the `useEffect` dependency array that triggers auto-save (after `state.selectedPath`):

```typescript
    state.zone1Tab,
    state.gitPanelTab,
```

Add to the return object:

```typescript
    setZone1Tab,
    setGitPanelTab,
```

- [ ] **Step 3: Verify types compile**

Run: `cd /Users/cwdavis/scripts/netstacks-terminal/frontend && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add frontend/src/types/workspace.ts frontend/src/hooks/useWorkspace.ts
git commit -m "feat: add zone1Tab and gitPanelTab state to workspace types"
```

---

### Task 2: Add Zone 1 tab bar UI to WorkspaceTab

**Files:**
- Modify: `frontend/src/components/workspace/WorkspaceTab.tsx`
- Modify: `frontend/src/components/workspace/WorkspaceTab.css`

- [ ] **Step 1: Add Zone 1 tab bar CSS**

Append to `frontend/src/components/workspace/WorkspaceTab.css`:

```css
/* Zone 1 tab bar (Files / Git) */
.workspace-zone1-tabs {
  display: flex;
  align-items: center;
  height: 28px;
  flex-shrink: 0;
  background: var(--color-bg-tertiary);
  border-bottom: 1px solid var(--color-border);
  padding: 0 var(--spacing-xs);
}

.workspace-zone1-tab {
  padding: 0 var(--spacing-sm);
  height: 100%;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--color-text-secondary);
  font-size: var(--font-size-small);
  cursor: pointer;
  font-family: var(--font-family);
}

.workspace-zone1-tab:hover {
  color: var(--color-text-primary);
}

.workspace-zone1-tab.active {
  color: var(--color-text-primary);
  border-bottom-color: var(--color-accent);
}
```

- [ ] **Step 2: Add Zone 1 tab bar to WorkspaceTab**

In `frontend/src/components/workspace/WorkspaceTab.tsx`, replace the `<div className="workspace-explorer">` block (lines 148-167) with:

```tsx
      <div className="workspace-explorer" style={{ width: state.fileExplorerWidth }}>
        <div className="workspace-zone1-tabs">
          <button
            className={`workspace-zone1-tab ${state.zone1Tab === 'files' ? 'active' : ''}`}
            onClick={() => workspace.setZone1Tab('files')}
          >
            Files
          </button>
          <button
            className={`workspace-zone1-tab ${state.zone1Tab === 'git' ? 'active' : ''}`}
            onClick={() => workspace.setZone1Tab('git')}
          >
            Git
          </button>
        </div>
        {state.zone1Tab === 'files' ? (
          <WorkspaceFileExplorer
            rootPath={state.rootPath}
            mode={state.mode}
            fileOps={fileOps}
            expandedDirs={state.expandedDirs}
            selectedPath={state.selectedPath}
            gitBranch={git.branch}
            gitStatuses={git.statuses}
            isGitRepo={git.isGitRepo}
            onToggleDir={workspace.toggleDir}
            onSelectPath={workspace.setSelectedPath}
            onOpenFile={handleFileOpen}
            onRefreshGit={git.refresh}
            getFileStatus={git.getFileStatus}
            gitOps={gitOps}
            onViewDiff={handleViewDiff}
            onViewBlame={handleViewBlame}
          />
        ) : (
          <div style={{ flex: 1, overflow: 'auto' }}>
            <div style={{ padding: 16, color: 'var(--color-text-secondary)' }}>
              Git panel placeholder — wired in Task 3
            </div>
          </div>
        )}
      </div>
```

- [ ] **Step 3: Verify the tab bar renders**

Run: `cd /Users/cwdavis/scripts/netstacks-terminal/frontend && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/workspace/WorkspaceTab.tsx frontend/src/components/workspace/WorkspaceTab.css
git commit -m "feat: add Zone 1 Files/Git tab bar"
```

---

### Task 3: Create WorkspaceGitPanel container

**Files:**
- Create: `frontend/src/components/workspace/WorkspaceGitPanel.tsx`
- Modify: `frontend/src/components/workspace/WorkspaceTab.css`
- Modify: `frontend/src/components/workspace/WorkspaceTab.tsx`

- [ ] **Step 1: Add Git panel CSS**

Append to `frontend/src/components/workspace/WorkspaceTab.css`:

```css
/* Git Panel */
.workspace-git-panel {
  display: flex;
  flex-direction: column;
  flex: 1;
  overflow: hidden;
}

.workspace-git-panel-tabs {
  display: flex;
  align-items: center;
  height: 28px;
  flex-shrink: 0;
  background: var(--color-bg-secondary);
  border-bottom: 1px solid var(--color-border);
  padding: 0 var(--spacing-xs);
  gap: 2px;
}

.workspace-git-panel-tab {
  padding: 0 var(--spacing-sm);
  height: 100%;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--color-text-secondary);
  font-size: 11px;
  cursor: pointer;
  font-family: var(--font-family);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.workspace-git-panel-tab:hover {
  color: var(--color-text-primary);
}

.workspace-git-panel-tab.active {
  color: var(--color-text-primary);
  border-bottom-color: var(--color-accent);
}

.workspace-git-panel-content {
  flex: 1;
  overflow: auto;
}

.workspace-git-not-repo {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: var(--spacing-md);
  color: var(--color-text-secondary);
  font-size: var(--font-size-small);
  padding: var(--spacing-lg);
  text-align: center;
}

.workspace-git-init-btn {
  padding: var(--spacing-sm) var(--spacing-md);
  background: var(--color-accent);
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: var(--font-size-small);
  font-family: var(--font-family);
}

.workspace-git-init-btn:hover {
  opacity: 0.9;
}
```

- [ ] **Step 2: Create WorkspaceGitPanel component**

Create `frontend/src/components/workspace/WorkspaceGitPanel.tsx`:

```tsx
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
  onOpenFile: (filePath: string, fileName: string) => void
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
  onOpenFile,
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
            onOpenFile={onOpenFile}
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
```

- [ ] **Step 3: Wire WorkspaceGitPanel into WorkspaceTab**

In `frontend/src/components/workspace/WorkspaceTab.tsx`, add the import:

```typescript
import WorkspaceGitPanel from './WorkspaceGitPanel'
```

Replace the placeholder `<div>` for the git panel (the `else` branch) with:

```tsx
          <WorkspaceGitPanel
            gitOps={gitOps}
            isGitRepo={git.isGitRepo}
            branch={git.branch}
            statuses={git.statuses}
            activeTab={state.gitPanelTab}
            onSetTab={workspace.setGitPanelTab}
            onRefresh={git.refresh}
            onOpenFile={handleFileOpen}
            onViewDiff={handleViewDiff}
          />
```

Note: This will have a type error until Tasks 4-6 create the child components. Create stub files to resolve:

Create `frontend/src/components/workspace/WorkspaceGitChanges.tsx`:
```tsx
export default function WorkspaceGitChanges(_props: any) {
  return <div style={{ padding: 8, color: 'var(--color-text-secondary)', fontSize: 12 }}>Changes tab — Task 4</div>
}
```

Create `frontend/src/components/workspace/WorkspaceGitHistory.tsx`:
```tsx
export default function WorkspaceGitHistory(_props: any) {
  return <div style={{ padding: 8, color: 'var(--color-text-secondary)', fontSize: 12 }}>History tab — Task 5</div>
}
```

Create `frontend/src/components/workspace/WorkspaceGitBranches.tsx`:
```tsx
export default function WorkspaceGitBranches(_props: any) {
  return <div style={{ padding: 8, color: 'var(--color-text-secondary)', fontSize: 12 }}>Branches tab — Task 6</div>
}
```

- [ ] **Step 4: Verify compilation**

Run: `cd /Users/cwdavis/scripts/netstacks-terminal/frontend && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/workspace/WorkspaceGitPanel.tsx frontend/src/components/workspace/WorkspaceGitChanges.tsx frontend/src/components/workspace/WorkspaceGitHistory.tsx frontend/src/components/workspace/WorkspaceGitBranches.tsx frontend/src/components/workspace/WorkspaceTab.tsx frontend/src/components/workspace/WorkspaceTab.css
git commit -m "feat: add WorkspaceGitPanel container with sub-tab navigation"
```

---

### Task 4: Implement WorkspaceGitChanges

**Files:**
- Replace: `frontend/src/components/workspace/WorkspaceGitChanges.tsx`
- Modify: `frontend/src/components/workspace/WorkspaceTab.css`

This is the main Changes tab showing staged/unstaged file lists, a commit message textarea, and Commit / Commit & Push buttons.

- [ ] **Step 1: Add Changes tab CSS**

Append to `frontend/src/components/workspace/WorkspaceTab.css`:

```css
/* Git Changes Tab */
.workspace-git-changes {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.workspace-git-changes-section {
  flex-shrink: 0;
}

.workspace-git-changes-section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 8px;
  background: var(--color-bg-tertiary);
  border-bottom: 1px solid var(--color-border);
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  user-select: none;
}

.workspace-git-changes-section-btn {
  background: none;
  border: none;
  color: var(--color-text-secondary);
  font-size: 11px;
  cursor: pointer;
  padding: 0 4px;
  font-family: var(--font-family);
}

.workspace-git-changes-section-btn:hover {
  color: var(--color-text-primary);
}

.workspace-git-changes-file-list {
  max-height: 200px;
  overflow-y: auto;
}

.workspace-git-changes-file {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 8px;
  font-size: var(--font-size-small);
  cursor: pointer;
  color: var(--color-text-primary);
}

.workspace-git-changes-file:hover {
  background: var(--color-bg-hover);
}

.workspace-git-changes-file-status {
  width: 16px;
  text-align: center;
  font-weight: 600;
  font-size: 11px;
  flex-shrink: 0;
}

.workspace-git-changes-file-status.modified { color: var(--color-warning); }
.workspace-git-changes-file-status.added { color: var(--color-success); }
.workspace-git-changes-file-status.untracked { color: var(--color-success); }
.workspace-git-changes-file-status.deleted { color: var(--color-error); }
.workspace-git-changes-file-status.renamed { color: var(--color-text-accent); }

.workspace-git-changes-file-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-family-mono);
  font-size: 12px;
}

.workspace-git-changes-file-actions {
  display: flex;
  gap: 2px;
  opacity: 0;
}

.workspace-git-changes-file:hover .workspace-git-changes-file-actions {
  opacity: 1;
}

.workspace-git-changes-file-action-btn {
  background: none;
  border: none;
  color: var(--color-text-secondary);
  font-size: 12px;
  cursor: pointer;
  padding: 0 2px;
  line-height: 1;
}

.workspace-git-changes-file-action-btn:hover {
  color: var(--color-text-primary);
}

.workspace-git-commit-form {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border-top: 1px solid var(--color-border);
  flex-shrink: 0;
}

.workspace-git-commit-input {
  width: 100%;
  min-height: 60px;
  max-height: 120px;
  resize: vertical;
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border);
  border-radius: 4px;
  color: var(--color-text-primary);
  font-family: var(--font-family);
  font-size: var(--font-size-small);
  padding: 6px 8px;
}

.workspace-git-commit-input:focus {
  outline: none;
  border-color: var(--color-accent);
}

.workspace-git-commit-input::placeholder {
  color: var(--color-text-secondary);
}

.workspace-git-commit-actions {
  display: flex;
  gap: 6px;
}

.workspace-git-commit-btn {
  flex: 1;
  padding: 6px 8px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--color-bg-secondary);
  color: var(--color-text-primary);
  font-size: var(--font-size-small);
  font-family: var(--font-family);
  cursor: pointer;
}

.workspace-git-commit-btn:hover:not(:disabled) {
  background: var(--color-bg-hover);
}

.workspace-git-commit-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.workspace-git-commit-btn.primary {
  background: var(--color-accent);
  border-color: var(--color-accent);
  color: white;
}

.workspace-git-commit-btn.primary:hover:not(:disabled) {
  opacity: 0.9;
}

.workspace-git-changes-empty {
  padding: 16px;
  text-align: center;
  color: var(--color-text-secondary);
  font-size: var(--font-size-small);
}
```

- [ ] **Step 2: Implement WorkspaceGitChanges**

Replace `frontend/src/components/workspace/WorkspaceGitChanges.tsx`:

```tsx
import { useState, useCallback } from 'react'
import type { GitOps, GitFileStatus, GitBranchInfo, GitStatusCode } from '../../types/workspace'
import { showToast } from '../Toast'

interface WorkspaceGitChangesProps {
  gitOps: GitOps
  branch: GitBranchInfo | null
  statuses: GitFileStatus[]
  onRefresh: () => void
  onOpenFile: (filePath: string, fileName: string) => void
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
  onOpenFile,
  onViewDiff,
}: WorkspaceGitChangesProps) {
  const [commitMsg, setCommitMsg] = useState('')
  const [isCommitting, setIsCommitting] = useState(false)

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
        <textarea
          className="workspace-git-commit-input"
          placeholder="Commit message..."
          value={commitMsg}
          onChange={e => setCommitMsg(e.target.value)}
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
    </div>
  )
}
```

- [ ] **Step 3: Verify compilation**

Run: `cd /Users/cwdavis/scripts/netstacks-terminal/frontend && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/workspace/WorkspaceGitChanges.tsx frontend/src/components/workspace/WorkspaceTab.css
git commit -m "feat: implement WorkspaceGitChanges with staged/unstaged lists and commit form"
```

---

### Task 5: Implement WorkspaceGitHistory

**Files:**
- Replace: `frontend/src/components/workspace/WorkspaceGitHistory.tsx`
- Modify: `frontend/src/components/workspace/WorkspaceTab.css`

Commit list view — fetches `gitOps.log()` and renders a scrollable list. Clicking a commit opens the full diff in Zone 2.

- [ ] **Step 1: Add History tab CSS**

Append to `frontend/src/components/workspace/WorkspaceTab.css`:

```css
/* Git History Tab */
.workspace-git-history {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.workspace-git-history-list {
  flex: 1;
  overflow-y: auto;
}

.workspace-git-history-item {
  display: flex;
  flex-direction: column;
  padding: 6px 8px;
  border-bottom: 1px solid var(--color-border);
  cursor: pointer;
  gap: 2px;
}

.workspace-git-history-item:hover {
  background: var(--color-bg-hover);
}

.workspace-git-history-item-top {
  display: flex;
  align-items: center;
  gap: 6px;
}

.workspace-git-history-hash {
  font-family: var(--font-family-mono);
  font-size: 11px;
  color: var(--color-accent);
  flex-shrink: 0;
}

.workspace-git-history-message {
  font-size: var(--font-size-small);
  color: var(--color-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}

.workspace-git-history-item-bottom {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--color-text-secondary);
}

.workspace-git-history-author {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workspace-git-history-date {
  flex-shrink: 0;
  margin-left: auto;
}

.workspace-git-history-branches {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.workspace-git-history-badge {
  padding: 0 4px;
  border-radius: 3px;
  font-size: 10px;
  background: var(--color-bg-hover);
  color: var(--color-accent);
  border: 1px solid var(--color-border);
}

.workspace-git-history-loading {
  padding: 16px;
  text-align: center;
  color: var(--color-text-secondary);
  font-size: var(--font-size-small);
}

.workspace-git-history-empty {
  padding: 16px;
  text-align: center;
  color: var(--color-text-secondary);
  font-size: var(--font-size-small);
}
```

- [ ] **Step 2: Implement WorkspaceGitHistory**

Replace `frontend/src/components/workspace/WorkspaceGitHistory.tsx`:

```tsx
import { useState, useEffect, useCallback } from 'react'
import type { GitOps, CommitInfo } from '../../types/workspace'

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
    </div>
  )
}
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/workspace/WorkspaceGitHistory.tsx frontend/src/components/workspace/WorkspaceTab.css
git commit -m "feat: implement WorkspaceGitHistory with commit list view"
```

---

### Task 6: Implement WorkspaceGitBranches

**Files:**
- Replace: `frontend/src/components/workspace/WorkspaceGitBranches.tsx`
- Modify: `frontend/src/components/workspace/WorkspaceTab.css`

Branch list with current highlighted, switch on click, and New Branch dialog.

- [ ] **Step 1: Add Branches tab CSS**

Append to `frontend/src/components/workspace/WorkspaceTab.css`:

```css
/* Git Branches Tab */
.workspace-git-branches {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.workspace-git-branches-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 8px;
  background: var(--color-bg-tertiary);
  border-bottom: 1px solid var(--color-border);
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  flex-shrink: 0;
}

.workspace-git-branches-new-btn {
  background: none;
  border: none;
  color: var(--color-accent);
  font-size: 12px;
  cursor: pointer;
  padding: 0 4px;
  font-family: var(--font-family);
}

.workspace-git-branches-new-btn:hover {
  opacity: 0.8;
}

.workspace-git-branches-list {
  flex: 1;
  overflow-y: auto;
}

.workspace-git-branches-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  font-size: var(--font-size-small);
  cursor: pointer;
  color: var(--color-text-primary);
}

.workspace-git-branches-item:hover {
  background: var(--color-bg-hover);
}

.workspace-git-branches-item.current {
  font-weight: 600;
}

.workspace-git-branches-item-indicator {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.workspace-git-branches-item.current .workspace-git-branches-item-indicator {
  background: var(--color-accent);
}

.workspace-git-branches-item-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-family-mono);
  font-size: 12px;
}

.workspace-git-branches-item-upstream {
  font-size: 10px;
  color: var(--color-text-secondary);
}

.workspace-git-branches-loading {
  padding: 16px;
  text-align: center;
  color: var(--color-text-secondary);
  font-size: var(--font-size-small);
}

.workspace-git-branches-section-label {
  padding: 6px 8px 2px;
  font-size: 10px;
  color: var(--color-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.workspace-git-new-branch-form {
  display: flex;
  gap: 4px;
  padding: 6px 8px;
  border-top: 1px solid var(--color-border);
  flex-shrink: 0;
}

.workspace-git-new-branch-input {
  flex: 1;
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border);
  border-radius: 4px;
  color: var(--color-text-primary);
  font-family: var(--font-family-mono);
  font-size: 12px;
  padding: 4px 6px;
}

.workspace-git-new-branch-input:focus {
  outline: none;
  border-color: var(--color-accent);
}

.workspace-git-new-branch-submit {
  padding: 4px 8px;
  background: var(--color-accent);
  color: white;
  border: none;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  font-family: var(--font-family);
}

.workspace-git-new-branch-submit:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
```

- [ ] **Step 2: Implement WorkspaceGitBranches**

Replace `frontend/src/components/workspace/WorkspaceGitBranches.tsx`:

```tsx
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
```

- [ ] **Step 3: Verify full compilation and tests**

Run: `cd /Users/cwdavis/scripts/netstacks-terminal/frontend && npx tsc --noEmit && npx vitest run`
Expected: no type errors, all tests pass

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/workspace/WorkspaceGitBranches.tsx frontend/src/components/workspace/WorkspaceTab.css
git commit -m "feat: implement WorkspaceGitBranches with branch list and create/switch"
```

---

### Task 7: Build and smoke test

**Files:** None (verification only)

- [ ] **Step 1: Build the app**

Run: `cd /Users/cwdavis/scripts/netstacks-terminal && ./terminal-dev.sh -s`
Expected: builds and launches without errors

- [ ] **Step 2: Test Zone 1 tab switching**

Click the "Git" tab in Zone 1. Verify:
- Tab bar shows Files | Git with active state indicator
- Switching between tabs preserves file explorer state
- Git panel renders with Changes/History/Branches sub-tabs

- [ ] **Step 3: Test Changes tab**

Modify a file. Verify:
- File appears in "Changes" section with correct status badge (M/A/D/U)
- Click + button to stage → file moves to "Staged" section
- Click − button to unstage → file moves back to "Changes"
- "Stage All" / "Unstage All" buttons work
- Type commit message → Commit button enables
- Cmd+Enter shortcut commits
- Commit & Push commits and pushes

- [ ] **Step 4: Test History tab**

Switch to History sub-tab. Verify:
- Commit list loads with hash, message, author, relative date
- Branch badges display on commits that have them
- Scrolling works for long history

- [ ] **Step 5: Test Branches tab**

Switch to Branches sub-tab. Verify:
- Current branch highlighted with accent dot
- Local and Remote sections shown
- "+ New" shows inline form
- Creating a branch creates and switches to it
- Clicking a different branch switches to it

- [ ] **Step 6: Test non-git workspace**

Open a non-git workspace. Verify:
- Git tab shows "Not a git repository" with Initialize button
- Initialize creates a repo, Changes tab appears
