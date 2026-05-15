# Phase 4: Git Panel Actions & Context Menus

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Push/Pull/Fetch toolbar to the git panel, and right-click context menus on changed files, commits, and branches.

**Architecture:** A toolbar row at the top of WorkspaceGitPanel shows branch name, ahead/behind counts, and Push/Pull/Fetch buttons. Context menus use the shared `ContextMenu` component with builder functions following the `getFileExplorerMenuItems` pattern from Phase 2.

**Tech Stack:** React, TypeScript, existing ContextMenu component, existing GitOps interface.

---

## Tasks

### Task 1: Add toolbar to WorkspaceGitPanel
### Task 2: Add context menu on changed files in WorkspaceGitChanges
### Task 3: Add context menu on commits in WorkspaceGitHistory
### Task 4: Add context menu on branches in WorkspaceGitBranches
### Task 5: Verify
