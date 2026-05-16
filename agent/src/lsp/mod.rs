//! LSP (Language Server Protocol) plugin host.

pub mod host;
pub mod install;
pub mod plugins;
pub mod routes;
pub mod session;
pub mod types;
pub mod wheel;

pub use host::{LspHost, LspHostError, SessionKey, WorkspaceKey};
pub use install::{current_platform_key, install_plugin, InstallError, InstallEvent, InstallPhase};
pub use routes::{http_router, router, ws_router, LspState};
pub use session::{
    InboundSender, LspMessage, LspSession, LspSessionError, OutboundReceiver,
};
pub use types::{
    InstallStatus, InstallationKind, LspPlugin, OnDemandSource, PluginSource, RuntimeConfig,
};
