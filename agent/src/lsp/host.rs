//! LSP plugin host.
//!
//! Owns the merged plugin registry (built-ins from `plugins::built_in_plugins()`
//! plus user-added entries loaded from SQLite) and the active session map.
//! Session lifecycle is owned by `LspSession` (added in P2T5). This struct
//! is the public surface used by HTTP/WS routes.

use crate::lsp::install::{install_plugin as do_install, InstallError, InstallEvent};
use crate::lsp::plugins::built_in_plugins;
use crate::lsp::session::LspSession;
use crate::lsp::types::{InstallationKind, InstallStatus, LspPlugin, PluginSource, RuntimeConfig};
use dashmap::DashMap;
use sqlx::SqlitePool;
use std::path::PathBuf;
use std::sync::Arc;
use thiserror::Error;
use tokio::sync::broadcast;

#[derive(Debug, Error)]
pub enum LspHostError {
    #[error("plugin id {0} not found")]
    PluginNotFound(String),
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("invalid plugin config: {0}")]
    InvalidConfig(String),
    #[error("install error: {0}")]
    Install(#[from] InstallError),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
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
    /// Base data directory for LSP plugin binaries.
    data_dir: PathBuf,
    /// Active sessions. Phase 2 only declares the map; LspSession is added in P2T5.
    pub(crate) sessions: DashMap<SessionKey, Arc<LspSession>>,
    /// In-progress installs. Maps plugin_id → broadcast channel for SSE subscribers.
    pub(crate) installs: DashMap<String, broadcast::Sender<InstallEvent>>,
}

impl LspHost {
    pub fn new(pool: SqlitePool, data_dir: PathBuf) -> Self {
        Self {
            pool,
            data_dir,
            sessions: DashMap::new(),
            installs: DashMap::new(),
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

        // For on-demand plugins, use the installed binary path instead of
        // the placeholder runtime command.
        let runtime = if let InstallationKind::OnDemandDownload { version, .. } = &plugin.installation {
            let binary_path = self.installed_binary_path(&plugin.id, version);
            if binary_path.exists() {
                RuntimeConfig {
                    command: binary_path.to_string_lossy().to_string(),
                    args: plugin.runtime.args.clone(),
                }
            } else {
                return Err(LspHostError::InvalidConfig(format!(
                    "plugin {} is not installed; binary not found at {}",
                    plugin.id,
                    binary_path.display()
                )));
            }
        } else {
            plugin.runtime.clone()
        };

        let workspace_path = match &workspace {
            WorkspaceKey::Path(p) => Some(p.as_path()),
            WorkspaceKey::Scratch(_) => None,
        };
        let session = LspSession::spawn(&runtime, workspace_path)
            .map_err(|e| LspHostError::InvalidConfig(format!("spawn LSP for {}: {}", plugin_id, e)))?;
        self.sessions.insert(key, session.clone());
        Ok(session)
    }

    /// Install a plugin from its on-demand download source.
    ///
    /// Returns a broadcast receiver for progress events. The install runs
    /// asynchronously in the background.
    ///
    /// Returns `InstallError::InProgress` if an install is already running
    /// for this plugin.
    pub fn install_plugin(
        &self,
        plugin_id: String,
    ) -> Result<broadcast::Receiver<InstallEvent>, LspHostError> {
        // Check if already installing
        if self.installs.contains_key(&plugin_id) {
            return Err(InstallError::InProgress.into());
        }

        // Create progress channel (buffer 100 events)
        let (tx, rx) = broadcast::channel(100);
        self.installs.insert(plugin_id.clone(), tx.clone());

        // Spawn the install task
        let data_dir = self.data_dir.clone();
        let pool = self.pool.clone();
        let installs = self.installs.clone();
        tokio::spawn(async move {
            let result = async {
                // Look up the plugin descriptor
                let host_temp = LspHost::new(pool, data_dir.clone());
                let plugin = host_temp.get_plugin(&plugin_id).await?;

                // Run the installer
                do_install(&plugin, &data_dir, tx.clone()).await?;

                Ok::<_, LspHostError>(())
            }
            .await;

            // Send final event on error
            if let Err(e) = result {
                let _ = tx.send(InstallEvent {
                    phase: crate::lsp::install::InstallPhase::Error,
                    bytes_downloaded: 0,
                    total_bytes: None,
                    error: Some(e.to_string()),
                });
            }

            // Remove from in-progress map
            installs.remove(&plugin_id);
        });

        Ok(rx)
    }

    /// Uninstall a plugin by deleting its binary directory.
    ///
    /// For built-in plugins, this removes the on-demand downloaded binary.
    /// For user-added plugins, this is a no-op (Phase 5 will implement).
    pub async fn uninstall_plugin(&self, plugin_id: &str) -> Result<(), LspHostError> {
        let plugin = self.get_plugin(plugin_id).await?;

        // Only on-demand plugins can be uninstalled
        let InstallationKind::OnDemandDownload { .. } = &plugin.installation else {
            return Ok(()); // No-op for system path / bundled plugins
        };

        // Kill any active sessions for this plugin
        self.sessions.retain(|key, _| key.0 != plugin_id);

        // Delete the plugin directory
        let plugin_dir = self.data_dir.join("lsp").join(plugin_id);
        if plugin_dir.exists() {
            tokio::fs::remove_dir_all(&plugin_dir).await?;
        }

        Ok(())
    }

    /// Compute install status for a plugin.
    ///
    /// Used by routes.rs to populate the `installStatus` field in plugin list responses.
    pub fn compute_install_status(&self, plugin: &LspPlugin) -> InstallStatus {
        match &plugin.installation {
            InstallationKind::SystemPath { .. } | InstallationKind::Bundled { .. } => {
                InstallStatus::Installed
            }
            InstallationKind::OnDemandDownload { version, .. } => {
                // Check if currently installing
                if self.installs.contains_key(&plugin.id) {
                    return InstallStatus::Installing;
                }

                // Check if binary exists on disk
                let binary_path = self.installed_binary_path(&plugin.id, version);
                if binary_path.exists() {
                    InstallStatus::Installed
                } else {
                    InstallStatus::NotInstalled
                }
            }
        }
    }

    /// Get the expected path to an installed binary.
    fn installed_binary_path(&self, plugin_id: &str, version: &str) -> PathBuf {
        #[cfg(target_os = "windows")]
        let binary_name = format!("{}.exe", plugin_id);
        #[cfg(not(target_os = "windows"))]
        let binary_name = plugin_id.to_string();

        self.data_dir
            .join("lsp")
            .join(plugin_id)
            .join(format!("v{}", version))
            .join(binary_name)
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
    async fn pyrefly_appears_in_built_in_list() {
        let pool = fresh_pool().await;
        let temp_dir = tempfile::TempDir::new().unwrap();
        let host = LspHost::new(pool, temp_dir.path().to_path_buf());
        let plugins = host.list_plugins().await.unwrap();
        assert_eq!(plugins.len(), 1, "Phase 4 adds Pyrefly as the only built-in");
        assert_eq!(plugins[0].id, "pyrefly");
        assert_eq!(plugins[0].language, "python");
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

        let temp_dir = tempfile::TempDir::new().unwrap();
        let host = LspHost::new(pool, temp_dir.path().to_path_buf());
        let plugins = host.list_plugins().await.unwrap();
        assert_eq!(plugins.len(), 2, "Pyrefly + gopls");
        let go = plugins.iter().find(|p| p.id == "go").unwrap();
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
        let temp_dir = tempfile::TempDir::new().unwrap();
        let host = LspHost::new(pool, temp_dir.path().to_path_buf());
        let err = host.get_plugin("nope").await.unwrap_err();
        assert!(matches!(err, LspHostError::PluginNotFound(_)));
    }
}
