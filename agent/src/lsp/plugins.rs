//! Built-in plugin descriptors.
//!
//! Hard-coded list of LSP plugins that ship with the agent. v1 is empty —
//! Phase 4 adds the Pyrefly descriptor. Adding a new built-in plugin is
//! a one-line append to `BUILT_IN_PLUGINS` plus the matching frontend
//! descriptor in `frontend/src/lsp/plugins.ts`.

use crate::lsp::types::LspPlugin;

pub fn built_in_plugins() -> Vec<LspPlugin> {
    vec![
        // Phase 4 adds the Pyrefly descriptor here.
    ]
}
