# NetStacks Git Integration & Workspace-as-Repo Design

**Date:** 2026-05-15
**Branch:** feature/workspace-tab
**Status:** Approved — ready for implementation planning

---

## Overview

A workspace IS a git repo. Git integration is seamless, complexity is hidden, and everything the user can do the AI can do too. Engineers who don't live in git should be able to do all their git work from NetStacks without switching to the command line or another tool.

### Standing Development Rules (apply to everything here)

1. **UI for every API** — no agent endpoint without a corresponding UI
2. **UX first** — right-click context menus, resizable/moveable panels, menu bar items
3. **Settings-based** — every user-facing behavior is customizable
4. **Full CRUD** — no orphan features
5. **AI parity** — everything a user can do, the AI can do

---

## Section 1: Architecture

### Agent (Rust) — new modules

**`git` module** — wraps git CLI for all local operations:
`status`, `commit`, `push`, `pull`, `fetch`, `log`, `diff`, `branch` (list/create/delete/switch), `merge`, `stash`, `rebase`, `cherry-pick`, `blame`

**`providers` module** — one adapter per git host, all implementing a shared `GitProvider` trait:
- `GitHubAdapter` — github.com
- `GitHubEnterpriseAdapter` — custom host URL
- `GitLabAdapter` — gitlab.com + self-hosted
- `GiteaAdapter` — self-hosted
- Each handles: OAuth flow, PAT auth, repo listing, PR creation, user info

**`credentials` module** — encrypted storage in the existing settings DB:
- Accounts table: `id`, `name`, `provider`, `host`, `auth_method`, `encrypted_credential`
- SSH keys stored as encrypted blobs
- OAuth tokens auto-refreshed

**New agent endpoints** (all require workspace auth, same as existing endpoints):

| Endpoint | Description |
|---|---|
| `POST /workspace/git/status` | Branch info + staged/unstaged files |
| `POST /workspace/git/diff` | Diff for a file or full working tree |
| `POST /workspace/git/commit` | Stage files + commit |
| `POST /workspace/git/push` | Push current branch |
| `POST /workspace/git/pull` | Pull / sync |
| `POST /workspace/git/fetch` | Fetch remotes |
| `POST /workspace/git/log` | Commit history |
| `POST /workspace/git/branch` | List/create/switch/delete branches |
| `POST /workspace/git/merge` | Merge branch into current |
| `POST /workspace/git/stash` | Stash / pop / list |
| `POST /workspace/git/blame` | Line-by-line authorship |
| `POST /workspace/git/resolve-conflict` | Apply conflict resolution for a file |
| `POST /workspace/git/generate-commit-message` | AI-generated commit message from staged diff |
| `POST /workspace/git/create-pr` | Create PR via provider API |
| `GET  /workspace/git/accounts` | List configured git accounts |
| `POST /workspace/git/accounts` | Create git account |
| `PUT  /workspace/git/accounts/:id` | Update git account |
| `DELETE /workspace/git/accounts/:id` | Delete git account |
| `POST /workspace/git/accounts/:id/test` | Test connection |
| `POST /workspace/git/oauth/start` | Begin OAuth flow |
| `GET  /workspace/git/oauth/callback` | OAuth callback handler |
| `POST /workspace/open-file` | Signal workspace to open a file in editor zone |

The AI side panel and AI coding tools in workspace terminals use these same endpoints — no separate AI-only API.

---

## Section 2: Workspace Opening Flow

A workspace is opened from the Workspaces sidebar. The opening dialog is context-aware:

```
1. User picks a directory (browse or type path, or paste a clone URL)

2. NetStacks checks the directory state:
   ├── Is a git repo with remote?  → open directly
   ├── Is a git repo, no remote?   → open, offer "Connect to remote" inline
   ├── Empty directory?            → "Initialize as git repo?" yes/no + pick account
   └── Has files, no git?          → "This folder isn't a git repo.
                                     Initialize it? Or clone a repo here instead?"

3. If initializing:
   - Pick git account (from configured accounts, or "Add account" inline)
   - Optional: create remote repo on provider in the same dialog
   - git init + optional initial commit

4. Workspace opens with git fully wired
```

**Clone flow:** "Clone Repo" button in Workspaces sidebar — paste URL or browse repos from connected accounts, pick local path, opens workspace on completion.

**Non-git directories:** Allowed. Git panel shows "Not a git repository" with an [Initialize] button. All other workspace features work normally.

**AI tool auto-launch:** Preserved from existing implementation. Configured per workspace (Claude Code, Aider, OpenCode, KimiCode, custom command, or none). Launches in a Zone 3 terminal tab on workspace open if enabled.

---

## Section 3: Context Menu System

### Core Rule

All workspace context menus use the shared `ContextMenu` component (`components/ContextMenu.tsx`). The current inline HTML menu in `WorkspaceFileExplorer` is replaced. No new inline menus created anywhere.

### Standard Group Order

Every workspace context menu follows this group order:

```
Group 1: Primary actions      Open, Open to Side
──────────────────────────────────────────────────
Group 2: Git actions          Stage, Unstage, Diff, Blame, Revert
                              (only shown when workspace is a git repo)
──────────────────────────────────────────────────
Group 3: File CRUD            New File, New Folder, Rename, Delete, Copy Path
──────────────────────────────────────────────────
Group 4: AI actions           Ask AI About This, Generate Tests, Explain
                              (always present, always last)
```

### No-Duplication Rule

Each context menu owns its target domain:
- **File explorer** owns file-level git actions (stage file, view diff, blame)
- **Git panel** owns commit-level and branch-level actions
- The two never duplicate each other

### Context Menus by Target

**File explorer — file right-click:**
- Open / Open to Side
- — git divider —
- Stage Changes / Unstage Changes (context-sensitive)
- Revert Changes
- View Diff (opens in editor Zone 2)
- View History (filters history tab to this file)
- Blame (opens blame view in editor)
- — file divider —
- New File / New Folder
- Rename / Delete
- Copy Path / Copy Relative Path
- — AI divider —
- Ask AI About This File
- Generate Tests for This File

**File explorer — directory right-click:**
- New File / New Folder
- — git divider —
- Stage All in Folder
- — AI divider —
- Ask AI About This Folder
- Copy Path

**Git panel — changed file right-click:**
- Open / View Diff
- Stage / Unstage
- Revert Changes
- — AI divider —
- Ask AI to Fix This

**Git panel — commit right-click:**
- Copy Hash
- Checkout This Commit
- Cherry-pick
- Revert Commit
- New Branch from Here
- Create Tag

**Git panel — branch right-click:**
- Checkout
- Rename Branch
- Delete Branch
- — divider —
- Merge into Current Branch
- Compare with Current Branch
- Create Pull Request

### Menu Bar — Git Menu

Active when a workspace tab is focused:

```
Git
  Commit...                    ⌘K
  Push                         ⌘⇧P
  Pull                         ⌘⇧L
  Sync (Fetch + Pull)
  ─────────────────────────────────
  New Branch...
  Switch Branch              ▶  (submenu: branch list)
  Merge Branch...
  Create Pull Request...
  ─────────────────────────────────
  Stage All
  Unstage All
  Discard All Changes
  ─────────────────────────────────
  View History
  Show Git Panel
```

### Positioning

All context menus open at the mouse cursor position, clamped to the viewport. Uses the existing viewport-clamp logic already in `ContextMenu.tsx`.

---

## Section 4: Git Account Settings

A "Git Accounts" section in the existing Settings panel.

### Account List View

```
Git Accounts                                    [+ Add Account]

  ● GitHub (personal)       github.com          ✓ Connected
  ● Work GitLab             gitlab.company.com  ✓ Connected
  ● Home Gitea              git.home.lab        ✗ Error
  ● GitHub Enterprise       ghe.corp.net        ✓ Connected
```

### Add / Edit Account Form

| Field | Description |
|---|---|
| Name | Free text label ("Work GitHub", "Personal") |
| Provider | GitHub / GitHub Enterprise / GitLab / GitLab Self-Hosted / Gitea / Bitbucket |
| Host URL | Self-hosted providers only (e.g. `https://ghe.corp.net`) |
| Auth Method | PAT / OAuth / SSH Key — options vary by provider |
| Credential | PAT: masked input. OAuth: [Authorize in Browser]. SSH: file picker + optional passphrase |
| Test Connection | Verifies credentials inline, shows result |

### Per-Workspace Override

Accessible via workspace `...` overflow menu or right-click on workspace in sidebar:

```
Git Account
  [Use account: Work GitLab    ▾]    [Override]
  Currently using: Work GitLab (workspace override)
```

Falls back to a global default account if no override set. Global default is configurable in Git Account settings.

### Credential Storage

All credentials stored encrypted in the agent's existing settings DB (same vault as SSH credentials). Never stored in plaintext. Never stored in `.netstacks/`.

---

## Section 5: Git Panel — Zone 1 Sidebar

Zone 1 header shows two tabs: `Files` | `Git`. Active tab is persisted per workspace in `.netstacks/workspace.json`.

### Changes Tab (default)

```
┌─ STAGED (3) ───────────────────── [Unstage All] ┐
│  M  src/api.rs                                  │
│  A  src/git/mod.rs                              │
│  D  src/old.rs                                  │
├─ UNSTAGED (2) ──────────────────── [Stage All] ─┤
│  M  frontend/App.tsx                            │
│  U  frontend/new-file.ts                        │
├─────────────────────────────────────────────────┤
│  Commit message...              [✨ Generate]    │
│                                                  │
├─────────────────────────────────────────────────┤
│  [Commit]                   [Commit & Push]      │
└──────────────────────────────────────────────────┘
```

- **Simple mode** (default): file list with checkboxes, no staged/unstaged split shown — include/exclude from commit
- **Advanced mode** (toggle, persisted in settings): staged/unstaged split as shown above
- **Generate:** calls `POST /workspace/git/generate-commit-message` with staged diff, populates textarea. User edits before committing.
- **Error banner:** any git operation failure shows inline with [Ask AI] button — error passed to AI automatically

### History Tab

- `[List]` / `[Graph]` toggle in tab bar, default from settings
- **List view:** 7-char hash, message (truncated), author, relative date, branch/tag badges
- **Graph view:** SVG-rendered DAG showing branch topology
- Click any commit → show diff in Zone 2 editor area
- Right-click → commit context menu (see Section 3)
- Optional file filter: "Filter to this file" from file explorer context menu

### Branches Tab

- Current branch highlighted
- Local branches
- Remote branches (collapsible section)
- `[+ New Branch]` button in header
- Right-click → branch context menu (see Section 3)
- "Saved for Later" collapsible section showing stash list

### Git Panel Settings (stored in workspace settings, customizable)

| Setting | Default | Options |
|---|---|---|
| Default history view | List | List / Graph |
| Auto-fetch interval | Off | Off / 1 min / 5 min / 15 min |
| Default commit action | Commit only | Commit only / Commit & Push |
| Show remote branches | On | On / Off |
| AI commit message generation | On | On / Off |
| Commit message template | (empty) | Free text |
| Advanced staging mode | Off | On / Off |

---

## Section 6: Conflict Resolution UX

No git jargon shown to the user. Plain English throughout.

### Push Rejected (remote has new commits)

```
┌─ Changes on the server ──────────────────────────┐
│                                                   │
│  Someone else pushed changes to "main" since      │
│  your last sync. You need to bring those in       │
│  before you can send yours.                       │
│                                                   │
│  [Sync & Push]   [View What Changed]   [Cancel]   │
│                                                   │
│  ▸ Advanced                                       │
│    Merge ●   Rebase ○                             │
└───────────────────────────────────────────────────┘
```

"Sync & Push" = fetch + merge (or rebase) + push. Advanced section collapsed by default.

### Merge Conflicts

```
┌─ Conflicts to Resolve ───────────────────────────┐
│                                                   │
│  3 files have conflicting changes:                │
│                                                   │
│  ⚠ src/api.rs       [Keep Mine] [Keep Theirs] [Compare]  │
│  ⚠ frontend/App.tsx [Keep Mine] [Keep Theirs] [Compare]  │
│  ⚠ agent/main.rs    [Keep Mine] [Keep Theirs] [Compare]  │
│                                                   │
│  [Ask AI to Help Resolve]                         │
│                                                   │
│  [Cancel Merge]            [Finish When Done]     │
└───────────────────────────────────────────────────┘
```

- **Keep Mine** — accepts local version immediately
- **Keep Theirs** — accepts incoming version immediately
- **Compare** — opens side-by-side diff in Zone 2 with per-block accept/reject controls
- **Ask AI to Help Resolve** — sends all conflicting files + both sides to AI, AI proposes and can apply resolutions via `POST /workspace/git/resolve-conflict`

### Side-by-Side Compare View (Zone 2)

```
◀ MINE                      THEIRS ▶
────────────────────────────────────
  return api.get(url)  │  return api.post(url)
[Accept Mine]                [Accept Theirs]
────────────────────────────── merged preview ──
```

When all conflict blocks resolved → [Mark as Resolved] re-stages the file.

### Branch Switch with Uncommitted Changes

```
┌─ Unsaved Changes ────────────────────────────────┐
│  You have changes that would be lost if you       │
│  switch branches.                                 │
│                                                   │
│  [Save for Later]  [Discard Changes]  [Cancel]    │
│                                                   │
│  "Save for Later" sets your changes aside and     │
│  restores them when you come back to this branch. │
└───────────────────────────────────────────────────┘
```

"Save for Later" = `git stash`. Stash list visible in Branches tab.

---

## Section 7: AI Integration

### AI Side Panel — Git Tool Definitions

```
git_status          → branch, staged/unstaged files, ahead/behind count
git_diff            → diff for a file or full working tree
git_commit          → stage files + commit with message
git_push            → push current branch
git_pull            → pull / sync
git_fetch           → fetch remotes
git_branch          → list, create, switch, delete branches
git_log             → commit history (count + optional file filter)
git_blame           → line-by-line authorship for a file
git_merge           → merge branch into current
git_stash           → stash / pop / list
git_create_pr       → open PR via provider API
git_resolve         → apply conflict resolution for a file
```

Git errors are automatically included in AI context — no copy-paste needed.

### AI Coding Tools in Workspace Terminals

Claude Code, Aider, and other CLI tools run in Zone 3 terminal tabs. They:
- Write files directly via filesystem — file explorer reflects changes immediately
- Run `git` CLI commands in their terminal session (workspace root is CWD)
- Open files in Zone 2 editor by writing to `.netstacks/open-request.json`:

```json
{ "path": "src/api.rs", "line": 42, "source": "claude-code" }
```

The workspace polls this file via filesystem watch. On detection it opens the editor tab, then deletes `open-request.json` immediately to clear the signal. The AI side panel uses `POST /workspace/open-file` which triggers the same mechanism. Both AI surfaces use the same path.

### AI Commit Message Generation

"Generate" button calls `POST /workspace/git/generate-commit-message`. The agent:
1. Assembles the staged diff
2. Sends to the configured AI provider (inherits workspace AI tool settings)
3. Returns a commit message string
4. Frontend populates the commit textarea — user edits before committing

### AI Git Settings

| Setting | Default |
|---|---|
| AI model for git features | Inherits workspace AI tool setting |
| Auto-include git context in AI side panel | On |
| AI commit message generation | On |

---

## Section 8: Workspace State & `.netstacks/` Files

### Workspace Identity

A workspace is identified by its `origin` remote URL (or a hash of the local absolute path for repos with no remote). This allows the same repo opened on different machines to be recognized as the same workspace. If a repo has multiple remotes, `origin` is always used as the identity key.

### `.netstacks/` Directory Structure

```
.netstacks/
  workspace.json      ← layout + preferences (travels with repo)
  settings.json       ← workspace-level settings overrides
  open-request.json   ← AI artifact open signal (transient, auto-cleared)
```

Added to `.gitignore` automatically on workspace init. Teams can opt in to shared config by removing it from `.gitignore`.

### What Lives Where

**`.netstacks/workspace.json`** (non-sensitive, can travel with repo):
- Open inner tabs (files, URLs, types)
- Terminal tab layout and active tab
- Panel sizes (explorer width, terminal height, collapsed state)
- Expanded directories in file tree
- AI tool selection and auto-launch setting
- Python run mode preference
- History view preference (list / graph)
- Git panel default tab (changes / history / branches)
- Zone 1 active tab (Files / Git)

**App settings DB** (machine-local, sensitive):
- Git account credentials
- Per-workspace git account override
- SSH keys and OAuth tokens
- Machine-specific paths

### Migration

Existing workspaces in the settings DB migrate automatically on first open: the app writes `.netstacks/workspace.json` from the saved config. No user action required.

### Non-Git Directories

`.netstacks/workspace.json` is still created and used. Git features are disabled until the user initializes a repo — the git panel shows an [Initialize] button. No data is lost on initialization.

---

## Migration: LocalGitOps

The existing `LocalGitOps` class (`frontend/src/lib/gitOps.ts`) runs git CLI commands directly via Tauri's `Command.create('git', ...)` shell plugin. Under this design, all git operations move to the agent — `LocalGitOps` is replaced by an agent-backed implementation that calls `POST /workspace/git/*` endpoints, matching how `RemoteGitOps` already works. The `GitOps` interface stays the same; only the implementation changes. This removes the Tauri shell dependency for git and centralizes credential/SSH handling in the agent.

---

## Component Reuse Plan

| New Component | Reuses |
|---|---|
| `WorkspaceGitPanel` | `ContextMenu`, `Toast`, existing dialog overlay pattern |
| `WorkspaceConflictDialog` | Existing dialog overlay (`workspace-new-dialog` pattern) |
| `WorkspaceGitAccountSettings` | Existing settings panel layout pattern |
| All workspace context menus | Shared `ContextMenu` component (replacing inline menus) |
| Commit message textarea | Monaco-lite or plain textarea — no new editor instance |
| Branch/history list | New, but styled with existing workspace CSS variables |

`WorkspaceFileExplorer` inline context menu is replaced with `ContextMenu` component as part of this work.

---

## Out of Scope (this design)

- PR review / inline code comments (create-only per decision)
- Rebase interactive (`git rebase -i`)
- Git LFS
- Submodules
- Tag management UI (tags visible in history, creation via commit context menu only)
