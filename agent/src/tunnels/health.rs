//! Health monitor and reconnect engine for SSH tunnels.
//!
//! Periodically checks pooled SSH connections for liveness and
//! automatically reconnects tunnels with exponential backoff when
//! connections fail.

use std::sync::Arc;
use std::time::Duration;

use crate::models::{Tunnel, TunnelStatus};

use super::{ConnectionKey, TunnelManager};

/// Trait for looking up tunnel definitions by ID.
///
/// The health monitor needs to retrieve full tunnel configs to attempt
/// reconnection. This is separate from DataProvider to keep the tunnel
/// module self-contained.
#[async_trait::async_trait]
pub trait TunnelProvider: Send + Sync {
    async fn get_tunnel(&self, id: &str) -> Option<Tunnel>;
}

impl TunnelManager {
    /// Start a background health monitor that periodically checks SSH
    /// connections for liveness.
    ///
    /// Runs every 30 seconds. When a connection is found to be dead,
    /// triggers reconnection for all tunnels using that connection.
    pub fn start_health_monitor(
        self: &Arc<Self>,
        tunnels_provider: Arc<dyn TunnelProvider>,
    ) {
        let manager = Arc::clone(self);

        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(30));

            loop {
                interval.tick().await;

                let dead_connections = manager.check_connections().await;

                for (key, tunnel_ids) in dead_connections {
                    tracing::warn!(
                        "Connection to {}:{} is dead, triggering reconnect for {} tunnel(s)",
                        key.host,
                        key.port,
                        tunnel_ids.len(),
                    );
                    manager
                        .handle_connection_failure(&key, &tunnel_ids, &tunnels_provider)
                        .await;
                }
            }
        });

        tracing::info!("Health monitor started (30s interval)");
    }

    /// Check all pooled connections and return any that appear dead.
    ///
    /// Currently checks if the connection still has associated active tunnels.
    /// Future versions may add SSH keepalive probing.
    async fn check_connections(&self) -> Vec<(ConnectionKey, Vec<String>)> {
        let conns = self.connections.read().await;
        let active = self.active_tunnels.read().await;
        let mut dead = Vec::new();

        for (key, conn) in conns.iter() {
            let guard = conn.lock().await;

            // Check if any tunnel IDs on this connection are no longer in
            // the active tunnels map (they may have been removed due to
            // task completion/failure without proper cleanup).
            let orphaned: Vec<String> = guard
                .tunnel_ids
                .iter()
                .filter(|id| !active.contains_key(*id))
                .cloned()
                .collect();

            if !orphaned.is_empty() && guard.tunnel_ids.len() == orphaned.len() {
                // All tunnels on this connection are gone — connection is stale
                dead.push((key.clone(), guard.tunnel_ids.clone()));
            }
        }

        dead
    }

    /// Handle a failed connection by marking its tunnels and attempting reconnection.
    ///
    /// For each tunnel on the failed connection:
    /// - If `auto_reconnect` is true, marks as Reconnecting and attempts backoff reconnect
    /// - If `auto_reconnect` is false, marks as Failed
    async fn handle_connection_failure(
        &self,
        conn_key: &ConnectionKey,
        tunnel_ids: &[String],
        tunnels_provider: &Arc<dyn TunnelProvider>,
    ) {
        // Remove the dead connection from the pool
        {
            let mut conns = self.connections.write().await;
            conns.remove(conn_key);
            tracing::info!(
                "Removed dead connection to {}:{} from pool",
                conn_key.host,
                conn_key.port,
            );
        }

        for tunnel_id in tunnel_ids {
            let tunnel = match tunnels_provider.get_tunnel(tunnel_id).await {
                Some(t) => t,
                None => {
                    tracing::warn!(
                        "Cannot reconnect tunnel {}: not found in provider",
                        tunnel_id,
                    );
                    continue;
                }
            };

            if tunnel.auto_reconnect {
                // Mark as Reconnecting
                self.update_tunnel_status(tunnel_id, TunnelStatus::Reconnecting)
                    .await;

                self.reconnect_with_backoff(&tunnel).await;
            } else {
                // Mark as Failed
                self.update_tunnel_status(tunnel_id, TunnelStatus::Failed)
                    .await;
                self.update_tunnel_error(
                    tunnel_id,
                    "Connection lost (auto_reconnect disabled)".to_string(),
                )
                .await;
                tracing::info!(
                    "Tunnel '{}' marked as failed (auto_reconnect=false)",
                    tunnel.name,
                );
            }
        }
    }

    /// Attempt to reconnect a tunnel with exponential backoff.
    ///
    /// Backoff schedule: 1s, 2s, 4s, 8s, 16s, 32s, 60s (capped).
    /// Respects `tunnel.max_retries` (0 means unlimited).
    async fn reconnect_with_backoff(&self, tunnel: &Tunnel) {
        let max_retries = if tunnel.max_retries == 0 {
            u32::MAX
        } else {
            tunnel.max_retries
        };

        for attempt in 1..=max_retries {
            let backoff = Duration::from_secs(std::cmp::min(
                1u64 << (attempt as u64 - 1).min(6),
                60,
            ));

            tracing::info!(
                "Reconnecting tunnel '{}' (attempt {}/{}, backoff {:?})",
                tunnel.name,
                attempt,
                if tunnel.max_retries == 0 {
                    "∞".to_string()
                } else {
                    max_retries.to_string()
                },
                backoff,
            );

            // Update retry count
            self.update_tunnel_retry_count(&tunnel.id, attempt).await;

            tokio::time::sleep(backoff).await;

            // Stop existing tunnel state (ignore errors — it may already be gone)
            let _ = self.stop_tunnel(&tunnel.id).await;

            // Attempt to start the tunnel fresh
            match self.start_tunnel(tunnel).await {
                Ok(()) => {
                    tracing::info!(
                        "Tunnel '{}' reconnected successfully on attempt {}",
                        tunnel.name,
                        attempt,
                    );
                    return;
                }
                Err(e) => {
                    tracing::warn!(
                        "Reconnect attempt {} for tunnel '{}' failed: {}",
                        attempt,
                        tunnel.name,
                        e,
                    );
                    self.update_tunnel_error(&tunnel.id, e).await;
                }
            }
        }

        // All retries exhausted
        tracing::error!(
            "Tunnel '{}' failed after {} reconnect attempts",
            tunnel.name,
            max_retries,
        );
        self.update_tunnel_status(&tunnel.id, TunnelStatus::Failed)
            .await;
        self.update_tunnel_error(
            &tunnel.id,
            format!("Reconnection failed after {} attempts", max_retries),
        )
        .await;
    }

    /// Update the status of an active tunnel.
    async fn update_tunnel_status(&self, tunnel_id: &str, status: TunnelStatus) {
        let active = self.active_tunnels.read().await;
        if let Some(at) = active.get(tunnel_id) {
            *at.status.lock().await = status;
        }
    }

    /// Update the last error of an active tunnel.
    async fn update_tunnel_error(&self, tunnel_id: &str, error: String) {
        let active = self.active_tunnels.read().await;
        if let Some(at) = active.get(tunnel_id) {
            *at.last_error.lock().await = Some(error);
        }
    }

    /// Update the retry count of an active tunnel.
    async fn update_tunnel_retry_count(&self, tunnel_id: &str, count: u32) {
        let active = self.active_tunnels.read().await;
        if let Some(at) = active.get(tunnel_id) {
            *at.retry_count.lock().await = count;
        }
    }
}
