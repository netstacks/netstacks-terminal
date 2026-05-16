//! LSP (Language Server Protocol) plugin host.
//!
//! Generic plugin-shaped system for hosting language servers as stdio
//! children proxied to Monaco editors over WebSocket. The plugin
//! registry is the single source of truth for what languages are
//! supported and how their servers are launched.

pub mod host;
pub mod plugins;
pub mod types;

pub use host::{LspHost, LspHostError, SessionKey, WorkspaceKey};
pub use types::{
    InstallStatus, InstallationKind, LspPlugin, OnDemandSource, PluginSource, RuntimeConfig,
};
