//! ProxyJump implementation using native russh.
//!
//! Connects to a target host through a jump host by:
//! 1. Authenticating to the jump host
//! 2. Opening a direct-tcpip channel from jump to target
//! 3. Running a second russh client over that channel
//! 4. Authenticating to the target
//!
//! This replaces the broken PTY-based `ssh -J` path that incorrectly
//! shared the target's credentials across both hops.

use crate::ssh::{SshConfig, SshError, approvals::HostKeyApprovalService};
use russh::client::Handle;
use std::sync::Arc;

use super::ClientHandler;

/// Connect to a target host through a jump host.
///
/// Authenticates each hop with its own credentials and returns a russh
/// `Handle` to the target. The caller can open channels (PTY, SFTP, etc.)
/// on the returned handle exactly as if they had connected directly.
///
/// The jump session is kept alive by the channel reference; when the
/// caller drops the target handle, the channel closes and the jump exits.
pub async fn connect_via_jump(
    target: &SshConfig,
    jump: &SshConfig,
    approvals: Option<Arc<HostKeyApprovalService>>,
) -> Result<Handle<ClientHandler>, SshError> {
    // Step 1: Connect and authenticate to jump host.
    let jump_handle = super::connect_and_authenticate_with_approvals(
        jump,
        false,
        approvals.clone(),
    )
    .await?;

    // Step 2: Open direct-tcpip channel from jump to target.
    let channel = jump_handle
        .channel_open_direct_tcpip(
            target.host.clone(),
            target.port as u32,
            "127.0.0.1".to_string(),
            0u32,
        )
        .await
        .map_err(|e| {
            SshError::ChannelError(format!(
                "Jump host refused to open a tunnel to {}:{} ({}). \
                 Check that the jump host permits TCP forwarding (AllowTcpForwarding yes).",
                target.host, target.port, e
            ))
        })?;

    // Step 3: Wrap the channel as AsyncRead + AsyncWrite.
    let stream = channel.into_stream();

    // Step 4: Build russh client over the stream and authenticate to target.
    let target_handle =
        super::connect_and_authenticate_over_stream(target, stream, approvals).await?;

    // Step 5: The channel keeps a reference to the jump session, so we can
    // drop the jump_handle here. When the caller drops target_handle, the
    // channel closes and the jump session exits cleanly.
    drop(jump_handle);

    Ok(target_handle)
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh::keys::ssh_key;
    use russh::keys::PrivateKey;
    use russh::server::{Auth, Config as ServerConfig, Msg, Server, Session};
    use russh::{Channel, ChannelId};
    use std::net::SocketAddr;
    use std::sync::Arc as StdArc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    /// Configuration for the test SSH server.
    #[derive(Clone)]
    struct TestServerConfig {
        /// If Some, accept password auth with this (username, password).
        accept_password: Option<(String, String)>,
        /// If Some, accept publickey auth from this username (any key).
        accept_key_user: Option<String>,
        /// Whether to allow direct-tcpip channels.
        allow_direct_tcpip: bool,
        /// Host key for the server.
        host_key: PrivateKey,
    }

    /// Test server handler — implements both `Server` and `Handler`.
    /// The Server trait creates new Handler instances for each client; we
    /// just clone ourselves since the config is shared via Arc.
    #[derive(Clone)]
    struct TestServer {
        cfg: StdArc<TestServerConfig>,
    }

    impl Server for TestServer {
        type Handler = Self;
        fn new_client(&mut self, _peer: Option<SocketAddr>) -> Self::Handler {
            self.clone()
        }
    }

    impl russh::server::Handler for TestServer {
        type Error = russh::Error;

        async fn auth_password(
            &mut self,
            user: &str,
            password: &str,
        ) -> Result<Auth, Self::Error> {
            if let Some((u, p)) = &self.cfg.accept_password {
                if user == u && password == p {
                    return Ok(Auth::Accept);
                }
            }
            Ok(Auth::reject())
        }

        async fn auth_publickey(
            &mut self,
            user: &str,
            _public_key: &ssh_key::PublicKey,
        ) -> Result<Auth, Self::Error> {
            if let Some(accept_user) = &self.cfg.accept_key_user {
                if user == accept_user {
                    return Ok(Auth::Accept);
                }
            }
            Ok(Auth::reject())
        }

        async fn channel_open_session(
            &mut self,
            _channel: Channel<Msg>,
            _session: &mut Session,
        ) -> Result<bool, Self::Error> {
            // Accept session channels (target needs this for shell).
            Ok(true)
        }

        async fn channel_open_direct_tcpip(
            &mut self,
            channel: Channel<Msg>,
            host_to_connect: &str,
            port_to_connect: u32,
            _originator_address: &str,
            _originator_port: u32,
            _session: &mut Session,
        ) -> Result<bool, Self::Error> {
            if !self.cfg.allow_direct_tcpip {
                return Ok(false);
            }

            // Connect to the actual target and bridge data through this channel.
            let addr = format!("{}:{}", host_to_connect, port_to_connect);
            let stream = match TcpStream::connect(&addr).await {
                Ok(s) => s,
                Err(_) => return Ok(false),
            };

            tokio::spawn(async move {
                let _ = pump_channel_to_socket(channel, stream).await;
            });
            Ok(true)
        }

        async fn shell_request(
            &mut self,
            channel: ChannelId,
            session: &mut Session,
        ) -> Result<(), Self::Error> {
            // Emit a "READY\n" banner that the test checks for. Spawn the
            // write so we don't block the request handler.
            let handle = session.handle();
            tokio::spawn(async move {
                let _ = handle.data(channel, b"READY\n".to_vec().into()).await;
            });
            Ok(())
        }
    }

    /// Bridge a russh server channel <-> a real TCP socket.
    /// Used by the jump server to forward client traffic to the target.
    async fn pump_channel_to_socket(
        mut channel: Channel<Msg>,
        mut stream: TcpStream,
    ) -> std::io::Result<()> {
        let mut buf = vec![0u8; 8192];
        loop {
            tokio::select! {
                msg = channel.wait() => {
                    match msg {
                        Some(russh::ChannelMsg::Data { data }) => {
                            stream.write_all(&data).await?;
                        }
                        None | Some(russh::ChannelMsg::Eof) | Some(russh::ChannelMsg::Close) => break,
                        _ => {}
                    }
                }
                n = stream.read(&mut buf) => {
                    match n? {
                        0 => break,
                        n => {
                            channel.data(&buf[..n]).await
                                .map_err(|e| std::io::Error::new(
                                    std::io::ErrorKind::Other, e.to_string()
                                ))?;
                        }
                    }
                }
            }
        }
        Ok(())
    }

    /// Start a russh server on an ephemeral port. Returns its bound address.
    async fn start_test_server(cfg: TestServerConfig) -> SocketAddr {
        let host_key = cfg.host_key.clone();
        let server_config = Arc::new(ServerConfig {
            keys: vec![host_key],
            // Short auth rejection times so failure tests don't take forever.
            auth_rejection_time: std::time::Duration::from_millis(10),
            auth_rejection_time_initial: Some(std::time::Duration::from_millis(0)),
            ..Default::default()
        });

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = TestServer {
            cfg: StdArc::new(cfg),
        };

        tokio::spawn(async move {
            loop {
                let (sock, peer) = match listener.accept().await {
                    Ok(x) => x,
                    Err(_) => break,
                };
                let mut srv = server.clone();
                let handler = russh::server::Server::new_client(&mut srv, Some(peer));
                let cfg = server_config.clone();
                tokio::spawn(async move {
                    let _ = russh::server::run_stream(cfg, sock, handler).await;
                });
            }
        });

        addr
    }

    fn ephemeral_ed25519() -> PrivateKey {
        PrivateKey::random(&mut rand::rngs::OsRng, ssh_key::Algorithm::Ed25519).unwrap()
    }

    fn write_temp_key(key: &PrivateKey) -> std::path::PathBuf {
        let dir = tempfile::tempdir().unwrap().keep();
        let path = dir.join("id_test");
        let pem = key.to_openssh(ssh_key::LineEnding::LF).unwrap();
        std::fs::write(&path, pem.as_bytes()).unwrap();
        path
    }

    #[tokio::test]
    async fn connects_through_jump_with_key_then_password() {
        let jump_host_key = ephemeral_ed25519();
        let target_host_key = ephemeral_ed25519();

        // Jump host: accepts publickey auth as "jumpuser".
        let jump_addr = start_test_server(TestServerConfig {
            accept_password: None,
            accept_key_user: Some("jumpuser".into()),
            allow_direct_tcpip: true,
            host_key: jump_host_key,
        })
        .await;

        // Target host: accepts password auth as devuser/devpw.
        let target_addr = start_test_server(TestServerConfig {
            accept_password: Some(("devuser".into(), "devpw".into())),
            accept_key_user: None,
            allow_direct_tcpip: false,
            host_key: target_host_key,
        })
        .await;

        let jump_key = ephemeral_ed25519();
        let key_path = write_temp_key(&jump_key);

        let jump_cfg = SshConfig {
            host: jump_addr.ip().to_string(),
            port: jump_addr.port(),
            username: "jumpuser".into(),
            auth: crate::ssh::SshAuth::KeyFile {
                path: key_path.to_string_lossy().into(),
                passphrase: None,
            },
            legacy_ssh: false,
        };
        let target_cfg = SshConfig {
            host: target_addr.ip().to_string(),
            port: target_addr.port(),
            username: "devuser".into(),
            auth: crate::ssh::SshAuth::Password("devpw".into()),
            legacy_ssh: false,
        };

        let handle = connect_via_jump(&target_cfg, &jump_cfg, None)
            .await
            .expect("should connect through jump");

        // Open a session and request shell to confirm we're talking to TARGET.
        let mut ch = handle.channel_open_session().await.unwrap();
        ch.request_shell(false).await.unwrap();

        // Wait for the READY banner the target's shell_request emits.
        let mut got_ready = false;
        for _ in 0..20 {
            match tokio::time::timeout(std::time::Duration::from_secs(2), ch.wait()).await {
                Ok(Some(russh::ChannelMsg::Data { data })) => {
                    let s = String::from_utf8_lossy(&data);
                    if s.contains("READY") {
                        got_ready = true;
                        break;
                    }
                }
                Ok(Some(_)) => continue,
                Ok(None) => break,
                Err(_) => break,
            }
        }
        assert!(got_ready, "expected READY banner from target shell");
    }

    #[tokio::test]
    async fn jump_auth_failure_returns_descriptive_error() {
        let jump_host_key = ephemeral_ed25519();
        let jump_addr = start_test_server(TestServerConfig {
            accept_password: Some(("right-user".into(), "right-pw".into())),
            accept_key_user: None,
            allow_direct_tcpip: true,
            host_key: jump_host_key,
        })
        .await;

        // Wrong creds for the jump host. Target server isn't even reachable —
        // the function should bail out at the jump-auth step.
        let jump_cfg = SshConfig {
            host: jump_addr.ip().to_string(),
            port: jump_addr.port(),
            username: "wrong-user".into(),
            auth: crate::ssh::SshAuth::Password("wrong-pw".into()),
            legacy_ssh: false,
        };
        let target_cfg = SshConfig {
            host: "127.0.0.1".into(),
            port: 1, // dummy — never reached
            username: "x".into(),
            auth: crate::ssh::SshAuth::Password("y".into()),
            legacy_ssh: false,
        };

        let err = match connect_via_jump(&target_cfg, &jump_cfg, None).await {
            Ok(_) => panic!("jump auth should fail"),
            Err(e) => e,
        };
        let msg = format!("{}", err);
        assert!(
            msg.to_lowercase().contains("auth") || msg.to_lowercase().contains("denied"),
            "expected auth-related error, got: {msg}"
        );
    }

    #[tokio::test]
    async fn target_auth_failure_returns_error_after_jump_succeeds() {
        let jump_host_key = ephemeral_ed25519();
        let target_host_key = ephemeral_ed25519();

        let jump_addr = start_test_server(TestServerConfig {
            accept_password: Some(("jumpuser".into(), "jumppw".into())),
            accept_key_user: None,
            allow_direct_tcpip: true,
            host_key: jump_host_key,
        })
        .await;
        let target_addr = start_test_server(TestServerConfig {
            accept_password: Some(("right".into(), "right".into())),
            accept_key_user: None,
            allow_direct_tcpip: false,
            host_key: target_host_key,
        })
        .await;

        // Correct jump creds, wrong target creds.
        let jump_cfg = SshConfig {
            host: jump_addr.ip().to_string(),
            port: jump_addr.port(),
            username: "jumpuser".into(),
            auth: crate::ssh::SshAuth::Password("jumppw".into()),
            legacy_ssh: false,
        };
        let target_cfg = SshConfig {
            host: target_addr.ip().to_string(),
            port: target_addr.port(),
            username: "wrong".into(),
            auth: crate::ssh::SshAuth::Password("wrong".into()),
            legacy_ssh: false,
        };

        let err = match connect_via_jump(&target_cfg, &jump_cfg, None).await {
            Ok(_) => panic!("target auth should fail"),
            Err(e) => e,
        };
        let msg = format!("{}", err);
        assert!(
            msg.to_lowercase().contains("auth") || msg.to_lowercase().contains("denied"),
            "expected auth-related error from target hop, got: {msg}"
        );
    }

    #[tokio::test]
    async fn jump_refuses_direct_tcpip_returns_descriptive_error() {
        let jump_host_key = ephemeral_ed25519();
        let jump_addr = start_test_server(TestServerConfig {
            accept_password: Some(("u".into(), "p".into())),
            accept_key_user: None,
            allow_direct_tcpip: false, // KEY: refuse forwarding
            host_key: jump_host_key,
        })
        .await;

        let jump_cfg = SshConfig {
            host: jump_addr.ip().to_string(),
            port: jump_addr.port(),
            username: "u".into(),
            auth: crate::ssh::SshAuth::Password("p".into()),
            legacy_ssh: false,
        };
        let target_cfg = SshConfig {
            host: "127.0.0.1".into(),
            port: 22,
            username: "x".into(),
            auth: crate::ssh::SshAuth::Password("y".into()),
            legacy_ssh: false,
        };

        let err = match connect_via_jump(&target_cfg, &jump_cfg, None).await {
            Ok(_) => panic!("jump should refuse direct-tcpip"),
            Err(e) => e,
        };
        let msg = format!("{}", err);
        assert!(
            msg.contains("AllowTcpForwarding") || msg.contains("refused"),
            "expected forwarding-refused message, got: {msg}"
        );
    }
}
