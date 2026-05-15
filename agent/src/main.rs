//! NetStacks Agent - HTTP server for the NetStacks network operations platform
//!
//! Serves the React frontend and provides API endpoints.
//!
//! In Enterprise mode (when connected to a Controller), this agent is not needed
//! as the Terminal app connects directly to the Controller. The agent will detect
//! Enterprise mode configuration and exit gracefully.

use axum::{
    routing::{delete, get, post, put},
    Router,
};
use crate::tracked_router::TrackedRouter;
// Registry write only matters when the dev-routes endpoint is compiled in
// (debug builds, or when the `dev-routes` feature is enabled). In release
// builds without the feature, dev::routes_handler is excluded — there is
// no reader, so we don't populate the registry either.
#[cfg(any(debug_assertions, feature = "dev-routes"))]
use crate::tracked_router::set_global_routes;
use base64::Engine as _;
use hyper_util::rt::{TokioExecutor, TokioIo};
use sqlx::sqlite::SqlitePool;
use std::fs;
use std::net::SocketAddr;
use std::path::PathBuf;
use rand::Rng;
use std::sync::Arc;
use tokio_rustls::TlsAcceptor;
use tower_http::cors::CorsLayer;
use tower_http::services::ServeDir;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

mod ai;
mod api;
mod biometric;
mod cert_manager;
mod crypto;
mod db;
#[cfg(any(debug_assertions, feature = "dev-routes"))]
mod dev;
mod discovery;
mod docs;
mod integrations;
mod models;
mod providers;
mod quick_actions;
mod scripts;
mod sftp;
mod snmp;
mod ssh;
mod tasks;
mod telnet;
mod terminal;
mod tls;
mod tracked_router;
mod git;
mod git_api;
mod tunnels;
mod utf8_decoder;
mod ws;

use api::AppState;
use providers::LocalDataProvider;

/// Get the path to the Tauri app config file.
///
/// The config file is stored in the platform-specific app data directory
/// as managed by @tauri-apps/plugin-store. The app identifier must match
/// what's in tauri.conf.json.
fn get_config_path() -> PathBuf {
    let app_name = "com.netstacks.terminal";

    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").unwrap_or_default();
        PathBuf::from(format!(
            "{}/Library/Application Support/{}/app-config.json",
            home, app_name
        ))
    }

    #[cfg(target_os = "linux")]
    {
        let home = std::env::var("HOME").unwrap_or_default();
        PathBuf::from(format!("{}/.local/share/{}/app-config.json", home, app_name))
    }

    #[cfg(target_os = "windows")]
    {
        let app_data = std::env::var("APPDATA").unwrap_or_default();
        PathBuf::from(format!("{}\\{}\\app-config.json", app_data, app_name))
    }
}

/// Check if the app is configured in Enterprise mode.
///
/// Enterprise mode is detected by the presence of a non-null `controllerUrl`
/// in the app configuration file. When Enterprise mode is enabled, the Terminal
/// connects directly to the Controller and doesn't need this local agent.
fn check_enterprise_mode() -> bool {
    let config_path = get_config_path();

    if !config_path.exists() {
        return false;
    }

    // Read and parse config file
    match fs::read_to_string(&config_path) {
        Ok(content) => {
            // Simple check for controllerUrl in JSON
            // If controllerUrl is present and not null, we're in Enterprise mode
            // Format: "controllerUrl":"https://..." (not "controllerUrl":null)
            if content.contains("\"controllerUrl\"")
                && !content.contains("\"controllerUrl\":null")
                && !content.contains("\"controllerUrl\": null")
            {
                return true;
            }
            false
        }
        Err(_) => false,
    }
}

/// Single-instance enforcement: if `addr` is already bound, confirm the
/// listener is one of our agents (responds 2xx on `/api/health` over our
/// self-signed TLS) before evicting it. Foreign processes are left alone.
///
/// Sequence: SIGTERM → wait up to 2s for the port to free → escalate to
/// SIGKILL if it didn't. Returns once the port appears free, or logs a
/// warning if eviction couldn't complete (the subsequent bind() will then
/// surface the EADDRINUSE error to the user).
#[cfg(unix)]
async fn evict_existing_agent_if_present(addr: SocketAddr) {
    use std::time::Duration;

    if !port_in_use(addr) {
        return;
    }

    // Confirm it's our agent before signalling. We accept self-signed
    // because that's exactly what our agent serves.
    let client = match reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(2))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!("Could not build probe client: {}", e);
            return;
        }
    };
    let probe_url = format!("https://{}/api/health", addr);
    let is_ours = matches!(
        client.get(&probe_url).send().await,
        Ok(r) if r.status().is_success()
    );
    if !is_ours {
        tracing::warn!(
            "Port {} is held by a non-NetStacks process — refusing to evict. Bind will fail.",
            addr.port()
        );
        return;
    }

    let pids = pids_listening_on(addr.port());
    if pids.is_empty() {
        tracing::warn!("Could not identify holder of port {} via lsof", addr.port());
        return;
    }

    for pid in &pids {
        tracing::warn!("Evicting orphaned netstacks-agent PID {}", pid);
        unsafe { libc::kill(*pid, libc::SIGTERM); }
    }

    // Poll for up to 2s for the port to free.
    for _ in 0..20 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        if !port_in_use(addr) {
            tracing::info!("Port {} freed", addr.port());
            return;
        }
    }

    tracing::warn!("SIGTERM didn't free port {} — escalating to SIGKILL", addr.port());
    for pid in &pids {
        unsafe { libc::kill(*pid, libc::SIGKILL); }
    }
    tokio::time::sleep(Duration::from_millis(500)).await;
}

#[cfg(not(unix))]
async fn evict_existing_agent_if_present(_addr: SocketAddr) {
    // TODO: Windows eviction (TerminateProcess via OpenProcess).
}

#[cfg(unix)]
fn port_in_use(addr: SocketAddr) -> bool {
    std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(200)).is_ok()
}

#[cfg(unix)]
fn pids_listening_on(port: u16) -> Vec<i32> {
    // lsof is available on macOS by default and standard on Linux.
    let output = std::process::Command::new("lsof")
        .args(["-nP", &format!("-iTCP:{}", port), "-sTCP:LISTEN", "-t"])
        .output();
    match output {
        Ok(o) => String::from_utf8_lossy(&o.stdout)
            .lines()
            .filter_map(|l| l.trim().parse().ok())
            .collect(),
        Err(_) => Vec::new(),
    }
}

/// Tauri spawns this agent as a sidecar but doesn't always cleanly kill it
/// on parent death (Ctrl+C, SIGKILL, crash all skip RunEvent::Exit). When
/// the parent dies, the kernel reparents us to PID 1 (launchd / init) and
/// `getppid()` changes. Watch for that and self-terminate so we never
/// outlive the user-visible app.
#[cfg(unix)]
fn spawn_parent_death_watcher() {
    let original_ppid = unsafe { libc::getppid() };
    if original_ppid <= 1 {
        // Already orphaned (running from CLI without a Tauri parent, or
        // launched by launchd directly). Nothing to watch — stay alive.
        tracing::info!("No supervising parent (ppid={}); skipping death watcher", original_ppid);
        return;
    }
    tracing::info!("Parent-PID watcher armed for ppid={}", original_ppid);
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            let now = unsafe { libc::getppid() };
            if now != original_ppid {
                tracing::warn!(
                    "Parent process {} died (now reparented to {}); exiting to avoid orphaned agent",
                    original_ppid, now
                );
                std::process::exit(0);
            }
        }
    });
}

#[cfg(not(unix))]
fn spawn_parent_death_watcher() {
    // TODO: Windows equivalent via Job Objects (CreateJobObject +
    // SetInformationJobObject with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE).
}

fn main() {
    // Install aws-lc-rs as the rustls crypto provider before any TLS code runs.
    // tokio-rustls disables rustls default features so no provider is auto-selected
    // unless we call this explicitly.
    tokio_rustls::rustls::crypto::aws_lc_rs::default_provider()
        .install_default()
        .expect("Failed to install rustls crypto provider");

    // --init-tls: generate the localhost TLS cert + fingerprint flag, then exit.
    // Invoked by the Windows installer so the cert can be added to the user's
    // trust store during the install wizard (when the security prompt fits the
    // user's mental model) instead of on first app launch.
    if std::env::args().any(|a| a == "--init-tls") {
        let rt = tokio::runtime::Runtime::new().expect("Failed to build tokio runtime");
        rt.block_on(init_tls_and_exit());
        return;
    }

    // Build tokio runtime with larger worker thread stack (8MB vs default 2MB).
    // Discovery spawns concurrent SNMP walks (6-way tokio::join) and SSH
    // sessions (russh auth state machines) whose combined async Future state
    // machines exceed 4MB in debug builds.
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_stack_size(8 * 1024 * 1024)
        .build()
        .expect("Failed to build tokio runtime");

    runtime.block_on(async_main());
}

/// Generate (or load) the localhost TLS cert and write a fingerprint flag
/// file matching the format the Tauri shell expects, so it knows the cert
/// is already in the OS trust store on first launch.
async fn init_tls_and_exit() {
    let local_tls = tls::load_or_generate()
        .await
        .expect("Failed to initialize localhost TLS");
    let flag_path = tls::data_dir().join("tls_installed.txt");
    let fingerprint = {
        let trimmed = local_tls.cert_pem.trim();
        let prefix = &trimmed[..trimmed.len().min(64)];
        format!("{}:{}", trimmed.len(), prefix)
    };
    std::fs::write(&flag_path, fingerprint).expect("Failed to write TLS flag file");
    println!("TLS cert initialized at {}", flag_path.display());
}

async fn async_main() {
    // Check for Enterprise mode - if enabled, agent is not needed
    // Terminal connects directly to Controller in Enterprise mode
    // NETSTACKS_STANDALONE=1 overrides this check (used by test infrastructure)
    if std::env::var("NETSTACKS_STANDALONE").unwrap_or_default() != "1" && check_enterprise_mode() {
        println!("Enterprise mode detected. Agent not needed - Terminal connects directly to Controller.");
        println!("Exiting...");
        return;
    }

    // Generate per-session auth token (256-bit, hex-encoded)
    // Printed to stdout BEFORE tracing init so Tauri can parse it cleanly
    let auth_token_bytes: [u8; 32] = rand::thread_rng().gen();
    let auth_token: String = auth_token_bytes.iter().map(|b| format!("{:02x}", b)).collect();
    println!("NETSTACKS_AUTH_TOKEN={}", auth_token);

    // Load or generate the localhost TLS certificate.
    // Cert PEM is base64-encoded on one line so Tauri can parse it from stdout.
    let local_tls = tls::load_or_generate().await.expect("Failed to initialize localhost TLS");
    let cert_b64 = base64::engine::general_purpose::STANDARD.encode(local_tls.cert_pem.as_bytes());
    println!("NETSTACKS_TLS_CERT={}", cert_b64);

    // Initialize logging
    //
    // AUDIT FIX (DATA-007, AUTH-006/AUTH-011): default level is `info`, not
    // `debug`. tower_http is at `warn` so request URIs (which include the
    // WebSocket auth token query param) are not logged on every connection.
    // Override with RUST_LOG env var when developing.
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "netstacks_agent=info,tower_http=warn".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    // Initialize database (NETSTACKS_DB_PATH overrides default, used for testing)
    let db_path = std::env::var("NETSTACKS_DB_PATH")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| db::default_db_path());
    tracing::info!("Database path: {}", db_path.display());

    let pool = db::init_db(&db_path).await.expect("Failed to initialize database");
    tracing::info!("Database initialized");

    // Seed template scripts
    if let Err(e) = scripts::seed_templates(&pool).await {
        tracing::warn!("Failed to seed template scripts: {}", e);
    }

    // Note: uv is downloaded on-demand when scripts are first run (no startup cost)

    // Create the data provider
    let provider = Arc::new(LocalDataProvider::new(pool.clone()));

    // AUDIT FIX (REMOTE-002): the boot-time `SELECT … FROM settings WHERE
    // key = 'ssh.hostKeyChecking'` reload that flipped a global "disable
    // strict host-key checking" flag has been removed along with the flag
    // itself. Strict host-key checking is always on; per-session opt-in is
    // the only escape hatch.

    // Create MCP client manager (Phase 06)
    // Wrapped in RwLock for safe sharing with task executor and API
    let mcp_client_manager = Arc::new(tokio::sync::RwLock::new(integrations::McpClientManager::new()));

    // Create shared sanitizer cache (used by both API handlers and background tasks)
    let sanitizer: Arc<tokio::sync::RwLock<Option<ai::sanitizer::Sanitizer>>> =
        Arc::new(tokio::sync::RwLock::new(None));

    // Create task management components (Phase 02)
    let task_store = tasks::TaskStore::new(pool.clone());
    let task_registry = Arc::new(tasks::TaskRegistry::new(3)); // Max 3 concurrent tasks
    let progress_broadcaster = tasks::ProgressBroadcaster::new(100); // Buffer 100 events
    let task_executor = Arc::new(tasks::AgentTaskExecutor::new(
        task_store.clone(),
        task_registry.clone(),
        progress_broadcaster.clone(),
        pool.clone(),
        provider.clone(),
        mcp_client_manager.clone(),
        sanitizer.clone(),
    ));

    // Initialize cert manager for SSH certificate auth
    let cert_manager = Arc::new(cert_manager::CertManager::new(pool.clone()));

    // Create tunnel manager (before provider is moved into AppState)
    let tunnel_manager = Arc::new(tunnels::TunnelManager::new(provider.clone()));

    // Create app state
    let app_state = Arc::new(AppState {
        provider: provider as Arc<dyn providers::DataProvider>,
        auth_token,
        sanitizer: sanitizer.clone(),
        task_store,
        task_registry,
        task_executor,
        progress_broadcaster,
        mcp_client_manager,
        cert_manager: Some(cert_manager),
        pool: pool.clone(),
        tunnel_manager,
        // AUDIT FIX (EXEC-002): start with config mode disabled.
        config_mode: Arc::new(tokio::sync::RwLock::new(None)),
        // AUDIT FIX (REMOTE-001): per-process host-key approval registry.
        host_key_approvals: ssh::approvals::HostKeyApprovalService::new(),
    });

    // Auto-connect enabled MCP servers on startup (non-blocking).
    //
    // AUDIT FIX (CRYPTO-002): servers that have an auth token are skipped
    // when the vault is locked. The user must manually click "Connect" after
    // unlocking the vault — at which point the per-server `connect_mcp_server`
    // handler will load the encrypted token through the vault.
    {
        let pool_bg = pool.clone();
        let manager_bg = app_state.mcp_client_manager.clone();
        let provider_bg = app_state.provider.clone();
        tokio::spawn(async move {
            // We deliberately DO NOT select auth_token here — it stays
            // server-side and only surfaces via the vault helper.
            let rows: Vec<(String, String, String, String, String, i32, Option<String>, String, String, Option<Vec<u8>>, Option<String>)> = sqlx::query_as(
                "SELECT id, name, transport_type, command, args, enabled, url, auth_type, server_type, auth_token_encrypted, auth_token FROM mcp_servers WHERE enabled = 1"
            )
            .fetch_all(&pool_bg)
            .await
            .unwrap_or_default();

            for (id, name, transport_type, command, args_json, _enabled, url, auth_type, server_type, enc_token, plain_token) in rows {
                let has_token = enc_token.is_some() || plain_token.is_some();
                let auth_token = if has_token {
                    if !provider_bg.is_unlocked() {
                        tracing::warn!(
                            "Skipping MCP auto-connect for '{}' — vault locked and server has an auth token. Reconnect after unlocking the vault.",
                            name
                        );
                        continue;
                    }
                    match provider_bg.get_mcp_auth_token(&id).await {
                        Ok(t) => t,
                        Err(e) => {
                            tracing::warn!("Failed to load MCP auth token for '{}': {} — skipping", name, e);
                            continue;
                        }
                    }
                } else {
                    None
                };

                let args: Vec<String> = serde_json::from_str(&args_json).unwrap_or_default();
                let config = integrations::McpServerConfig {
                    id: id.clone(),
                    name: name.clone(),
                    transport_type,
                    command,
                    args,
                    url,
                    auth_type,
                    auth_token,
                    server_type,
                    enabled: true,
                };
                // Timeout each connection attempt to 10 seconds
                match tokio::time::timeout(
                    std::time::Duration::from_secs(10),
                    manager_bg.read().await.connect(config),
                ).await {
                    Ok(Ok(tools)) => {
                        tracing::info!("Auto-connected MCP server '{}' ({} tools)", name, tools.len());
                        // Upsert discovered tools to database (preserves user's enabled state)
                        for tool in &tools {
                            let schema_json = serde_json::to_string(&tool.input_schema).unwrap_or_else(|_| "{}".to_string());
                            let _ = sqlx::query(
                                r#"INSERT INTO mcp_tools (id, server_id, name, description, input_schema, enabled)
                                   VALUES (?, ?, ?, ?, ?, 0)
                                   ON CONFLICT(server_id, name) DO UPDATE SET
                                     description = excluded.description,
                                     input_schema = excluded.input_schema,
                                     updated_at = datetime('now')"#
                            )
                            .bind(&tool.id)
                            .bind(&tool.server_id)
                            .bind(&tool.name)
                            .bind(&tool.description)
                            .bind(&schema_json)
                            .execute(&pool_bg)
                            .await;
                        }
                    }
                    Ok(Err(e)) => {
                        tracing::warn!("Failed to auto-connect MCP server '{}': {}", name, e);
                    }
                    Err(_) => {
                        tracing::warn!("Timed out connecting to MCP server '{}'", name);
                    }
                }
            }
        });
    }

    // Build the application
    let app = create_app(app_state, pool);

    // Start HTTPS server on localhost only
    let addr = SocketAddr::from(([127, 0, 0, 1], 8080));
    assert!(addr.ip().is_loopback(), "Security: sidecar must bind to loopback address only");

    // Single-instance enforcement (Layer 2): if another netstacks-agent is
    // already bound to 8080 — usually an orphan from a previous Tauri session
    // whose parent died ungracefully — confirm it's actually one of ours via
    // /api/health, then SIGTERM (escalate to SIGKILL after 2s) and reclaim
    // the port. Foreign processes are left alone and we fail loudly.
    evict_existing_agent_if_present(addr).await;

    tracing::info!("NetStacks Agent starting on https://{}", addr);

    let acceptor = TlsAcceptor::from(local_tls.server_config);
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();

    // Layer 1: parent-PID watcher. Tauri's RunEvent::Exit cleanup is
    // unreliable (Ctrl+C, SIGKILL, crash all skip it), so the agent
    // self-terminates as soon as it notices the parent died and we got
    // reparented. Belt-and-suspenders with the eviction above.
    spawn_parent_death_watcher();

    loop {
        let (tcp, _remote_addr) = match listener.accept().await {
            Ok(pair) => pair,
            Err(e) => { tracing::warn!("Accept error: {}", e); continue; }
        };
        let acceptor = acceptor.clone();
        let app = app.clone();
        tokio::spawn(async move {
            let tls_stream = match acceptor.accept(tcp).await {
                Ok(s) => s,
                Err(e) => { tracing::debug!("TLS handshake failed: {}", e); return; }
            };
            let io = TokioIo::new(tls_stream);
            let svc = hyper::service::service_fn(move |req: hyper::Request<hyper::body::Incoming>| {
                let mut app = app.clone();
                async move {
                    tower::Service::call(&mut app, req.map(axum::body::Body::new)).await
                }
            });
            if let Err(e) = hyper_util::server::conn::auto::Builder::new(TokioExecutor::new())
                .serve_connection_with_upgrades(io, svc)
                .await
            {
                tracing::debug!("Connection closed: {}", e);
            }
        });
    }
}

fn create_app(app_state: Arc<AppState>, pool: SqlitePool) -> Router {
    // Create terminal manager
    let terminal_manager = Arc::new(terminal::TerminalManager::new());

    // Create WebSocket state with both terminal manager and app state
    let ws_state = ws::WsState {
        terminal_manager,
        app_state: app_state.clone(),
    };

    // CORS layer for development and Tauri production
    // Allow localhost origins and Tauri origins
    let cors = CorsLayer::new()
        .allow_origin(tower_http::cors::Any)
        .allow_methods(tower_http::cors::Any)
        .allow_headers(tower_http::cors::Any);

    // API routes with state
    let api_routes = TrackedRouter::new()
        // Health & Info
        .route("/health", get(api::health))
        .route("/info", get(api::app_info))
        // Sessions
        .route("/sessions", get(api::list_sessions).post(api::create_session))
        .route("/sessions/bulk-delete", post(api::bulk_delete_sessions))
        .route("/sessions/:id/move", put(api::move_session))
        .route(
            "/sessions/:id/jump-dependents",
            get(api::get_session_jump_dependents),
        )
        .route(
            "/sessions/:id",
            get(api::get_session)
                .put(api::update_session)
                .delete(api::delete_session),
        )
        // Folders
        .route("/folders", get(api::list_folders).post(api::create_folder))
        .route("/folders/:id/move", put(api::move_folder))
        .route(
            "/folders/:id",
            get(api::get_folder)
                .put(api::update_folder)
                .delete(api::delete_folder),
        )
        // Vault
        .route("/vault/status", get(api::vault_status))
        .route("/vault/password", post(api::set_master_password))
        .route("/vault/unlock", post(api::unlock_vault))
        .route("/vault/lock", post(api::lock_vault))
        // Touch ID / biometric vault unlock (macOS only meaningful)
        .route("/vault/biometric/status", get(api::biometric_status))
        .route("/vault/biometric/enable", post(api::enable_biometric))
        .route("/vault/biometric/unlock", post(api::unlock_with_biometric))
        .route("/vault/biometric", axum::routing::delete(api::disable_biometric))
        // Credentials
        .route(
            "/credentials/:session_id",
            post(api::store_credential).delete(api::delete_credential),
        )
        // Session Snippets
        .route(
            "/sessions/:id/snippets",
            get(api::list_session_snippets).post(api::create_session_snippet),
        )
        .route(
            "/sessions/:session_id/snippets/:snippet_id",
            delete(api::delete_session_snippet),
        )
        // Global Snippets
        .route(
            "/snippets",
            get(api::list_global_snippets).post(api::create_global_snippet),
        )
        .route("/snippets/:id", delete(api::delete_global_snippet))
        // Connection History
        .route(
            "/history",
            get(api::list_history).post(api::create_history),
        )
        .route("/history/:id", delete(api::delete_history))
        // Export/Import
        .route("/sessions/export", get(api::export_all))
        .route("/sessions/:id/export", get(api::export_session))
        .route("/folders/:id/export", get(api::export_folder))
        .route("/sessions/import", post(api::import_sessions))
        // Settings
        .route(
            "/settings/:key",
            get(api::get_setting).put(api::set_setting),
        )
        // Terminal Logging
        .route(
            "/terminals/:id/log/start",
            post(api::start_terminal_log),
        )
        .route(
            "/terminals/:id/log/stop",
            post(api::stop_terminal_log),
        )
        .route(
            "/terminals/:id/log/write",
            post(api::write_terminal_log),
        )
        .route("/logs/append", post(api::append_to_log))
        // Bulk command execution
        .route("/bulk-command", post(api::bulk_command))
        // Credential Profiles
        .route(
            "/profiles",
            get(api::list_profiles).post(api::create_profile),
        )
        .route(
            "/profiles/:id",
            get(api::get_profile)
                .put(api::update_profile)
                .delete(api::delete_profile),
        )
        .route(
            "/profiles/:id/credential",
            get(api::get_profile_credential_meta)
                .put(api::store_profile_credential)
                .delete(api::delete_profile_credential),
        )
        // Mapped Keys (Global)
        .route(
            "/mapped-keys",
            get(api::list_mapped_keys).post(api::create_mapped_key),
        )
        .route(
            "/mapped-keys/:key_id",
            put(api::update_mapped_key).delete(api::delete_mapped_key),
        )
        // Custom Commands (right-click menu)
        .route(
            "/custom-commands",
            get(api::list_custom_commands).post(api::create_custom_command),
        )
        .route(
            "/custom-commands/:id",
            put(api::update_custom_command).delete(api::delete_custom_command),
        )
        // Jump Hosts (Global Proxy Configuration)
        .route(
            "/jump-hosts",
            get(api::list_jump_hosts).post(api::create_jump_host),
        )
        .route(
            "/jump-hosts/:id",
            get(api::get_jump_host)
                .put(api::update_jump_host)
                .delete(api::delete_jump_host),
        )
        // NetBox Sources
        .route(
            "/netbox-sources",
            get(api::list_netbox_sources).post(api::create_netbox_source),
        )
        .route(
            "/netbox-sources/:id",
            get(api::get_netbox_source)
                .put(api::update_netbox_source)
                .delete(api::delete_netbox_source),
        )
        .route("/netbox-sources/:id/test", post(api::test_netbox_source))
        .route("/netbox/test", post(api::test_netbox_direct))
        .route("/netbox-sources/:id/sync-complete", post(api::sync_complete_netbox_source))
        .route("/netbox-sources/:id/token", get(api::get_netbox_token))
        // NetBox proxy endpoints (for filter options with SSL bypass)
        .route("/netbox/proxy/sites", post(api::netbox_proxy_sites))
        .route("/netbox/proxy/roles", post(api::netbox_proxy_roles))
        .route("/netbox/proxy/manufacturers", post(api::netbox_proxy_manufacturers))
        .route("/netbox/proxy/platforms", post(api::netbox_proxy_platforms))
        .route("/netbox/proxy/tags", post(api::netbox_proxy_tags))
        .route("/netbox/proxy/devices/count", post(api::netbox_proxy_count_devices))
        .route("/netbox/proxy/devices", post(api::netbox_proxy_devices))
        .route("/netbox/proxy/ip-addresses", post(api::netbox_proxy_ip_addresses))
        // LibreNMS Sources (Phase 22)
        .route(
            "/librenms-sources",
            get(api::list_librenms_sources).post(api::create_librenms_source),
        )
        .route(
            "/librenms-sources/:id",
            get(api::get_librenms_source).delete(api::delete_librenms_source),
        )
        .route("/librenms-sources/:id/test", post(api::test_librenms_source))
        .route("/librenms/test", post(api::test_librenms_direct))
        .route("/librenms-sources/:id/devices", get(api::get_librenms_devices))
        .route("/librenms-sources/:id/devices/:hostname/links", get(api::get_librenms_device_links))
        .route("/librenms-sources/:id/links", get(api::get_librenms_all_links))
        // Netdisco Sources (Phase 22)
        .route(
            "/netdisco-sources",
            get(api::list_netdisco_sources).post(api::create_netdisco_source),
        )
        .route(
            "/netdisco-sources/:id",
            get(api::get_netdisco_source)
                .put(api::update_netdisco_source)
                .delete(api::delete_netdisco_source),
        )
        .route("/netdisco-sources/:id/test", post(api::test_netdisco_source))
        .route("/netdisco/test", post(api::test_netdisco_direct))
        .route("/netdisco-sources/:id/devices", get(api::netdisco_proxy_devices))
        .route("/netdisco-sources/:id/devices/:device_ip/neighbors", get(api::netdisco_proxy_neighbors))
        .route("/netdisco-sources/:id/devicelinks", get(api::netdisco_proxy_devicelinks))
        .route("/netdisco-sources/:id/search", get(api::netdisco_proxy_search))
        // API Key Vault
        .route(
            "/vault/api-keys/:key_type",
            get(api::get_api_key)
                .put(api::store_api_key)
                .delete(api::delete_api_key),
        )
        .route("/vault/api-keys/:key_type/exists", get(api::has_api_key))
        // Recordings
        .route(
            "/recordings",
            get(api::list_recordings).post(api::create_recording),
        )
        .route(
            "/recordings/:id",
            get(api::get_recording)
                .put(api::update_recording)
                .delete(api::delete_recording),
        )
        .route("/recordings/:id/data", get(api::get_recording_data))
        .route("/recordings/:id/append", post(api::append_recording_data))
        .route("/recordings/:id/save-to-docs", post(api::save_recording_to_docs))
        // Highlight Rules
        .route(
            "/highlight-rules",
            get(api::list_highlight_rules).post(api::create_highlight_rule),
        )
        .route(
            "/highlight-rules/:id",
            get(api::get_highlight_rule)
                .put(api::update_highlight_rule)
                .delete(api::delete_highlight_rule),
        )
        .route("/sessions/:session_id/highlight-rules/effective", get(api::get_effective_highlight_rules))
        // Change Control
        .route(
            "/changes",
            get(api::list_changes).post(api::create_change),
        )
        .route("/changes/import-mop", post(api::import_mop_package))
        .route(
            "/changes/:id",
            get(api::get_change)
                .put(api::update_change)
                .delete(api::delete_change),
        )
        .route("/changes/:id/export-mop", get(api::export_mop_package))
        .route("/changes/:change_id/snapshots", get(api::list_snapshots))
        .route(
            "/snapshots",
            post(api::create_snapshot),
        )
        .route(
            "/snapshots/:id",
            get(api::get_snapshot).delete(api::delete_snapshot),
        )
        // Session Context (Phase 14)
        .route(
            "/sessions/:session_id/context",
            get(api::list_session_context).post(api::create_session_context),
        )
        .route(
            "/context/:id",
            get(api::get_session_context)
                .put(api::update_session_context)
                .delete(api::delete_session_context),
        )
        // Network Lookups (Phase 19)
        .route("/lookup/oui/:mac", get(api::lookup_oui))
        .route("/lookup/dns/:query", get(api::lookup_dns))
        .route("/lookup/whois/:query", get(api::lookup_whois))
        .route("/lookup/asn/:asn", get(api::lookup_asn))
        // Saved Topologies (Phase 20.1)
        .route("/topologies", get(api::list_topologies).post(api::create_topology))
        .route("/topologies/bulk-delete", post(api::bulk_delete_topologies))
        .route("/topologies/folders", get(api::list_topology_folders).post(api::create_topology_folder))
        .route(
            "/topologies/folders/:id",
            get(api::get_topology_folder)
                .put(api::update_topology_folder)
                .delete(api::delete_topology_folder),
        )
        .route("/topologies/folders/:id/move", put(api::move_topology_folder))
        .route(
            "/topologies/:id",
            get(api::get_topology)
                .put(api::update_topology)
                .delete(api::delete_topology),
        )
        .route("/topologies/:id/move", put(api::move_topology))
        .route("/topologies/:id/devices", post(api::add_topology_device))
        .route("/topologies/:id/devices/:device_id/position", put(api::update_topology_device_position))
        .route("/topologies/:id/devices/:device_id/type", put(api::update_topology_device_type))
        .route("/topologies/:id/devices/:device_id/details", put(api::update_topology_device_details))
        .route("/topologies/:id/devices/:device_id", delete(api::delete_topology_device))
        .route("/topologies/:id/connections", post(api::create_topology_connection))
        .route("/topologies/:id/connections/:conn_id", delete(api::delete_topology_connection))
        // Topology Annotations (Phase 27-03)
        .route("/topologies/:id/annotations", get(api::list_topology_annotations).post(api::create_topology_annotation))
        .route("/topologies/:id/annotations/reorder", post(api::reorder_topology_annotations))
        .route("/topologies/:id/annotations/:annotation_id", put(api::update_topology_annotation).delete(api::delete_topology_annotation))
        // Layouts (Phase 25)
        .route("/layouts", get(api::list_layouts).post(api::create_layout))
        .route(
            "/layouts/:id",
            get(api::get_layout)
                .put(api::update_layout)
                .delete(api::delete_layout),
        )
        // Groups (Plan 1: Tab Groups Redesign)
        .route("/groups", get(api::list_groups).post(api::create_group))
        .route("/groups/:id", get(api::get_group).put(api::update_group).delete(api::delete_group))
        // API Resources
        .route("/api-resources", get(api::list_api_resources).post(api::create_api_resource))
        .route("/api-resources/:id", get(api::get_api_resource).put(api::update_api_resource).delete(api::delete_api_resource))
        .route("/api-resources/:id/test", post(api::test_api_resource))
        .route(
            "/api-resources/:id/auth-flow/:step_index/test",
            post(api::test_auth_flow_step),
        )
        // Quick Actions
        .route("/quick-actions", get(api::list_quick_actions).post(api::create_quick_action))
        .route("/quick-actions/:id", get(api::get_quick_action).put(api::update_quick_action).delete(api::delete_quick_action))
        .route("/quick-actions/:id/execute", post(api::execute_quick_action))
        .route("/quick-actions/execute-inline", post(api::execute_inline_quick_action))
        // Quick Prompts
        .route("/quick-prompts", get(api::list_quick_prompts).post(api::create_quick_prompt))
        .route("/quick-prompts/:id", put(api::update_quick_prompt).delete(api::delete_quick_prompt))
        // Agent Definitions
        .route("/agent-definitions", get(api::list_agent_definitions).post(api::create_agent_definition))
        .route("/agent-definitions/:id", get(api::get_agent_definition).put(api::update_agent_definition).delete(api::delete_agent_definition))
        .route("/agent-definitions/:id/run", post(api::run_agent_definition))
        // MOP Templates (Phase 30)
        .route("/mop-templates", get(api::list_mop_templates).post(api::create_mop_template))
        .route("/mop-templates/:id", get(api::get_mop_template).put(api::update_mop_template).delete(api::delete_mop_template))
        // MOP Executions (Phase 30)
        .route("/mop-executions", get(api::list_mop_executions).post(api::create_mop_execution))
        .route("/mop-executions/:id", get(api::get_mop_execution).put(api::update_mop_execution).delete(api::delete_mop_execution))
        // MOP Execution Control
        .route("/mop-executions/:id/start", post(api::start_mop_execution))
        .route("/mop-executions/:id/pause", post(api::pause_mop_execution))
        .route("/mop-executions/:id/resume", post(api::resume_mop_execution))
        .route("/mop-executions/:id/abort", post(api::abort_mop_execution))
        .route("/mop-executions/:id/complete", post(api::complete_mop_execution))
        // MOP Execution Devices
        .route("/mop-executions/:id/devices", get(api::list_execution_devices).post(api::add_execution_device))
        .route("/mop-executions/:exec_id/devices/:device_id/skip", post(api::skip_execution_device))
        .route("/mop-executions/:exec_id/devices/:device_id/retry", post(api::retry_execution_device))
        .route("/mop-executions/:exec_id/devices/:device_id/rollback", post(api::rollback_execution_device))
        // MOP Execution Steps
        .route("/mop-executions/:exec_id/devices/:device_id/steps", get(api::list_execution_steps).post(api::add_execution_steps))
        .route("/mop-executions/:exec_id/steps/:step_id/execute", post(api::execute_step))
        .route("/mop-executions/:exec_id/steps/:step_id/approve", post(api::approve_step))
        .route("/mop-executions/:exec_id/steps/:step_id/skip", post(api::skip_step))
        .route("/mop-executions/:exec_id/steps/:step_id/mock", put(api::update_step_mock))
        .route("/mop-executions/:exec_id/steps/:step_id/output", put(api::update_step_output))
        // MOP Phase Execution & Snapshots (Phase 30 - Production)
        .route("/mop-executions/:exec_id/devices/:device_id/execute-phase", post(api::execute_device_phase))
        .route("/mop-executions/:exec_id/devices/:device_id/diff", get(api::get_device_snapshot_diff))
        .route("/mop-executions/:exec_id/analyze", post(api::analyze_mop_execution))
        // MOP Diff (paired step comparison)
        .route("/mop/diff", post(api::mop_diff))
        // SNMP Operations (Phase 6)
        .route("/snmp/get", post(api::snmp_get))
        .route("/snmp/walk", post(api::snmp_walk))
        .route("/snmp/try-communities", post(api::snmp_try_communities))
        // SNMP Interface Stats (Phase 7)
        .route("/snmp/interface-stats", post(api::snmp_interface_stats))
        .route("/snmp/try-interface-stats", post(api::snmp_try_interface_stats))
        // Discovery (Phase 27: Topology Discovery v2)
        .route("/discovery/batch", post(api::discovery_batch))
        .route("/discovery/traceroute-resolve", post(api::discovery_traceroute_resolve))
        .route("/discovery/capabilities", get(api::discovery_capabilities))
        // Tasks (Phase 02)
        .route("/tasks", get(api::list_tasks).post(api::create_task))
        .route(
            "/tasks/:id",
            get(api::get_task).delete(api::delete_task_endpoint),
        )
        // SMTP Configuration (Phase 06)
        .route("/smtp/config", get(api::get_smtp_config).post(api::save_smtp_config).delete(api::delete_smtp_config))
        .route("/smtp/test", post(api::test_smtp_connection))
        // MCP Server Management (Phase 06-03)
        .route("/mcp/servers", get(api::list_mcp_servers).post(api::add_mcp_server))
        .route("/mcp/servers/:id", delete(api::delete_mcp_server))
        .route("/mcp/servers/:id/connect", post(api::connect_mcp_server))
        .route("/mcp/servers/:id/disconnect", post(api::disconnect_mcp_server))
        // MCP Tool Approval (Phase 06-04)
        .route("/mcp/tools/:id/enabled", put(api::set_mcp_tool_enabled))
        .route("/mcp/tools/:id/execute", post(api::execute_mcp_tool))
        // SSH Certificate Auth
        .route("/cert/status", get(api::cert_status))
        .route("/cert/public-key", get(api::cert_public_key))
        .route("/cert/store", post(api::cert_store))
        .route("/cert/renew", post(api::cert_renew))
        // AUDIT FIX (REMOTE-001): host-key fingerprint prompts
        .route("/host-keys/prompts", get(api::list_host_key_prompts))
        .route("/host-keys/prompts/:id/approve", post(api::approve_host_key_prompt))
        .route("/host-keys/prompts/:id/reject", post(api::reject_host_key_prompt))
        // AUDIT FIX (EXEC-017): per-tool-call approval prompts for ReAct tasks
        .route("/tasks/:task_id/pending-approvals", get(api::list_task_pending_approvals))
        .route("/task-approvals", get(api::list_all_task_approvals))
        .route("/task-approvals/:approval_id/approve", post(api::approve_task_tool_use))
        .route("/task-approvals/:approval_id/reject", post(api::reject_task_tool_use))
        // Tunnels (static routes before parameterized)
        .route("/tunnels/status", get(api::tunnel_status))
        .route("/tunnels/start-all", post(api::start_all_tunnels))
        .route("/tunnels/stop-all", post(api::stop_all_tunnels))
        .route("/tunnels", get(api::list_tunnels).post(api::create_tunnel))
        .route("/tunnels/:id", put(api::update_tunnel).delete(api::delete_tunnel))
        .route("/tunnels/:id/start", post(api::start_tunnel))
        .route("/tunnels/:id/stop", post(api::stop_tunnel))
        .route("/tunnels/:id/reconnect", post(api::reconnect_tunnel))
        // Workspace local file operations
        .route("/local/read-file", post(api::local_file_read))
        .route("/local/write-file", post(api::local_file_write))
        .route("/local/list-dir", post(api::local_dir_list))
        .route("/local/mkdir", post(api::local_file_mkdir))
        .route("/local/delete", post(api::local_file_delete))
        .route("/local/rename", post(api::local_file_rename))
        .route("/local/exists", post(api::local_file_exists))
        .route("/local/run-python", post(api::local_run_python))
        .with_state(app_state.clone());

    // Dev-only route introspection (cfg-gated; absent from release builds).
    #[cfg(any(debug_assertions, feature = "dev-routes"))]
    let api_routes = api_routes.route("/dev/routes", get(dev::routes_handler));

    // Scripts state (separate from app state)
    let scripts_state = Arc::new(scripts::ScriptsState {
        pool: pool.clone(),
        provider: app_state.provider.clone(),
    });

    // Scripts routes
    let scripts_routes = TrackedRouter::new()
        .route("/", get(scripts::list_scripts).post(scripts::create_script))
        .route(
            "/:id",
            get(scripts::get_script)
                .put(scripts::update_script)
                .delete(scripts::delete_script),
        )
        .route("/:id/run", post(scripts::run_script))
        .route("/:id/stream", post(scripts::run_script_stream))
        .route("/:id/analyze", get(scripts::analyze_script))
        // AUDIT FIX (EXEC-014): user-initiated approval of AI-authored scripts
        .route("/:id/approve", post(scripts::approve_script))
        .with_state(scripts_state);

    // Docs state (separate from app state). Carries the vault-aware provider
    // so Notes (Secure Notes) can encrypt/decrypt at rest.
    let docs_state = Arc::new(docs::DocsState {
        pool,
        provider: app_state.provider.clone(),
    });

    // Docs routes
    let docs_routes = TrackedRouter::new()
        .route("/", get(docs::list_documents).post(docs::create_document))
        .route(
            "/:id",
            get(docs::get_document)
                .put(docs::update_document)
                .delete(docs::delete_document),
        )
        // Version history routes
        .route("/:id/versions", get(docs::list_versions))
        .route("/versions/:version_id", get(docs::get_version))
        .route("/:id/restore/:version_id", post(docs::restore_version))
        // Template rendering
        .route("/:id/render", post(docs::render_template))
        .with_state(docs_state);

    // AI routes (with state for settings access)
    let ai_routes = TrackedRouter::new()
        .route("/chat", post(ai::chat::chat_completion))
        .route("/generate-script", post(ai::chat::generate_script))
        .route("/agent-chat", post(ai::chat::agent_chat))
        .route("/agent-chat-stream", post(ai::chat::agent_chat_stream_handler))
        .route("/analyze-highlights", post(ai::chat::analyze_highlights))
        .route("/sanitization/test", post(ai::chat::test_sanitization))
        .route("/ssh-execute", post(api::ai_ssh_execute))
        .route("/write-file", post(api::ai_write_file))
        .route("/edit-file", post(api::ai_edit_file))
        .route("/patch-file", post(api::ai_patch_file))
        .route("/profile", get(ai::chat::get_ai_profile).put(ai::chat::update_ai_profile).delete(ai::chat::reset_ai_profile))
        .route("/profile/status", get(ai::chat::get_ai_profile_status))
        .route("/knowledge-pack-sizes", get(ai::chat::get_knowledge_pack_sizes))
        .route("/memory", get(api::list_ai_memories).post(api::create_ai_memory))
        .route("/memory/:id", put(api::update_ai_memory).delete(api::delete_ai_memory))
        // AUDIT FIX (EXEC-002): server-side config-mode lifecycle
        .route("/config-mode/enable", post(api::enable_config_mode))
        .route("/config-mode/disable", post(api::disable_config_mode))
        .route("/config-mode/status", get(api::config_mode_status))
        .with_state(app_state.clone());

    // SFTP state (separate manager with access to app state for credentials)
    let sftp_state = Arc::new(api::SftpState {
        manager: sftp::SftpManager::new(),
        app_state: app_state.clone(),
    });

    // SFTP routes
    let sftp_routes = TrackedRouter::new()
        .route("/:id/connect", post(api::sftp_connect))
        .route("/:id/disconnect", post(api::sftp_disconnect))
        .route("/:id/ls", get(api::sftp_ls))
        .route("/:id/download", get(api::sftp_download))
        .route("/:id/upload", post(api::sftp_upload))
        .route("/:id/mkdir", post(api::sftp_mkdir))
        .route("/:id/rm", delete(api::sftp_rm))
        .route("/:id/rename", post(api::sftp_rename))
        .route("/:id/stat", get(api::sftp_stat))
        .with_state(sftp_state);

    // WebSocket routes for terminal, topology live SNMP polling, and task progress
    let ws_routes = TrackedRouter::new()
        .route("/terminal", get(ws::terminal_ws))
        .route("/topology-live", get(ws::topology_live_ws))
        .route("/tasks", get(ws::task_progress_ws))
        .with_state(ws_state);

    // Static file serving for production builds
    let static_service = ServeDir::new("../frontend/dist")
        .not_found_service(ServeDir::new("../frontend/dist"));

    // Compose API sub-routers (these get auth middleware).
    let api_composed = TrackedRouter::<()>::new()
        .nest_tracked("/api", api_routes)
        .nest_tracked("/api/scripts", scripts_routes)
        .nest_tracked("/api/docs", docs_routes)
        .nest_tracked("/api/ai", ai_routes)
        .nest_tracked("/api/sftp", sftp_routes);

    // Compose WS routes separately (no auth middleware).
    let ws_composed = TrackedRouter::<()>::new()
        .nest_tracked("/ws", ws_routes);

    // Aggregate captured routes from BOTH and stash globally — only when
    // the dev-routes endpoint will read them back.
    #[cfg(any(debug_assertions, feature = "dev-routes"))]
    {
        let mut all_routes = api_composed.captured_routes();
        all_routes.extend(ws_composed.captured_routes());
        set_global_routes(all_routes);
    }

    let (api_router, _) = api_composed.into_inner_with_routes();
    let (ws_router, _) = ws_composed.into_inner_with_routes();

    let authenticated = api_router.layer(axum::middleware::from_fn_with_state(
        app_state.clone(),
        api::auth_middleware,
    ));

    Router::new()
        .merge(authenticated)
        .merge(ws_router)
        .fallback_service(static_service)
        .layer(cors)
}
