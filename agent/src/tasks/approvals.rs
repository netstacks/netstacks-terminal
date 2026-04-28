//! Background-task tool-use approval service (AUDIT FIX EXEC-017).
//!
//! Before this existed, a long-running ReAct task could autonomously
//! invoke any registered tool — including writes (`write_file`,
//! `edit_file`, `patch_file`), email (`send_email`), and any MCP tool the
//! user had previously enabled. Combined with prompt injection, a single
//! task started in the morning could quietly destructive-act all day.
//!
//! Now: every mutating tool dispatch (per `is_mutating_tool` below) blocks
//! on a per-task approval. The frontend polls
//! `GET /api/tasks/:id/pending-approval`, surfaces a modal showing the
//! tool name + arguments, and resolves via
//! `POST /api/tasks/:id/approvals/:approval_id/{approve,reject}`. While
//! waiting, the task status stays `Running` (no schema change required);
//! the pending approval is in-memory state.

use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{oneshot, RwLock};
use uuid::Uuid;

/// Maximum time the user has to respond to a tool-use approval before the
/// task auto-rejects. Generous because a user might step away from a
/// long-running agent task.
pub const APPROVAL_TIMEOUT: Duration = Duration::from_secs(600);

/// Returns true when the named tool requires explicit user approval per
/// invocation. Add new mutating tools here.
pub fn is_mutating_tool(name: &str) -> bool {
    matches!(
        name,
        "write_file" | "ai_write_file"
            | "edit_file" | "ai_edit_file"
            | "patch_file" | "ai_patch_file"
            | "send_email"
    ) || name.starts_with("mcp_")
}

#[derive(Debug, Clone, Serialize)]
pub struct PendingTaskApproval {
    pub id: String,
    pub task_id: String,
    pub tool_name: String,
    pub tool_input: serde_json::Value,
    pub created_at: String,
}

struct PendingState {
    info: PendingTaskApproval,
    sender: oneshot::Sender<bool>,
}

#[derive(Default)]
pub struct TaskApprovalService {
    /// Approval id → state. One task can have at most one active prompt
    /// at a time (the ReAct loop is sequential).
    pending: RwLock<HashMap<String, PendingState>>,
}

impl TaskApprovalService {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Create a pending approval and await the user's decision. Returns
    /// `true` if approved, `false` if rejected or timed out.
    pub async fn request(
        &self,
        task_id: String,
        tool_name: String,
        tool_input: serde_json::Value,
    ) -> bool {
        let id = Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        let info = PendingTaskApproval {
            id: id.clone(),
            task_id: task_id.clone(),
            tool_name: tool_name.clone(),
            tool_input,
            created_at: chrono::Utc::now().to_rfc3339(),
        };
        tracing::warn!(
            target: "audit",
            task_id = %task_id,
            tool = %tool_name,
            approval_id = %id,
            "ReAct task awaiting tool-use approval"
        );
        self.pending.write().await.insert(id.clone(), PendingState { info, sender: tx });

        let outcome = tokio::time::timeout(APPROVAL_TIMEOUT, rx).await;
        self.pending.write().await.remove(&id);
        match outcome {
            Ok(Ok(approved)) => {
                tracing::warn!(
                    target: "audit",
                    task_id = %task_id,
                    tool = %tool_name,
                    approved,
                    "ReAct task approval resolved"
                );
                approved
            }
            _ => {
                tracing::warn!(
                    target: "audit",
                    task_id = %task_id,
                    tool = %tool_name,
                    "ReAct task approval timed out — treating as rejected"
                );
                false
            }
        }
    }

    /// REST endpoint backing: prompts pending for a specific task.
    pub async fn pending_for_task(&self, task_id: &str) -> Vec<PendingTaskApproval> {
        self.pending
            .read()
            .await
            .values()
            .filter(|p| p.info.task_id == task_id)
            .map(|p| p.info.clone())
            .collect()
    }

    /// REST endpoint backing: every pending approval (used for a global
    /// "anything waiting?" indicator on the agents panel).
    pub async fn list_all(&self) -> Vec<PendingTaskApproval> {
        self.pending.read().await.values().map(|p| p.info.clone()).collect()
    }

    pub async fn resolve(&self, approval_id: &str, approved: bool) -> bool {
        let removed = self.pending.write().await.remove(approval_id);
        match removed {
            Some(state) => {
                let _ = state.sender.send(approved);
                true
            }
            None => false,
        }
    }
}
