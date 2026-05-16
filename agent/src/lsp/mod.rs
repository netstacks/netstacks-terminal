//! LSP (Language Server Protocol) plugin host.

pub mod host;
pub mod plugins;
pub mod routes;
pub mod session;
pub mod types;

pub use host::{LspHost, LspHostError, SessionKey, WorkspaceKey};
pub use routes::{router, LspState};
pub use session::{
    InboundSender, LspMessage, LspSession, LspSessionError, OutboundReceiver,
};
pub use types::{
    InstallStatus, InstallationKind, LspPlugin, OnDemandSource, PluginSource, RuntimeConfig,
};
