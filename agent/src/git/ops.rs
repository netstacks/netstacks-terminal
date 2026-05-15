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
