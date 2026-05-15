# Phase 1: Agent Git Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all git operations into the Rust agent, expose them as REST endpoints, and migrate the frontend's `LocalGitOps` to call the agent — giving every subsequent phase (git panel, conflict resolution, AI tools) a single, tested, credential-aware git backend.

**Architecture:** New `agent/src/git/` module wraps the git CLI via `tokio::process::Command`. New `agent/src/git_api.rs` exposes REST handlers. Frontend `LocalGitOps` is replaced by `AgentGitOps` which calls those endpoints. `RemoteGitOps` gains new method stubs (implemented properly in Phase 5). Push/pull use system git credentials for now — credential vault is Phase 4.

**Tech Stack:** Rust (tokio, axum, serde), TypeScript (Vitest), git CLI, `tempfile` crate (already in dev-deps)

---

## Phase Map (for context — this plan is Phase 1 only)

- **Phase 1: Agent Git Foundation** ← you are here
- Phase 2: Context Menu Refactor + File Explorer Git Actions
- Phase 3: Git Panel (Changes / History / Branches tabs)
- Phase 4: Git Account Settings + Credential Storage
- Phase 5: Workspace Opening Flow Refactor
- Phase 6: Conflict Resolution UX
- Phase 7: Commit History Editor (interactive rebase)
- Phase 8: AI Integration + `.netstacks/` State Migration

---

## File Structure

**New files:**
- `agent/src/git/mod.rs` — module re-exports
- `agent/src/git/types.rs` — shared Rust types (GitFileStatus, CommitInfo, BranchEntry, etc.)
- `agent/src/git/ops.rs` — `GitOps` struct + all git CLI operations
- `agent/src/git_api.rs` — API request/response types + axum handlers
- `frontend/src/lib/__tests__/gitOps.test.ts` — frontend unit tests

**Modified files:**
- `agent/src/main.rs` — add `mod git;` + `mod git_api;`, register new routes
- `frontend/src/types/workspace.ts` — extend `GitOps` interface + add new types
- `frontend/src/lib/gitOps.ts` — replace `LocalGitOps` with `AgentGitOps`, stub new methods on `RemoteGitOps`
- `frontend/src/hooks/useWorkspace.ts` — swap `LocalGitOps` → `AgentGitOps`

---

## Task 1: Extend TypeScript GitOps Interface + Workspace Types

**Files:**
- Modify: `frontend/src/types/workspace.ts`

- [ ] **Step 1: Add new types to workspace.ts**

Replace the existing content after the `GitOps` interface with:

```typescript
// Add after GitBranchInfo interface:

export interface CommitInfo {
  hash: string
  shortHash: string
  message: string
  author: string
  date: string
  branches: string[]
}

export interface BranchEntry {
  name: string
  isCurrent: boolean
  isRemote: boolean
  upstream?: string
}

export interface StashEntry {
  index: number
  message: string
  branch: string
}

export interface BlameLine {
  lineNumber: number
  hash: string
  author: string
  date: string
  content: string
}
```

- [ ] **Step 2: Replace the GitOps interface**

Replace the existing `GitOps` interface in `workspace.ts`:

```typescript
export interface GitOps {
  // Read ops
  isRepo(): Promise<boolean>
  status(): Promise<GitFileStatus[]>
  branch(): Promise<GitBranchInfo | null>
  diff(filePath?: string): Promise<string>
  log(limit?: number, filePath?: string): Promise<CommitInfo[]>
  blame(filePath: string): Promise<BlameLine[]>
  listBranches(): Promise<BranchEntry[]>
  listStashes(): Promise<StashEntry[]>

  // Stage / unstage / revert
  stage(paths: string[]): Promise<void>
  unstage(paths: string[]): Promise<void>
  revert(paths: string[]): Promise<void>

  // Commit
  commit(message: string, paths?: string[]): Promise<CommitInfo>

  // Remote ops (use system git credentials in Phase 1; vault added in Phase 4)
  push(force?: boolean): Promise<void>
  pull(rebase?: boolean): Promise<void>
  fetch(): Promise<void>

  // Branch management
  createBranch(name: string, from?: string): Promise<void>
  switchBranch(name: string): Promise<void>
  deleteBranch(name: string, force?: boolean): Promise<void>
  merge(branch: string): Promise<void>

  // Stash
  stash(action: 'push' | 'pop' | 'drop', index?: number): Promise<void>

  // Init
  init(): Promise<void>
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd frontend && npx tsc --noEmit 2>&1 | head -30
```

Expected: errors only from `LocalGitOps` / `RemoteGitOps` missing the new methods (not yet implemented). Interface definition itself should be clean.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/types/workspace.ts
git commit -m "feat(workspace): extend GitOps interface with full git command set"
```

---

## Task 2: Create Rust Git Types Module

**Files:**
- Create: `agent/src/git/mod.rs`
- Create: `agent/src/git/types.rs`

- [ ] **Step 1: Create `agent/src/git/mod.rs`**

```rust
pub mod ops;
pub mod types;

pub use ops::GitOps;
pub use types::*;
```

- [ ] **Step 2: Create `agent/src/git/types.rs`**

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitFileStatus {
    pub path: String,
    pub status: String, // "modified" | "added" | "deleted" | "untracked" | "renamed" | "copied"
    pub staged: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitBranchInfo {
    pub name: String,
    pub ahead: i32,
    pub behind: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitInfo {
    pub hash: String,
    pub short_hash: String,
    pub message: String,
    pub author: String,
    pub date: String,
    pub branches: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BranchEntry {
    pub name: String,
    pub is_current: bool,
    pub is_remote: bool,
    pub upstream: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StashEntry {
    pub index: usize,
    pub message: String,
    pub branch: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlameLine {
    pub line_number: usize,
    pub hash: String,
    pub author: String,
    pub date: String,
    pub content: String,
}

#[derive(Debug)]
pub enum GitError {
    NotARepo,
    CommandFailed(String),
    Io(std::io::Error),
}

impl std::fmt::Display for GitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GitError::NotARepo => write!(f, "Not a git repository"),
            GitError::CommandFailed(s) => write!(f, "Git error: {}", s),
            GitError::Io(e) => write!(f, "IO error: {}", e),
        }
    }
}

impl std::error::Error for GitError {}

impl From<std::io::Error> for GitError {
    fn from(e: std::io::Error) -> Self {
        GitError::Io(e)
    }
}

impl From<GitError> for crate::api::ApiError {
    fn from(e: GitError) -> Self {
        crate::api::ApiError {
            error: e.to_string(),
            code: match &e {
                GitError::NotARepo => "GIT_NOT_REPO".to_string(),
                GitError::CommandFailed(_) => "GIT_CMD_FAILED".to_string(),
                GitError::Io(_) => "GIT_IO".to_string(),
            },
        }
    }
}
```

- [ ] **Step 3: Add `mod git;` to `agent/src/main.rs`**

Find the `mod` declarations block and add:

```rust
mod git;
mod git_api;
```

- [ ] **Step 4: Create empty `agent/src/git_api.rs`** (so it compiles)

```rust
// Git API handlers — implemented in Task 9
```

- [ ] **Step 5: Verify agent compiles**

```bash
cd agent && cargo build 2>&1 | grep "^error" | head -20
```

Expected: no errors (git_api.rs is empty, git module has no ops yet).

- [ ] **Step 6: Commit**

```bash
git add agent/src/git/ agent/src/git_api.rs agent/src/main.rs
git commit -m "feat(agent): add git module skeleton with shared types"
```

---

## Task 3: GitOps Struct — Core Helper + Status + Branch

**Files:**
- Create: `agent/src/git/ops.rs`

- [ ] **Step 1: Write failing tests for `is_repo`, `status`, `branch`**

Create `agent/src/git/ops.rs` with tests first:

```rust
use std::path::PathBuf;
use super::types::*;

pub struct GitOps {
    cwd: PathBuf,
}

impl GitOps {
    pub fn new(cwd: impl Into<PathBuf>) -> Self {
        Self { cwd: cwd.into() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use tempfile::TempDir;

    fn make_repo() -> TempDir {
        let dir = TempDir::new().unwrap();
        let p = dir.path();
        Command::new("git").args(["init"]).current_dir(p).status().unwrap();
        Command::new("git").args(["config", "user.email", "t@t.com"]).current_dir(p).status().unwrap();
        Command::new("git").args(["config", "user.name", "Test"]).current_dir(p).status().unwrap();
        std::fs::write(p.join("a.txt"), "hello").unwrap();
        Command::new("git").args(["add", "."]).current_dir(p).status().unwrap();
        Command::new("git").args(["commit", "-m", "init"]).current_dir(p).status().unwrap();
        dir
    }

    #[tokio::test]
    async fn test_is_repo_true() {
        let dir = make_repo();
        let ops = GitOps::new(dir.path());
        assert!(ops.is_repo().await);
    }

    #[tokio::test]
    async fn test_is_repo_false() {
        let dir = TempDir::new().unwrap();
        let ops = GitOps::new(dir.path());
        assert!(!ops.is_repo().await);
    }

    #[tokio::test]
    async fn test_status_clean() {
        let dir = make_repo();
        let ops = GitOps::new(dir.path());
        let files = ops.status().await.unwrap();
        assert!(files.is_empty());
    }

    #[tokio::test]
    async fn test_status_modified() {
        let dir = make_repo();
        std::fs::write(dir.path().join("a.txt"), "changed").unwrap();
        let ops = GitOps::new(dir.path());
        let files = ops.status().await.unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "a.txt");
        assert_eq!(files[0].status, "modified");
        assert!(!files[0].staged);
    }

    #[tokio::test]
    async fn test_branch_info() {
        let dir = make_repo();
        let ops = GitOps::new(dir.path());
        let branch = ops.branch_info().await.unwrap();
        assert!(branch.is_some());
        let b = branch.unwrap();
        assert!(!b.name.is_empty());
        assert_eq!(b.ahead, 0);
        assert_eq!(b.behind, 0);
    }
}
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
cd agent && cargo test git::ops 2>&1 | tail -20
```

Expected: compile errors (methods not implemented yet).

- [ ] **Step 3: Implement `run`, `is_repo`, `status`, `branch_info`**

Add to `agent/src/git/ops.rs` above the `#[cfg(test)]` block:

```rust
impl GitOps {
    async fn run(&self, args: &[&str]) -> Result<String, GitError> {
        let output = tokio::process::Command::new("git")
            .args(args)
            .current_dir(&self.cwd)
            .output()
            .await
            .map_err(GitError::Io)?;
        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).into_owned())
        } else {
            Err(GitError::CommandFailed(
                String::from_utf8_lossy(&output.stderr).trim().to_string(),
            ))
        }
    }

    pub async fn is_repo(&self) -> bool {
        self.run(&["rev-parse", "--is-inside-work-tree"]).await.is_ok()
    }

    pub async fn status(&self) -> Result<Vec<GitFileStatus>, GitError> {
        let output = self.run(&["status", "--porcelain"]).await?;
        Ok(parse_status_output(&output))
    }

    pub async fn branch_info(&self) -> Result<Option<GitBranchInfo>, GitError> {
        let output = self.run(&["status", "--branch", "--porcelain"]).await?;
        Ok(parse_branch_output(&output))
    }
}

fn parse_status_output(output: &str) -> Vec<GitFileStatus> {
    output
        .lines()
        .filter(|l| l.len() >= 4)
        .map(|line| {
            let x = &line[0..1];
            let y = &line[1..2];
            let rest = &line[3..];
            let parts: Vec<&str> = rest.splitn(2, " -> ").collect();
            let path = parts.last().unwrap_or(&rest).trim().to_string();
            let old_path = if parts.len() > 1 {
                Some(parts[0].trim().to_string())
            } else {
                None
            };
            let (status, staged) = parse_status_code(x, y);
            GitFileStatus { path, status, staged, old_path }
        })
        .collect()
}

fn parse_status_code(x: &str, y: &str) -> (String, bool) {
    match (x, y) {
        ("?", "?") => ("untracked".into(), false),
        ("A", _) => ("added".into(), true),
        ("D", _) => ("deleted".into(), true),
        ("R", _) => ("renamed".into(), true),
        ("C", _) => ("copied".into(), true),
        ("M", _) => ("modified".into(), true),
        (_, "M") => ("modified".into(), false),
        (_, "D") => ("deleted".into(), false),
        _ => ("modified".into(), x != " "),
    }
}

fn parse_branch_output(output: &str) -> Option<GitBranchInfo> {
    for line in output.lines() {
        if line.starts_with("## ") {
            // ## main...origin/main [ahead 2, behind 1]
            let rest = &line[3..];
            let (name_part, tracking) = rest.split_once("...").unwrap_or((rest, ""));
            let name = name_part.trim().to_string();
            let ahead = tracking
                .find("ahead ")
                .and_then(|i| tracking[i + 6..].split_once(|c: char| !c.is_ascii_digit()))
                .and_then(|(n, _)| n.parse().ok())
                .unwrap_or(0);
            let behind = tracking
                .find("behind ")
                .and_then(|i| tracking[i + 7..].split_once(|c: char| !c.is_ascii_digit()))
                .and_then(|(n, _)| n.parse().ok())
                .unwrap_or(0);
            let upstream = if tracking.is_empty() {
                None
            } else {
                Some(tracking.split_whitespace().next().unwrap_or("").to_string())
            };
            return Some(GitBranchInfo { name, ahead, behind, upstream });
        }
    }
    None
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
cd agent && cargo test git::ops::tests 2>&1 | tail -20
```

Expected: `test result: ok. 5 passed; 0 failed`

- [ ] **Step 5: Commit**

```bash
git add agent/src/git/ops.rs
git commit -m "feat(agent/git): implement GitOps with status and branch parsing"
```

---

## Task 4: GitOps — Diff, Log, Blame

**Files:**
- Modify: `agent/src/git/ops.rs`

- [ ] **Step 1: Write failing tests**

Add to the `tests` module in `ops.rs`:

```rust
    #[tokio::test]
    async fn test_diff_empty_when_clean() {
        let dir = make_repo();
        let ops = GitOps::new(dir.path());
        let d = ops.diff(None).await.unwrap();
        assert!(d.is_empty());
    }

    #[tokio::test]
    async fn test_diff_shows_change() {
        let dir = make_repo();
        std::fs::write(dir.path().join("a.txt"), "changed").unwrap();
        let ops = GitOps::new(dir.path());
        let d = ops.diff(None).await.unwrap();
        assert!(d.contains("changed"));
    }

    #[tokio::test]
    async fn test_log_returns_commits() {
        let dir = make_repo();
        let ops = GitOps::new(dir.path());
        let commits = ops.log(10, None).await.unwrap();
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].message, "init");
        assert!(!commits[0].hash.is_empty());
        assert_eq!(commits[0].short_hash.len(), 7);
    }

    #[tokio::test]
    async fn test_blame_returns_lines() {
        let dir = make_repo();
        let ops = GitOps::new(dir.path());
        let lines = ops.blame("a.txt").await.unwrap();
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].content, "hello");
        assert_eq!(lines[0].line_number, 1);
        assert_eq!(lines[0].author, "Test");
    }
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
cd agent && cargo test git::ops::tests::test_diff 2>&1 | tail -5
cd agent && cargo test git::ops::tests::test_log 2>&1 | tail -5
cd agent && cargo test git::ops::tests::test_blame 2>&1 | tail -5
```

Expected: compile errors.

- [ ] **Step 3: Implement `diff`, `log`, `blame`**

Add to the `impl GitOps` block:

```rust
    pub async fn diff(&self, file_path: Option<&str>) -> Result<String, GitError> {
        let mut args = vec!["diff"];
        if let Some(p) = file_path {
            args.push("--");
            args.push(p);
        }
        self.run(&args).await
    }

    pub async fn log(&self, limit: usize, file_path: Option<&str>) -> Result<Vec<CommitInfo>, GitError> {
        let limit_str = limit.to_string();
        let mut cmd = tokio::process::Command::new("git");
        cmd.current_dir(&self.cwd);
        cmd.args([
            "log",
            "--format=%H|||%h|||%s|||%an|||%aI|||%D",
            "-n",
            &limit_str,
        ]);
        if let Some(p) = file_path {
            cmd.args(["--", p]);
        }
        let output = cmd.output().await.map_err(GitError::Io)?;
        if !output.status.success() {
            return Err(GitError::CommandFailed(
                String::from_utf8_lossy(&output.stderr).trim().to_string(),
            ));
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        Ok(parse_log_output(&stdout))
    }

    pub async fn blame(&self, file_path: &str) -> Result<Vec<BlameLine>, GitError> {
        let output = self.run(&["blame", "--porcelain", file_path]).await?;
        Ok(parse_blame_output(&output))
    }
```

Add the parsing helpers (outside `impl`, inside the module):

```rust
fn parse_log_output(output: &str) -> Vec<CommitInfo> {
    output
        .lines()
        .filter(|l| !l.is_empty())
        .map(|line| {
            let parts: Vec<&str> = line.splitn(6, "|||").collect();
            let branches = parts
                .get(5)
                .map(|r| {
                    r.split(", ")
                        .filter(|s| !s.is_empty())
                        .map(|s| s.trim_start_matches("HEAD -> ").to_string())
                        .collect()
                })
                .unwrap_or_default();
            CommitInfo {
                hash: parts.get(0).unwrap_or(&"").to_string(),
                short_hash: parts.get(1).unwrap_or(&"").to_string(),
                message: parts.get(2).unwrap_or(&"").to_string(),
                author: parts.get(3).unwrap_or(&"").to_string(),
                date: parts.get(4).unwrap_or(&"").to_string(),
                branches,
            }
        })
        .collect()
}

fn parse_blame_output(output: &str) -> Vec<BlameLine> {
    // porcelain format: each block starts with "<hash> <orig> <final> [<lines>]"
    // followed by key-value lines, then a tab-prefixed content line
    let mut lines = Vec::new();
    let mut current_hash = String::new();
    let mut current_author = String::new();
    let mut current_date = String::new();
    let mut current_line_no: usize = 0;

    for line in output.lines() {
        if line.starts_with('\t') {
            // Content line
            lines.push(BlameLine {
                line_number: current_line_no,
                hash: current_hash[..7.min(current_hash.len())].to_string(),
                author: current_author.clone(),
                date: current_date.clone(),
                content: line[1..].to_string(),
            });
        } else if line.starts_with("author ") && !line.starts_with("author-") {
            current_author = line[7..].to_string();
        } else if line.starts_with("author-time ") {
            current_date = line[12..].to_string();
        } else {
            // First token of header line is the hash + line numbers
            let parts: Vec<&str> = line.splitn(4, ' ').collect();
            if parts.len() >= 3 && parts[0].len() == 40 {
                current_hash = parts[0].to_string();
                current_line_no = parts[2].parse().unwrap_or(0);
            }
        }
    }
    lines
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
cd agent && cargo test git::ops::tests 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add agent/src/git/ops.rs
git commit -m "feat(agent/git): implement diff, log, and blame operations"
```

---

## Task 5: GitOps — Stage, Unstage, Revert, Commit

**Files:**
- Modify: `agent/src/git/ops.rs`

- [ ] **Step 1: Write failing tests**

```rust
    #[tokio::test]
    async fn test_stage_and_commit() {
        let dir = make_repo();
        std::fs::write(dir.path().join("b.txt"), "new file").unwrap();
        let ops = GitOps::new(dir.path());

        // File is untracked
        let files = ops.status().await.unwrap();
        assert_eq!(files[0].status, "untracked");

        // Stage it
        ops.stage(&["b.txt"]).await.unwrap();
        let files = ops.status().await.unwrap();
        assert!(files[0].staged);

        // Commit it
        let commit = ops.commit("add b.txt", &[]).await.unwrap();
        assert_eq!(commit.message, "add b.txt");

        // Now clean
        let files = ops.status().await.unwrap();
        assert!(files.is_empty());
    }

    #[tokio::test]
    async fn test_unstage() {
        let dir = make_repo();
        std::fs::write(dir.path().join("c.txt"), "c").unwrap();
        let ops = GitOps::new(dir.path());
        ops.stage(&["c.txt"]).await.unwrap();
        let files = ops.status().await.unwrap();
        assert!(files[0].staged);

        ops.unstage(&["c.txt"]).await.unwrap();
        let files = ops.status().await.unwrap();
        assert!(!files[0].staged);
    }

    #[tokio::test]
    async fn test_revert() {
        let dir = make_repo();
        std::fs::write(dir.path().join("a.txt"), "modified").unwrap();
        let ops = GitOps::new(dir.path());
        let files = ops.status().await.unwrap();
        assert_eq!(files[0].status, "modified");

        ops.revert(&["a.txt"]).await.unwrap();
        let files = ops.status().await.unwrap();
        assert!(files.is_empty());
    }
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
cd agent && cargo test git::ops::tests::test_stage 2>&1 | tail -5
```

Expected: compile errors.

- [ ] **Step 3: Implement stage, unstage, revert, commit**

```rust
    pub async fn stage(&self, paths: &[&str]) -> Result<(), GitError> {
        if paths.is_empty() {
            self.run(&["add", "-A"]).await?;
        } else {
            let mut args = vec!["add", "--"];
            args.extend_from_slice(paths);
            self.run(&args).await?;
        }
        Ok(())
    }

    pub async fn unstage(&self, paths: &[&str]) -> Result<(), GitError> {
        if paths.is_empty() {
            self.run(&["reset", "HEAD"]).await?;
        } else {
            let mut args = vec!["reset", "HEAD", "--"];
            args.extend_from_slice(paths);
            self.run(&args).await?;
        }
        Ok(())
    }

    pub async fn revert(&self, paths: &[&str]) -> Result<(), GitError> {
        let mut args = vec!["checkout", "--"];
        args.extend_from_slice(paths);
        self.run(&args).await?;
        Ok(())
    }

    pub async fn commit(&self, message: &str, paths: &[&str]) -> Result<CommitInfo, GitError> {
        if !paths.is_empty() {
            self.stage(paths).await?;
        }
        self.run(&["commit", "-m", message]).await?;
        // Return the new HEAD commit
        let commits = self.log(1, None).await?;
        commits.into_iter().next().ok_or_else(|| GitError::CommandFailed("no commit after git commit".into()))
    }
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
cd agent && cargo test git::ops::tests 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add agent/src/git/ops.rs
git commit -m "feat(agent/git): implement stage, unstage, revert, and commit"
```

---

## Task 6: GitOps — Push, Pull, Fetch

**Files:**
- Modify: `agent/src/git/ops.rs`

> **Note:** Push/pull use whatever git credentials are on the host (SSH keys, keychain). Credential vault is Phase 4. These operations will work for repos already authenticated via system git config.

- [ ] **Step 1: Write failing tests**

```rust
    // Push/pull/fetch require a remote — test that the methods exist and
    // return a meaningful error when no remote is configured.
    #[tokio::test]
    async fn test_push_fails_without_remote() {
        let dir = make_repo();
        let ops = GitOps::new(dir.path());
        let result = ops.push(false).await;
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string().to_lowercase();
        assert!(msg.contains("remote") || msg.contains("origin") || msg.contains("git error"));
    }

    #[tokio::test]
    async fn test_fetch_fails_without_remote() {
        let dir = make_repo();
        let ops = GitOps::new(dir.path());
        let result = ops.fetch().await;
        assert!(result.is_err());
    }
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
cd agent && cargo test git::ops::tests::test_push 2>&1 | tail -5
```

Expected: compile errors.

- [ ] **Step 3: Implement push, pull, fetch**

```rust
    pub async fn push(&self, force: bool) -> Result<(), GitError> {
        // Set upstream on first push if not already set
        let branch_info = self.branch_info().await?;
        let branch_name = branch_info.map(|b| b.name).unwrap_or_else(|| "HEAD".into());

        let mut args = vec!["push"];
        if force {
            args.push("--force-with-lease");
        }
        // Always set upstream so first push works
        args.extend_from_slice(&["--set-upstream", "origin", &branch_name]);

        // Build owned string to avoid lifetime issue
        let mut cmd = tokio::process::Command::new("git");
        cmd.current_dir(&self.cwd).args(&args);
        let output = cmd.output().await.map_err(GitError::Io)?;
        if !output.status.success() {
            return Err(GitError::CommandFailed(
                String::from_utf8_lossy(&output.stderr).trim().to_string(),
            ));
        }
        Ok(())
    }

    pub async fn pull(&self, rebase: bool) -> Result<(), GitError> {
        if rebase {
            self.run(&["pull", "--rebase"]).await?;
        } else {
            self.run(&["pull"]).await?;
        }
        Ok(())
    }

    pub async fn fetch(&self) -> Result<(), GitError> {
        self.run(&["fetch", "--all", "--prune"]).await?;
        Ok(())
    }
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
cd agent && cargo test git::ops::tests 2>&1 | tail -10
```

Expected: all tests pass (push/pull/fetch tests assert the error message shape).

- [ ] **Step 5: Commit**

```bash
git add agent/src/git/ops.rs
git commit -m "feat(agent/git): implement push, pull, fetch (system credentials)"
```

---

## Task 7: GitOps — Branch Management

**Files:**
- Modify: `agent/src/git/ops.rs`

- [ ] **Step 1: Write failing tests**

```rust
    #[tokio::test]
    async fn test_list_branches() {
        let dir = make_repo();
        let ops = GitOps::new(dir.path());
        let branches = ops.list_branches().await.unwrap();
        assert_eq!(branches.len(), 1);
        assert!(branches[0].is_current);
        assert!(!branches[0].is_remote);
    }

    #[tokio::test]
    async fn test_create_and_switch_branch() {
        let dir = make_repo();
        let ops = GitOps::new(dir.path());
        ops.create_branch("feature/test", None).await.unwrap();

        let branches = ops.list_branches().await.unwrap();
        assert!(branches.iter().any(|b| b.name == "feature/test"));

        ops.switch_branch("feature/test").await.unwrap();
        let info = ops.branch_info().await.unwrap().unwrap();
        assert_eq!(info.name, "feature/test");
    }

    #[tokio::test]
    async fn test_delete_branch() {
        let dir = make_repo();
        let ops = GitOps::new(dir.path());
        ops.create_branch("to-delete", None).await.unwrap();
        ops.delete_branch("to-delete", false).await.unwrap();
        let branches = ops.list_branches().await.unwrap();
        assert!(!branches.iter().any(|b| b.name == "to-delete"));
    }

    #[tokio::test]
    async fn test_merge_branch() {
        let dir = make_repo();
        let ops = GitOps::new(dir.path());
        ops.create_branch("feature/merge-test", None).await.unwrap();
        ops.switch_branch("feature/merge-test").await.unwrap();
        std::fs::write(dir.path().join("merged.txt"), "merged content").unwrap();
        ops.stage(&["merged.txt"]).await.unwrap();
        ops.commit("add merged.txt", &[]).await.unwrap();

        // Get default branch name (could be main or master)
        let main_branch = {
            Command::new("git")
                .args(["config", "init.defaultBranch"])
                .current_dir(dir.path())
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .unwrap_or_else(|_| "main".into())
        };
        let default = if main_branch.is_empty() { "master".to_string() } else { main_branch };
        ops.switch_branch(&default).await.unwrap();
        ops.merge("feature/merge-test").await.unwrap();

        let log = ops.log(10, None).await.unwrap();
        assert!(log.iter().any(|c| c.message == "add merged.txt"));
    }
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
cd agent && cargo test git::ops::tests::test_list 2>&1 | tail -5
```

Expected: compile errors.

- [ ] **Step 3: Implement branch operations**

```rust
    pub async fn list_branches(&self) -> Result<Vec<BranchEntry>, GitError> {
        let local = self
            .run(&[
                "branch",
                "--format=%(refname:short)|||%(upstream:short)|||%(HEAD)",
                "--no-color",
            ])
            .await?;

        let remote = self
            .run(&["branch", "-r", "--format=%(refname:short)", "--no-color"])
            .await
            .unwrap_or_default();

        let mut entries: Vec<BranchEntry> = local
            .lines()
            .filter(|l| !l.is_empty())
            .map(|line| {
                let parts: Vec<&str> = line.splitn(3, "|||").collect();
                let name = parts.get(0).unwrap_or(&"").to_string();
                let upstream = parts
                    .get(1)
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string());
                let is_current = parts.get(2).map(|s| s.trim() == "*").unwrap_or(false);
                BranchEntry { name, is_current, is_remote: false, upstream }
            })
            .collect();

        let remotes: Vec<BranchEntry> = remote
            .lines()
            .filter(|l| !l.is_empty() && !l.contains("HEAD ->"))
            .map(|name| BranchEntry {
                name: name.trim().to_string(),
                is_current: false,
                is_remote: true,
                upstream: None,
            })
            .collect();

        entries.extend(remotes);
        Ok(entries)
    }

    pub async fn create_branch(&self, name: &str, from: Option<&str>) -> Result<(), GitError> {
        if let Some(base) = from {
            self.run(&["checkout", "-b", name, base]).await?;
        } else {
            self.run(&["checkout", "-b", name]).await?;
        }
        Ok(())
    }

    pub async fn switch_branch(&self, name: &str) -> Result<(), GitError> {
        self.run(&["checkout", name]).await?;
        Ok(())
    }

    pub async fn delete_branch(&self, name: &str, force: bool) -> Result<(), GitError> {
        if force {
            self.run(&["branch", "-D", name]).await?;
        } else {
            self.run(&["branch", "-d", name]).await?;
        }
        Ok(())
    }

    pub async fn merge(&self, branch: &str) -> Result<(), GitError> {
        self.run(&["merge", "--no-ff", branch]).await?;
        Ok(())
    }
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
cd agent && cargo test git::ops::tests 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add agent/src/git/ops.rs
git commit -m "feat(agent/git): implement branch list, create, switch, delete, merge"
```

---

## Task 8: GitOps — Stash, ListStashes, Init

**Files:**
- Modify: `agent/src/git/ops.rs`

- [ ] **Step 1: Write failing tests**

```rust
    #[tokio::test]
    async fn test_stash_push_and_pop() {
        let dir = make_repo();
        std::fs::write(dir.path().join("a.txt"), "stashed change").unwrap();
        let ops = GitOps::new(dir.path());

        // Verify modified
        let files = ops.status().await.unwrap();
        assert!(!files.is_empty());

        ops.stash("push", None).await.unwrap();

        // Now clean
        let files = ops.status().await.unwrap();
        assert!(files.is_empty());

        let stashes = ops.list_stashes().await.unwrap();
        assert_eq!(stashes.len(), 1);

        ops.stash("pop", Some(0)).await.unwrap();
        let files = ops.status().await.unwrap();
        assert!(!files.is_empty());
    }

    #[tokio::test]
    async fn test_init_non_repo() {
        let dir = TempDir::new().unwrap();
        let ops = GitOps::new(dir.path());
        assert!(!ops.is_repo().await);
        ops.init().await.unwrap();
        assert!(ops.is_repo().await);
    }
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
cd agent && cargo test git::ops::tests::test_stash 2>&1 | tail -5
```

Expected: compile errors.

- [ ] **Step 3: Implement stash, list_stashes, init**

```rust
    pub async fn stash(&self, action: &str, index: Option<usize>) -> Result<(), GitError> {
        match action {
            "push" => {
                self.run(&["stash", "push"]).await?;
            }
            "pop" => {
                if let Some(i) = index {
                    let ref_str = format!("stash@{{{}}}", i);
                    self.run(&["stash", "pop", &ref_str]).await?;
                } else {
                    self.run(&["stash", "pop"]).await?;
                }
            }
            "drop" => {
                if let Some(i) = index {
                    let ref_str = format!("stash@{{{}}}", i);
                    self.run(&["stash", "drop", &ref_str]).await?;
                } else {
                    self.run(&["stash", "drop"]).await?;
                }
            }
            _ => {
                return Err(GitError::CommandFailed(format!(
                    "Unknown stash action: {}",
                    action
                )))
            }
        }
        Ok(())
    }

    pub async fn list_stashes(&self) -> Result<Vec<StashEntry>, GitError> {
        let output = self
            .run(&["stash", "list", "--format=%gd|||%gs"])
            .await
            .unwrap_or_default();
        Ok(output
            .lines()
            .enumerate()
            .filter(|(_, l)| !l.is_empty())
            .map(|(i, line)| {
                let parts: Vec<&str> = line.splitn(2, "|||").collect();
                let branch = parts
                    .get(0)
                    .unwrap_or(&"")
                    .trim_start_matches("stash@{")
                    .trim_end_matches('}')
                    .to_string();
                let message = parts.get(1).unwrap_or(&line).to_string();
                StashEntry { index: i, message, branch }
            })
            .collect())
    }

    pub async fn init(&self) -> Result<(), GitError> {
        self.run(&["init"]).await?;
        Ok(())
    }
```

- [ ] **Step 4: Run all git ops tests**

```bash
cd agent && cargo test git::ops::tests 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add agent/src/git/ops.rs
git commit -m "feat(agent/git): implement stash, list_stashes, and init"
```

---

## Task 9: API Handlers — Request Types + Handler Functions

**Files:**
- Modify: `agent/src/git_api.rs`

- [ ] **Step 1: Add request/response types and all handlers**

Replace the contents of `agent/src/git_api.rs`:

```rust
use axum::Json;
use serde::{Deserialize, Serialize};
use crate::api::ApiError;
use crate::git::{GitOps, GitError};

// ── Shared request base ────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct WorkspaceRoot {
    pub workspace_root: String,
}

// ── Status ─────────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct GitStatusResponse {
    pub is_repo: bool,
    pub branch: Option<crate::git::GitBranchInfo>,
    pub files: Vec<crate::git::GitFileStatus>,
}

pub async fn git_status(
    Json(req): Json<WorkspaceRoot>,
) -> Result<Json<GitStatusResponse>, ApiError> {
    let ops = GitOps::new(&req.workspace_root);
    let is_repo = ops.is_repo().await;
    if !is_repo {
        return Ok(Json(GitStatusResponse { is_repo: false, branch: None, files: vec![] }));
    }
    let (branch, files) = tokio::join!(ops.branch_info(), ops.status());
    Ok(Json(GitStatusResponse {
        is_repo: true,
        branch: branch.unwrap_or(None),
        files: files.map_err(ApiError::from)?,
    }))
}

// ── Diff ───────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct GitDiffRequest {
    pub workspace_root: String,
    pub path: Option<String>,
}

pub async fn git_diff(
    Json(req): Json<GitDiffRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ops = GitOps::new(&req.workspace_root);
    let diff = ops.diff(req.path.as_deref()).await.map_err(ApiError::from)?;
    Ok(Json(serde_json::json!({ "diff": diff })))
}

// ── Log ────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct GitLogRequest {
    pub workspace_root: String,
    pub limit: Option<usize>,
    pub path: Option<String>,
}

pub async fn git_log(
    Json(req): Json<GitLogRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ops = GitOps::new(&req.workspace_root);
    let commits = ops
        .log(req.limit.unwrap_or(50), req.path.as_deref())
        .await
        .map_err(ApiError::from)?;
    Ok(Json(serde_json::json!({ "commits": commits })))
}

// ── Blame ──────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct GitBlameRequest {
    pub workspace_root: String,
    pub path: String,
}

pub async fn git_blame(
    Json(req): Json<GitBlameRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ops = GitOps::new(&req.workspace_root);
    let lines = ops.blame(&req.path).await.map_err(ApiError::from)?;
    Ok(Json(serde_json::json!({ "lines": lines })))
}

// ── Stage / Unstage / Revert ───────────────────────────────────────────────

#[derive(Deserialize)]
pub struct GitPathsRequest {
    pub workspace_root: String,
    pub paths: Vec<String>,
}

pub async fn git_stage(
    Json(req): Json<GitPathsRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ops = GitOps::new(&req.workspace_root);
    let path_refs: Vec<&str> = req.paths.iter().map(|s| s.as_str()).collect();
    ops.stage(&path_refs).await.map_err(ApiError::from)?;
    Ok(Json(serde_json::json!({ "success": true })))
}

pub async fn git_unstage(
    Json(req): Json<GitPathsRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ops = GitOps::new(&req.workspace_root);
    let path_refs: Vec<&str> = req.paths.iter().map(|s| s.as_str()).collect();
    ops.unstage(&path_refs).await.map_err(ApiError::from)?;
    Ok(Json(serde_json::json!({ "success": true })))
}

pub async fn git_revert(
    Json(req): Json<GitPathsRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ops = GitOps::new(&req.workspace_root);
    let path_refs: Vec<&str> = req.paths.iter().map(|s| s.as_str()).collect();
    ops.revert(&path_refs).await.map_err(ApiError::from)?;
    Ok(Json(serde_json::json!({ "success": true })))
}

// ── Commit ─────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct GitCommitRequest {
    pub workspace_root: String,
    pub message: String,
    pub paths: Option<Vec<String>>,
}

pub async fn git_commit(
    Json(req): Json<GitCommitRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ops = GitOps::new(&req.workspace_root);
    let paths = req.paths.unwrap_or_default();
    let path_refs: Vec<&str> = paths.iter().map(|s| s.as_str()).collect();
    let commit = ops.commit(&req.message, &path_refs).await.map_err(ApiError::from)?;
    Ok(Json(serde_json::json!({ "commit": commit })))
}

// ── Push / Pull / Fetch ────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct GitPushRequest {
    pub workspace_root: String,
    pub force: Option<bool>,
}

pub async fn git_push(
    Json(req): Json<GitPushRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ops = GitOps::new(&req.workspace_root);
    ops.push(req.force.unwrap_or(false)).await.map_err(ApiError::from)?;
    Ok(Json(serde_json::json!({ "success": true })))
}

#[derive(Deserialize)]
pub struct GitPullRequest {
    pub workspace_root: String,
    pub rebase: Option<bool>,
}

pub async fn git_pull(
    Json(req): Json<GitPullRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ops = GitOps::new(&req.workspace_root);
    ops.pull(req.rebase.unwrap_or(false)).await.map_err(ApiError::from)?;
    Ok(Json(serde_json::json!({ "success": true })))
}

pub async fn git_fetch(
    Json(req): Json<WorkspaceRoot>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ops = GitOps::new(&req.workspace_root);
    ops.fetch().await.map_err(ApiError::from)?;
    Ok(Json(serde_json::json!({ "success": true })))
}

// ── Branches ───────────────────────────────────────────────────────────────

pub async fn git_list_branches(
    Json(req): Json<WorkspaceRoot>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ops = GitOps::new(&req.workspace_root);
    let branches = ops.list_branches().await.map_err(ApiError::from)?;
    Ok(Json(serde_json::json!({ "branches": branches })))
}

#[derive(Deserialize)]
pub struct GitBranchRequest {
    pub workspace_root: String,
    pub name: String,
    pub from: Option<String>,
}

pub async fn git_create_branch(
    Json(req): Json<GitBranchRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ops = GitOps::new(&req.workspace_root);
    ops.create_branch(&req.name, req.from.as_deref()).await.map_err(ApiError::from)?;
    Ok(Json(serde_json::json!({ "success": true })))
}

#[derive(Deserialize)]
pub struct GitSwitchRequest {
    pub workspace_root: String,
    pub name: String,
}

pub async fn git_switch_branch(
    Json(req): Json<GitSwitchRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ops = GitOps::new(&req.workspace_root);
    ops.switch_branch(&req.name).await.map_err(ApiError::from)?;
    Ok(Json(serde_json::json!({ "success": true })))
}

#[derive(Deserialize)]
pub struct GitDeleteBranchRequest {
    pub workspace_root: String,
    pub name: String,
    pub force: Option<bool>,
}

pub async fn git_delete_branch(
    Json(req): Json<GitDeleteBranchRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ops = GitOps::new(&req.workspace_root);
    ops.delete_branch(&req.name, req.force.unwrap_or(false)).await.map_err(ApiError::from)?;
    Ok(Json(serde_json::json!({ "success": true })))
}

#[derive(Deserialize)]
pub struct GitMergeRequest {
    pub workspace_root: String,
    pub branch: String,
}

pub async fn git_merge(
    Json(req): Json<GitMergeRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ops = GitOps::new(&req.workspace_root);
    ops.merge(&req.branch).await.map_err(ApiError::from)?;
    Ok(Json(serde_json::json!({ "success": true })))
}

// ── Stash ──────────────────────────────────────────────────────────────────

pub async fn git_list_stashes(
    Json(req): Json<WorkspaceRoot>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ops = GitOps::new(&req.workspace_root);
    let stashes = ops.list_stashes().await.map_err(ApiError::from)?;
    Ok(Json(serde_json::json!({ "stashes": stashes })))
}

#[derive(Deserialize)]
pub struct GitStashRequest {
    pub workspace_root: String,
    pub action: String,
    pub index: Option<usize>,
}

pub async fn git_stash(
    Json(req): Json<GitStashRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ops = GitOps::new(&req.workspace_root);
    ops.stash(&req.action, req.index).await.map_err(ApiError::from)?;
    Ok(Json(serde_json::json!({ "success": true })))
}

// ── Init ───────────────────────────────────────────────────────────────────

pub async fn git_init(
    Json(req): Json<WorkspaceRoot>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ops = GitOps::new(&req.workspace_root);
    ops.init().await.map_err(ApiError::from)?;
    Ok(Json(serde_json::json!({ "success": true })))
}

// ── ApiError From<GitError> ────────────────────────────────────────────────

impl From<GitError> for ApiError {
    fn from(e: GitError) -> Self {
        ApiError {
            error: e.to_string(),
            code: match &e {
                GitError::NotARepo => "GIT_NOT_REPO".to_string(),
                GitError::CommandFailed(_) => "GIT_CMD_FAILED".to_string(),
                GitError::Io(_) => "GIT_IO".to_string(),
            },
        }
    }
}
```

- [ ] **Step 2: Verify agent compiles**

```bash
cd agent && cargo build 2>&1 | grep "^error" | head -20
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add agent/src/git_api.rs
git commit -m "feat(agent): add git API handlers for all git operations"
```

---

## Task 10: Register Git Routes in main.rs

**Files:**
- Modify: `agent/src/main.rs`

- [ ] **Step 1: Find the route registration block**

```bash
grep -n "local/read-file\|local/write-file" agent/src/main.rs
```

Note the line number — the new git routes go in the same `.route(...)` chain.

- [ ] **Step 2: Add git routes**

In `agent/src/main.rs`, find the block with `.route("/local/read-file", ...)` and add after the existing local routes:

```rust
        // Git operations
        .route("/workspace/git/status", post(git_api::git_status))
        .route("/workspace/git/diff", post(git_api::git_diff))
        .route("/workspace/git/log", post(git_api::git_log))
        .route("/workspace/git/blame", post(git_api::git_blame))
        .route("/workspace/git/stage", post(git_api::git_stage))
        .route("/workspace/git/unstage", post(git_api::git_unstage))
        .route("/workspace/git/revert", post(git_api::git_revert))
        .route("/workspace/git/commit", post(git_api::git_commit))
        .route("/workspace/git/push", post(git_api::git_push))
        .route("/workspace/git/pull", post(git_api::git_pull))
        .route("/workspace/git/fetch", post(git_api::git_fetch))
        .route("/workspace/git/branches", post(git_api::git_list_branches))
        .route("/workspace/git/branch/create", post(git_api::git_create_branch))
        .route("/workspace/git/branch/switch", post(git_api::git_switch_branch))
        .route("/workspace/git/branch/delete", post(git_api::git_delete_branch))
        .route("/workspace/git/merge", post(git_api::git_merge))
        .route("/workspace/git/stashes", post(git_api::git_list_stashes))
        .route("/workspace/git/stash", post(git_api::git_stash))
        .route("/workspace/git/init", post(git_api::git_init))
```

Also add `use crate::git_api;` near the top imports if not already there via `use crate::*`.

- [ ] **Step 3: Verify agent compiles and routes appear**

```bash
cd agent && cargo build 2>&1 | grep "^error" | head -10
```

Expected: clean build.

- [ ] **Step 4: Add routes to capabilities file**

In `frontend/src-tauri/capabilities/default.json`, verify `http` permissions allow the agent host. No change needed if existing workspace endpoints already work.

- [ ] **Step 5: Commit**

```bash
git add agent/src/main.rs
git commit -m "feat(agent): register git REST endpoints in router"
```

---

## Task 11: Frontend — Replace LocalGitOps with AgentGitOps

**Files:**
- Modify: `frontend/src/lib/gitOps.ts`
- Create: `frontend/src/lib/__tests__/gitOps.test.ts`

- [ ] **Step 1: Write failing frontend tests**

Create `frontend/src/lib/__tests__/gitOps.test.ts`:

```typescript
import { vi, describe, it, expect, beforeEach } from 'vitest'

const mockPost = vi.fn()
vi.mock('../../api/client', () => ({
  getClient: () => ({ http: { post: mockPost } }),
}))

import { AgentGitOps } from '../gitOps'

const ROOT = '/home/user/myproject'

describe('AgentGitOps', () => {
  let ops: AgentGitOps

  beforeEach(() => {
    ops = new AgentGitOps(ROOT)
    mockPost.mockReset()
  })

  it('isRepo returns true when agent says is_repo', async () => {
    mockPost.mockResolvedValue({ data: { is_repo: true, branch: null, files: [] } })
    expect(await ops.isRepo()).toBe(true)
    expect(mockPost).toHaveBeenCalledWith('/workspace/git/status', {
      workspace_root: ROOT,
    })
  })

  it('isRepo returns false when agent says not a repo', async () => {
    mockPost.mockResolvedValue({ data: { is_repo: false, branch: null, files: [] } })
    expect(await ops.isRepo()).toBe(false)
  })

  it('status returns parsed files', async () => {
    mockPost.mockResolvedValue({
      data: {
        is_repo: true,
        branch: null,
        files: [{ path: 'src/main.ts', status: 'modified', staged: false }],
      },
    })
    const result = await ops.status()
    expect(result).toHaveLength(1)
    expect(result[0].path).toBe('src/main.ts')
    expect(result[0].status).toBe('modified')
  })

  it('branch returns branch info', async () => {
    mockPost.mockResolvedValue({
      data: {
        is_repo: true,
        branch: { name: 'main', ahead: 1, behind: 0 },
        files: [],
      },
    })
    const result = await ops.branch()
    expect(result?.name).toBe('main')
    expect(result?.ahead).toBe(1)
  })

  it('commit calls the commit endpoint', async () => {
    mockPost.mockResolvedValue({
      data: { commit: { hash: 'abc123', shortHash: 'abc', message: 'test', author: 'Me', date: '', branches: [] } },
    })
    const commit = await ops.commit('test commit', ['src/main.ts'])
    expect(mockPost).toHaveBeenCalledWith('/workspace/git/commit', {
      workspace_root: ROOT,
      message: 'test commit',
      paths: ['src/main.ts'],
    })
    expect(commit.message).toBe('test')
  })

  it('stage calls stage endpoint', async () => {
    mockPost.mockResolvedValue({ data: { success: true } })
    await ops.stage(['a.ts', 'b.ts'])
    expect(mockPost).toHaveBeenCalledWith('/workspace/git/stage', {
      workspace_root: ROOT,
      paths: ['a.ts', 'b.ts'],
    })
  })

  it('push calls push endpoint', async () => {
    mockPost.mockResolvedValue({ data: { success: true } })
    await ops.push(false)
    expect(mockPost).toHaveBeenCalledWith('/workspace/git/push', {
      workspace_root: ROOT,
      force: false,
    })
  })
})
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
cd frontend && npx vitest run src/lib/__tests__/gitOps.test.ts 2>&1 | tail -10
```

Expected: import errors (AgentGitOps not defined yet).

- [ ] **Step 3: Replace LocalGitOps with AgentGitOps in gitOps.ts**

Replace the entire contents of `frontend/src/lib/gitOps.ts`:

```typescript
import { getClient } from '../api/client'
import type {
  GitOps,
  GitFileStatus,
  GitBranchInfo,
  CommitInfo,
  BranchEntry,
  StashEntry,
  BlameLine,
} from '../types/workspace'

// AgentGitOps — calls the local agent for all git operations.
// Works for local workspaces. Remote workspaces (Phase 5) will use RemoteGitOps.
export class AgentGitOps implements GitOps {
  constructor(private workspaceRoot: string) {}

  private async post<T = unknown>(endpoint: string, body: Record<string, unknown> = {}): Promise<T> {
    const { data } = await getClient().http.post(endpoint, {
      workspace_root: this.workspaceRoot,
      ...body,
    })
    return data as T
  }

  async isRepo(): Promise<boolean> {
    const data = await this.post<{ is_repo: boolean }>('/workspace/git/status')
    return data.is_repo ?? false
  }

  async status(): Promise<GitFileStatus[]> {
    const data = await this.post<{ files: GitFileStatus[] }>('/workspace/git/status')
    return data.files ?? []
  }

  async branch(): Promise<GitBranchInfo | null> {
    const data = await this.post<{ branch: GitBranchInfo | null }>('/workspace/git/status')
    return data.branch ?? null
  }

  async diff(filePath?: string): Promise<string> {
    const data = await this.post<{ diff: string }>('/workspace/git/diff', {
      path: filePath ?? null,
    })
    return data.diff ?? ''
  }

  async log(limit = 50, filePath?: string): Promise<CommitInfo[]> {
    const data = await this.post<{ commits: CommitInfo[] }>('/workspace/git/log', {
      limit,
      path: filePath ?? null,
    })
    return data.commits ?? []
  }

  async blame(filePath: string): Promise<BlameLine[]> {
    const data = await this.post<{ lines: BlameLine[] }>('/workspace/git/blame', {
      path: filePath,
    })
    return data.lines ?? []
  }

  async listBranches(): Promise<BranchEntry[]> {
    const data = await this.post<{ branches: BranchEntry[] }>('/workspace/git/branches')
    return data.branches ?? []
  }

  async listStashes(): Promise<StashEntry[]> {
    const data = await this.post<{ stashes: StashEntry[] }>('/workspace/git/stashes')
    return data.stashes ?? []
  }

  async stage(paths: string[]): Promise<void> {
    await this.post('/workspace/git/stage', { paths })
  }

  async unstage(paths: string[]): Promise<void> {
    await this.post('/workspace/git/unstage', { paths })
  }

  async revert(paths: string[]): Promise<void> {
    await this.post('/workspace/git/revert', { paths })
  }

  async commit(message: string, paths?: string[]): Promise<CommitInfo> {
    const data = await this.post<{ commit: CommitInfo }>('/workspace/git/commit', {
      message,
      paths: paths ?? [],
    })
    return data.commit
  }

  async push(force = false): Promise<void> {
    await this.post('/workspace/git/push', { force })
  }

  async pull(rebase = false): Promise<void> {
    await this.post('/workspace/git/pull', { rebase })
  }

  async fetch(): Promise<void> {
    await this.post('/workspace/git/fetch')
  }

  async createBranch(name: string, from?: string): Promise<void> {
    await this.post('/workspace/git/branch/create', { name, from: from ?? null })
  }

  async switchBranch(name: string): Promise<void> {
    await this.post('/workspace/git/branch/switch', { name })
  }

  async deleteBranch(name: string, force = false): Promise<void> {
    await this.post('/workspace/git/branch/delete', { name, force })
  }

  async merge(branch: string): Promise<void> {
    await this.post('/workspace/git/merge', { branch })
  }

  async stash(action: 'push' | 'pop' | 'drop', index?: number): Promise<void> {
    await this.post('/workspace/git/stash', { action, index: index ?? null })
  }

  async init(): Promise<void> {
    await this.post('/workspace/git/init')
  }
}

// RemoteGitOps — runs git over SSH session.
// New methods are stubbed here; full remote implementation in Phase 5.
export class RemoteGitOps implements GitOps {
  constructor(
    private sessionId: string,
    private cwd: string,
  ) {}

  private async run(args: string[]): Promise<string> {
    const command = `cd ${this.shellEscape(this.cwd)} && git ${args.join(' ')}`
    const { data } = await getClient().http.post('/api/ai-ssh-execute', {
      session_id: this.sessionId,
      commands: [command],
    })
    if (data.error) throw new Error(data.error)
    return data.results?.[0]?.output || data.output || ''
  }

  private shellEscape(s: string): string {
    return `'${s.replace(/'/g, "'\\''")}'`
  }

  async isRepo(): Promise<boolean> {
    try {
      await this.run(['rev-parse', '--is-inside-work-tree'])
      return true
    } catch {
      return false
    }
  }

  async status(): Promise<GitFileStatus[]> {
    // Reuse existing parse logic inline
    const output = await this.run(['status', '--porcelain'])
    return parseStatusOutput(output)
  }

  async branch(): Promise<GitBranchInfo | null> {
    const output = await this.run(['status', '--branch', '--porcelain'])
    return parseBranchOutput(output)
  }

  async diff(filePath?: string): Promise<string> {
    const args = filePath ? ['diff', '--', filePath] : ['diff']
    return this.run(args)
  }

  // Phase 5 stubs — throw informative error so callers know these aren't wired yet
  private notImplemented(method: string): never {
    throw new Error(`RemoteGitOps.${method} not implemented until Phase 5`)
  }

  async log(): Promise<CommitInfo[]> { return this.notImplemented('log') }
  async blame(): Promise<BlameLine[]> { return this.notImplemented('blame') }
  async listBranches(): Promise<BranchEntry[]> { return this.notImplemented('listBranches') }
  async listStashes(): Promise<StashEntry[]> { return this.notImplemented('listStashes') }
  async stage(): Promise<void> { return this.notImplemented('stage') }
  async unstage(): Promise<void> { return this.notImplemented('unstage') }
  async revert(): Promise<void> { return this.notImplemented('revert') }
  async commit(): Promise<CommitInfo> { return this.notImplemented('commit') }
  async push(): Promise<void> { return this.notImplemented('push') }
  async pull(): Promise<void> { return this.notImplemented('pull') }
  async fetch(): Promise<void> { return this.notImplemented('fetch') }
  async createBranch(): Promise<void> { return this.notImplemented('createBranch') }
  async switchBranch(): Promise<void> { return this.notImplemented('switchBranch') }
  async deleteBranch(): Promise<void> { return this.notImplemented('deleteBranch') }
  async merge(): Promise<void> { return this.notImplemented('merge') }
  async stash(): Promise<void> { return this.notImplemented('stash') }
  async init(): Promise<void> { return this.notImplemented('init') }
}

// ── Shared parsers (used by RemoteGitOps for backward compat) ─────────────

function parseStatusOutput(output: string): GitFileStatus[] {
  return output
    .trim()
    .split('\n')
    .filter((l) => l.length >= 4)
    .map((line) => {
      const x = line[0]
      const y = line[1]
      const rest = line.slice(3)
      const parts = rest.split(' -> ')
      const { status, staged } = parseStatusCode(x, y)
      return {
        path: parts[parts.length - 1],
        status,
        staged,
        oldPath: parts.length > 1 ? parts[0] : undefined,
      }
    })
}

function parseStatusCode(x: string, y: string): { status: string; staged: boolean } {
  if (x === '?' && y === '?') return { status: 'untracked', staged: false }
  if (x === 'A') return { status: 'added', staged: true }
  if (x === 'D') return { status: 'deleted', staged: true }
  if (x === 'R') return { status: 'renamed', staged: true }
  if (x === 'C') return { status: 'copied', staged: true }
  if (x === 'M') return { status: 'modified', staged: true }
  if (y === 'M') return { status: 'modified', staged: false }
  if (y === 'D') return { status: 'deleted', staged: false }
  return { status: 'modified', staged: x !== ' ' }
}

function parseBranchOutput(output: string): GitBranchInfo | null {
  for (const line of output.trim().split('\n')) {
    if (line.startsWith('## ')) {
      const match = line.match(
        /^## ([^.\s]+)(?:\.\.\.(\S+))?\s*(?:\[ahead (\d+)(?:, behind (\d+))?\])?/,
      )
      if (!match) {
        const simpleName = line.slice(3).trim().split('...')[0]
        return { name: simpleName || 'HEAD', ahead: 0, behind: 0 }
      }
      return {
        name: match[1],
        ahead: match[3] ? parseInt(match[3], 10) : 0,
        behind: match[4] ? parseInt(match[4], 10) : 0,
      }
    }
  }
  return null
}
```

- [ ] **Step 4: Run frontend tests — verify they pass**

```bash
cd frontend && npx vitest run src/lib/__tests__/gitOps.test.ts 2>&1 | tail -15
```

Expected: `Tests 7 passed`.

- [ ] **Step 5: Verify TypeScript compiles**

```bash
cd frontend && npx tsc --noEmit 2>&1 | grep "gitOps\|workspace" | head -20
```

Expected: no errors in gitOps.ts or workspace.ts.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/gitOps.ts frontend/src/lib/__tests__/gitOps.test.ts
git commit -m "feat(frontend): replace LocalGitOps with AgentGitOps, stub RemoteGitOps new methods"
```

---

## Task 12: Wire AgentGitOps into useWorkspace

**Files:**
- Modify: `frontend/src/hooks/useWorkspace.ts`

- [ ] **Step 1: Update the gitOps import and instantiation**

In `frontend/src/hooks/useWorkspace.ts`, find:

```typescript
import { LocalFileOps, RemoteFileOps } from '../lib/fileOps'
import { LocalGitOps, RemoteGitOps } from '../lib/gitOps'
```

Change to:

```typescript
import { LocalFileOps, RemoteFileOps } from '../lib/fileOps'
import { AgentGitOps, RemoteGitOps } from '../lib/gitOps'
```

- [ ] **Step 2: Update the gitOps useMemo**

Find:

```typescript
  const gitOps = useMemo<GitOps>(() => {
    if (config.mode === 'remote' && config.sessionId) {
      return new RemoteGitOps(config.sessionId, config.rootPath)
    }
    return new LocalGitOps(config.rootPath)
  }, [config.mode, config.sessionId, config.rootPath])
```

Change to:

```typescript
  const gitOps = useMemo<GitOps>(() => {
    if (config.mode === 'remote' && config.sessionId) {
      return new RemoteGitOps(config.sessionId, config.rootPath)
    }
    return new AgentGitOps(config.rootPath)
  }, [config.mode, config.sessionId, config.rootPath])
```

- [ ] **Step 3: Verify TypeScript compiles clean**

```bash
cd frontend && npx tsc --noEmit 2>&1 | grep "^src" | head -20
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/hooks/useWorkspace.ts
git commit -m "feat(workspace): wire AgentGitOps into useWorkspace for local mode"
```

---

## Task 13: Smoke Test — Verify End to End

- [ ] **Step 1: Start the app**

```bash
./terminal-dev.sh -s
```

- [ ] **Step 2: Open a local workspace that is a git repo**

In the app: Activity bar → Workspaces → New Workspace → browse to any local git repo → Open Workspace.

- [ ] **Step 3: Verify git status displays**

In the file explorer (Zone 1), confirm:
- Branch name displays in the git status bar (e.g., `⎇ main`)
- Modified files show `M` badge
- Untracked files show `U` badge

- [ ] **Step 4: Verify agent logs show git endpoint calls**

In the terminal running `terminal-dev.sh`, look for log lines like:
```
POST /workspace/git/status
```

- [ ] **Step 5: Run all tests one final time**

```bash
cd agent && cargo test git:: 2>&1 | tail -5
cd frontend && npx vitest run src/lib/__tests__/gitOps.test.ts 2>&1 | tail -5
```

Expected: all pass.

- [ ] **Step 6: Final commit**

```bash
git add -u
git commit -m "chore: phase 1 complete — agent git foundation wired end to end"
```

---

## Summary of What Phase 1 Delivers

- All git operations run through the Rust agent (no Tauri shell for git)
- 19 new REST endpoints under `/workspace/git/*`
- `AgentGitOps` replaces `LocalGitOps` — polling still works, new ops available
- `RemoteGitOps` satisfies the extended interface with stubs (won't break remote workspaces)
- Full Rust test coverage for all git operations
- Frontend unit tests for `AgentGitOps`
- Foundation for Phases 2–8 to build on

## Next: Phase 2

Phase 2 covers the context menu refactor (replace `WorkspaceFileExplorer`'s inline menu with the shared `ContextMenu` component) and adds git actions (stage, diff, blame, revert) to the file explorer right-click menu. Request the Phase 2 plan when ready to proceed.
