//! Task store for CRUD operations on agent tasks
//!
//! Provides persistence layer for AI agent tasks using SQLite.

use chrono::Utc;
use sqlx::SqlitePool;
use uuid::Uuid;

use super::models::{AgentTask, CreateTaskRequest, TaskStatus, UpdateTaskRequest};

/// Task store errors
#[derive(Debug, thiserror::Error)]
pub enum TaskStoreError {
    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("Task not found: {0}")]
    NotFound(String),
    #[error("Invalid status transition: {0} -> {1}")]
    InvalidTransition(String, String),
}

/// Task store for CRUD operations
#[derive(Clone)]
pub struct TaskStore {
    pool: SqlitePool,
}

const SELECT_COLUMNS: &str = "id, prompt, status, progress_pct, result_json, error_message, created_at, updated_at, started_at, completed_at, agent_definition_id";

type TaskRow = (
    String,
    String,
    String,
    i32,
    Option<String>,
    Option<String>,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
);

fn row_to_task(row: TaskRow) -> AgentTask {
    AgentTask {
        id: row.0,
        prompt: row.1,
        status: TaskStatus::from_str(&row.2).unwrap_or(TaskStatus::Pending),
        progress_pct: row.3,
        result_json: row.4,
        error_message: row.5,
        created_at: row.6,
        updated_at: row.7,
        started_at: row.8,
        completed_at: row.9,
        agent_definition_id: row.10,
    }
}

impl TaskStore {
    /// Create a new task store
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// Create a new task
    pub async fn create_task(&self, req: CreateTaskRequest) -> Result<AgentTask, TaskStoreError> {
        self.create_task_with_agent(req, None).await
    }

    /// Create a new task with an optional agent definition ID
    pub async fn create_task_with_agent(&self, req: CreateTaskRequest, agent_definition_id: Option<String>) -> Result<AgentTask, TaskStoreError> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();

        sqlx::query(
            r#"INSERT INTO agent_tasks (id, prompt, status, progress_pct, created_at, updated_at, agent_definition_id)
               VALUES (?, ?, 'pending', 0, ?, ?, ?)"#,
        )
        .bind(&id)
        .bind(&req.prompt)
        .bind(&now)
        .bind(&now)
        .bind(&agent_definition_id)
        .execute(&self.pool)
        .await?;

        self.get_task(&id).await
    }

    /// Get a task by ID
    pub async fn get_task(&self, id: &str) -> Result<AgentTask, TaskStoreError> {
        let query = format!("SELECT {} FROM agent_tasks WHERE id = ?", SELECT_COLUMNS);
        let row: TaskRow = sqlx::query_as(&query)
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .ok_or_else(|| TaskStoreError::NotFound(id.to_string()))?;

        Ok(row_to_task(row))
    }

    /// Update task status and/or progress
    pub async fn update_task(
        &self,
        id: &str,
        req: UpdateTaskRequest,
    ) -> Result<AgentTask, TaskStoreError> {
        let current = self.get_task(id).await?;
        let now = Utc::now().to_rfc3339();

        // Validate status transition if status is being updated
        if let Some(ref new_status) = req.status {
            if !current.status.can_transition_to(new_status) {
                return Err(TaskStoreError::InvalidTransition(
                    current.status.as_str().to_string(),
                    new_status.as_str().to_string(),
                ));
            }
        }

        let new_status = req
            .status
            .as_ref()
            .map(|s| s.as_str())
            .unwrap_or(current.status.as_str());
        let new_progress = req.progress_pct.unwrap_or(current.progress_pct);

        // Set started_at when transitioning to running
        let started_at = if new_status == "running" && current.started_at.is_none() {
            Some(now.clone())
        } else {
            current.started_at.clone()
        };

        // Set completed_at when transitioning to a terminal state
        let completed_at =
            if matches!(new_status, "completed" | "failed" | "cancelled")
                && current.completed_at.is_none()
            {
                Some(now.clone())
            } else {
                current.completed_at.clone()
            };

        sqlx::query(
            r#"UPDATE agent_tasks
               SET status = ?, progress_pct = ?, result_json = COALESCE(?, result_json),
                   error_message = COALESCE(?, error_message), updated_at = ?,
                   started_at = ?, completed_at = ?
               WHERE id = ?"#,
        )
        .bind(new_status)
        .bind(new_progress)
        .bind(&req.result_json)
        .bind(&req.error_message)
        .bind(&now)
        .bind(&started_at)
        .bind(&completed_at)
        .bind(id)
        .execute(&self.pool)
        .await?;

        self.get_task(id).await
    }

    /// List tasks with optional status filter
    pub async fn list_tasks(
        &self,
        status: Option<TaskStatus>,
        limit: i32,
        offset: i32,
    ) -> Result<Vec<AgentTask>, TaskStoreError> {
        let rows: Vec<TaskRow> = if let Some(status) = status {
            let query = format!("SELECT {} FROM agent_tasks WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?", SELECT_COLUMNS);
            sqlx::query_as(&query)
                .bind(status.as_str())
                .bind(limit)
                .bind(offset)
                .fetch_all(&self.pool)
                .await?
        } else {
            let query = format!("SELECT {} FROM agent_tasks ORDER BY created_at DESC LIMIT ? OFFSET ?", SELECT_COLUMNS);
            sqlx::query_as(&query)
                .bind(limit)
                .bind(offset)
                .fetch_all(&self.pool)
                .await?
        };

        Ok(rows.into_iter().map(row_to_task).collect())
    }

    /// Delete a task (for cleanup or cancellation)
    pub async fn delete_task(&self, id: &str) -> Result<(), TaskStoreError> {
        let result = sqlx::query("DELETE FROM agent_tasks WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await?;

        if result.rows_affected() == 0 {
            return Err(TaskStoreError::NotFound(id.to_string()));
        }

        Ok(())
    }

    /// Count tasks by status (for concurrency limiting)
    pub async fn _count_by_status(&self, status: TaskStatus) -> Result<i64, TaskStoreError> {
        let count: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM agent_tasks WHERE status = ?")
                .bind(status.as_str())
                .fetch_one(&self.pool)
                .await?;

        Ok(count.0)
    }
}
