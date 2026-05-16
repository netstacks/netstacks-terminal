//! Axum route handlers for the LSP plugin system.
//!
//! Mounted under `/lsp` in `main.rs::create_app` (done in P2T9). The
//! WebSocket route uses `?token=...` query auth like `ws.rs::terminal_ws`.
//! REST endpoints are protected by the existing auth_middleware at mount
//! time.

use crate::lsp::host::{LspHost, WorkspaceKey};
use crate::lsp::types::{InstallStatus, InstallationKind, LspPlugin};
use axum::extract::{
    ws::{Message, WebSocket, WebSocketUpgrade},
    Path, Query, State,
};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{delete, get, post, put};
use axum::Router;
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::broadcast::error::RecvError;
use uuid::Uuid;

/// Axum state for LSP routes.
#[derive(Clone)]
pub struct LspState {
    pub host: Arc<LspHost>,
    pub auth_token: String,
}

/// Public API: build the router for `/lsp/*`. Caller mounts at the right path.
pub fn router(state: LspState) -> Router {
    Router::new()
        .route("/plugins", get(list_plugins))
        .route("/plugins", post(create_plugin_stub))
        .route("/plugins/:id", put(update_plugin_stub))
        .route("/plugins/:id", delete(delete_plugin_stub))
        .route("/plugins/:id/install", post(install_plugin_stub))
        .route("/plugins/test", post(test_plugin_stub))
        .route("/:plugin_id", get(lsp_websocket))
        .with_state(state)
}

// ===== Plugin listing =====

#[derive(Serialize)]
struct PluginListItem {
    #[serde(flatten)]
    plugin: LspPlugin,
    #[serde(rename = "installStatus")]
    install_status: InstallStatus,
}

async fn list_plugins(State(state): State<LspState>) -> impl IntoResponse {
    match state.host.list_plugins().await {
        Ok(plugins) => {
            let items: Vec<PluginListItem> = plugins
                .into_iter()
                .map(|p| {
                    let install_status = compute_install_status(&p);
                    PluginListItem {
                        plugin: p,
                        install_status,
                    }
                })
                .collect();
            (StatusCode::OK, axum::Json(items)).into_response()
        }
        Err(e) => {
            tracing::warn!(error = %e, "list_plugins failed");
            (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response()
        }
    }
}

/// Compute install status for a plugin descriptor. Cheap stub for Phase 2:
/// SystemPath/Bundled = always Installed (we trust them).
/// OnDemandDownload = NotInstalled if the binary file is missing; Installed otherwise.
/// Phase 4 will replace this with a proper InstallRegistry check including
/// Installing/InstalledButUnusable states.
fn compute_install_status(plugin: &LspPlugin) -> InstallStatus {
    match &plugin.installation {
        InstallationKind::SystemPath { .. } | InstallationKind::Bundled { .. } => {
            InstallStatus::Installed
        }
        InstallationKind::OnDemandDownload { .. } => {
            // Phase 4 replaces this with actual on-disk presence check.
            InstallStatus::NotInstalled
        }
    }
}

// ===== CRUD stubs (Phase 5 implements) =====

async fn create_plugin_stub() -> impl IntoResponse {
    (StatusCode::NOT_IMPLEMENTED, "create custom plugin: Phase 5")
}

async fn update_plugin_stub(Path(_id): Path<String>) -> impl IntoResponse {
    (StatusCode::NOT_IMPLEMENTED, "update plugin: Phase 5")
}

async fn delete_plugin_stub(Path(_id): Path<String>) -> impl IntoResponse {
    (StatusCode::NOT_IMPLEMENTED, "delete plugin: Phase 5")
}

async fn install_plugin_stub(Path(_id): Path<String>) -> impl IntoResponse {
    (StatusCode::NOT_IMPLEMENTED, "install plugin: Phase 4")
}

async fn test_plugin_stub() -> impl IntoResponse {
    (StatusCode::NOT_IMPLEMENTED, "test plugin: Phase 5")
}

// ===== WebSocket: LSP JSON-RPC bridge =====

#[derive(Debug, Deserialize)]
struct WsQuery {
    /// Bearer token (same as the agent's auth_token).
    token: Option<String>,
    /// Workspace root (absolute path). When absent, use scratch mode.
    workspace: Option<String>,
    /// When `1`, force loose-file/scratch mode even if no workspace given.
    /// Phase 6 wires this up in earnest; for Phase 2 it's just an alternative
    /// to "no workspace param".
    scratch: Option<String>,
}

async fn lsp_websocket(
    ws: WebSocketUpgrade,
    State(state): State<LspState>,
    Path(plugin_id): Path<String>,
    Query(query): Query<WsQuery>,
) -> impl IntoResponse {
    // Auth: query token must match the agent's session token.
    let token_ok = query.token.as_deref() == Some(state.auth_token.as_str());
    if !token_ok {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }

    // Resolve workspace key
    let workspace_key = match (query.workspace.as_deref(), query.scratch.as_deref()) {
        (Some(path), _) => WorkspaceKey::Path(PathBuf::from(path)),
        (None, Some(_)) => WorkspaceKey::Scratch(Uuid::new_v4().to_string()),
        (None, None) => WorkspaceKey::Scratch(Uuid::new_v4().to_string()),
    };

    // Look up the session (spawn if needed)
    let session = match state.host.get_or_create_session(&plugin_id, workspace_key).await {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!(plugin_id, error = %e, "get_or_create_session failed");
            return (StatusCode::NOT_FOUND, e.to_string()).into_response();
        }
    };

    ws.on_upgrade(move |socket| async move {
        bridge_websocket_to_session(socket, session).await;
    })
    .into_response()
}

/// Once upgraded, fan out child stdout → WebSocket and WebSocket → child stdin.
async fn bridge_websocket_to_session(
    socket: WebSocket,
    session: Arc<crate::lsp::session::LspSession>,
) {
    let (mut ws_tx, mut ws_rx) = socket.split();
    let mut outbound = session.subscribe();
    let inbound = session.inbound_sender();

    // Task: drain LSP child stdout → WebSocket
    let outbound_task = tokio::spawn(async move {
        loop {
            match outbound.recv().await {
                Ok(body) => {
                    // Wrap the JSON body in a text WebSocket frame. The
                    // browser client (Phase 3) gets unframed JSON; LSP
                    // framing (Content-Length headers) only exists at the
                    // stdio boundary.
                    let text = match String::from_utf8(body) {
                        Ok(s) => s,
                        Err(_) => continue,
                    };
                    if ws_tx.send(Message::Text(text)).await.is_err() {
                        return;
                    }
                }
                Err(RecvError::Lagged(n)) => {
                    tracing::warn!("LSP broadcast lagged {} messages for this client", n);
                    continue;
                }
                Err(RecvError::Closed) => return,
            }
        }
    });

    // Task: drain WebSocket → LSP child stdin
    let inbound_task = tokio::spawn(async move {
        while let Some(msg) = ws_rx.next().await {
            match msg {
                Ok(Message::Text(text)) => {
                    if inbound.send(text.into_bytes()).await.is_err() {
                        return;
                    }
                }
                Ok(Message::Binary(bytes)) => {
                    if inbound.send(bytes.to_vec()).await.is_err() {
                        return;
                    }
                }
                Ok(Message::Close(_)) | Err(_) => return,
                _ => {}
            }
        }
    });

    // Wait for either side to finish, then drop the other.
    tokio::select! {
        _ = outbound_task => {},
        _ = inbound_task => {},
    }

    // Note: we deliberately do NOT shut down the session here. Other
    // WebSocket clients may still be attached, and even if not, P2T11
    // will add a grace-period teardown. For Phase 2, the session lives
    // until the agent shuts down or explicit teardown is requested.
    let _ = Duration::from_secs(0); // no-op; reserved for grace-period logic in P2T11
}
