#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::Engine as _;
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder},
    Emitter, Manager,
};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Stores the sidecar auth token so the frontend can retrieve it via IPC command.
/// The token event may fire before the webview JS loads, so this provides a
/// reliable fallback for the frontend to get the token on demand.
struct SidecarToken(Mutex<Option<String>>);

/// Returns path to the TLS cert fingerprint flag file in the agent data directory.
/// Presence of this file (with matching content) means the cert is already in the
/// OS trust store — skips the install prompt on subsequent launches.
fn tls_cert_flag_path() -> std::path::PathBuf {
    const APP_ID: &str = "com.netstacks.terminal";
    #[cfg(target_os = "macos")]
    let base = std::env::var("HOME").map(|h| format!("{}/Library/Application Support/{}", h, APP_ID)).unwrap_or_default();
    #[cfg(target_os = "linux")]
    let base = std::env::var("HOME").map(|h| format!("{}/.local/share/{}", h, APP_ID)).unwrap_or_default();
    #[cfg(target_os = "windows")]
    let base = std::env::var("APPDATA").map(|a| format!("{}\\{}", a, APP_ID)).unwrap_or_default();
    std::path::PathBuf::from(base).join("tls_installed.txt")
}

/// Cheap fingerprint: length + first 64 chars. Good enough for change detection.
fn cert_fingerprint(pem: &str) -> String {
    let trimmed = pem.trim();
    let prefix = &trimmed[..trimmed.len().min(64)];
    format!("{}:{}", trimmed.len(), prefix)
}

/// Path to the flag marking that the macOS Local Network access prompt has been
/// shown to this user. Presence of the file means we've already explained the
/// requirement and triggered the OS prompt — don't bother the user again.
#[cfg(target_os = "macos")]
fn lan_prompt_flag_path() -> std::path::PathBuf {
    const APP_ID: &str = "com.netstacks.terminal";
    let base = std::env::var("HOME")
        .map(|h| format!("{}/Library/Application Support/{}", h, APP_ID))
        .unwrap_or_default();
    std::path::PathBuf::from(base).join("lan_prompt_shown.txt")
}

/// Holds the sidecar child process so we can kill it when the app exits.
struct SidecarChild(Mutex<Option<CommandChild>>);

#[tauri::command]
fn get_sidecar_token(state: tauri::State<SidecarToken>) -> Option<String> {
    state.0.lock().unwrap().clone()
}

/// Open a new full app window (same sidecar, independent UI).
/// Can be called from frontend or AI tools.
#[tauri::command]
async fn open_new_window(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::WebviewWindowBuilder;
    let window_id = format!("window-{}", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis());
    WebviewWindowBuilder::new(
        &app,
        &window_id,
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("NetStacks")
    .inner_size(1280.0, 800.0)
    .min_inner_size(800.0, 500.0)
    .build()
    .map_err(|e| format!("Failed to create window: {}", e))?;
    Ok(window_id)
}

/// Fetch the Controller's CA certificate info, bypassing TLS verification.
/// Used when the webview can't connect due to an untrusted self-signed cert.
///
/// AUDIT FIX: the URL is user-supplied and TLS verification is intentionally
/// disabled (we are bootstrapping trust in a self-signed cert). To prevent a
/// downgrade to plaintext or an alternate scheme being abused, parse the URL
/// and require https:// before issuing the request. The trust pivot still
/// happens at the human verification step in AuthProvider, which constant-time
/// compares the SHA-256 fingerprint against a value the user obtained
/// out-of-band.
#[tauri::command]
async fn fetch_controller_cert(controller_url: String) -> Result<serde_json::Value, String> {
    let parsed = reqwest::Url::parse(controller_url.trim_end_matches('/'))
        .map_err(|e| format!("Invalid controller URL: {}", e))?;
    if parsed.scheme() != "https" {
        return Err("Controller URL must use https://".to_string());
    }
    if parsed.host_str().is_none() {
        return Err("Controller URL must include a host".to_string());
    }

    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let url = format!("{}/api/tls/ca-certificate/info", parsed.as_str().trim_end_matches('/'));
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to connect to controller: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Controller returned status {}", resp.status()));
    }

    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))
}

/// Install a CA certificate into the user's OS trust store.
///
/// On macOS: adds to user login keychain (no admin password required)
/// On Windows: adds to user certificate store
/// On Linux: writes to ~/.local/share/ca-certificates and updates
///
/// AUDIT FIX (AUTH-003): the previous implementation accepted an arbitrary
/// `filename` from the frontend and joined it to the temp dir without
/// sanitization. `PathBuf::join` does not reject absolute paths or `..`
/// components, so a compromised webview could write arbitrary content (the
/// `pem_content` argument) to arbitrary user-writable locations.
///
/// We now:
///   1. Ignore the caller-supplied `filename` and use a fixed name.
///   2. Reject obviously-non-PEM content before writing it.
///   3. Place the temp file in a per-process subdir of the temp dir.
#[tauri::command]
async fn install_ca_certificate(pem_content: String, filename: String) -> Result<String, String> {
    use std::io::Write;

    // Sanity check the PEM payload — reject anything that doesn't even look
    // like a CERTIFICATE block. Full X.509 validation is a TODO best done
    // with the `x509-parser` crate.
    let pem = pem_content.trim();
    if !pem.starts_with("-----BEGIN CERTIFICATE-----") || !pem.contains("-----END CERTIFICATE-----") {
        return Err("Refusing to install: payload is not a PEM-encoded CERTIFICATE block".into());
    }
    if pem_content.len() > 64 * 1024 {
        return Err("Refusing to install: PEM payload exceeds 64 KiB".into());
    }

    // Filename argument is logged but not used as a path component.
    tracing_log_filename(&filename);

    let temp_dir = std::env::temp_dir().join("netstacks-cacert");
    if let Err(e) = std::fs::create_dir_all(&temp_dir) {
        return Err(format!("Failed to prepare temp dir: {}", e));
    }
    let cert_path = temp_dir.join("install.pem");

    let mut file = std::fs::File::create(&cert_path)
        .map_err(|e| format!("Failed to write certificate: {}", e))?;
    file.write_all(pem.as_bytes())
        .map_err(|e| format!("Failed to write certificate: {}", e))?;
    drop(file);

    let result = install_cert_os(&cert_path).await;

    // Clean up temp file
    let _ = std::fs::remove_file(&cert_path);

    result
}

/// Best-effort logging of the (now-unused) caller-supplied filename. Helpful
/// for debugging while making clear this value is not on the critical path.
fn tracing_log_filename(filename: &str) {
    // Strip any path separators so we never accidentally log a full path.
    let safe = filename
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .chars()
        .take(64)
        .collect::<String>();
    eprintln!("[install_ca_certificate] caller-supplied filename (ignored): {}", safe);
}

#[cfg(target_os = "macos")]
async fn install_cert_os(cert_path: &std::path::Path) -> Result<String, String> {
    // Install to user login keychain (no admin password needed)
    let output = std::process::Command::new("security")
        .args([
            "add-trusted-cert",
            "-r", "trustRoot",
            "-k", &format!("{}/Library/Keychains/login.keychain-db",
                std::env::var("HOME").unwrap_or_default()),
            cert_path.to_str().unwrap_or_default(),
        ])
        .output()
        .map_err(|e| format!("Failed to run security command: {}", e))?;

    if output.status.success() {
        Ok("CA certificate installed to macOS login keychain. Restart the app for changes to take effect.".into())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("Failed to install certificate: {}", stderr))
    }
}

#[cfg(target_os = "windows")]
async fn install_cert_os(cert_path: &std::path::Path) -> Result<String, String> {
    // Install to current user Root store
    let output = std::process::Command::new("certutil")
        .args([
            "-user",
            "-addstore",
            "Root",
            cert_path.to_str().unwrap_or_default(),
        ])
        .output()
        .map_err(|e| format!("Failed to run certutil: {}", e))?;

    if output.status.success() {
        Ok("CA certificate installed to Windows user certificate store. Restart the app for changes to take effect.".into())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("Failed to install certificate: {}", stderr))
    }
}

/// On macOS, RFC1918 connections from a bundled app silently fail with
/// "No route to host" until the user grants Local Network access. The OS
/// prompt only fires after the first RFC1918/multicast attempt — and it
/// fires without context, so users don't know what they're being asked.
///
/// On first launch we show our own explanation dialog, then fire a one-shot
/// mDNS multicast send to deterministically trigger the OS prompt right
/// after the user dismisses our message. Multicast (224.0.0.251:5353) is
/// the most reliable trigger and doesn't depend on which subnet the user
/// is on. A flag file in Application Support records that we've done this,
/// so the dialog never appears twice for the same user.
#[cfg(target_os = "macos")]
fn maybe_prompt_for_lan_access(app: &tauri::AppHandle) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

    let flag = lan_prompt_flag_path();
    if flag.exists() {
        return;
    }

    if let Some(parent) = flag.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    app.dialog()
        .message(
            "NetStacks needs permission to reach devices on your local network \
             (SSH, telnet, SNMP, discovery).\n\n\
             macOS will ask you to allow this on the next screen. Click Allow.\n\n\
             You can change this later in System Settings \u{2192} Privacy & Security \u{2192} Local Network.",
        )
        .title("Local Network Access Required")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::Ok)
        .show(move |_| {
            // User dismissed — fire mDNS multicast send to trigger the OS prompt.
            // Errors are intentionally ignored: even a failed send registers the
            // app with TCC, which is the only thing we actually need.
            if let Ok(socket) = std::net::UdpSocket::bind("0.0.0.0:0") {
                let _ = socket.send_to(b"\x00", "224.0.0.251:5353");
            }
            let _ = std::fs::write(&flag, "1");
        });
}

#[cfg(not(target_os = "macos"))]
fn maybe_prompt_for_lan_access(_app: &tauri::AppHandle) {}

#[cfg(target_os = "linux")]
async fn install_cert_os(cert_path: &std::path::Path) -> Result<String, String> {
    // Install to user-local certificate directory
    let ca_dir = format!(
        "{}/.local/share/ca-certificates",
        std::env::var("HOME").unwrap_or_default()
    );
    std::fs::create_dir_all(&ca_dir)
        .map_err(|e| format!("Failed to create cert directory: {}", e))?;

    let dest = std::path::PathBuf::from(&ca_dir).join("netstacks-controller-ca.crt");
    std::fs::copy(cert_path, &dest)
        .map_err(|e| format!("Failed to copy certificate: {}", e))?;

    // Try to update CA certs (may need sudo)
    let output = std::process::Command::new("update-ca-certificates")
        .output();

    match output {
        Ok(o) if o.status.success() => {
            Ok("CA certificate installed. Restart the app for changes to take effect.".into())
        }
        _ => {
            Ok(format!(
                "CA certificate saved to {}. Run 'sudo update-ca-certificates' to activate, then restart the app.",
                dest.display()
            ))
        }
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(SidecarToken(Mutex::new(None)))
        .manage(SidecarChild(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![get_sidecar_token, install_ca_certificate, fetch_controller_cert, open_new_window])
        .setup(|app| {
            // Build the native menu bar (macOS/Windows/Linux)
            let menu = build_menu(app.handle())?;
            app.set_menu(menu)?;

            // Spawn the netstacks-agent sidecar
            let sidecar_command = app.shell().sidecar("netstacks-agent").unwrap();
            let (mut rx, child) =
                sidecar_command.spawn().expect("Failed to spawn netstacks-agent sidecar");

            // Store child process handle so we can kill it on app exit
            if let Some(state) = app.try_state::<SidecarChild>() {
                *state.0.lock().unwrap() = Some(child);
            }

            // Clone app handle for use in async task (needed to emit events to frontend)
            let app_handle = app.handle().clone();

            // Spawn a task to consume sidecar output (prevents blocking when buffer fills)
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(line) => {
                            let line_str = String::from_utf8_lossy(&line);
                            if let Some(token) = line_str.strip_prefix("NETSTACKS_AUTH_TOKEN=") {
                                let token = token.trim().to_string();
                                if let Some(state) = app_handle.try_state::<SidecarToken>() {
                                    *state.0.lock().unwrap() = Some(token.clone());
                                }
                                app_handle.emit("sidecar-auth-token", token).unwrap();
                                println!("[sidecar] Auth token received and forwarded to frontend");
                            } else if let Some(cert_b64) = line_str.strip_prefix("NETSTACKS_TLS_CERT=") {
                                let pem_opt = base64::engine::general_purpose::STANDARD
                                    .decode(cert_b64.trim().as_bytes())
                                    .ok()
                                    .and_then(|b| String::from_utf8(b).ok());
                                if let Some(pem) = pem_opt {
                                    let app = app_handle.clone();
                                    tauri::async_runtime::spawn(async move {
                                        let fingerprint = cert_fingerprint(&pem);
                                        let flag = tls_cert_flag_path();

                                        // Skip install if this exact cert was already trusted
                                        let already_done = std::fs::read_to_string(&flag)
                                            .map(|s| s.trim() == fingerprint)
                                            .unwrap_or(false);

                                        if already_done {
                                            app.emit("sidecar-tls-ready", ()).ok();
                                            return;
                                        }

                                        // First run or cert changed — install into OS trust store.
                                        // macOS will prompt once for login password; subsequent
                                        // launches are silently skipped by the check above.
                                        match install_ca_certificate(pem, "netstacks-local.crt".into()).await {
                                            Ok(_) => {
                                                let _ = std::fs::write(&flag, fingerprint);
                                                app.emit("sidecar-tls-ready", ()).ok();
                                            }
                                            Err(e) => {
                                                eprintln!("[sidecar] TLS cert install failed: {}", e);
                                                // Emit anyway so app doesn't hang; HTTPS may fail
                                                app.emit("sidecar-tls-ready", ()).ok();
                                            }
                                        }
                                    });
                                }
                            } else {
                                println!("[sidecar] {}", line_str);
                            }
                        }
                        CommandEvent::Stderr(line) => {
                            eprintln!("[sidecar err] {}", String::from_utf8_lossy(&line));
                        }
                        CommandEvent::Terminated(status) => {
                            eprintln!("[sidecar] terminated with status: {:?}", status);
                            break;
                        }
                        _ => {}
                    }
                }
            });

            println!("netstacks-agent sidecar started");

            // First-run only: explain macOS Local Network requirement and
            // trigger the OS prompt. No-op on other platforms and on
            // subsequent launches.
            maybe_prompt_for_lan_access(app.handle());

            Ok(())
        })
        .on_menu_event(|app, event| {
            // Handle custom menu item clicks and emit frontend events
            let id = event.id();

            // Handle "New Window" directly (opens a full second app instance)
            if id.as_ref() == "new-window" {
                use tauri::WebviewWindowBuilder;
                let window_id = format!("window-{}", std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis());
                let _ = WebviewWindowBuilder::new(
                    app,
                    &window_id,
                    tauri::WebviewUrl::App("index.html".into()),
                )
                .title("NetStacks")
                .inner_size(1280.0, 800.0)
                .min_inner_size(800.0, 500.0)
                .build();
                return;
            }

            let event_name = match id.as_ref() {
                "new-session" => Some("menu://new-session"),
                "new-terminal" => Some("menu://new-terminal"),
                "new-document" => Some("menu://new-document"),
                "quick-connect" => Some("menu://quick-connect"),
                "save" => Some("menu://save"),
                "close-tab" => Some("menu://close-tab"),
                "settings" => Some("menu://settings"),
                "find" => Some("menu://find"),
                "command-palette" => Some("menu://command-palette"),
                "toggle-sidebar" => Some("menu://toggle-sidebar"),
                "toggle-ai-panel" => Some("menu://toggle-ai-panel"),
                "zoom-reset" => Some("menu://zoom-reset"),
                "zoom-in" => Some("menu://zoom-in"),
                "zoom-out" => Some("menu://zoom-out"),
                "reconnect" => Some("menu://reconnect"),
                "toggle-multi-send" => Some("menu://toggle-multi-send"),
                "connect-selected" => Some("menu://connect-selected"),
                "start-troubleshooting" => Some("menu://start-troubleshooting"),
                "next-tab" => Some("menu://next-tab"),
                "previous-tab" => Some("menu://previous-tab"),
                "open-docs" => Some("menu://open-docs"),
                "about" => Some("menu://about"),
                _ => None,
            };
            if let Some(name) = event_name {
                app.emit(name, ()).ok();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                // Kill the sidecar agent when the app exits
                if let Some(state) = app.try_state::<SidecarChild>() {
                    if let Some(child) = state.0.lock().unwrap().take() {
                        println!("[sidecar] Killing agent process on app exit");
                        let _ = child.kill();
                    }
                }
            }
        });
}

/// Build the native menu bar with platform-appropriate structure.
/// On macOS: NetStacks app menu + File/Edit/View/Session/Window/Help
/// On Windows/Linux: File (with Settings/Exit) + Edit/View/Session/Window/Help (with About)
#[allow(unused_mut)] // mut needed on Windows/Linux for conditional menu items
fn build_menu(handle: &tauri::AppHandle) -> Result<Menu<tauri::Wry>, tauri::Error> {
    let mut menu_builder = MenuBuilder::new(handle);

    // === macOS App Menu ===
    // On macOS, the first submenu becomes the system app menu
    #[cfg(target_os = "macos")]
    {
        let about = MenuItemBuilder::with_id("about", "About NetStacks")
            .build(handle)?;
        let settings = MenuItemBuilder::with_id("settings", "Settings\u{2026}")
            .accelerator("CmdOrCtrl+,")
            .build(handle)?;

        let app_menu = SubmenuBuilder::new(handle, "NetStacks")
            .item(&about)
            .separator()
            .item(&settings)
            .separator()
            .item(&PredefinedMenuItem::services(handle, None)?)
            .separator()
            .item(&PredefinedMenuItem::hide(handle, None)?)
            .item(&PredefinedMenuItem::hide_others(handle, None)?)
            .item(&PredefinedMenuItem::show_all(handle, None)?)
            .separator()
            .item(&PredefinedMenuItem::quit(handle, Some("Quit NetStacks"))?)
            .build()?;
        menu_builder = menu_builder.item(&app_menu);
    }

    // === File Menu ===
    let new_session = MenuItemBuilder::with_id("new-session", "New Session")
        .accelerator("CmdOrCtrl+N")
        .build(handle)?;
    let new_terminal = MenuItemBuilder::with_id("new-terminal", "New Terminal Tab")
        .accelerator("CmdOrCtrl+T")
        .build(handle)?;
    let new_document = MenuItemBuilder::with_id("new-document", "New Document")
        .accelerator("CmdOrCtrl+Shift+N")
        .build(handle)?;
    let quick_connect = MenuItemBuilder::with_id("quick-connect", "Quick Connect\u{2026}")
        .accelerator("CmdOrCtrl+Shift+Q")
        .build(handle)?;
    let save = MenuItemBuilder::with_id("save", "Save")
        .accelerator("CmdOrCtrl+S")
        .build(handle)?;
    let close_tab = MenuItemBuilder::with_id("close-tab", "Close Tab")
        .accelerator("CmdOrCtrl+W")
        .build(handle)?;

    let mut file_builder = SubmenuBuilder::new(handle, "File")
        .item(&new_session)
        .item(&new_terminal)
        .item(&new_document)
        .separator()
        .item(&quick_connect)
        .separator()
        .item(&save)
        .separator()
        .item(&close_tab);

    // On Windows/Linux, add Settings and Exit to File menu
    #[cfg(not(target_os = "macos"))]
    {
        let settings = MenuItemBuilder::with_id("settings", "Settings\u{2026}")
            .accelerator("CmdOrCtrl+,")
            .build(handle)?;
        file_builder = file_builder
            .separator()
            .item(&settings)
            .separator()
            .item(&PredefinedMenuItem::quit(handle, Some("Exit"))?);
    }

    let file_menu = file_builder.build()?;

    // === Edit Menu ===
    let find = MenuItemBuilder::with_id("find", "Find\u{2026}")
        .accelerator("CmdOrCtrl+F")
        .build(handle)?;

    let edit_menu = SubmenuBuilder::new(handle, "Edit")
        .item(&PredefinedMenuItem::undo(handle, None)?)
        .item(&PredefinedMenuItem::redo(handle, None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(handle, None)?)
        .item(&PredefinedMenuItem::copy(handle, None)?)
        .item(&PredefinedMenuItem::paste(handle, None)?)
        .item(&PredefinedMenuItem::select_all(handle, None)?)
        .separator()
        .item(&find)
        .build()?;

    // === View Menu ===
    let command_palette = MenuItemBuilder::with_id("command-palette", "Command Palette\u{2026}")
        .accelerator("CmdOrCtrl+Shift+P")
        .build(handle)?;
    let toggle_sidebar = MenuItemBuilder::with_id("toggle-sidebar", "Toggle Sidebar")
        .accelerator("CmdOrCtrl+B")
        .build(handle)?;
    let toggle_ai_panel = MenuItemBuilder::with_id("toggle-ai-panel", "Toggle AI Panel")
        .accelerator("CmdOrCtrl+I")
        .build(handle)?;
    let zoom_reset = MenuItemBuilder::with_id("zoom-reset", "Actual Size")
        .accelerator("CmdOrCtrl+0")
        .build(handle)?;
    let zoom_in = MenuItemBuilder::with_id("zoom-in", "Zoom In")
        .accelerator("CmdOrCtrl+=")
        .build(handle)?;
    let zoom_out = MenuItemBuilder::with_id("zoom-out", "Zoom Out")
        .accelerator("CmdOrCtrl+-")
        .build(handle)?;

    let view_menu = SubmenuBuilder::new(handle, "View")
        .item(&command_palette)
        .separator()
        .item(&toggle_sidebar)
        .item(&toggle_ai_panel)
        .separator()
        .item(&zoom_reset)
        .item(&zoom_in)
        .item(&zoom_out)
        .separator()
        .item(&PredefinedMenuItem::fullscreen(handle, None)?)
        .build()?;

    // === Session Menu ===
    let reconnect = MenuItemBuilder::with_id("reconnect", "Reconnect")
        .accelerator("CmdOrCtrl+Shift+R")
        .build(handle)?;
    let toggle_multi_send = MenuItemBuilder::with_id("toggle-multi-send", "Toggle Multi-Send")
        .accelerator("CmdOrCtrl+Shift+M")
        .build(handle)?;
    let connect_selected = MenuItemBuilder::with_id("connect-selected", "Connect Selected Sessions")
        .accelerator("CmdOrCtrl+Shift+Return")
        .build(handle)?;
    let start_troubleshooting =
        MenuItemBuilder::with_id("start-troubleshooting", "Start Troubleshooting\u{2026}")
            .accelerator("CmdOrCtrl+Shift+K")
            .build(handle)?;

    let session_menu = SubmenuBuilder::new(handle, "Session")
        .item(&reconnect)
        .item(&toggle_multi_send)
        .separator()
        .item(&connect_selected)
        .separator()
        .item(&start_troubleshooting)
        .build()?;

    // === Window Menu ===
    let new_window = MenuItemBuilder::with_id("new-window", "New Window")
        .accelerator("CmdOrCtrl+Shift+N")
        .build(handle)?;
    let next_tab = MenuItemBuilder::with_id("next-tab", "Show Next Tab")
        .accelerator("CmdOrCtrl+Shift+]")
        .build(handle)?;
    let prev_tab = MenuItemBuilder::with_id("previous-tab", "Show Previous Tab")
        .accelerator("CmdOrCtrl+Shift+[")
        .build(handle)?;

    let window_menu = SubmenuBuilder::new(handle, "Window")
        .item(&new_window)
        .separator()
        .item(&PredefinedMenuItem::minimize(handle, None)?)
        .item(&PredefinedMenuItem::maximize(handle, None)?)
        .separator()
        .item(&next_tab)
        .item(&prev_tab)
        .build()?;

    // === Help Menu ===
    let open_docs = MenuItemBuilder::with_id("open-docs", "NetStacks Documentation")
        .build(handle)?;

    let mut help_builder = SubmenuBuilder::new(handle, "Help")
        .item(&open_docs);

    // On Windows/Linux, add About to Help menu (on macOS it's in the app menu)
    #[cfg(not(target_os = "macos"))]
    {
        let about = MenuItemBuilder::with_id("about", "About NetStacks")
            .build(handle)?;
        help_builder = help_builder
            .separator()
            .item(&about);
    }

    let help_menu = help_builder.build()?;

    // Build the complete menu bar
    menu_builder
        .item(&file_menu)
        .item(&edit_menu)
        .item(&view_menu)
        .item(&session_menu)
        .item(&window_menu)
        .item(&help_menu)
        .build()
}
