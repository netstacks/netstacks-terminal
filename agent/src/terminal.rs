use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex, RwLock};
use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};
use std::io::{Read, Write};
use crate::models::PortForward;
use crate::ssh::{SshSession, SshConfig, SshAuth};
use crate::telnet::{TelnetConfig, TelnetSession};

/// Message types for terminal communication
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", content = "data")]
pub enum TerminalMessage {
    /// Data to write to the terminal
    Input(String),
    /// Data from the terminal
    Output(String),
    /// Resize the terminal
    Resize { cols: u16, rows: u16 },
    /// Terminal closed
    Close,
    /// Error occurred
    Error(String),
}

/// Inner session type - either local PTY or native SSH
enum SessionKind {
    /// Local shell via PTY
    Local {
        writer: Arc<Mutex<Box<dyn Write + Send>>>,
        master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    },
    /// Native SSH via russh
    Ssh {
        session: Arc<SshSession>,
    },
    /// Telnet via raw TCP
    Telnet {
        session: Arc<TelnetSession>,
    },
}

/// A terminal session (local PTY or SSH)
pub struct TerminalSession {
    pub id: String,
    kind: SessionKind,
    _reader_handle: tokio::task::JoinHandle<()>,
}

impl TerminalSession {
    /// Create a new local PTY session
    pub fn new_local(
        id: String,
        output_tx: mpsc::UnboundedSender<TerminalMessage>,
        initial_cols: u32,
        initial_rows: u32,
    ) -> Result<Self, anyhow::Error> {
        let pty_system = native_pty_system();

        let pair = pty_system.openpty(PtySize {
            rows: if initial_rows == 0 { 24 } else { initial_rows as u16 },
            cols: if initial_cols == 0 { 80 } else { initial_cols as u16 },
            pixel_width: 0,
            pixel_height: 0,
        })?;

        #[cfg(target_os = "windows")]
        let (shell, login_flag) = {
            let shell = ["pwsh.exe", "powershell.exe", "cmd.exe"]
                .iter()
                .find(|&&s| which::which(s).is_ok())
                .map(|&s| s.to_string())
                .unwrap_or_else(|| "cmd.exe".to_string());
            (shell, None::<&str>)
        };
        #[cfg(not(target_os = "windows"))]
        let (shell, login_flag) = (
            std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string()),
            Some("-l"),
        );

        let mut cmd = CommandBuilder::new(&shell);
        if let Some(flag) = login_flag {
            cmd.arg(flag);
        }

        // AUDIT FIX (EXEC-011): start from a clean env and forward only the
        // known-safe vars below. The local PTY is a full-trust shell to the
        // local user, but we still strip vars that could leak NetStacks
        // internals (auth tokens, vault material, integration creds, sidecar
        // config) to arbitrary commands the user runs. The login shell will
        // set its own $HOME/$PATH/$LANG/etc. from the system profile.
        cmd.env_clear();
        #[cfg(not(target_os = "windows"))]
        const FORWARDED_ENV: &[&str] = &[
            "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TZ",
            "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "SHELL",
        ];
        #[cfg(target_os = "windows")]
        const FORWARDED_ENV: &[&str] = &[
            "USERPROFILE", "USERNAME", "USERDOMAIN", "APPDATA", "LOCALAPPDATA",
            "TEMP", "TMP", "COMPUTERNAME", "HOMEDRIVE", "HOMEPATH",
        ];
        for var in FORWARDED_ENV {
            if let Ok(value) = std::env::var(var) {
                cmd.env(var, value);
            }
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("PATH", std::env::var("PATH").unwrap_or_else(|_| {
            #[cfg(target_os = "windows")]
            return r"C:\Windows\System32;C:\Windows;C:\Windows\System32\Wbem".to_string();
            #[cfg(not(target_os = "windows"))]
            return "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin".to_string();
        }));

        let _child = pair.slave.spawn_command(cmd)?;
        drop(pair.slave);

        let writer: Box<dyn Write + Send> = pair.master.take_writer()?;
        let writer = Arc::new(Mutex::new(writer));
        let mut reader = pair.master.try_clone_reader()?;
        let master: Box<dyn MasterPty + Send> = pair.master;
        let master = Arc::new(Mutex::new(master));

        // Spawn a task to read from PTY and send to output channel
        let reader_handle = tokio::task::spawn_blocking(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => {
                        let _ = output_tx.send(TerminalMessage::Close);
                        break;
                    }
                    Ok(n) => {
                        let data = String::from_utf8_lossy(&buf[..n]).to_string();
                        if output_tx.send(TerminalMessage::Output(data)).is_err() {
                            break;
                        }
                    }
                    Err(e) => {
                        let _ = output_tx.send(TerminalMessage::Error(e.to_string()));
                        break;
                    }
                }
            }
        });

        Ok(Self {
            id,
            kind: SessionKind::Local { writer, master },
            _reader_handle: reader_handle,
        })
    }

    /// Create a new SSH session using native russh library
    pub async fn new_ssh(
        id: String,
        output_tx: mpsc::UnboundedSender<TerminalMessage>,
        host: &str,
        port: u16,
        username: &str,
        password: Option<&str>,
        key_path: Option<&str>,
        key_passphrase: Option<&str>,
        // Jump host / proxy support
        jump_host: Option<&str>,
        jump_port: Option<u16>,
        jump_username: Option<&str>,
        // Port forwarding - delegated to TunnelManager
        port_forwards: Vec<PortForward>,
        // Legacy SSH support for older devices
        legacy_ssh: bool,
        // Initial PTY dimensions from frontend (0 = use defaults)
        initial_cols: u32,
        initial_rows: u32,
    ) -> Result<Self, anyhow::Error> {
        // Port forwards are started via TunnelManager in ws.rs, not here
        let _ = port_forwards;

        // If jump host is configured, use PTY-based SSH with ProxyJump flag
        // This is simpler and more reliable than native russh channel tunneling
        if let Some(jump) = jump_host {
            tracing::info!("Creating SSH session to {} via jump host {}", host, jump);

            // Build jump host specification for -J flag
            let jump_user = jump_username.unwrap_or(username);
            let jump_p = jump_port.unwrap_or(22);
            let jump_spec = format!("{}@{}:{}", jump_user, jump, jump_p);

            // Build SSH command with ProxyJump
            let mut cmd = CommandBuilder::new("ssh");
            cmd.arg("-J");
            cmd.arg(&jump_spec);
            cmd.arg("-p");
            cmd.arg(port.to_string());

            // Add key or handle password auth
            if let Some(key) = key_path {
                cmd.arg("-i");
                cmd.arg(key);
            }
            // Note: Password auth through jump host would require sshpass
            // which we'll handle in a future iteration if needed

            // TOFU: auto-add new host keys to known_hosts, reject changes.
            // Matches the trust model of the direct (russh) SSH path —
            // never silently accept a key that doesn't match a previously-seen
            // one for the same host.
            cmd.arg("-o");
            cmd.arg("StrictHostKeyChecking=accept-new");

            if legacy_ssh {
                cmd.arg("-o");
                cmd.arg("KexAlgorithms=+diffie-hellman-group14-sha1,diffie-hellman-group1-sha1");
                cmd.arg("-o");
                cmd.arg("HostKeyAlgorithms=+ssh-rsa,ssh-dss");
            }

            cmd.arg(format!("{}@{}", username, host));
            cmd.env("TERM", "xterm-256color");

            // Create PTY session for jump host connection
            let pty_system = native_pty_system();
            let pair = pty_system.openpty(PtySize {
                rows: if initial_rows == 0 { 24 } else { initial_rows as u16 },
                cols: if initial_cols == 0 { 80 } else { initial_cols as u16 },
                pixel_width: 0,
                pixel_height: 0,
            })?;

            let _child = pair.slave.spawn_command(cmd)?;
            drop(pair.slave);

            let writer: Box<dyn Write + Send> = pair.master.take_writer()?;
            let writer = Arc::new(Mutex::new(writer));
            let mut reader = pair.master.try_clone_reader()?;
            let master: Box<dyn MasterPty + Send> = pair.master;
            let master = Arc::new(Mutex::new(master));

            // Spawn reader task for PTY output
            let reader_handle = tokio::task::spawn_blocking(move || {
                let mut buf = [0u8; 4096];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => {
                            let _ = output_tx.send(TerminalMessage::Close);
                            break;
                        }
                        Ok(n) => {
                            let data = String::from_utf8_lossy(&buf[..n]).to_string();
                            if output_tx.send(TerminalMessage::Output(data)).is_err() {
                                break;
                            }
                        }
                        Err(e) => {
                            let _ = output_tx.send(TerminalMessage::Error(e.to_string()));
                            break;
                        }
                    }
                }
            });

            return Ok(Self {
                id,
                kind: SessionKind::Local { writer, master },
                _reader_handle: reader_handle,
            });
        }

        // Direct connection (no jump host) - use native russh
        // Build authentication method
        let auth = if let Some(password) = password {
            SshAuth::Password(password.to_string())
        } else if let Some(key_path) = key_path {
            SshAuth::KeyFile {
                path: key_path.to_string(),
                passphrase: key_passphrase.map(|s| s.to_string()),
            }
        } else {
            return Err(anyhow::anyhow!("No authentication method provided"));
        };

        let config = SshConfig {
            host: host.to_string(),
            port,
            username: username.to_string(),
            auth,
            legacy_ssh,
        };

        // Connect to SSH server with initial PTY dimensions
        let session = SshSession::connect(config, initial_cols, initial_rows)
            .await
            .map_err(|e| anyhow::anyhow!("SSH connection failed: {}", e))?;

        let session = Arc::new(session);
        let session_for_reader = session.clone();

        // Spawn a task to read from SSH session and send to output channel
        let reader_handle = tokio::spawn(async move {
            loop {
                match session_for_reader.recv().await {
                    Ok(Some(data)) => {
                        if data.is_empty() {
                            continue;
                        }
                        let text = String::from_utf8_lossy(&data).to_string();
                        if output_tx.send(TerminalMessage::Output(text)).is_err() {
                            break;
                        }
                    }
                    Ok(None) => {
                        // Channel closed
                        let _ = output_tx.send(TerminalMessage::Close);
                        break;
                    }
                    Err(e) => {
                        let _ = output_tx.send(TerminalMessage::Error(e.to_string()));
                        break;
                    }
                }
            }
        });

        Ok(Self {
            id,
            kind: SessionKind::Ssh { session },
            _reader_handle: reader_handle,
        })
    }

    /// Create a new Telnet session
    pub async fn new_telnet(
        output_tx: mpsc::UnboundedSender<TerminalMessage>,
        host: String,
        port: u16,
        username: Option<String>,
        password: Option<String>,
    ) -> Result<Self, anyhow::Error> {
        let config = TelnetConfig {
            host,
            port,
            username,
            password,
        };

        let session = TelnetSession::connect(config)
            .await
            .map_err(|e| anyhow::anyhow!("Telnet connection failed: {}", e))?;

        let session = Arc::new(session);
        let id = uuid::Uuid::new_v4().to_string();

        // Spawn reader task (same pattern as SSH)
        let reader_session = session.clone();
        let reader_handle = tokio::spawn(async move {
            loop {
                match reader_session.recv().await {
                    Ok(Some(data)) => {
                        let text = String::from_utf8_lossy(&data).to_string();
                        if output_tx.send(TerminalMessage::Output(text)).is_err() {
                            break;
                        }
                    }
                    Ok(None) | Err(_) => break,
                }
            }
        });

        Ok(Self {
            id,
            kind: SessionKind::Telnet { session },
            _reader_handle: reader_handle,
        })
    }

    /// Write data to the terminal
    pub async fn write(&self, data: &str) -> Result<(), anyhow::Error> {
        match &self.kind {
            SessionKind::Local { writer, .. } => {
                let mut writer = writer.lock().await;
                writer.write_all(data.as_bytes())?;
                writer.flush()?;
                Ok(())
            }
            SessionKind::Ssh { session } => {
                session.send(data.as_bytes()).await
                    .map_err(|e| anyhow::anyhow!("Failed to send data: {}", e))
            }
            SessionKind::Telnet { session } => {
                session.send(data.as_bytes()).await
                    .map_err(|e| anyhow::anyhow!("Failed to send data: {}", e))
            }
        }
    }

    /// Resize the terminal PTY
    pub async fn resize(&self, cols: u32, rows: u32) -> Result<(), anyhow::Error> {
        match &self.kind {
            SessionKind::Local { master, .. } => {
                let master = master.lock().await;
                master.resize(PtySize {
                    rows: rows as u16,
                    cols: cols as u16,
                    pixel_width: 0,
                    pixel_height: 0,
                })?;
                Ok(())
            }
            SessionKind::Ssh { session } => {
                session.resize(cols, rows).await
                    .map_err(|e| anyhow::anyhow!("Failed to resize: {}", e))
            }
            SessionKind::Telnet { session } => {
                session.resize(cols as u16, rows as u16).await
                    .map_err(|e| anyhow::anyhow!("Failed to resize telnet: {}", e))
            }
        }
    }
}

/// Manager for all terminal sessions
pub struct TerminalManager {
    sessions: RwLock<HashMap<String, Arc<TerminalSession>>>,
}

impl TerminalManager {
    pub fn new() -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
        }
    }

    /// Create a new local terminal session
    pub async fn create_local_session(
        &self,
        output_tx: mpsc::UnboundedSender<TerminalMessage>,
        initial_cols: u32,
        initial_rows: u32,
    ) -> Result<String, anyhow::Error> {
        let id = uuid::Uuid::new_v4().to_string();
        let session = TerminalSession::new_local(id.clone(), output_tx, initial_cols, initial_rows)?;

        self.sessions
            .write()
            .await
            .insert(id.clone(), Arc::new(session));

        Ok(id)
    }

    /// Create a new SSH terminal session using native russh
    pub async fn create_ssh_session(
        &self,
        output_tx: mpsc::UnboundedSender<TerminalMessage>,
        host: &str,
        port: u16,
        username: &str,
        password: Option<&str>,
        key_path: Option<&str>,
        key_passphrase: Option<&str>,
        // Jump host / proxy support (Phase 06.2)
        jump_host: Option<&str>,
        jump_port: Option<u16>,
        jump_username: Option<&str>,
        // Port forwarding (Phase 06.3)
        port_forwards: Vec<PortForward>,
        // Legacy SSH support for older devices
        legacy_ssh: bool,
        // Initial PTY dimensions from frontend
        initial_cols: u32,
        initial_rows: u32,
    ) -> Result<String, anyhow::Error> {
        let id = uuid::Uuid::new_v4().to_string();
        let session = TerminalSession::new_ssh(
            id.clone(),
            output_tx,
            host,
            port,
            username,
            password,
            key_path,
            key_passphrase,
            jump_host,
            jump_port,
            jump_username,
            port_forwards,
            legacy_ssh,
            initial_cols,
            initial_rows,
        ).await?;

        self.sessions
            .write()
            .await
            .insert(id.clone(), Arc::new(session));

        Ok(id)
    }

    /// Create a new Telnet terminal session
    pub async fn create_telnet_session(
        &self,
        output_tx: mpsc::UnboundedSender<TerminalMessage>,
        host: String,
        port: u16,
        username: Option<String>,
        password: Option<String>,
    ) -> Result<String, anyhow::Error> {
        let session = TerminalSession::new_telnet(
            output_tx,
            host,
            port,
            username,
            password,
        ).await?;

        let id = session.id.clone();
        self.sessions
            .write()
            .await
            .insert(id.clone(), Arc::new(session));

        Ok(id)
    }

    /// Get a session by ID
    pub async fn get_session(&self, id: &str) -> Option<Arc<TerminalSession>> {
        self.sessions.read().await.get(id).cloned()
    }

    /// Remove a session
    pub async fn remove_session(&self, id: &str) {
        self.sessions.write().await.remove(id);
    }
}

impl Default for TerminalManager {
    fn default() -> Self {
        Self::new()
    }
}

// SAFETY: TerminalManager's only field is `sessions: RwLock<HashMap<String, Arc<TerminalSession>>>`.
// RwLock, HashMap, and Arc are all Send+Sync when their contents are. TerminalSession contains
// SessionKind whose non-Send PTY types (Box<dyn MasterPty + Send>, Box<dyn Write + Send>) are
// wrapped in Arc<tokio::sync::Mutex<...>>, ensuring exclusive access across threads. The write()
// and resize() methods acquire the Mutex lock before any PTY operation. SshSession and
// TelnetSession are already Send+Sync. JoinHandle<()> is Send+Sync.
unsafe impl Send for TerminalManager {}
unsafe impl Sync for TerminalManager {}
