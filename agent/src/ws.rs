use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    response::IntoResponse,
};
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::mpsc;

use crate::api::AppState;
use crate::models::{AuthType, PortForward};
use crate::terminal::{TerminalManager, TerminalMessage};

/// Combined state for WebSocket handlers
#[derive(Clone)]
pub struct WsState {
    pub terminal_manager: Arc<TerminalManager>,
    pub app_state: Arc<AppState>,
}

/// Query parameters for WebSocket connections
#[derive(Debug, Deserialize)]
pub struct WsQuery {
    #[serde(default)]
    pub r#type: ConnectionType,
    pub session_id: Option<String>,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub username: Option<String>,
    pub password: Option<String>,
    pub key_path: Option<String>,
    pub token: Option<String>,
    /// Initial terminal columns (from xterm.js FitAddon)
    #[serde(default)]
    pub cols: u32,
    /// Initial terminal rows (from xterm.js FitAddon)
    #[serde(default)]
    pub rows: u32,
}

/// Connection type for WebSocket
#[derive(Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionType {
    #[default]
    Local,
    Ssh,
    Telnet,
}

/// Messages from client to server
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum _ClientMessage {
    Input { data: String },
    Resize { cols: u32, rows: u32 },
}

/// Messages from server to client
#[derive(Debug, Serialize)]
#[serde(tag = "type")]
pub enum ServerMessage {
    _Output { data: String },
    Connected { session_id: Option<String> },
    _Disconnected { reason: String },
    Error { data: String },
}

/// WebSocket handler for terminal connections
///
/// Validates auth token from query parameter before upgrading.
/// Rejects with 401 if token is missing or invalid.
pub async fn terminal_ws(
    ws: WebSocketUpgrade,
    State(state): State<WsState>,
    Query(query): Query<WsQuery>,
) -> impl IntoResponse {
    // Validate auth token from query parameter
    match &query.token {
        Some(token) if token == &state.app_state.auth_token => {}
        _ => {
            return (
                axum::http::StatusCode::UNAUTHORIZED,
                "unauthorized",
            )
                .into_response();
        }
    }

    ws.on_upgrade(move |socket| async move {
        let initial_cols = query.cols;
        let initial_rows = query.rows;
        match query.r#type {
            ConnectionType::Local => handle_local_terminal(socket, state.terminal_manager, initial_cols, initial_rows).await,
            ConnectionType::Ssh => handle_ssh_terminal(socket, query, state.terminal_manager, state.app_state).await,
            ConnectionType::Telnet => handle_telnet_terminal(socket, query, state.terminal_manager, state.app_state).await,
        }
    })
    .into_response()
}

/// Handle local terminal connections (PTY)
async fn handle_local_terminal(socket: WebSocket, manager: Arc<TerminalManager>, initial_cols: u32, initial_rows: u32) {
    let (ws_tx, ws_rx) = socket.split();

    // Create channel for PTY output
    let (pty_tx, pty_rx) = mpsc::unbounded_channel::<TerminalMessage>();

    // Create a new local terminal session with initial dimensions from frontend
    let session_id = match manager.create_local_session(pty_tx, initial_cols, initial_rows).await {
        Ok(id) => id,
        Err(e) => {
            tracing::error!("Failed to create terminal session: {}", e);
            let mut ws_tx = ws_tx;
            let _ = ws_tx
                .send(Message::Text(
                    serde_json::to_string(&TerminalMessage::Error(e.to_string())).unwrap().into(),
                ))
                .await;
            return;
        }
    };

    tracing::info!("Created terminal session: {}", session_id);

    run_terminal_session(ws_tx, ws_rx, pty_rx, &session_id, &manager, "Terminal").await;
}

/// Handle SSH terminal connections using PTY-based ssh command
async fn handle_ssh_terminal(socket: WebSocket, query: WsQuery, manager: Arc<TerminalManager>, app_state: Arc<AppState>) {
    let (mut ws_tx, ws_rx) = socket.split();

    // Get SSH credentials from vault if session_id provided
    let ssh_params = match get_ssh_params_with_vault(&query, &app_state).await {
        Ok(params) => params,
        Err(e) => {
            let msg = ServerMessage::Error { data: e };
            let _ = ws_tx
                .send(Message::Text(serde_json::to_string(&msg).unwrap().into()))
                .await;
            return;
        }
    };

    let host_for_log = ssh_params.host.clone();

    // Create channel for PTY output
    let (pty_tx, pty_rx) = mpsc::unbounded_channel::<TerminalMessage>();

    // Clone port forwards before passing to create_ssh_session (which moves them)
    let session_port_forwards = ssh_params.port_forwards.clone();

    // Create SSH session with initial dimensions from frontend
    let session_id = match manager.create_ssh_session(
        pty_tx,
        &ssh_params.host,
        ssh_params.port,
        &ssh_params.username,
        ssh_params.password.as_deref(),
        ssh_params.key_path.as_deref(),
        ssh_params.key_passphrase.as_deref(),
        ssh_params.jump_host.as_deref(),
        ssh_params.jump_port,
        ssh_params.jump_username.as_deref(),
        ssh_params.jump_password.as_deref(),
        ssh_params.jump_key_path.as_deref(),
        ssh_params.jump_key_passphrase.as_deref(),
        ssh_params.jump_legacy_ssh,
        ssh_params.port_forwards,
        ssh_params.legacy_ssh,
        query.cols,
        query.rows,
    ).await {
        Ok(id) => id,
        Err(e) => {
            tracing::error!("Failed to create SSH session: {}", e);
            let msg = ServerMessage::Error {
                data: format!("SSH connection failed: {}", e),
            };
            let _ = ws_tx
                .send(Message::Text(serde_json::to_string(&msg).unwrap().into()))
                .await;
            return;
        }
    };

    tracing::info!("Created SSH session {} to {}", session_id, host_for_log);

    // Start session port forwards via TunnelManager
    if !session_port_forwards.is_empty() {
        let enabled_forwards: Vec<_> = session_port_forwards.iter()
            .filter(|f| f.enabled)
            .collect();
        if !enabled_forwards.is_empty() {
            tracing::info!("Starting {} session tunnel(s) for {}", enabled_forwards.len(), host_for_log);
            for fwd in enabled_forwards {
                // Inherit the SSH session's resolved jump host so this
                // session-attached tunnel travels the same path (and shares
                // the pooled SSH connection where possible).
                let tunnel = crate::models::Tunnel {
                    id: format!("session:{}:{}", session_id, fwd.id),
                    name: format!("Session forward :{}", fwd.local_port),
                    host: ssh_params.host.clone(),
                    port: ssh_params.port,
                    profile_id: ssh_params.profile_id.clone(),
                    jump_host_id: ssh_params.jump_host_id_effective.clone(),
                    forward_type: fwd.forward_type.clone(),
                    local_port: fwd.local_port,
                    bind_address: fwd.bind_address.clone().unwrap_or_else(|| "127.0.0.1".to_string()),
                    remote_host: fwd.remote_host.clone(),
                    remote_port: fwd.remote_port,
                    auto_start: false,
                    auto_reconnect: false,
                    max_retries: 0,
                    enabled: true,
                    created_at: String::new(),
                    updated_at: String::new(),
                };
                if let Err(e) = app_state.tunnel_manager.start_tunnel(&tunnel).await {
                    tracing::warn!("Failed to start session tunnel :{}: {}", fwd.local_port, e);
                }
            }
        }
    }

    // Send connected message
    let connected_msg = ServerMessage::Connected {
        session_id: query.session_id.clone(),
    };
    if ws_tx
        .send(Message::Text(serde_json::to_string(&connected_msg).unwrap().into()))
        .await
        .is_err()
    {
        return;
    }

    let log_label = format!("SSH session to {}", host_for_log);

    // Execute auto commands if configured (Phase: auto commands on connect)
    // We need to wait for the shell to be ready before sending commands
    if !ssh_params.auto_commands.is_empty() {
        run_terminal_session_with_auto_commands(
            ws_tx, ws_rx, pty_rx, &session_id, &manager, &log_label,
            ssh_params.auto_commands,
        ).await;
    } else {
        run_terminal_session(ws_tx, ws_rx, pty_rx, &session_id, &manager, &log_label).await;
    }

    // Stop session tunnels on disconnect
    let session_prefix = format!("session:{}:", session_id);
    let active_states = app_state.tunnel_manager.get_all_states().await;
    for state in active_states {
        if state.id.starts_with(&session_prefix) {
            let _ = app_state.tunnel_manager.stop_tunnel(&state.id).await;
        }
    }
}

/// Shared terminal session message loop.
/// Handles forwarding PTY output to WebSocket and processing incoming messages.
async fn run_terminal_session<S>(
    ws_tx: futures::stream::SplitSink<WebSocket, Message>,
    mut ws_rx: S,
    mut pty_rx: mpsc::UnboundedReceiver<TerminalMessage>,
    session_id: &str,
    manager: &Arc<TerminalManager>,
    log_label: &str,
)
where
    S: futures::Stream<Item = Result<Message, axum::Error>> + Unpin,
{
    let session_id_for_output = session_id.to_string();
    let session_id_owned = session_id.to_string();
    let log_label_owned = log_label.to_string();
    let manager_for_cleanup = manager.clone();
    let manager_for_input = manager.clone();

    // Task to forward PTY output to WebSocket
    let output_task = tokio::spawn(async move {
        let mut ws_tx = ws_tx;
        while let Some(msg) = pty_rx.recv().await {
            let json = match serde_json::to_string(&msg) {
                Ok(j) => j,
                Err(e) => {
                    tracing::error!("Failed to serialize message: {}", e);
                    continue;
                }
            };

            if ws_tx.send(Message::Text(json.into())).await.is_err() {
                tracing::info!("WebSocket closed for {}", session_id_for_output);
                break;
            }
        }
    });

    // Handle incoming WebSocket messages
    while let Some(Ok(msg)) = ws_rx.next().await {
        match msg {
            Message::Text(text) => {
                let terminal_msg: TerminalMessage = match serde_json::from_str(&text) {
                    Ok(m) => m,
                    Err(e) => {
                        tracing::warn!("Invalid message: {}", e);
                        continue;
                    }
                };

                match terminal_msg {
                    TerminalMessage::Input(data) => {
                        if let Some(session) = manager_for_input.get_session(&session_id_owned).await {
                            if let Err(e) = session.write(&data).await {
                                tracing::error!("Failed to write to PTY: {}", e);
                            }
                        }
                    }
                    TerminalMessage::Resize { cols, rows } => {
                        if let Some(session) = manager_for_input.get_session(&session_id_owned).await {
                            if let Err(e) = session.resize(cols as u32, rows as u32).await {
                                tracing::warn!("Failed to resize PTY: {}", e);
                            } else {
                                tracing::trace!("Resized PTY to {}x{}", cols, rows);
                            }
                        }
                    }
                    TerminalMessage::Close => {
                        break;
                    }
                    _ => {}
                }
            }
            Message::Binary(_) | Message::Close(_) => {
                break;
            }
            _ => {}
        }
    }

    // Cleanup
    output_task.abort();
    manager_for_cleanup.remove_session(&session_id_owned).await;
    tracing::info!("{} {} closed", log_label_owned, session_id_owned);
}

/// Terminal session with auto commands execution.
/// Waits for shell prompt before sending configured commands.
async fn run_terminal_session_with_auto_commands<S>(
    ws_tx: futures::stream::SplitSink<WebSocket, Message>,
    mut ws_rx: S,
    mut pty_rx: mpsc::UnboundedReceiver<TerminalMessage>,
    session_id: &str,
    manager: &Arc<TerminalManager>,
    log_label: &str,
    auto_commands: Vec<String>,
)
where
    S: futures::Stream<Item = Result<Message, axum::Error>> + Unpin,
{
    let session_id_for_output = session_id.to_string();
    let session_id_owned = session_id.to_string();
    let log_label_owned = log_label.to_string();
    let manager_for_cleanup = manager.clone();
    let manager_for_input = manager.clone();
    let manager_for_auto = manager.clone();
    let session_id_for_auto = session_id.to_string();

    // Channel to signal when auto commands are done
    let (auto_done_tx, _auto_done_rx) = tokio::sync::oneshot::channel::<()>();

    // Task to forward PTY output to WebSocket and detect prompt for auto commands
    let output_task = tokio::spawn(async move {
        let mut ws_tx = ws_tx;
        let mut output_buffer = String::new();
        let mut auto_commands_sent = false;
        let mut auto_done_tx = Some(auto_done_tx);
        let commands_to_send = auto_commands;
        let mut current_command_idx = 0;

        while let Some(msg) = pty_rx.recv().await {
            // Forward to WebSocket
            let json = match serde_json::to_string(&msg) {
                Ok(j) => j,
                Err(e) => {
                    tracing::error!("Failed to serialize message: {}", e);
                    continue;
                }
            };

            if ws_tx.send(Message::Text(json.into())).await.is_err() {
                tracing::info!("WebSocket closed for {}", session_id_for_output);
                break;
            }

            // Check for prompt if we haven't sent all auto commands yet
            if current_command_idx < commands_to_send.len() {
                if let TerminalMessage::Output(data) = &msg {
                    output_buffer.push_str(data);

                    // Check if output ends with a prompt character
                    // Common prompts: hostname>, hostname#, user$, user%, Password:
                    let trimmed = output_buffer.trim_end();
                    let looks_like_prompt = trimmed.ends_with('>')
                        || trimmed.ends_with('#')
                        || trimmed.ends_with('$')
                        || trimmed.ends_with('%')
                        || trimmed.ends_with(':');

                    if looks_like_prompt {
                        // Send the next auto command
                        if let Some(session) = manager_for_auto.get_session(&session_id_for_auto).await {
                            let cmd = &commands_to_send[current_command_idx];
                            tracing::debug!("Executing auto command {}: {}", current_command_idx + 1, cmd);
                            if let Err(e) = session.write(&format!("{}\n", cmd)).await {
                                tracing::warn!("Failed to execute auto command '{}': {}", cmd, e);
                            }
                            current_command_idx += 1;
                            output_buffer.clear();
                        }
                    }
                }
            } else if !auto_commands_sent {
                // All commands sent, signal completion
                auto_commands_sent = true;
                if let Some(tx) = auto_done_tx.take() {
                    let _ = tx.send(());
                }
            }
        }
    });

    // Handle incoming WebSocket messages
    while let Some(Ok(msg)) = ws_rx.next().await {
        match msg {
            Message::Text(text) => {
                let terminal_msg: TerminalMessage = match serde_json::from_str(&text) {
                    Ok(m) => m,
                    Err(e) => {
                        tracing::warn!("Invalid message: {}", e);
                        continue;
                    }
                };

                match terminal_msg {
                    TerminalMessage::Input(data) => {
                        if let Some(session) = manager_for_input.get_session(&session_id_owned).await {
                            if let Err(e) = session.write(&data).await {
                                tracing::error!("Failed to write to PTY: {}", e);
                            }
                        }
                    }
                    TerminalMessage::Resize { cols, rows } => {
                        if let Some(session) = manager_for_input.get_session(&session_id_owned).await {
                            if let Err(e) = session.resize(cols as u32, rows as u32).await {
                                tracing::warn!("Failed to resize PTY: {}", e);
                            } else {
                                tracing::trace!("Resized PTY to {}x{}", cols, rows);
                            }
                        }
                    }
                    TerminalMessage::Close => {
                        break;
                    }
                    _ => {}
                }
            }
            Message::Binary(_) | Message::Close(_) => {
                break;
            }
            _ => {}
        }
    }

    // Cleanup
    output_task.abort();
    manager_for_cleanup.remove_session(&session_id_owned).await;
    tracing::info!("{} {} closed", log_label_owned, session_id_owned);
}

/// SSH parameters for PTY-based connection
struct SshParams {
    host: String,
    port: u16,
    username: String,
    password: Option<String>,
    key_path: Option<String>,
    key_passphrase: Option<String>,
    // Effective jump host (session override or profile default).
    jump_host_id_effective: Option<String>,
    jump_host: Option<String>,
    jump_port: Option<u16>,
    jump_username: Option<String>,
    jump_password: Option<String>,
    jump_key_path: Option<String>,
    jump_key_passphrase: Option<String>,
    jump_legacy_ssh: bool,
    // Port forwarding (Phase 06.3)
    port_forwards: Vec<PortForward>,
    // Profile ID for tunnel credential lookup
    profile_id: String,
    // Auto commands on connect
    auto_commands: Vec<String>,
    // Legacy SSH support for older devices
    legacy_ssh: bool,
}

/// Get SSH parameters with vault credential lookup
///
/// If session_id is provided and no password/key is in query params,
/// tries to look up the session details and credentials from the vault.
/// Falls back to query params if vault lookup fails or params are provided.
async fn get_ssh_params_with_vault(query: &WsQuery, app_state: &Arc<AppState>) -> Result<SshParams, String> {
    // If session_id provided and no explicit credentials in query, try vault lookup
    if let Some(session_id) = &query.session_id {
        // Only do vault lookup if credentials not provided via query params
        if query.password.is_none() && query.key_path.is_none() {
            // Try to get session details from database
            match app_state.provider.get_session(session_id).await {
                Ok(session) => {
                    tracing::debug!("Found session {} in database", session_id);

                    // All sessions now require a profile for credentials
                    let profile_id = &session.profile_id;
                    tracing::debug!("Looking up profile for profile_id={}", profile_id);

                    // Get the profile
                    let profile = match app_state.provider.get_profile(profile_id).await {
                        Ok(p) => p,
                        Err(e) => {
                            return Err(format!("Failed to get profile: {}", e));
                        }
                    };

                    // Get profile credential from vault
                    let credential = match app_state.provider.get_profile_credential(profile_id).await {
                        Ok(Some(pc)) => {
                            tracing::debug!("Found profile credential, has_password={}", pc.password.is_some());
                            Some(pc)
                        }
                        Ok(None) => {
                            tracing::debug!("No profile credential found");
                            None
                        }
                        Err(crate::providers::ProviderError::VaultLocked) => {
                            return Err("Vault is locked. Go to Settings > Security to unlock.".to_string());
                        }
                        Err(e) => {
                            tracing::warn!("Failed to get profile credential: {}", e);
                            None
                        }
                    };

                    // Build params based on profile auth_type and credential
                    let (password, key_path, key_passphrase) = match profile.auth_type {
                        AuthType::Password => {
                            let password = credential
                                .as_ref()
                                .and_then(|c| c.password.clone())
                                .or_else(|| query.password.clone());

                            if password.is_none() {
                                return Err("No password stored. Edit profile to add password, then unlock vault in Settings > Security.".to_string());
                            }
                            (password, None, None)
                        }
                        AuthType::Key => {
                            let key_path = profile.key_path.clone()
                                .or_else(|| query.key_path.clone());

                            if key_path.is_none() {
                                return Err("No key path found in profile or query params".to_string());
                            }
                            let key_passphrase = credential
                                .as_ref()
                                .and_then(|c| c.key_passphrase.clone());
                            (None, key_path, key_passphrase)
                        }
                    };

                    let auto_commands = if session.auto_commands.is_empty() {
                        profile.auto_commands.clone()
                    } else {
                        session.auto_commands.clone()
                    };

                    // Resolve effective jump (session override > profile default).
                    let jump_resolution = resolve_effective_jump(
                        session.jump_host_id.as_deref(),
                        profile.jump_host_id.as_deref(),
                        &app_state.provider,
                    ).await?;

                    let (jump_host_id_effective, jump_host, jump_port, jump_username,
                         jump_password, jump_key_path, jump_key_passphrase, jump_legacy_ssh) =
                        if let Some(r) = jump_resolution {
                            let (jp_pw, jp_kpath, jp_kpass) = match r.jump_profile.auth_type {
                                AuthType::Password => (
                                    r.jump_credential.as_ref().and_then(|c| c.password.clone()),
                                    None, None,
                                ),
                                AuthType::Key => (
                                    None,
                                    r.jump_profile.key_path.clone(),
                                    r.jump_credential.as_ref().and_then(|c| c.key_passphrase.clone()),
                                ),
                            };
                            (
                                Some(r.jump_host.id.clone()),
                                Some(r.jump_host.host.clone()),
                                Some(r.jump_host.port),
                                Some(r.jump_profile.username.clone()),
                                jp_pw, jp_kpath, jp_kpass,
                                false, // jump_legacy_ssh — no profile field for it yet; can wire later
                            )
                        } else {
                            (None, None, None, None, None, None, None, false)
                        };

                    return Ok(SshParams {
                        host: session.host,
                        port: session.port,
                        username: profile.username.clone(),
                        password,
                        key_path,
                        key_passphrase,
                        jump_host_id_effective,
                        jump_host,
                        jump_port,
                        jump_username,
                        jump_password,
                        jump_key_path,
                        jump_key_passphrase,
                        jump_legacy_ssh,
                        port_forwards: session.port_forwards,
                        profile_id: session.profile_id,
                        auto_commands,
                        legacy_ssh: session.legacy_ssh,
                    });
                }
                Err(e) => {
                    // If a session_id was provided but not found, return error
                    // (don't fall through to query params - that would give confusing errors)
                    return Err(format!("Session '{}' not found: {}", session_id, e));
                }
            }
        }
    }

    // Fallback: build params from query params (for quick connect without saved session)
    // This only runs if session_id was NOT provided
    get_ssh_params(query)
}

/// Fully-resolved jump host context for one connection.
#[derive(Debug, Clone)]
pub struct JumpResolution {
    pub jump_host: crate::models::JumpHost,
    pub jump_profile: crate::models::CredentialProfile,
    pub jump_credential: Option<crate::models::ProfileCredential>,
}

/// Resolve the effective jump host for a connection.
/// Session-level `Some(id)` overrides profile-level. Returns Ok(None)
/// when neither is set (direct connection).
pub async fn resolve_effective_jump(
    session_jump_id: Option<&str>,
    profile_jump_id: Option<&str>,
    provider: &Arc<dyn crate::providers::DataProvider>,
) -> Result<Option<JumpResolution>, String> {
    let id = session_jump_id.or(profile_jump_id);
    let Some(id) = id else { return Ok(None); };

    let jump_host = provider.get_jump_host(id).await
        .map_err(|e| format!(
            "Jump host '{}' referenced by session/profile no longer exists. \
             Edit the session or profile to fix. (Underlying error: {})",
            id, e
        ))?;

    let jump_profile = provider.get_profile(&jump_host.profile_id).await
        .map_err(|e| format!(
            "Failed to load auth profile '{}' for jump host '{}': {}",
            jump_host.profile_id, jump_host.name, e
        ))?;

    let jump_credential = match provider.get_profile_credential(&jump_host.profile_id).await {
        Ok(opt) => opt,
        Err(crate::providers::ProviderError::VaultLocked) => {
            return Err(format!(
                "Vault is locked — cannot read credentials for jump host '{}'. \
                 Unlock in Settings > Security.",
                jump_host.name
            ));
        }
        Err(e) => return Err(format!(
            "Failed to read credentials for jump host '{}': {}",
            jump_host.name, e
        )),
    };

    Ok(Some(JumpResolution { jump_host, jump_profile, jump_credential }))
}

/// Get SSH parameters from query
fn get_ssh_params(query: &WsQuery) -> Result<SshParams, String> {
    let host = query
        .host
        .clone()
        .ok_or_else(|| "Missing required parameter: host".to_string())?;

    let username = query
        .username
        .clone()
        .ok_or_else(|| "Missing required parameter: username".to_string())?;

    let (password, key_path) = if query.password.is_some() {
        (query.password.clone(), None)
    } else if query.key_path.is_some() {
        (None, query.key_path.clone())
    } else {
        return Err("Missing required parameter: password or key_path".to_string());
    };

    Ok(SshParams {
        host,
        port: query.port.unwrap_or(22),
        username,
        password,
        key_path,
        key_passphrase: None,
        // Jump host / proxy not supported in quick connect (only stored sessions)
        jump_host_id_effective: None,
        jump_host: None,
        jump_port: None,
        jump_username: None,
        jump_password: None,
        jump_key_path: None,
        jump_key_passphrase: None,
        jump_legacy_ssh: false,
        // Port forwarding not supported in quick connect (only stored sessions)
        port_forwards: vec![],
        profile_id: String::new(),
        // Auto commands not supported in quick connect (only stored sessions)
        auto_commands: vec![],
        // Legacy SSH not supported in quick connect (only stored sessions)
        legacy_ssh: false,
    })
}

// === Telnet Terminal ===

/// Telnet connection parameters
struct TelnetParams {
    host: String,
    port: u16,
    username: Option<String>,
    password: Option<String>,
    auto_commands: Vec<String>,
}

/// Get Telnet parameters with vault credential lookup
async fn get_telnet_params_with_vault(
    query: &WsQuery,
    app_state: &Arc<AppState>,
) -> Result<TelnetParams, String> {
    if let Some(session_id) = &query.session_id {
        let provider = &app_state.provider;

        let session = provider
            .get_session(session_id)
            .await
            .map_err(|e| format!("Failed to get session: {}", e))?;

        let profile = provider
            .get_profile(&session.profile_id)
            .await
            .map_err(|e| format!("Failed to get profile: {}", e))?;

        let credential = match provider.get_profile_credential(&session.profile_id).await {
            Ok(Some(pc)) => Some(pc),
            Ok(None) => None,
            Err(crate::providers::ProviderError::VaultLocked) => {
                return Err("Vault is locked. Go to Settings > Security to unlock.".to_string());
            }
            Err(e) => {
                tracing::warn!("Failed to get profile credential: {}", e);
                None
            }
        };

        let password = credential.and_then(|c| c.password);

        let auto_commands = if session.auto_commands.is_empty() {
            profile.auto_commands.clone()
        } else {
            session.auto_commands.clone()
        };

        Ok(TelnetParams {
            host: session.host,
            port: session.port,
            username: Some(profile.username),
            password,
            auto_commands,
        })
    } else {
        Err("Telnet requires a session_id".to_string())
    }
}

/// Handle Telnet terminal connections
async fn handle_telnet_terminal(
    socket: WebSocket,
    query: WsQuery,
    manager: Arc<TerminalManager>,
    app_state: Arc<AppState>,
) {
    let (mut ws_tx, ws_rx) = socket.split();

    let telnet_params = match get_telnet_params_with_vault(&query, &app_state).await {
        Ok(params) => params,
        Err(e) => {
            let msg = ServerMessage::Error { data: format!("Failed to get Telnet params: {}", e) };
            let _ = ws_tx
                .send(Message::Text(serde_json::to_string(&msg).unwrap().into()))
                .await;
            return;
        }
    };

    let host_for_log = telnet_params.host.clone();

    let (pty_tx, pty_rx) = mpsc::unbounded_channel();

    let session_id = match manager
        .create_telnet_session(
            pty_tx,
            telnet_params.host.clone(),
            telnet_params.port,
            telnet_params.username,
            telnet_params.password,
        )
        .await
    {
        Ok(id) => id,
        Err(e) => {
            let msg = ServerMessage::Error {
                data: format!("Telnet connection failed: {}", e),
            };
            let _ = ws_tx
                .send(Message::Text(serde_json::to_string(&msg).unwrap().into()))
                .await;
            return;
        }
    };

    tracing::info!("Created Telnet session {} to {}", session_id, host_for_log);

    // Send connected message
    let connected_msg = ServerMessage::Connected {
        session_id: query.session_id.clone(),
    };
    if ws_tx
        .send(Message::Text(serde_json::to_string(&connected_msg).unwrap().into()))
        .await
        .is_err()
    {
        return;
    }

    let log_label = format!("Telnet session to {}", host_for_log);

    if !telnet_params.auto_commands.is_empty() {
        run_terminal_session_with_auto_commands(
            ws_tx, ws_rx, pty_rx, &session_id, &manager, &log_label,
            telnet_params.auto_commands,
        ).await;
    } else {
        run_terminal_session(ws_tx, ws_rx, pty_rx, &session_id, &manager, &log_label).await;
    }
}

// === Topology Live SNMP WebSocket ===

/// Query parameters for topology live WebSocket
#[derive(Debug, Deserialize)]
pub struct TopologyWsQuery {
    pub token: Option<String>,
}

/// Client → Server: subscribe to SNMP polling targets
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum TopologyClientMessage {
    Subscribe {
        targets: Vec<TopologyTarget>,
        #[serde(default = "default_interval")]
        #[serde(rename = "intervalSecs")]
        interval_secs: u64,
    },
    Unsubscribe,
}

fn default_interval() -> u64 {
    30
}

/// A single device target with interfaces to poll
#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TopologyTarget {
    host: String,
    profile_id: String,
    interfaces: Vec<String>,
}

/// Server → Client: stats update for a host
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TopologyStatsMessage {
    r#type: &'static str,
    host: String,
    timestamp: String,
    interfaces: Vec<TopologyInterfaceStats>,
}

/// Single interface stats in topology live response
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TopologyInterfaceStats {
    if_descr: String,
    if_alias: String,
    oper_status: u8,
    oper_status_text: String,
    speed_mbps: u64,
    in_octets: u64,
    out_octets: u64,
    in_errors: u64,
    out_errors: u64,
    in_discards: u64,
    out_discards: u64,
    hc_counters: bool,
}

/// Per-interface summary included in device_stats message
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceInterfaceInfo {
    if_descr: String,
    if_alias: String,
    oper_status: u8,
    admin_status: u8,
    speed_mbps: u64,
    in_octets: u64,
    out_octets: u64,
    in_errors: u64,
    out_errors: u64,
}

/// Server → Client: device-level stats (system info + interface summary + resources)
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TopologyDeviceStatsMessage {
    r#type: &'static str,
    host: String,
    timestamp: String,
    sys_uptime_seconds: Option<f64>,
    sys_descr: Option<String>,
    interface_summary: InterfaceSummary,
    cpu_percent: Option<f64>,
    memory_percent: Option<f64>,
    memory_used_mb: Option<f64>,
    memory_total_mb: Option<f64>,
    interfaces: Vec<DeviceInterfaceInfo>,
}

/// Aggregated interface summary for a device
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct InterfaceSummary {
    total: u32,
    up: u32,
    down: u32,
    admin_down: u32,
    total_in_errors: u64,
    total_out_errors: u64,
    total_in_discards: u64,
    total_out_discards: u64,
}

/// Server → Client: error for a specific host
#[derive(Debug, Serialize)]
struct TopologyErrorMessage {
    r#type: &'static str,
    host: String,
    error: String,
}

/// WebSocket handler for topology live SNMP polling
///
/// Validates auth token from query parameter before upgrading.
/// On subscribe, polls SNMP targets periodically and pushes stats.
pub async fn topology_live_ws(
    ws: WebSocketUpgrade,
    State(state): State<WsState>,
    Query(query): Query<TopologyWsQuery>,
) -> impl IntoResponse {
    // Validate auth token from query parameter (same pattern as terminal_ws)
    match &query.token {
        Some(token) if token == &state.app_state.auth_token => {}
        _ => {
            return (
                axum::http::StatusCode::UNAUTHORIZED,
                "unauthorized",
            )
                .into_response();
        }
    }

    ws.on_upgrade(move |socket| handle_topology_live(socket, state.app_state))
        .into_response()
}

/// Handle topology live WebSocket connection
async fn handle_topology_live(socket: WebSocket, app_state: Arc<AppState>) {
    let (mut ws_tx, mut ws_rx) = socket.split();
    let (msg_tx, mut msg_rx) = mpsc::unbounded_channel::<String>();

    // Track the current polling task so we can cancel it
    let mut poll_handle: Option<tokio::task::JoinHandle<()>> = None;

    // Task to forward outgoing messages to WebSocket
    let output_task = tokio::spawn(async move {
        while let Some(msg) = msg_rx.recv().await {
            if ws_tx.send(Message::Text(msg.into())).await.is_err() {
                break;
            }
        }
    });

    // Handle incoming WebSocket messages
    while let Some(Ok(msg)) = ws_rx.next().await {
        match msg {
            Message::Text(text) => {
                let client_msg: TopologyClientMessage = match serde_json::from_str(&text) {
                    Ok(m) => m,
                    Err(e) => {
                        tracing::warn!("Invalid topology-live message: {}", e);
                        let err = TopologyErrorMessage {
                            r#type: "error",
                            host: String::new(),
                            error: format!("Invalid message: {}", e),
                        };
                        let _ = msg_tx.send(serde_json::to_string(&err).unwrap());
                        continue;
                    }
                };

                match client_msg {
                    TopologyClientMessage::Subscribe { targets, interval_secs } => {
                        // Cancel existing polling task
                        if let Some(handle) = poll_handle.take() {
                            handle.abort();
                        }

                        // Clamp interval: minimum 10, maximum 300
                        let interval = interval_secs.max(10).min(300);

                        let msg_tx = msg_tx.clone();
                        let app_state = app_state.clone();

                        // Spawn polling task
                        poll_handle = Some(tokio::spawn(async move {
                            topology_poll_loop(targets, interval, msg_tx, app_state).await;
                        }));
                    }
                    TopologyClientMessage::Unsubscribe => {
                        if let Some(handle) = poll_handle.take() {
                            handle.abort();
                        }
                        tracing::debug!("Topology-live: unsubscribed");
                    }
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    // Cleanup
    if let Some(handle) = poll_handle.take() {
        handle.abort();
    }
    output_task.abort();
    tracing::info!("Topology-live WebSocket closed");
}

/// Polling loop: periodically polls all targets and sends stats.
/// Exits when the WebSocket receiver is dropped (msg_tx sends fail).
async fn topology_poll_loop(
    targets: Vec<TopologyTarget>,
    interval_secs: u64,
    msg_tx: mpsc::UnboundedSender<String>,
    app_state: Arc<AppState>,
) {
    let interval = tokio::time::Duration::from_secs(interval_secs);

    loop {
        // Poll all targets in parallel; each task returns whether the channel is still open
        let mut tasks = Vec::new();
        for target in &targets {
            let target = target.clone();
            let app_state = app_state.clone();
            let msg_tx = msg_tx.clone();

            tasks.push(tokio::spawn(async move {
                poll_single_target(&target, &app_state, &msg_tx).await
            }));
        }

        // Wait for all polls to complete and check if channel is still open
        let mut channel_open = true;
        for task in tasks {
            match task.await {
                Ok(false) => channel_open = false,
                Err(_) => {} // task panicked, continue
                _ => {}
            }
        }

        if !channel_open {
            tracing::debug!("Topology WebSocket closed, stopping poll loop");
            break;
        }

        // Sleep until next poll interval
        tokio::time::sleep(interval).await;
    }
}

/// Poll a single target device and send results or errors.
/// Returns `true` if the channel is still open, `false` if the WebSocket receiver has been dropped.
async fn poll_single_target(
    target: &TopologyTarget,
    app_state: &Arc<AppState>,
    msg_tx: &mpsc::UnboundedSender<String>,
) -> bool {
    let host = &target.host;
    let port: u16 = 161;

    // Resolve SNMP communities from profile vault
    let communities = match resolve_snmp_communities(&target.profile_id, app_state).await {
        Ok(c) => c,
        Err(e) => {
            let err = TopologyErrorMessage {
                r#type: "error",
                host: host.clone(),
                error: e,
            };
            if msg_tx.send(serde_json::to_string(&err).unwrap()).is_err() {
                return false;
            }
            return true;
        }
    };

    // Try each community with snmp_bulk_interface_stats (same try-communities pattern)
    let mut last_error: Option<String> = None;
    for community in &communities {
        match crate::snmp::snmp_bulk_interface_stats(host, port, community, &target.interfaces).await {
            Ok(stats) => {
                let timestamp = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);

                // Compute interface summary from already-fetched stats (zero extra SNMP calls)
                let mut summary = InterfaceSummary {
                    total: stats.len() as u32,
                    up: 0,
                    down: 0,
                    admin_down: 0,
                    total_in_errors: 0,
                    total_out_errors: 0,
                    total_in_discards: 0,
                    total_out_discards: 0,
                };
                for s in &stats {
                    match s.oper_status {
                        1 => summary.up += 1,
                        2 => {
                            if s.admin_status == 2 {
                                summary.admin_down += 1;
                            } else {
                                summary.down += 1;
                            }
                        }
                        _ => {}
                    }
                    summary.total_in_errors += s.in_errors;
                    summary.total_out_errors += s.out_errors;
                    summary.total_in_discards += s.in_discards;
                    summary.total_out_discards += s.out_discards;
                }

                // Build per-interface info array BEFORE consuming stats with into_iter
                let iface_infos: Vec<DeviceInterfaceInfo> = stats
                    .iter()
                    .map(|s| DeviceInterfaceInfo {
                        if_descr: s.if_descr.clone(),
                        if_alias: s.if_alias.clone(),
                        oper_status: s.oper_status,
                        admin_status: s.admin_status,
                        speed_mbps: s.speed_mbps,
                        in_octets: s.in_octets,
                        out_octets: s.out_octets,
                        in_errors: s.in_errors,
                        out_errors: s.out_errors,
                    })
                    .collect();

                let interfaces: Vec<TopologyInterfaceStats> = stats
                    .into_iter()
                    .map(|s| {
                        let oper_status_text = match s.oper_status {
                            1 => "up".to_string(),
                            2 => "down".to_string(),
                            3 => "testing".to_string(),
                            n => format!("unknown({})", n),
                        };
                        TopologyInterfaceStats {
                            if_descr: s.if_descr,
                            if_alias: s.if_alias,
                            oper_status: s.oper_status,
                            oper_status_text,
                            speed_mbps: s.speed_mbps,
                            in_octets: s.in_octets,
                            out_octets: s.out_octets,
                            in_errors: s.in_errors,
                            out_errors: s.out_errors,
                            in_discards: s.in_discards,
                            out_discards: s.out_discards,
                            hc_counters: s.hc_counters,
                        }
                    })
                    .collect();

                // Send interface stats message (existing behavior)
                let msg = TopologyStatsMessage {
                    r#type: "stats",
                    host: host.clone(),
                    timestamp: timestamp.clone(),
                    interfaces,
                };
                if msg_tx.send(serde_json::to_string(&msg).unwrap()).is_err() {
                    return false;
                }

                // Fetch device system info (one extra UDP round-trip for sysUpTime + sysDescr)
                let (sys_uptime_seconds, sys_descr) =
                    match crate::snmp::snmp_device_system_info(host, port, community).await {
                        Ok(info) => (
                            info.sys_uptime_hundredths.map(|h| h as f64 / 100.0),
                            info.sys_descr,
                        ),
                        Err(e) => {
                            tracing::debug!("Failed to get system info for {}: {}", host, e);
                            (None, None)
                        }
                    };

                // Fetch CPU/memory resources (1-2 extra UDP round-trips)
                let (cpu_percent, memory_percent, memory_used_mb, memory_total_mb) =
                    match crate::snmp::snmp_device_resources(host, port, community).await {
                        Ok(res) => {
                            let mem_pct = match (res.memory_used_bytes, res.memory_free_bytes) {
                                (Some(used), Some(free)) if used + free > 0 => {
                                    Some((used as f64 / (used + free) as f64) * 100.0)
                                }
                                _ => None,
                            };
                            let mem_used_mb = res.memory_used_bytes.map(|b| b as f64 / (1024.0 * 1024.0));
                            let mem_total_mb = match (res.memory_used_bytes, res.memory_free_bytes) {
                                (Some(used), Some(free)) => Some((used + free) as f64 / (1024.0 * 1024.0)),
                                _ => None,
                            };
                            (res.cpu_percent, mem_pct, mem_used_mb, mem_total_mb)
                        }
                        Err(e) => {
                            tracing::debug!("Failed to get resource info for {}: {}", host, e);
                            (None, None, None, None)
                        }
                    };

                // Send device stats message
                let device_msg = TopologyDeviceStatsMessage {
                    r#type: "device_stats",
                    host: host.clone(),
                    timestamp,
                    sys_uptime_seconds,
                    sys_descr,
                    interface_summary: summary,
                    cpu_percent,
                    memory_percent,
                    memory_used_mb,
                    memory_total_mb,
                    interfaces: iface_infos,
                };
                return msg_tx.send(serde_json::to_string(&device_msg).unwrap()).is_ok();
            }
            Err(crate::snmp::SnmpError::Timeout(_)) => {
                last_error = Some("SNMP timeout after 5s".to_string());
                continue;
            }
            Err(crate::snmp::SnmpError::AuthError) => {
                last_error = Some("SNMP authentication failed".to_string());
                continue;
            }
            Err(e) => {
                // Non-auth/timeout error: report immediately
                let err = TopologyErrorMessage {
                    r#type: "error",
                    host: host.clone(),
                    error: e.to_string(),
                };
                return msg_tx.send(serde_json::to_string(&err).unwrap()).is_ok();
            }
        }
    }

    // No community worked
    let err = TopologyErrorMessage {
        r#type: "error",
        host: host.clone(),
        error: last_error.unwrap_or_else(|| "No SNMP community succeeded".to_string()),
    };
    msg_tx.send(serde_json::to_string(&err).unwrap()).is_ok()
}

/// Resolve SNMP communities from a profile ID via the vault.
/// Falls back to scanning all profiles if the requested profile has no SNMP communities
/// (same pattern as the HTTP API's snmp_try_interface_stats).
async fn resolve_snmp_communities(
    profile_id: &str,
    app_state: &Arc<AppState>,
) -> Result<Vec<String>, String> {
    let mut communities: Vec<String> = Vec::new();

    // Level 1: Try the requested profile
    match app_state.provider.get_profile_credential(profile_id).await {
        Ok(Some(cred)) => {
            if let Some(ref comms) = cred.snmp_communities {
                if !comms.is_empty() {
                    communities = comms.clone();
                    tracing::debug!("Using SNMP communities from requested profile {}", profile_id);
                }
            }
        }
        Ok(None) => {
            tracing::debug!("No credential found for profile {}", profile_id);
        }
        Err(crate::providers::ProviderError::VaultLocked) => {
            return Err("Vault is locked. Unlock in Settings > Security.".to_string());
        }
        Err(e) => {
            tracing::warn!("Failed to get profile credential for {}: {}", profile_id, e);
        }
    }

    // Level 2: Scan all profiles for one with SNMP communities
    if communities.is_empty() {
        tracing::debug!("Profile {} has no SNMP communities, scanning all profiles", profile_id);
        if let Ok(all_profiles) = app_state.provider.list_profiles().await {
            for profile in &all_profiles {
                if profile.id == profile_id {
                    continue; // Already tried
                }
                if let Ok(Some(cred)) = app_state.provider.get_profile_credential(&profile.id).await {
                    if let Some(ref comms) = cred.snmp_communities {
                        if !comms.is_empty() {
                            communities = comms.clone();
                            tracing::info!(
                                "Found SNMP communities in profile {} ({})",
                                profile.name, profile.id
                            );
                            break;
                        }
                    }
                }
            }
        }
    }

    if communities.is_empty() {
        return Err("No SNMP communities found in any profile".to_string());
    }

    Ok(communities)
}

// === Task Progress WebSocket ===

/// Query parameters for task progress WebSocket
#[derive(Debug, Deserialize)]
pub struct TaskProgressWsQuery {
    pub token: Option<String>,
}

/// WebSocket handler for task progress streaming
///
/// Validates auth token from query parameter before upgrading.
/// Sends init message with current task list, then streams progress events.
pub async fn task_progress_ws(
    ws: WebSocketUpgrade,
    State(state): State<WsState>,
    Query(query): Query<TaskProgressWsQuery>,
) -> impl IntoResponse {
    // Validate auth token from query parameter
    match &query.token {
        Some(token) if token == &state.app_state.auth_token => {}
        _ => {
            return (
                axum::http::StatusCode::UNAUTHORIZED,
                "unauthorized",
            )
                .into_response();
        }
    }

    ws.on_upgrade(move |socket| handle_task_progress(socket, state.app_state))
        .into_response()
}

/// Handle task progress WebSocket connection
async fn handle_task_progress(socket: WebSocket, app_state: Arc<AppState>) {
    let (mut ws_tx, mut ws_rx) = socket.split();

    // Subscribe to progress events
    let mut progress_rx = app_state.progress_broadcaster.subscribe();

    // Send current task list on connect (so client has initial state)
    if let Ok(tasks) = app_state.task_store.list_tasks(None, 50, 0).await {
        let init_msg = serde_json::json!({
            "type": "init",
            "tasks": tasks,
            "running_count": app_state.task_registry.running_count().await,
            "max_concurrent": app_state.task_registry.max_concurrent(),
        });
        if let Ok(json) = serde_json::to_string(&init_msg) {
            let _ = ws_tx.send(Message::Text(json.into())).await;
        }
    }

    // Spawn task to forward progress events to WebSocket
    let forward_task = tokio::spawn(async move {
        loop {
            match progress_rx.recv().await {
                Ok(event) => {
                    if let Ok(json) = serde_json::to_string(&event) {
                        if ws_tx.send(Message::Text(json.into())).await.is_err() {
                            break;
                        }
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!("Task progress WebSocket lagged {} events", n);
                    continue;
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    break;
                }
            }
        }
    });

    // Handle incoming messages (client can send commands like cancel)
    while let Some(Ok(msg)) = ws_rx.next().await {
        match msg {
            Message::Text(text) => {
                // Parse client commands
                if let Ok(cmd) = serde_json::from_str::<TaskWsCommand>(&text) {
                    match cmd {
                        TaskWsCommand::Cancel { task_id } => {
                            if let Err(e) = app_state.task_executor.cancel_task(&task_id).await {
                                tracing::warn!("Failed to cancel task {}: {}", task_id, e);
                            }
                        }
                    }
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    forward_task.abort();
    tracing::debug!("Task progress WebSocket closed");
}

/// Commands from client to server via WebSocket
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum TaskWsCommand {
    Cancel { task_id: String },
}

#[cfg(test)]
mod resolve_effective_jump_tests {
    use super::*;
    use crate::models::{NewCredentialProfile, NewJumpHost, AuthType, CliFlavor};
    use crate::providers::local::LocalDataProvider;
    use std::sync::Arc;
    use tempfile::tempdir;

    async fn fresh_provider() -> Arc<dyn crate::providers::DataProvider> {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let pool = crate::db::init_db(&db_path).await.unwrap();
        std::mem::forget(dir);
        Arc::new(LocalDataProvider::new(pool))
    }

    fn np(name: &str, jump_host_id: Option<String>) -> NewCredentialProfile {
        NewCredentialProfile {
            name: name.into(),
            username: "u".into(),
            auth_type: AuthType::Password,
            key_path: None,
            port: 22,
            keepalive_interval: 30,
            connection_timeout: 10,
            terminal_theme: None,
            default_font_size: None,
            default_font_family: None,
            scrollback_lines: 1000,
            local_echo: false,
            auto_reconnect: false,
            reconnect_delay: 5,
            cli_flavor: CliFlavor::default(),
            auto_commands: vec![],
            jump_host_id,
        }
    }

    #[tokio::test]
    async fn session_jump_overrides_profile_jump() {
        let provider = fresh_provider().await;
        let session_jump_profile = provider.create_profile(np("session-jump-creds", None)).await.unwrap();
        let profile_jump_profile = provider.create_profile(np("profile-jump-creds", None)).await.unwrap();
        let session_jump = provider.create_jump_host(NewJumpHost {
            name: "session-jump".into(), host: "10.0.0.1".into(), port: 22,
            profile_id: session_jump_profile.id.clone(),
        }).await.unwrap();
        let profile_jump = provider.create_jump_host(NewJumpHost {
            name: "profile-jump".into(), host: "10.0.0.2".into(), port: 22,
            profile_id: profile_jump_profile.id.clone(),
        }).await.unwrap();

        let result = resolve_effective_jump(
            Some(&session_jump.id), Some(&profile_jump.id), &provider,
        ).await.unwrap();

        let r = result.expect("should resolve");
        assert_eq!(r.jump_host.id, session_jump.id, "session jump should win");
        assert_eq!(r.jump_profile.name, "session-jump-creds");
    }

    #[tokio::test]
    async fn falls_back_to_profile_jump_when_session_has_none() {
        let provider = fresh_provider().await;
        let backing = provider.create_profile(np("backing", None)).await.unwrap();
        let jh = provider.create_jump_host(NewJumpHost {
            name: "the-jump".into(), host: "10.0.0.1".into(), port: 22,
            profile_id: backing.id.clone(),
        }).await.unwrap();

        let result = resolve_effective_jump(None, Some(&jh.id), &provider).await.unwrap();
        let r = result.expect("should resolve from profile");
        assert_eq!(r.jump_host.id, jh.id);
    }

    #[tokio::test]
    async fn returns_none_when_neither_set() {
        let provider = fresh_provider().await;
        let result = resolve_effective_jump(None, None, &provider).await.unwrap();
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn missing_jump_host_returns_descriptive_error() {
        let provider = fresh_provider().await;
        let result = resolve_effective_jump(Some("does-not-exist"), None, &provider).await;
        let err = result.unwrap_err();
        assert!(err.contains("does-not-exist"), "msg should name the missing id: {err}");
        assert!(err.contains("no longer exists"), "msg should explain: {err}");
    }

    /// End-to-end smoke test for the full jump-host bug fix:
    /// - Profile-default jump host (no session-level override)
    /// - Real DB + real vault with stored credentials
    /// - resolve_effective_jump returns the right jump host AND its credential
    ///
    /// Pre-fix, the chain dropped the device password entirely AND never
    /// loaded the jump host's credential. This test exercises both halves.
    #[tokio::test]
    async fn end_to_end_profile_default_jump_with_vault_credentials() {
        let provider = fresh_provider().await;
        provider.set_master_password("test-password").await.unwrap();

        // Set up the jump-host side: profile + JumpHost + stored vault credential.
        let jump_profile = provider
            .create_profile(np("bastion-creds", None))
            .await
            .unwrap();
        provider
            .store_profile_credential(
                &jump_profile.id,
                crate::models::ProfileCredential {
                    password: Some("jump-secret".into()),
                    key_passphrase: None,
                    snmp_communities: None,
                },
            )
            .await
            .unwrap();
        let jh = provider
            .create_jump_host(crate::models::NewJumpHost {
                name: "edge-bastion".into(),
                host: "10.0.0.1".into(),
                port: 22,
                profile_id: jump_profile.id.clone(),
            })
            .await
            .unwrap();

        // Set up the target side: profile with profile-level jump_host_id set.
        let target_profile = provider
            .create_profile(np("corp-routers", Some(jh.id.clone())))
            .await
            .unwrap();
        provider
            .store_profile_credential(
                &target_profile.id,
                crate::models::ProfileCredential {
                    password: Some("device-secret".into()),
                    key_passphrase: None,
                    snmp_communities: None,
                },
            )
            .await
            .unwrap();

        // Resolve the effective jump for a session that has NO override
        // (so it should inherit from the target profile).
        let resolution = resolve_effective_jump(None, target_profile.jump_host_id.as_deref(), &provider)
            .await
            .unwrap()
            .expect("profile-default jump should resolve");

        // The resolved jump host matches what was configured on the profile.
        assert_eq!(resolution.jump_host.id, jh.id);
        assert_eq!(resolution.jump_host.name, "edge-bastion");
        assert_eq!(resolution.jump_profile.username, "u");

        // The bug fix: the jump credential is loaded from the vault and
        // matches what was stored on the jump's profile.
        let cred = resolution.jump_credential.expect("jump credential must be loaded");
        assert_eq!(
            cred.password.as_deref(),
            Some("jump-secret"),
            "jump host's own password must be loaded — pre-fix, this was never read"
        );
    }
}
