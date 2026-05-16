//! LSP (Language Server Protocol) plugin host.

pub mod host;
pub mod install;
pub mod plugins;
pub mod routes;
pub mod scratch;
pub mod session;
pub mod test_cmd;
pub mod types;
pub mod wheel;

pub use host::{LspHost, LspHostError, PluginUpdateInput, SessionKey, UserPluginInput, WorkspaceKey};
pub use install::{current_platform_key, install_plugin, InstallError, InstallEvent, InstallPhase};
pub use routes::{http_router, router, ws_router, LspState};
pub use session::{
    InboundSender, LspMessage, LspSession, LspSessionError, OutboundReceiver,
};
pub use test_cmd::{test_lsp_command, TestCommandInput, TestCommandResult};
pub use types::{
    InstallStatus, InstallationKind, LspPlugin, OnDemandSource, PluginSource, RuntimeConfig,
};
