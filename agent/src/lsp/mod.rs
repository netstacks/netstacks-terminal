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

pub use host::LspHost;
// `router` is unused by the bin target but consumed by tests/lsp_integration.rs;
// keep the re-export and silence the bin-target warning.
#[allow(unused_imports)]
pub use routes::{http_router, router, ws_router, LspState};
