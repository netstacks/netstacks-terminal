# Phase 2: Context Menu Refactor + File Explorer Git Actions

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the inline context menu in WorkspaceFileExplorer with the shared ContextMenu component, add git file actions (Stage, Unstage, Revert, View Diff, View Blame), and wire up diff and blame viewers in Zone 2.

**Architecture:** A new `getFileExplorerMenuItems()` builder function (matching the pattern of `getDeviceMenuItems()`, `getDetectionMenuItems()` in `ContextMenu.tsx`) produces `MenuItem[]` based on file/directory context and git status. The existing shared `ContextMenu` component renders them. New `WorkspaceDiffViewer` and `WorkspaceBlameViewer` components render git diffs and blame annotations as inner tabs in Zone 2. The `gitOps` interface is threaded from `WorkspaceTab` → `WorkspaceFileExplorer` → menu actions, and from `WorkspaceTab` → `WorkspaceEditorArea` → diff/blame viewers.

**Tech Stack:** React, TypeScript, Vitest, existing `ContextMenu` component, existing `GitOps` interface / `AgentGitOps` class.

---

## File Structure

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `frontend/src/components/workspace/fileExplorerMenuItems.ts` | Builder function producing `MenuItem[]` for file/directory context menus |
| Create | `frontend/src/components/workspace/__tests__/fileExplorerMenuItems.test.ts` | Tests for menu item builder |
| Create | `frontend/src/components/workspace/WorkspaceDiffViewer.tsx` | Renders unified git diff output as an inner tab |
| Create | `frontend/src/components/workspace/WorkspaceDiffViewer.css` | Styles for the diff viewer |
| Create | `frontend/src/components/workspace/WorkspaceBlameViewer.tsx` | Renders git blame annotations as an inner tab |
| Create | `frontend/src/components/workspace/WorkspaceBlameViewer.css` | Styles for the blame viewer |
| Modify | `frontend/src/types/workspace.ts:10` | Add `'blame'` to `InnerTabType` union |
| Modify | `frontend/src/components/workspace/WorkspaceEditorArea.tsx` | Handle `'diff'` and `'blame'` tab types, pass `gitOps` to viewers |
| Modify | `frontend/src/components/workspace/WorkspaceFileExplorer.tsx` | Replace inline context menu with shared `ContextMenu`, accept `gitOps` + `onViewDiff` props |
| Modify | `frontend/src/components/workspace/WorkspaceTab.tsx` | Thread `gitOps` and diff-open callback to explorer and editor area |
| Modify | `frontend/src/components/workspace/WorkspaceTab.css` | Remove dead `.workspace-context-menu*` styles |

---

### Task 1: Create the file explorer context menu item builder

**Files:**
- Create: `frontend/src/components/workspace/fileExplorerMenuItems.ts`
- Create: `frontend/src/components/workspace/__tests__/fileExplorerMenuItems.test.ts`

This function takes context (entry, git status, isGitRepo) and callbacks, and returns `MenuItem[]` following the spec's group order: Primary → Git → File CRUD → Copy.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/components/workspace/__tests__/fileExplorerMenuItems.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { getFileExplorerMenuItems } from '../fileExplorerMenuItems'
import type { WorkspaceFileEntry, GitFileStatus } from '../../../types/workspace'

const makeEntry = (overrides: Partial<WorkspaceFileEntry> = {}): WorkspaceFileEntry => ({
  name: 'test.ts',
  path: '/project/src/test.ts',
  isDir: false,
  size: 100,
  modified: null,
  ...overrides,
})

const makeDirEntry = (overrides: Partial<WorkspaceFileEntry> = {}): WorkspaceFileEntry => ({
  name: 'src',
  path: '/project/src',
  isDir: true,
  size: 0,
  modified: null,
  ...overrides,
})

const makeCallbacks = () => ({
  onOpen: vi.fn(),
  onNewFile: vi.fn(),
  onNewFolder: vi.fn(),
  onRename: vi.fn(),
  onDelete: vi.fn(),
  onCopyPath: vi.fn(),
  onCopyRelativePath: vi.fn(),
  onStage: vi.fn(),
  onUnstage: vi.fn(),
  onRevert: vi.fn(),
  onViewDiff: vi.fn(),
  onViewBlame: vi.fn(),
})

describe('getFileExplorerMenuItems', () => {
  it('returns Open as first item for files', () => {
    const cb = makeCallbacks()
    const items = getFileExplorerMenuItems(
      { entry: makeEntry(), parentDir: '/project/src', isGitRepo: false, gitStatus: undefined, rootPath: '/project' },
      cb,
    )
    const nonDividers = items.filter(i => !i.divider)
    expect(nonDividers[0].id).toBe('open')
    expect(nonDividers[0].label).toBe('Open')
  })

  it('does not include Open for directories', () => {
    const cb = makeCallbacks()
    const items = getFileExplorerMenuItems(
      { entry: makeDirEntry(), parentDir: '/project', isGitRepo: false, gitStatus: undefined, rootPath: '/project' },
      cb,
    )
    expect(items.find(i => i.id === 'open')).toBeUndefined()
  })

  it('includes git actions when isGitRepo is true and file has unstaged changes', () => {
    const cb = makeCallbacks()
    const status: GitFileStatus = { path: 'src/test.ts', status: 'modified', staged: false }
    const items = getFileExplorerMenuItems(
      { entry: makeEntry(), parentDir: '/project/src', isGitRepo: true, gitStatus: status, rootPath: '/project' },
      cb,
    )
    expect(items.find(i => i.id === 'git-stage')).toBeDefined()
    expect(items.find(i => i.id === 'git-unstage')).toBeUndefined()
    expect(items.find(i => i.id === 'git-revert')).toBeDefined()
    expect(items.find(i => i.id === 'git-diff')).toBeDefined()
    expect(items.find(i => i.id === 'git-blame')).toBeDefined()
  })

  it('shows Unstage instead of Stage when file is staged', () => {
    const cb = makeCallbacks()
    const status: GitFileStatus = { path: 'src/test.ts', status: 'modified', staged: true }
    const items = getFileExplorerMenuItems(
      { entry: makeEntry(), parentDir: '/project/src', isGitRepo: true, gitStatus: status, rootPath: '/project' },
      cb,
    )
    expect(items.find(i => i.id === 'git-unstage')).toBeDefined()
    expect(items.find(i => i.id === 'git-stage')).toBeUndefined()
  })

  it('omits git actions when isGitRepo is false', () => {
    const cb = makeCallbacks()
    const items = getFileExplorerMenuItems(
      { entry: makeEntry(), parentDir: '/project/src', isGitRepo: false, gitStatus: undefined, rootPath: '/project' },
      cb,
    )
    expect(items.find(i => i.id === 'git-stage')).toBeUndefined()
    expect(items.find(i => i.id === 'git-unstage')).toBeUndefined()
    expect(items.find(i => i.id === 'git-revert')).toBeUndefined()
    expect(items.find(i => i.id === 'git-diff')).toBeUndefined()
    expect(items.find(i => i.id === 'git-blame')).toBeUndefined()
  })

  it('includes Stage All in Folder for directories in git repos', () => {
    const cb = makeCallbacks()
    const items = getFileExplorerMenuItems(
      { entry: makeDirEntry(), parentDir: '/project', isGitRepo: true, gitStatus: undefined, rootPath: '/project' },
      cb,
    )
    expect(items.find(i => i.id === 'git-stage-folder')).toBeDefined()
  })

  it('always includes New File, New Folder, Copy Path', () => {
    const cb = makeCallbacks()
    const items = getFileExplorerMenuItems(
      { entry: makeEntry(), parentDir: '/project/src', isGitRepo: false, gitStatus: undefined, rootPath: '/project' },
      cb,
    )
    expect(items.find(i => i.id === 'new-file')).toBeDefined()
    expect(items.find(i => i.id === 'new-folder')).toBeDefined()
    expect(items.find(i => i.id === 'copy-path')).toBeDefined()
  })

  it('includes Rename and Delete for named entries', () => {
    const cb = makeCallbacks()
    const items = getFileExplorerMenuItems(
      { entry: makeEntry(), parentDir: '/project/src', isGitRepo: false, gitStatus: undefined, rootPath: '/project' },
      cb,
    )
    expect(items.find(i => i.id === 'rename')).toBeDefined()
    expect(items.find(i => i.id === 'delete')).toBeDefined()
  })

  it('omits Rename and Delete for root entry (empty name)', () => {
    const cb = makeCallbacks()
    const entry = makeEntry({ name: '', path: '/project' })
    const items = getFileExplorerMenuItems(
      { entry, parentDir: '/project', isGitRepo: false, gitStatus: undefined, rootPath: '/project' },
      cb,
    )
    expect(items.find(i => i.id === 'rename')).toBeUndefined()
    expect(items.find(i => i.id === 'delete')).toBeUndefined()
  })

  it('calls onStage with file path when Stage action is triggered', () => {
    const cb = makeCallbacks()
    const status: GitFileStatus = { path: 'src/test.ts', status: 'modified', staged: false }
    const items = getFileExplorerMenuItems(
      { entry: makeEntry(), parentDir: '/project/src', isGitRepo: true, gitStatus: status, rootPath: '/project' },
      cb,
    )
    items.find(i => i.id === 'git-stage')!.action()
    expect(cb.onStage).toHaveBeenCalledWith(['/project/src/test.ts'])
  })

  it('computes relative path for Copy Relative Path', () => {
    const cb = makeCallbacks()
    const items = getFileExplorerMenuItems(
      { entry: makeEntry(), parentDir: '/project/src', isGitRepo: false, gitStatus: undefined, rootPath: '/project' },
      cb,
    )
    items.find(i => i.id === 'copy-relative-path')!.action()
    expect(cb.onCopyRelativePath).toHaveBeenCalledWith('src/test.ts')
  })

  it('does not show git actions for clean files (no git status)', () => {
    const cb = makeCallbacks()
    const items = getFileExplorerMenuItems(
      { entry: makeEntry(), parentDir: '/project/src', isGitRepo: true, gitStatus: undefined, rootPath: '/project' },
      cb,
    )
    expect(items.find(i => i.id === 'git-stage')).toBeUndefined()
    expect(items.find(i => i.id === 'git-revert')).toBeUndefined()
    expect(items.find(i => i.id === 'git-diff')).toBeDefined()
    expect(items.find(i => i.id === 'git-blame')).toBeDefined()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/cwdavis/scripts/netstacks-terminal/frontend && npx vitest run src/components/workspace/__tests__/fileExplorerMenuItems.test.ts`
Expected: FAIL — module `../fileExplorerMenuItems` not found

- [ ] **Step 3: Implement the menu item builder**

Create `frontend/src/components/workspace/fileExplorerMenuItems.ts`:

```typescript
import type { MenuItem } from '../ContextMenu'
import type { WorkspaceFileEntry, GitFileStatus } from '../../types/workspace'

export interface FileExplorerMenuContext {
  entry: WorkspaceFileEntry
  parentDir: string
  isGitRepo: boolean
  gitStatus: GitFileStatus | undefined
  rootPath: string
}

export interface FileExplorerMenuCallbacks {
  onOpen: (filePath: string, fileName: string) => void
  onNewFile: (parentDir: string) => void
  onNewFolder: (parentDir: string) => void
  onRename: (entry: WorkspaceFileEntry) => void
  onDelete: (entry: WorkspaceFileEntry) => void
  onCopyPath: (path: string) => void
  onCopyRelativePath: (relativePath: string) => void
  onStage: (paths: string[]) => void
  onUnstage: (paths: string[]) => void
  onRevert: (paths: string[]) => void
  onViewDiff: (filePath: string) => void
  onViewBlame: (filePath: string) => void
}

const divider = (id: string): MenuItem => ({ id, label: '', divider: true, action: () => {} })

export function getFileExplorerMenuItems(
  ctx: FileExplorerMenuContext,
  cb: FileExplorerMenuCallbacks,
): MenuItem[] {
  const { entry, parentDir, isGitRepo, gitStatus, rootPath } = ctx
  const items: MenuItem[] = []
  const isFile = !entry.isDir
  const hasName = entry.name.length > 0

  // ── Group 1: Primary actions ──
  if (isFile) {
    items.push({
      id: 'open',
      label: 'Open',
      action: () => cb.onOpen(entry.path, entry.name),
    })
  }

  // ── Group 2: Git actions (only in git repos) ──
  if (isGitRepo) {
    if (isFile) {
      const hasChanges = gitStatus != null
      if (hasChanges) {
        items.push(divider('git-divider'))
        if (gitStatus.staged) {
          items.push({
            id: 'git-unstage',
            label: 'Unstage Changes',
            action: () => cb.onUnstage([entry.path]),
          })
        } else {
          items.push({
            id: 'git-stage',
            label: 'Stage Changes',
            action: () => cb.onStage([entry.path]),
          })
        }
        items.push({
          id: 'git-revert',
          label: 'Revert Changes',
          action: () => cb.onRevert([entry.path]),
        })
      } else {
        items.push(divider('git-divider'))
      }
      items.push({
        id: 'git-diff',
        label: 'View Diff',
        action: () => cb.onViewDiff(entry.path),
      })
      items.push({
        id: 'git-blame',
        label: 'Blame',
        action: () => cb.onViewBlame(entry.path),
      })
    } else {
      items.push(divider('git-divider'))
      items.push({
        id: 'git-stage-folder',
        label: 'Stage All in Folder',
        action: () => cb.onStage([entry.path]),
      })
    }
  }

  // ── Group 3: File CRUD ──
  items.push(divider('file-divider'))
  items.push({
    id: 'new-file',
    label: 'New File',
    action: () => cb.onNewFile(parentDir),
  })
  items.push({
    id: 'new-folder',
    label: 'New Folder',
    action: () => cb.onNewFolder(parentDir),
  })

  if (hasName) {
    items.push({
      id: 'rename',
      label: 'Rename',
      action: () => cb.onRename(entry),
    })
    items.push({
      id: 'delete',
      label: 'Delete',
      action: () => cb.onDelete(entry),
    })
  }

  // ── Group 4: Copy ──
  items.push(divider('copy-divider'))
  items.push({
    id: 'copy-path',
    label: 'Copy Path',
    action: () => cb.onCopyPath(entry.path),
  })
  if (hasName) {
    const sep = rootPath.includes('/') ? '/' : '\\'
    const relative = entry.path.startsWith(rootPath + sep)
      ? entry.path.slice(rootPath.length + 1)
      : entry.path
    items.push({
      id: 'copy-relative-path',
      label: 'Copy Relative Path',
      action: () => cb.onCopyRelativePath(relative),
    })
  }

  return items
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/cwdavis/scripts/netstacks-terminal/frontend && npx vitest run src/components/workspace/__tests__/fileExplorerMenuItems.test.ts`
Expected: PASS — all 11 tests pass

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/workspace/fileExplorerMenuItems.ts frontend/src/components/workspace/__tests__/fileExplorerMenuItems.test.ts
git commit -m "feat: add file explorer context menu item builder with tests"
```

---

### Task 2: Create WorkspaceDiffViewer component

**Files:**
- Create: `frontend/src/components/workspace/WorkspaceDiffViewer.tsx`
- Create: `frontend/src/components/workspace/WorkspaceDiffViewer.css`

A component that takes `filePath` and `gitOps`, fetches the unified diff on mount, parses it into colored lines, and renders it in Zone 2 as an inner tab.

- [ ] **Step 1: Create the CSS for the diff viewer**

Create `frontend/src/components/workspace/WorkspaceDiffViewer.css`:

```css
.workspace-diff-viewer {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  background: var(--color-bg-primary);
}

.workspace-diff-header {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-sm) var(--spacing-md);
  background: var(--color-bg-secondary);
  border-bottom: 1px solid var(--color-border);
  font-size: var(--font-size-small);
  color: var(--color-text-secondary);
  flex-shrink: 0;
}

.workspace-diff-header-path {
  font-family: var(--font-family-mono);
  color: var(--color-text-primary);
}

.workspace-diff-stats {
  display: flex;
  gap: var(--spacing-sm);
  margin-left: auto;
}

.workspace-diff-stat-add {
  color: var(--color-success);
}

.workspace-diff-stat-del {
  color: var(--color-error);
}

.workspace-diff-refresh-btn {
  background: none;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  color: var(--color-text-secondary);
  font-size: 12px;
  padding: 2px 8px;
  cursor: pointer;
}

.workspace-diff-refresh-btn:hover {
  background: var(--color-bg-hover);
  color: var(--color-text-primary);
}

.workspace-diff-content {
  flex: 1;
  overflow: auto;
  font-family: var(--font-family-mono);
  font-size: 13px;
  line-height: 20px;
}

.workspace-diff-hunk-header {
  padding: 4px 12px;
  background: var(--color-bg-secondary);
  color: var(--color-accent);
  border-top: 1px solid var(--color-border);
  border-bottom: 1px solid var(--color-border);
  font-size: 12px;
  user-select: none;
}

.workspace-diff-line {
  display: flex;
  padding: 0 12px;
  white-space: pre;
  min-height: 20px;
}

.workspace-diff-line.added {
  background: rgba(46, 160, 67, 0.15);
}

.workspace-diff-line.removed {
  background: rgba(248, 81, 73, 0.15);
}

.workspace-diff-line-number {
  width: 50px;
  text-align: right;
  padding-right: 12px;
  color: var(--color-text-secondary);
  user-select: none;
  flex-shrink: 0;
  opacity: 0.6;
}

.workspace-diff-line-marker {
  width: 16px;
  flex-shrink: 0;
  user-select: none;
}

.workspace-diff-line.added .workspace-diff-line-marker {
  color: var(--color-success);
}

.workspace-diff-line.removed .workspace-diff-line-marker {
  color: var(--color-error);
}

.workspace-diff-line-text {
  flex: 1;
  min-width: 0;
}

.workspace-diff-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--color-text-secondary);
  font-size: var(--font-size-small);
}

.workspace-diff-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--color-text-secondary);
}
```

- [ ] **Step 2: Create the WorkspaceDiffViewer component**

Create `frontend/src/components/workspace/WorkspaceDiffViewer.tsx`:

```tsx
import { useState, useEffect, useCallback } from 'react'
import type { GitOps } from '../../types/workspace'
import './WorkspaceDiffViewer.css'

interface WorkspaceDiffViewerProps {
  filePath: string
  gitOps: GitOps
}

interface DiffHunk {
  header: string
  lines: DiffLine[]
}

interface DiffLine {
  type: 'context' | 'added' | 'removed'
  content: string
  oldLineNum: number | null
  newLineNum: number | null
}

function parseDiff(raw: string): { hunks: DiffHunk[]; additions: number; deletions: number } {
  const lines = raw.split('\n')
  const hunks: DiffHunk[] = []
  let current: DiffHunk | null = null
  let oldLine = 0
  let newLine = 0
  let additions = 0
  let deletions = 0

  for (const line of lines) {
    if (line.startsWith('@@')) {
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/)
      if (match) {
        oldLine = parseInt(match[1], 10)
        newLine = parseInt(match[2], 10)
        current = { header: line, lines: [] }
        hunks.push(current)
      }
      continue
    }

    if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
      continue
    }

    if (!current) continue

    if (line.startsWith('+')) {
      current.lines.push({ type: 'added', content: line.slice(1), oldLineNum: null, newLineNum: newLine })
      newLine++
      additions++
    } else if (line.startsWith('-')) {
      current.lines.push({ type: 'removed', content: line.slice(1), oldLineNum: oldLine, newLineNum: null })
      oldLine++
      deletions++
    } else {
      const content = line.startsWith(' ') ? line.slice(1) : line
      current.lines.push({ type: 'context', content, oldLineNum: oldLine, newLineNum: newLine })
      oldLine++
      newLine++
    }
  }

  return { hunks, additions, deletions }
}

export default function WorkspaceDiffViewer({ filePath, gitOps }: WorkspaceDiffViewerProps) {
  const [rawDiff, setRawDiff] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchDiff = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const diff = await gitOps.diff(filePath)
      setRawDiff(diff)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load diff')
    } finally {
      setLoading(false)
    }
  }, [filePath, gitOps])

  useEffect(() => {
    fetchDiff()
  }, [fetchDiff])

  if (loading) {
    return <div className="workspace-diff-loading">Loading diff...</div>
  }

  if (error) {
    return <div className="workspace-diff-empty">{error}</div>
  }

  if (!rawDiff || rawDiff.trim().length === 0) {
    return <div className="workspace-diff-empty">No changes</div>
  }

  const { hunks, additions, deletions } = parseDiff(rawDiff)
  const fileName = filePath.split('/').pop() || filePath

  return (
    <div className="workspace-diff-viewer">
      <div className="workspace-diff-header">
        <span>Diff:</span>
        <span className="workspace-diff-header-path">{fileName}</span>
        <div className="workspace-diff-stats">
          <span className="workspace-diff-stat-add">+{additions}</span>
          <span className="workspace-diff-stat-del">-{deletions}</span>
        </div>
        <button className="workspace-diff-refresh-btn" onClick={fetchDiff} title="Refresh diff">
          Refresh
        </button>
      </div>
      <div className="workspace-diff-content">
        {hunks.map((hunk, hi) => (
          <div key={hi}>
            <div className="workspace-diff-hunk-header">{hunk.header}</div>
            {hunk.lines.map((line, li) => (
              <div key={`${hi}-${li}`} className={`workspace-diff-line ${line.type}`}>
                <span className="workspace-diff-line-number">
                  {line.oldLineNum ?? ''}
                </span>
                <span className="workspace-diff-line-number">
                  {line.newLineNum ?? ''}
                </span>
                <span className="workspace-diff-line-marker">
                  {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}
                </span>
                <span className="workspace-diff-line-text">{line.content}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/workspace/WorkspaceDiffViewer.tsx frontend/src/components/workspace/WorkspaceDiffViewer.css
git commit -m "feat: add WorkspaceDiffViewer component for git diffs in Zone 2"
```

---

### Task 3: Add 'blame' to InnerTabType and create WorkspaceBlameViewer

**Files:**
- Modify: `frontend/src/types/workspace.ts:10`
- Create: `frontend/src/components/workspace/WorkspaceBlameViewer.tsx`
- Create: `frontend/src/components/workspace/WorkspaceBlameViewer.css`

- [ ] **Step 1: Add 'blame' to InnerTabType**

In `frontend/src/types/workspace.ts`, line 10, change:

```typescript
export type InnerTabType = 'code-editor' | 'browser' | 'diff' | 'image' | 'markdown'
```

to:

```typescript
export type InnerTabType = 'code-editor' | 'browser' | 'diff' | 'blame' | 'image' | 'markdown'
```

- [ ] **Step 2: Create the blame viewer CSS**

Create `frontend/src/components/workspace/WorkspaceBlameViewer.css`:

```css
.workspace-blame-viewer {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  background: var(--color-bg-primary);
}

.workspace-blame-header {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-sm) var(--spacing-md);
  background: var(--color-bg-secondary);
  border-bottom: 1px solid var(--color-border);
  font-size: var(--font-size-small);
  color: var(--color-text-secondary);
  flex-shrink: 0;
}

.workspace-blame-header-path {
  font-family: var(--font-family-mono);
  color: var(--color-text-primary);
}

.workspace-blame-content {
  flex: 1;
  overflow: auto;
  font-family: var(--font-family-mono);
  font-size: 13px;
  line-height: 20px;
}

.workspace-blame-line {
  display: flex;
  padding: 0 12px;
  white-space: pre;
  min-height: 20px;
  border-bottom: 1px solid var(--color-border);
}

.workspace-blame-line:hover {
  background: var(--color-bg-hover);
}

.workspace-blame-line-number {
  width: 40px;
  text-align: right;
  padding-right: 8px;
  color: var(--color-text-secondary);
  user-select: none;
  flex-shrink: 0;
  opacity: 0.6;
}

.workspace-blame-line-meta {
  width: 280px;
  flex-shrink: 0;
  display: flex;
  gap: var(--spacing-sm);
  padding-right: 12px;
  color: var(--color-text-secondary);
  font-size: 12px;
  overflow: hidden;
  border-right: 1px solid var(--color-border);
}

.workspace-blame-line-hash {
  width: 56px;
  flex-shrink: 0;
  color: var(--color-accent);
}

.workspace-blame-line-author {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workspace-blame-line-date {
  width: 80px;
  flex-shrink: 0;
  text-align: right;
}

.workspace-blame-line-text {
  flex: 1;
  padding-left: 12px;
  min-width: 0;
}

.workspace-blame-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--color-text-secondary);
}

.workspace-blame-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--color-text-secondary);
  font-size: var(--font-size-small);
}
```

- [ ] **Step 3: Create the WorkspaceBlameViewer component**

Create `frontend/src/components/workspace/WorkspaceBlameViewer.tsx`:

```tsx
import { useState, useEffect, useCallback } from 'react'
import type { GitOps, BlameLine } from '../../types/workspace'
import './WorkspaceBlameViewer.css'

interface WorkspaceBlameViewerProps {
  filePath: string
  gitOps: GitOps
}

function formatRelativeDate(dateStr: string): string {
  try {
    const date = new Date(dateStr)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))
    if (diffDays === 0) return 'today'
    if (diffDays === 1) return '1d ago'
    if (diffDays < 30) return `${diffDays}d ago`
    if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo ago`
    return `${Math.floor(diffDays / 365)}y ago`
  } catch {
    return dateStr.slice(0, 10)
  }
}

export default function WorkspaceBlameViewer({ filePath, gitOps }: WorkspaceBlameViewerProps) {
  const [lines, setLines] = useState<BlameLine[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchBlame = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await gitOps.blame(filePath)
      setLines(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load blame')
    } finally {
      setLoading(false)
    }
  }, [filePath, gitOps])

  useEffect(() => {
    fetchBlame()
  }, [fetchBlame])

  if (loading) {
    return <div className="workspace-blame-loading">Loading blame...</div>
  }

  if (error) {
    return <div className="workspace-blame-empty">{error}</div>
  }

  if (lines.length === 0) {
    return <div className="workspace-blame-empty">No blame data</div>
  }

  const fileName = filePath.split('/').pop() || filePath

  return (
    <div className="workspace-blame-viewer">
      <div className="workspace-blame-header">
        <span>Blame:</span>
        <span className="workspace-blame-header-path">{fileName}</span>
        <span style={{ marginLeft: 'auto' }}>{lines.length} lines</span>
      </div>
      <div className="workspace-blame-content">
        {lines.map((line) => (
          <div key={line.lineNumber} className="workspace-blame-line">
            <span className="workspace-blame-line-number">{line.lineNumber}</span>
            <div className="workspace-blame-line-meta">
              <span className="workspace-blame-line-hash">{line.hash.slice(0, 7)}</span>
              <span className="workspace-blame-line-author">{line.author}</span>
              <span className="workspace-blame-line-date">{formatRelativeDate(line.date)}</span>
            </div>
            <span className="workspace-blame-line-text">{line.content}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/types/workspace.ts frontend/src/components/workspace/WorkspaceBlameViewer.tsx frontend/src/components/workspace/WorkspaceBlameViewer.css
git commit -m "feat: add blame tab type and WorkspaceBlameViewer component"
```

---

### Task 4: Wire diff and blame tab types in WorkspaceEditorArea

**Files:**
- Modify: `frontend/src/components/workspace/WorkspaceEditorArea.tsx`

The `'diff'` and `'blame'` cases in `InnerTabType` aren't handled. Add rendering support using `WorkspaceDiffViewer` and `WorkspaceBlameViewer`, passing `gitOps` as a new prop.

- [ ] **Step 1: Add `gitOps` prop and imports**

In `frontend/src/components/workspace/WorkspaceEditorArea.tsx`, add imports and update props:

```typescript
import WorkspaceDiffViewer from './WorkspaceDiffViewer'
import WorkspaceBlameViewer from './WorkspaceBlameViewer'
import type { InnerTab, FileOps, GitOps } from '../../types/workspace'

interface WorkspaceEditorAreaProps {
  innerTabs: InnerTab[]
  activeInnerTabId: string | null
  fileOps: FileOps
  gitOps: GitOps | null
  onSetActiveTab: (id: string) => void
  onCloseTab: (id: string) => void
  onMarkModified: (id: string, modified: boolean) => void
  onRunFile: (filePath: string) => void
}
```

Update the function signature to destructure `gitOps`:

```typescript
export default function WorkspaceEditorArea({
  innerTabs,
  activeInnerTabId,
  fileOps,
  gitOps,
  onSetActiveTab,
  onCloseTab,
  onMarkModified,
  onRunFile,
}: WorkspaceEditorAreaProps) {
```

- [ ] **Step 2: Add `'diff'` and `'blame'` cases to `renderTabContent`**

In the `renderTabContent` switch statement, add these cases after the `'browser'` case:

```typescript
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
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/workspace/WorkspaceEditorArea.tsx
git commit -m "feat: wire diff and blame tab types in WorkspaceEditorArea"
```

---

### Task 5: Replace inline context menu and add git actions

**Files:**
- Modify: `frontend/src/components/workspace/WorkspaceFileExplorer.tsx`
- Modify: `frontend/src/components/workspace/WorkspaceTab.tsx`

Replace the inline `<div className="workspace-context-menu">` with the shared `ContextMenu` component. Add `gitOps`, `onViewDiff`, and `onViewBlame` props to `WorkspaceFileExplorer`. Thread these from `WorkspaceTab`.

- [ ] **Step 1: Update WorkspaceFileExplorer props and imports**

In `frontend/src/components/workspace/WorkspaceFileExplorer.tsx`:

Add imports at the top (after existing imports):

```typescript
import ContextMenu from '../ContextMenu'
import { getFileExplorerMenuItems } from './fileExplorerMenuItems'
import type { GitOps } from '../../types/workspace'
```

Add two new props to the `WorkspaceFileExplorerProps` interface:

```typescript
interface WorkspaceFileExplorerProps {
  rootPath: string
  mode: WorkspaceMode
  fileOps: FileOps
  expandedDirs: Set<string>
  selectedPath: string | null
  gitBranch: GitBranchInfo | null
  gitStatuses: GitFileStatus[]
  isGitRepo: boolean
  gitOps: GitOps | null
  onToggleDir: (path: string) => void
  onSelectPath: (path: string | null) => void
  onOpenFile: (filePath: string, fileName: string) => void
  onRefreshGit: () => void
  onViewDiff: (filePath: string) => void
  onViewBlame: (filePath: string) => void
  getFileStatus: (path: string) => GitFileStatus | undefined
}
```

Update the destructuring of the component function to include `gitOps` and `onViewDiff`.

- [ ] **Step 2: Change ContextMenuState to store position + items**

Replace the `ContextMenuState` interface:

```typescript
interface ContextMenuState {
  x: number
  y: number
  entry: WorkspaceFileEntry
  parentDir: string
}
```

Change the state type to use `{ x: number; y: number } | null` for position tracking. The menu items will be computed from the entry at the time the menu opens.

Actually, keep the existing `ContextMenuState` as-is (it stores the entry info). Add a computed items approach. Replace the `contextMenu` state with a `menuState` that stores both position and items:

Replace the `ContextMenuState` type and `contextMenu` state with:

```typescript
interface ContextMenuState {
  position: { x: number; y: number }
  items: import('../ContextMenu').MenuItem[]
}
```

And update `useState`:

```typescript
const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
```

- [ ] **Step 3: Update handleContextMenu to build items**

Replace the `handleContextMenu` callback:

```typescript
  const handleCopyRelativePath = useCallback((relativePath: string) => {
    navigator.clipboard.writeText(relativePath)
    showToast('Relative path copied', 'info', 1500)
  }, [])

  const handleStage = useCallback(async (paths: string[]) => {
    if (!gitOps) return
    try {
      await gitOps.stage(paths)
      onRefreshGit()
      showToast('Staged', 'success', 1500)
    } catch (err) {
      showToast(`Stage failed: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error')
    }
  }, [gitOps, onRefreshGit])

  const handleUnstage = useCallback(async (paths: string[]) => {
    if (!gitOps) return
    try {
      await gitOps.unstage(paths)
      onRefreshGit()
      showToast('Unstaged', 'success', 1500)
    } catch (err) {
      showToast(`Unstage failed: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error')
    }
  }, [gitOps, onRefreshGit])

  const handleRevert = useCallback(async (paths: string[]) => {
    if (!gitOps) return
    try {
      await gitOps.revert(paths)
      onRefreshGit()
      refreshDir(getParentDir(paths[0]))
      showToast('Reverted', 'success', 1500)
    } catch (err) {
      showToast(`Revert failed: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error')
    }
  }, [gitOps, onRefreshGit, refreshDir, getParentDir])

  const handleContextMenu = useCallback((e: React.MouseEvent, entry: WorkspaceFileEntry) => {
    e.preventDefault()
    e.stopPropagation()
    const parentDir = entry.isDir ? entry.path : getParentDir(entry.path)
    const items = getFileExplorerMenuItems(
      {
        entry,
        parentDir,
        isGitRepo,
        gitStatus: getFileStatus(entry.path),
        rootPath,
      },
      {
        onOpen: onOpenFile,
        onNewFile: handleNewFile,
        onNewFolder: handleNewFolder,
        onRename: handleRename,
        onDelete: handleDelete,
        onCopyPath: handleCopyPath,
        onCopyRelativePath: handleCopyRelativePath,
        onStage: handleStage,
        onUnstage: handleUnstage,
        onRevert: handleRevert,
        onViewDiff: onViewDiff,
        onViewBlame: onViewBlame,
      },
    )
    setContextMenu({ position: { x: e.clientX, y: e.clientY }, items })
  }, [getParentDir, isGitRepo, getFileStatus, rootPath, onOpenFile, handleNewFile, handleNewFolder, handleRename, handleDelete, handleCopyPath, handleCopyRelativePath, handleStage, handleUnstage, handleRevert, onViewDiff, onViewBlame])
```

Update `handleTreeContextMenu` similarly:

```typescript
  const handleTreeContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const entry: WorkspaceFileEntry = { name: '', path: rootPath, isDir: true, size: 0, modified: null }
    const items = getFileExplorerMenuItems(
      { entry, parentDir: rootPath, isGitRepo, gitStatus: undefined, rootPath },
      {
        onOpen: onOpenFile,
        onNewFile: handleNewFile,
        onNewFolder: handleNewFolder,
        onRename: handleRename,
        onDelete: handleDelete,
        onCopyPath: handleCopyPath,
        onCopyRelativePath: handleCopyRelativePath,
        onStage: handleStage,
        onUnstage: handleUnstage,
        onRevert: handleRevert,
        onViewDiff: onViewDiff,
        onViewBlame: onViewBlame,
      },
    )
    setContextMenu({ position: { x: e.clientX, y: e.clientY }, items })
  }, [rootPath, isGitRepo, onOpenFile, handleNewFile, handleNewFolder, handleRename, handleDelete, handleCopyPath, handleCopyRelativePath, handleStage, handleUnstage, handleRevert, onViewDiff, onViewBlame])
```

- [ ] **Step 4: Replace the inline context menu JSX with shared ContextMenu**

Remove the old context menu JSX block (the `{contextMenu && (<div className="workspace-context-menu" ...>` block, approximately lines 434–467 of `WorkspaceFileExplorer.tsx`) and replace with:

```tsx
      <ContextMenu
        position={contextMenu?.position ?? null}
        items={contextMenu?.items ?? []}
        onClose={() => setContextMenu(null)}
      />
```

- [ ] **Step 5: Remove the old `useEffect` for closing the context menu on click outside**

Delete the `useEffect` block that starts with `if (!contextMenu) return` and adds a `window.addEventListener('click', handler)` — the shared `ContextMenu` component handles click-outside dismissal internally.

```typescript
  // DELETE THIS ENTIRE BLOCK:
  // useEffect(() => {
  //   if (!contextMenu) return
  //   const handler = () => setContextMenu(null)
  //   window.addEventListener('click', handler)
  //   return () => window.removeEventListener('click', handler)
  // }, [contextMenu])
```

- [ ] **Step 6: Update WorkspaceTab to pass gitOps and onViewDiff**

In `frontend/src/components/workspace/WorkspaceTab.tsx`:

Add `handleViewDiff` and `handleViewBlame` callbacks:

```typescript
  const handleViewDiff = useCallback((filePath: string) => {
    const fileName = filePath.split('/').pop() || 'diff'
    workspace.openInnerTab('diff', { filePath, title: `${fileName} (diff)` })
  }, [workspace])

  const handleViewBlame = useCallback((filePath: string) => {
    const fileName = filePath.split('/').pop() || 'blame'
    workspace.openInnerTab('blame', { filePath, title: `${fileName} (blame)` })
  }, [workspace])
```

Update the `<WorkspaceFileExplorer>` JSX to pass the new props:

```tsx
        <WorkspaceFileExplorer
          rootPath={state.rootPath}
          mode={state.mode}
          fileOps={fileOps}
          expandedDirs={state.expandedDirs}
          selectedPath={state.selectedPath}
          gitBranch={git.branch}
          gitStatuses={git.statuses}
          isGitRepo={git.isGitRepo}
          gitOps={gitOps}
          onToggleDir={workspace.toggleDir}
          onSelectPath={workspace.setSelectedPath}
          onOpenFile={handleFileOpen}
          onRefreshGit={git.refresh}
          onViewDiff={handleViewDiff}
          onViewBlame={handleViewBlame}
          getFileStatus={git.getFileStatus}
        />
```

Also pass `gitOps` to `WorkspaceEditorArea`:

```tsx
          <WorkspaceEditorArea
            innerTabs={state.innerTabs}
            activeInnerTabId={state.activeInnerTabId}
            fileOps={fileOps}
            gitOps={gitOps}
            onSetActiveTab={workspace.setActiveInnerTab}
            onCloseTab={workspace.closeInnerTab}
            onMarkModified={workspace.markInnerTabModified}
            onRunFile={handleRunFile}
          />
```

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/workspace/WorkspaceFileExplorer.tsx frontend/src/components/workspace/WorkspaceTab.tsx
git commit -m "feat: replace inline context menu with shared ContextMenu, add git actions"
```

---

### Task 6: Remove dead CSS and verify

**Files:**
- Modify: `frontend/src/components/workspace/WorkspaceTab.css`

- [ ] **Step 1: Remove old inline context menu CSS**

In `frontend/src/components/workspace/WorkspaceTab.css`, delete these class rules (lines 645–680):

```css
/* DELETE ALL OF THESE: */
.workspace-context-menu { ... }
.workspace-context-menu-item { ... }
.workspace-context-menu-item:hover { ... }
.workspace-context-menu-item.danger { ... }
.workspace-context-menu-separator { ... }
```

- [ ] **Step 2: Run type check**

Run: `cd /Users/cwdavis/scripts/netstacks-terminal/frontend && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Run all workspace tests**

Run: `cd /Users/cwdavis/scripts/netstacks-terminal/frontend && npx vitest run src/components/workspace/`
Expected: all tests pass (including fileExplorerMenuItems tests)

- [ ] **Step 4: Run full frontend test suite**

Run: `cd /Users/cwdavis/scripts/netstacks-terminal/frontend && npx vitest run`
Expected: all tests pass

- [ ] **Step 5: Build the app**

Run: `cd /Users/cwdavis/scripts/netstacks-terminal && ./terminal-dev.sh -s`
Expected: starts successfully, no build errors

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/workspace/WorkspaceTab.css
git commit -m "chore: remove dead inline context menu CSS"
```

---

### Task 7: Manual smoke test in the browser

**Files:** None (verification only)

- [ ] **Step 1: Open a workspace that is a git repo**

Start the dev server with `./terminal-dev.sh -s` if not already running. Open the app in the browser. Open a workspace pointing to a git repo with some modified files.

- [ ] **Step 2: Right-click a modified file in the file explorer**

Verify:
- Shared `ContextMenu` component renders (rounded corners, proper animation, `var(--color-bg-secondary)` background)
- Menu items appear in correct order: Open → git divider → Stage Changes → Revert Changes → View Diff → Blame → file divider → New File → New Folder → Rename → Delete → copy divider → Copy Path → Copy Relative Path
- Menu opens at mouse cursor position, clamped to viewport

- [ ] **Step 3: Test Stage action**

Click "Stage Changes" on a modified file. Verify:
- Toast shows "Staged"
- Git status badge updates (file moves from unstaged to staged)
- Right-clicking the same file now shows "Unstage Changes" instead of "Stage Changes"

- [ ] **Step 4: Test View Diff action**

Click "View Diff" on a modified file. Verify:
- A new tab opens in Zone 2 with title `filename.ext (diff)`
- The diff viewer shows hunks with colored +/- lines
- "Refresh" button re-fetches the diff
- "No changes" shows for clean files

- [ ] **Step 5: Test Blame action**

Click "Blame" on a committed file. Verify:
- A new tab opens in Zone 2 with title `filename.ext (blame)`
- The blame viewer shows line numbers, short hash, author, relative date, and line content
- Each line is displayed with metadata in a fixed-width column and code content flowing right

- [ ] **Step 6: Test Revert action**

Modify a file, then right-click → "Revert Changes". Verify:
- File reverts to last committed state
- Toast shows "Reverted"
- Git status badge clears

- [ ] **Step 7: Test directory context menu**

Right-click a folder. Verify:
- No "Open" item
- "Stage All in Folder" appears (if repo)
- New File, New Folder, Copy Path all work

- [ ] **Step 8: Test non-git workspace**

Open a workspace that is NOT a git repo. Verify:
- No git actions appear in context menu
- File CRUD actions all work normally
