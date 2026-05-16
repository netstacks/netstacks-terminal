//! LSP plugin host.
//!
//! Owns the merged plugin registry (built-ins from `plugins::built_in_plugins()`
//! plus user-added entries loaded from SQLite) and the active session map.
//! Session lifecycle is owned by `LspSession` (added in P2T5). This struct
//! is the public surface used by HTTP/WS routes.

use crate::lsp::plugins::built_in_plugins;
use crate::lsp::session::LspSession;
use crate::lsp::types::{InstallationKind, LspPlugin, PluginSource, RuntimeConfig};
use dashmap::DashMap;
use sqlx::SqlitePool;
use std::path::PathBuf;
use std::sync::Arc;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum LspHostError {
    #[error("plugin id {0} not found")]
    PluginNotFound(String),
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("invalid plugin config: {0}")]
    InvalidConfig(String),
}

/// Session key: a plugin id paired with its workspace root. A loose-file
/// session (no workspace) uses a synthetic per-connection id stored in
/// `WorkspaceKey::Scratch`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum WorkspaceKey {
    Path(PathBuf),
    Scratch(String), // UUID; Phase 6 implements scratch dirs
}

pub type SessionKey = (String, WorkspaceKey);

/// The agent-wide LSP host. Held inside AppState as `Arc<LspHost>`.
pub struct LspHost {
    pool: SqlitePool,
    /// Active sessions. Phase 2 only declares the map; LspSession is added in P2T5.
    pub(crate) sessions: DashMap<SessionKey, Arc<LspSession>>,
}

impl LspHost {
    pub fn new(pool: SqlitePool) -> Self {
        Self {
            pool,
            sessions: DashMap::new(),
        }
    }

    /// Return the merged plugin list (built-in + user-added). User-added
    /// rows from `lsp_plugins` are wrapped as `PluginSource::UserAdded`
    /// descriptors with `InstallationKind::SystemPath`. Per-built-in
    /// overrides from `lsp_plugin_overrides` are applied to built-ins.
    pub async fn list_plugins(&self) -> Result<Vec<LspPlugin>, LspHostError> {
        let mut all = built_in_plugins();

        // Apply per-built-in overrides
        let overrides = sqlx::query_as::<_, BuiltInOverrideRow>(
            "SELECT plugin_id, enabled, custom_command, custom_args FROM lsp_plugin_overrides"
        )
        .fetch_all(&self.pool)
        .await?;

        for row in overrides {
            if let Some(plugin) = all.iter_mut().find(|p| p.id == row.plugin_id) {
                if !row.enabled {
                    plugin.default_enabled = false;
                }
                if let Some(cmd) = row.custom_command {
                    let args: Vec<String> = serde_json::from_str(&row.custom_args)
                        .map_err(|e| LspHostError::InvalidConfig(format!(
                            "lsp_plugin_overrides.custom_args for {}: {}",
                            row.plugin_id, e
                        )))?;
                    plugin.runtime = RuntimeConfig { command: cmd, args };
                }
            }
        }

        // Append user-added plugins
        let user_rows = sqlx::query_as::<_, UserPluginRow>(
            "SELECT id, display_name, language, file_extensions, command, args, enabled FROM lsp_plugins"
        )
        .fetch_all(&self.pool)
        .await?;

        for row in user_rows {
            let file_extensions: Vec<String> = serde_json::from_str(&row.file_extensions)
                .map_err(|e| LspHostError::InvalidConfig(format!(
                    "lsp_plugins.file_extensions for {}: {}",
                    row.id, e
                )))?;
            let args: Vec<String> = serde_json::from_str(&row.args)
                .map_err(|e| LspHostError::InvalidConfig(format!(
                    "lsp_plugins.args for {}: {}",
                    row.id, e
                )))?;
            all.push(LspPlugin {
                id: row.id.clone(),
                display_name: row.display_name,
                language: row.language,
                file_extensions,
                default_enabled: row.enabled,
                unavailable_in_enterprise: false,
                source: PluginSource::UserAdded,
                installation: InstallationKind::SystemPath {
                    default_command: row.command.clone(),
                },
                runtime: RuntimeConfig {
                    command: row.command,
                    args,
                },
            });
        }

        Ok(all)
    }

    /// Look up a plugin by id from the merged registry. Returns Err if not found.
    pub async fn get_plugin(&self, id: &str) -> Result<LspPlugin, LspHostError> {
        let all = self.list_plugins().await?;
        all.into_iter()
            .find(|p| p.id == id)
            .ok_or_else(|| LspHostError::PluginNotFound(id.to_string()))
    }

    /// Get or create the session for `(plugin_id, workspace)`. Spawns the
    /// LSP child if no session exists. Subsequent calls for the same key
    /// return the existing session so WebSocket clients can share it.
    pub async fn get_or_create_session(
        &self,
        plugin_id: &str,
        workspace: WorkspaceKey,
    ) -> Result<Arc<LspSession>, LspHostError> {
        let key = (plugin_id.to_string(), workspace.clone());
        if let Some(s) = self.sessions.get(&key) {
            return Ok(s.clone());
        }
        let plugin = self.get_plugin(plugin_id).await?;
        let workspace_path = match &workspace {
            WorkspaceKey::Path(p) => Some(p.as_path()),
            WorkspaceKey::Scratch(_) => None,
        };
        let session = LspSession::spawn(&plugin.runtime, workspace_path)
            .map_err(|e| LspHostError::InvalidConfig(format!("spawn LSP for {}: {}", plugin_id, e)))?;
        self.sessions.insert(key, session.clone());
        Ok(session)
    }
}

#[derive(sqlx::FromRow)]
struct BuiltInOverrideRow {
    plugin_id: String,
    enabled: bool,
    custom_command: Option<String>,
    custom_args: String,
}

#[derive(sqlx::FromRow)]
struct UserPluginRow {
    id: String,
    display_name: String,
    language: String,
    file_extensions: String,
    command: String,
    args: String,
    enabled: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn fresh_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query(
            r#"CREATE TABLE lsp_plugins (
                id TEXT PRIMARY KEY,
                display_name TEXT NOT NULL,
                language TEXT NOT NULL,
                file_extensions TEXT NOT NULL,
                command TEXT NOT NULL,
                args TEXT NOT NULL,
                env_vars TEXT NOT NULL DEFAULT '{}',
                enabled INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            )"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            r#"CREATE TABLE lsp_plugin_overrides (
                plugin_id TEXT PRIMARY KEY,
                enabled INTEGER NOT NULL DEFAULT 1,
                custom_command TEXT,
                custom_args TEXT NOT NULL DEFAULT '[]',
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            )"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    #[tokio::test]
    async fn empty_registry_returns_no_plugins() {
        let pool = fresh_pool().await;
        let host = LspHost::new(pool);
        let plugins = host.list_plugins().await.unwrap();
        assert!(plugins.is_empty(), "v1 built-ins are empty (Pyrefly added in Phase 4)");
    }

    #[tokio::test]
    async fn user_added_plugin_appears_in_list() {
        let pool = fresh_pool().await;
        sqlx::query(
            "INSERT INTO lsp_plugins (id, display_name, language, file_extensions, command, args, enabled) \
             VALUES ('go', 'gopls', 'go', '[\".go\"]', 'gopls', '[\"serve\"]', 1)",
        )
        .execute(&pool)
        .await
        .unwrap();

        let host = LspHost::new(pool);
        let plugins = host.list_plugins().await.unwrap();
        assert_eq!(plugins.len(), 1);
        let go = &plugins[0];
        assert_eq!(go.id, "go");
        assert_eq!(go.display_name, "gopls");
        assert_eq!(go.language, "go");
        assert_eq!(go.file_extensions, vec![".go".to_string()]);
        assert_eq!(go.runtime.command, "gopls");
        assert_eq!(go.runtime.args, vec!["serve".to_string()]);
        assert!(matches!(go.source, PluginSource::UserAdded));
        assert!(matches!(go.installation, InstallationKind::SystemPath { .. }));
    }

    #[tokio::test]
    async fn get_plugin_returns_not_found_for_unknown_id() {
        let pool = fresh_pool().await;
        let host = LspHost::new(pool);
        let err = host.get_plugin("nope").await.unwrap_err();
        assert!(matches!(err, LspHostError::PluginNotFound(_)));
    }
}
