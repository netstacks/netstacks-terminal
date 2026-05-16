//! LSP (Language Server Protocol) plugin host.
//!
//! Generic plugin-shaped system for hosting language servers as stdio
//! children proxied to Monaco editors over WebSocket. The plugin
//! registry is the single source of truth for what languages are
//! supported and how their servers are launched.

pub mod types;

pub use types::{
    InstallStatus, InstallationKind, LspPlugin, PluginSource, RuntimeConfig,
};
