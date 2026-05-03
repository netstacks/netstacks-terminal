//! Discovery orchestrator for batch parallel discovery and traceroute resolution
//!
//! Coordinates SNMP, CLI, nmap, and integration modules into coherent batch
//! operations with bounded concurrency. This is the main entry point for
//! discovery API endpoints.

use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::Semaphore;

use super::cli_neighbors::{self};
use super::integration_lookup::{IntegrationConfigs, IntegrationResolver};
use super::nmap;
use super::snmp_neighbors::{self, DiscoveredNeighbor};
use super::NmapResult;

/// Maximum concurrent discovery targets
const MAX_CONCURRENT_TARGETS: usize = 10;

// === Batch Discovery Types ===

/// A target for batch discovery
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryTarget {
    /// Target IP or hostname
    pub ip: String,
    /// If the target has an open session (for credential reuse)
    pub session_id: Option<String>,
    /// SNMP profile ID for community string lookup
    pub snmp_profile_id: Option<String>,
    /// Credential profile ID for SSH auth lookup
    pub credential_profile_id: Option<String>,
    /// CLI flavor hint (cisco-ios, juniper-junos, arista-eos, etc.)
    #[serde(rename = "cliFlavor")]
    pub _cli_flavor: Option<String>,
}

/// Batch discovery request
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchDiscoveryRequest {
    /// Targets to discover
    pub targets: Vec<DiscoveryTarget>,
    /// Ordered list of discovery methods to try: "snmp", "cli", "nmap"
    #[serde(default = "default_methods")]
    pub methods: Vec<String>,
}

fn default_methods() -> Vec<String> {
    vec!["snmp".to_string(), "cli".to_string()]
}

/// Per-target discovery result
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetDiscoveryResult {
    /// Target IP that was discovered
    pub ip: String,
    /// Device sysName (from SNMP or CLI prompt)
    pub sys_name: Option<String>,
    /// Device sysDescr (platform/vendor/version string from SNMP)
    pub sys_descr: Option<String>,
    /// Discovered neighbors
    pub neighbors: Vec<DiscoveredNeighbor>,
    /// Method that succeeded: "snmp", "cli", "nmap", or "none"
    pub discovery_method: String,
    /// Nmap results (if nmap was run)
    pub nmap: Option<NmapResult>,
    /// Error message if all methods failed
    pub error: Option<String>,
}

// === Traceroute Resolution Types ===

/// Traceroute hop resolution request
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TracerouteResolveRequest {
    /// Hops to resolve
    pub hops: Vec<TracerouteHop>,
    /// SNMP profile IDs to try for neighbor discovery on resolved devices
    pub snmp_profile_ids: Vec<String>,
    /// Credential profile IDs to try for SSH fallback
    pub credential_profile_ids: Vec<String>,
}

/// A traceroute hop to resolve
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TracerouteHop {
    /// Hop number (1-based)
    pub hop_number: u32,
    /// Hop IP address
    pub ip: String,
}

/// Per-hop resolution result
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HopResolutionResult {
    /// Hop number
    pub hop_number: u32,
    /// Original hop IP
    pub ip: String,
    /// Whether the hop was resolved to a parent device
    pub resolved: bool,
    /// Integration source that resolved it (netbox, netdisco, librenms)
    pub source: Option<String>,
    /// Parent device info (if resolved)
    pub parent_device: Option<ParentDeviceInfo>,
    /// Neighbors discovered on this hop's device
    pub neighbors: Vec<DiscoveredNeighbor>,
    /// Nmap results (if nmap was run on unresolved hops)
    pub nmap: Option<NmapResult>,
    /// Error message
    pub error: Option<String>,
}

/// Parent device information after IP resolution
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParentDeviceInfo {
    /// Device hostname
    pub hostname: String,
    /// Management IP address
    pub management_ip: String,
    /// Interface on the device that has the hop IP
    pub interface_name: Option<String>,
    /// Device type/role
    pub device_type: Option<String>,
    /// Platform/OS
    pub platform: Option<String>,
}

// === Discovery Capabilities ===

/// Discovery capabilities report
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryCapabilities {
    /// Whether nmap binary is available
    pub nmap_available: bool,
    /// Whether passwordless sudo is available (for OS detection)
    pub nmap_sudo: bool,
    /// SNMP is always available (built into agent)
    pub snmp_available: bool,
}

// === Credential Resolution ===

/// Resolved credentials for a discovery target
struct ResolvedCredentials {
    /// SNMP community strings to try
    snmp_communities: Vec<String>,
    /// SSH auth (if available)
    ssh_auth: Option<(String, crate::ssh::SshAuth)>, // (username, auth)
    /// SSH port
    ssh_port: u16,
    /// Legacy SSH mode
    legacy_ssh: bool,
}

/// Load SNMP communities from a profile ID via the provider
async fn resolve_snmp_communities(
    profile_id: &str,
    provider: &dyn crate::providers::DataProvider,
) -> Vec<String> {
    match provider.get_profile_credential(profile_id).await {
        Ok(Some(cred)) => cred.snmp_communities.unwrap_or_default(),
        _ => Vec::new(),
    }
}

/// Load SSH credentials from a profile ID via the provider
async fn resolve_ssh_auth(
    profile_id: &str,
    provider: &dyn crate::providers::DataProvider,
) -> Option<(String, crate::ssh::SshAuth)> {
    // Get the profile to find username and auth_type
    let profiles = provider.list_profiles().await.ok()?;
    let profile = profiles.iter().find(|p| p.id == profile_id)?;

    let username = profile.username.clone();
    let credential = provider.get_profile_credential(profile_id).await.ok()??;

    let auth = match profile.auth_type {
        crate::models::AuthType::Password => {
            let password = credential.password?;
            Some(crate::ssh::SshAuth::Password(password))
        }
        crate::models::AuthType::Key => {
            let key_path = profile.key_path.clone()?;
            Some(crate::ssh::SshAuth::KeyFile {
                path: key_path,
                passphrase: credential.key_passphrase.clone(),
            })
        }
    };

    auth.map(|a| (username, a))
}

/// Resolve all credentials for a discovery target
async fn resolve_credentials(
    target: &DiscoveryTarget,
    provider: &dyn crate::providers::DataProvider,
) -> ResolvedCredentials {
    let mut snmp_communities = Vec::new();
    let mut ssh_auth = None;
    let mut ssh_port = 22u16;
    let legacy_ssh = false;

    // Resolve SNMP communities from profile
    if let Some(ref profile_id) = target.snmp_profile_id {
        snmp_communities = resolve_snmp_communities(profile_id, provider).await;
    }

    // If no SNMP profile, try the credential profile for SNMP too
    if snmp_communities.is_empty() {
        if let Some(ref profile_id) = target.credential_profile_id {
            snmp_communities = resolve_snmp_communities(profile_id, provider).await;
        }
    }

    // Resolve SSH credentials
    if let Some(ref profile_id) = target.credential_profile_id {
        ssh_auth = resolve_ssh_auth(profile_id, provider).await;
    }

    // If the target has a session, try to get credentials from it
    if let Some(ref session_id) = target.session_id {
        if let Ok(session) = provider.get_session(session_id).await {
            ssh_port = session.port;

            // Try SNMP from session's profile if not already resolved
            if snmp_communities.is_empty() {
                snmp_communities =
                    resolve_snmp_communities(&session.profile_id, provider).await;
            }

            // Try SSH from session's profile if not already resolved
            if ssh_auth.is_none() {
                ssh_auth = resolve_ssh_auth(&session.profile_id, provider).await;
            }
        }
    }

    ResolvedCredentials {
        snmp_communities,
        ssh_auth,
        ssh_port,
        legacy_ssh,
    }
}

// === Integration Config Loading ===

/// Load integration configs from the data provider, decrypting tokens
async fn load_integration_configs(
    provider: &dyn crate::providers::DataProvider,
) -> IntegrationConfigs {
    let mut configs = IntegrationConfigs::default();

    // NetBox sources
    if let Ok(sources) = provider.list_netbox_sources().await {
        for source in sources {
            if let Ok(Some(token)) = provider.get_netbox_token(&source.id).await {
                configs.netbox.push((source.url.clone(), token));
            }
        }
    }

    // Netdisco sources
    if let Ok(sources) = provider.list_netdisco_sources().await {
        for source in sources {
            if let Ok(Some(credential)) = provider.get_api_key(&source.credential_key).await {
                configs.netdisco.push((
                    source.url.clone(),
                    source.auth_type.clone(),
                    source.username.clone(),
                    credential,
                ));
            }
        }
    }

    // LibreNMS sources
    if let Ok(sources) = provider.list_librenms_sources().await {
        for source in sources {
            if let Ok(Some(token)) = provider.get_librenms_token(&source.id).await {
                configs.librenms.push((source.url.clone(), token));
            }
        }
    }

    configs
}

// === Batch Discovery Orchestrator ===

/// Run discovery on a single target using the specified methods in order.
/// Returns as soon as one method finds neighbors.
///
/// Each discovery method is spawned as a separate tokio task to fully
/// isolate their large async Futures (russh SSH state machines, SNMP walk
/// buffers with tokio::join! of 6 concurrent walks). Without isolation,
/// the Rust compiler inlines all branches into a single Future enum that
/// exceeds the worker thread stack in debug builds.
async fn discover_single_target(
    target: DiscoveryTarget,
    methods: Vec<String>,
    creds: ResolvedCredentials,
) -> TargetDiscoveryResult {
    let ip = target.ip.clone();
    let mut last_error: Option<String> = None;

    for method in &methods {
        match method.as_str() {
            "snmp" => {
                if creds.snmp_communities.is_empty() {
                    tracing::debug!("Skipping SNMP for {} - no communities configured", ip);
                    continue;
                }

                // Try each community string — spawn as separate task to isolate
                // the large SNMP future (6-way tokio::join of walks)
                for community in &creds.snmp_communities {
                    let task_ip = ip.clone();
                    let community = community.clone();
                    let result = tokio::spawn(async move {
                        let dest = crate::snmp::SnmpDest::direct(task_ip.as_str(), 161);
                        snmp_neighbors::discover_snmp_neighbors(&dest, &community).await
                    })
                    .await;

                    let result = match result {
                        Ok(r) => r,
                        Err(e) => {
                            last_error = Some(format!("SNMP task panicked: {}", e));
                            continue;
                        }
                    };

                    if !result.neighbors.is_empty() {
                        return TargetDiscoveryResult {
                            ip,
                            sys_name: result.sys_name,
                            sys_descr: result.sys_descr,
                            neighbors: result.neighbors,
                            discovery_method: format!("snmp-{}", result.method),
                            nmap: None,
                            error: None,
                        };
                    }

                    if let Some(ref err) = result.error {
                        last_error = Some(format!("SNMP: {}", err));
                    }
                }
            }
            "cli" => {
                if let Some((ref username, ref auth)) = creds.ssh_auth {
                    // Spawn CLI discovery as separate task to isolate the
                    // large russh SSH Future (auth state machines, channel I/O)
                    let task_ip = ip.clone();
                    let port = creds.ssh_port;
                    let username = username.clone();
                    let auth = auth.clone();
                    let legacy_ssh = creds.legacy_ssh;
                    let result = tokio::spawn(async move {
                        cli_neighbors::discover_cli_neighbors(
                            &task_ip, port, &username, auth, legacy_ssh,
                        )
                        .await
                    })
                    .await;

                    let result = match result {
                        Ok(r) => r,
                        Err(e) => {
                            last_error = Some(format!("CLI task panicked: {}", e));
                            continue;
                        }
                    };

                    if !result.neighbors.is_empty() {
                        return TargetDiscoveryResult {
                            ip,
                            sys_name: result.device_name,
                            sys_descr: None, // CLI discovery doesn't capture sysDescr
                            neighbors: result.neighbors,
                            discovery_method: result.method,
                            nmap: None,
                            error: None,
                        };
                    }

                    if let Some(ref err) = result.error {
                        last_error = Some(format!("CLI: {}", err));
                    }
                } else {
                    tracing::debug!("Skipping CLI for {} - no SSH credentials", ip);
                }
            }
            "nmap" => {
                let ip_clone = ip.clone();
                let nmap_result = tokio::spawn(async move {
                    let sudo_available = nmap::check_sudo_available().await;
                    nmap::nmap_fingerprint(&ip_clone, sudo_available).await
                })
                .await;

                match nmap_result {
                    Ok(nmap_result) => {
                        return TargetDiscoveryResult {
                            ip,
                            sys_name: nmap_result.os_match.clone(),
                            sys_descr: None,
                            neighbors: Vec::new(),
                            discovery_method: "nmap".to_string(),
                            nmap: Some(nmap_result),
                            error: None,
                        };
                    }
                    Err(e) => {
                        last_error = Some(format!("nmap task panicked: {}", e));
                    }
                }
            }
            _ => {
                tracing::warn!("Unknown discovery method: {}", method);
            }
        }
    }

    // No method succeeded
    TargetDiscoveryResult {
        ip,
        sys_name: None,
        sys_descr: None,
        neighbors: Vec::new(),
        discovery_method: "none".to_string(),
        nmap: None,
        error: last_error,
    }
}

/// Run batch discovery on multiple targets concurrently.
///
/// For each target: resolves credentials, then tries discovery methods in order.
/// Bounded to MAX_CONCURRENT_TARGETS simultaneous targets.
pub async fn run_batch_discovery(
    request: BatchDiscoveryRequest,
    provider: &Arc<dyn crate::providers::DataProvider>,
) -> Vec<TargetDiscoveryResult> {
    if request.targets.is_empty() {
        return Vec::new();
    }

    tracing::info!(
        "Starting batch discovery for {} targets, methods: {:?}",
        request.targets.len(),
        request.methods
    );

    let semaphore = Arc::new(Semaphore::new(MAX_CONCURRENT_TARGETS));
    let methods = request.methods.clone();
    let mut handles = Vec::with_capacity(request.targets.len());

    for target in request.targets {
        let sem = semaphore.clone();
        let provider = provider.clone();
        let methods = methods.clone();

        handles.push(tokio::spawn(async move {
            let _permit = sem.acquire().await.expect("semaphore closed");

            // Resolve IP from session if not provided
            let mut target = target;
            if target.ip.is_empty() {
                if let Some(ref session_id) = target.session_id {
                    if let Ok(session) = provider.get_session(session_id).await {
                        tracing::debug!("Resolved IP {} from session {}", session.host, session_id);
                        target.ip = session.host.clone();
                    }
                }
            }

            // Resolve credentials for this target
            let creds = resolve_credentials(&target, provider.as_ref()).await;

            discover_single_target(target, methods, creds).await
        }));
    }

    let mut results = Vec::with_capacity(handles.len());
    for handle in handles {
        match handle.await {
            Ok(result) => results.push(result),
            Err(e) => {
                tracing::error!("Discovery task panicked: {}", e);
            }
        }
    }

    tracing::info!("Batch discovery complete: {} results", results.len());
    results
}

// === Traceroute Resolution ===

/// Resolve traceroute hops to parent devices and run neighbor discovery.
///
/// For each hop:
/// 1. Query integration sources (NetBox/Netdisco/LibreNMS) for parent device
/// 2. If found: run SNMP neighbor discovery on the management IP
/// 3. If not found: try SNMP/CLI/nmap directly on the hop IP
pub async fn resolve_traceroute_hops(
    request: TracerouteResolveRequest,
    provider: &Arc<dyn crate::providers::DataProvider>,
) -> Vec<HopResolutionResult> {
    if request.hops.is_empty() {
        return Vec::new();
    }

    tracing::info!(
        "Resolving {} traceroute hops",
        request.hops.len()
    );

    // Load integration configs for IP resolution
    let integration_configs = load_integration_configs(provider.as_ref()).await;
    let resolver = Arc::new(IntegrationResolver::new());

    // Load SNMP communities from all provided profiles
    let mut all_communities = Vec::new();
    for profile_id in &request.snmp_profile_ids {
        let mut comms = resolve_snmp_communities(profile_id, provider.as_ref()).await;
        all_communities.append(&mut comms);
    }
    all_communities.dedup();

    // Load SSH credentials from all provided profiles
    let mut ssh_auths = Vec::new();
    for profile_id in &request.credential_profile_ids {
        if let Some(auth) = resolve_ssh_auth(profile_id, provider.as_ref()).await {
            ssh_auths.push(auth);
        }
    }

    let semaphore = Arc::new(Semaphore::new(MAX_CONCURRENT_TARGETS));
    let mut handles = Vec::with_capacity(request.hops.len());

    for hop in request.hops {
        let sem = semaphore.clone();
        let resolver = resolver.clone();
        let configs = integration_configs.clone();
        let communities = all_communities.clone();
        let ssh_auths = ssh_auths.clone();

        handles.push(tokio::spawn(async move {
            let _permit = sem.acquire().await.expect("semaphore closed");

            resolve_single_hop(hop, &resolver, &configs, &communities, &ssh_auths).await
        }));
    }

    let mut results = Vec::with_capacity(handles.len());
    for handle in handles {
        match handle.await {
            Ok(result) => results.push(result),
            Err(e) => {
                tracing::error!("Hop resolution task panicked: {}", e);
            }
        }
    }

    // Sort by hop number
    results.sort_by_key(|r| r.hop_number);

    tracing::info!("Traceroute resolution complete: {} hops", results.len());
    results
}

/// Resolve a single traceroute hop
async fn resolve_single_hop(
    hop: TracerouteHop,
    resolver: &IntegrationResolver,
    configs: &IntegrationConfigs,
    communities: &[String],
    ssh_auths: &[(String, crate::ssh::SshAuth)],
) -> HopResolutionResult {
    let hop_number = hop.hop_number;
    let ip = hop.ip.clone();

    // Step 1: Try to resolve via integrations
    if let Some(device) = resolver.resolve_ip_to_device(&ip, configs).await {
        let mgmt_ip = device.management_ip.clone();
        let parent = ParentDeviceInfo {
            hostname: device.hostname.unwrap_or_else(|| mgmt_ip.clone()),
            management_ip: mgmt_ip.clone(),
            interface_name: None,
            device_type: device.device_type,
            platform: device.platform,
        };

        // Step 2: Run SNMP neighbor discovery on management IP
        let mut neighbors = Vec::new();
        let mgmt_dest = crate::snmp::SnmpDest::direct(mgmt_ip.as_str(), 161);
        for community in communities {
            let result = snmp_neighbors::discover_snmp_neighbors(&mgmt_dest, community).await;
            if !result.neighbors.is_empty() {
                neighbors = result.neighbors;
                break;
            }
        }

        return HopResolutionResult {
            hop_number,
            ip,
            resolved: true,
            source: Some(device.source),
            parent_device: Some(parent),
            neighbors,
            nmap: None,
            error: None,
        };
    }

    // Step 3: Not resolved via integrations - try SNMP directly on hop IP
    let hop_dest = crate::snmp::SnmpDest::direct(ip.as_str(), 161);
    for community in communities {
        let result = snmp_neighbors::discover_snmp_neighbors(&hop_dest, community).await;
        if !result.neighbors.is_empty() {
            return HopResolutionResult {
                hop_number,
                ip: ip.clone(),
                resolved: false,
                source: None,
                parent_device: result.sys_name.map(|name| ParentDeviceInfo {
                    hostname: name,
                    management_ip: ip,
                    interface_name: None,
                    device_type: None,
                    platform: None,
                }),
                neighbors: result.neighbors,
                nmap: None,
                error: None,
            };
        }
    }

    // Step 4: Try CLI via SSH
    for (username, auth) in ssh_auths {
        let result = cli_neighbors::discover_cli_neighbors(&ip, 22, username, auth.clone(), false).await;
        if !result.neighbors.is_empty() {
            return HopResolutionResult {
                hop_number,
                ip: ip.clone(),
                resolved: false,
                source: None,
                parent_device: result.device_name.map(|name| ParentDeviceInfo {
                    hostname: name,
                    management_ip: ip,
                    interface_name: None,
                    device_type: None,
                    platform: None,
                }),
                neighbors: result.neighbors,
                nmap: None,
                error: None,
            };
        }
    }

    // Step 5: Try nmap as last resort
    if nmap::check_nmap_available().await {
        let sudo = nmap::check_sudo_available().await;
        let nmap_result = nmap::nmap_fingerprint(&ip, sudo).await;
        return HopResolutionResult {
            hop_number,
            ip,
            resolved: false,
            source: None,
            parent_device: None,
            neighbors: Vec::new(),
            nmap: Some(nmap_result),
            error: None,
        };
    }

    // Nothing worked
    HopResolutionResult {
        hop_number,
        ip,
        resolved: false,
        source: None,
        parent_device: None,
        neighbors: Vec::new(),
        nmap: None,
        error: Some("No integration sources matched and SNMP/CLI/nmap all failed".to_string()),
    }
}

// === Capabilities Check ===

/// Check what discovery capabilities are available on this system
pub async fn check_capabilities() -> DiscoveryCapabilities {
    let nmap_available = nmap::check_nmap_available().await;
    let nmap_sudo = if nmap_available {
        nmap::check_sudo_available().await
    } else {
        false
    };

    DiscoveryCapabilities {
        nmap_available,
        nmap_sudo,
        snmp_available: true, // SNMP is always available (built into agent)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_batch_discovery_request_deserialization() {
        let json = r#"{
            "targets": [
                {
                    "ip": "10.0.0.1",
                    "sessionId": "sess-1",
                    "snmpProfileId": "prof-1"
                },
                {
                    "ip": "10.0.0.2",
                    "credentialProfileId": "cred-1",
                    "cliFlavor": "cisco-ios"
                }
            ],
            "methods": ["snmp", "cli", "nmap"]
        }"#;

        let req: BatchDiscoveryRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.targets.len(), 2);
        assert_eq!(req.methods.len(), 3);
        assert_eq!(req.targets[0].ip, "10.0.0.1");
        assert_eq!(req.targets[0].session_id, Some("sess-1".to_string()));
        assert_eq!(req.targets[0].snmp_profile_id, Some("prof-1".to_string()));
        assert_eq!(req.targets[1].ip, "10.0.0.2");
        assert_eq!(
            req.targets[1].credential_profile_id,
            Some("cred-1".to_string())
        );
        assert_eq!(
            req.targets[1]._cli_flavor,
            Some("cisco-ios".to_string())
        );
    }

    #[test]
    fn test_batch_discovery_request_default_methods() {
        let json = r#"{"targets": [{"ip": "10.0.0.1"}]}"#;
        let req: BatchDiscoveryRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.methods, vec!["snmp", "cli"]);
    }

    #[test]
    fn test_traceroute_resolve_request_deserialization() {
        let json = r#"{
            "hops": [
                {"hopNumber": 1, "ip": "10.0.0.1"},
                {"hopNumber": 2, "ip": "10.0.0.2"},
                {"hopNumber": 3, "ip": "10.0.0.3"}
            ],
            "snmpProfileIds": ["prof-1"],
            "credentialProfileIds": ["cred-1"]
        }"#;

        let req: TracerouteResolveRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.hops.len(), 3);
        assert_eq!(req.hops[0].hop_number, 1);
        assert_eq!(req.hops[0].ip, "10.0.0.1");
        assert_eq!(req.snmp_profile_ids, vec!["prof-1"]);
        assert_eq!(req.credential_profile_ids, vec!["cred-1"]);
    }

    #[test]
    fn test_target_discovery_result_serialization() {
        let result = TargetDiscoveryResult {
            ip: "10.0.0.1".to_string(),
            sys_name: Some("router1".to_string()),
            sys_descr: Some("Cisco IOS XR Software, Version 7.3.2".to_string()),
            neighbors: vec![DiscoveredNeighbor {
                local_interface: "Gi0/0".to_string(),
                neighbor_name: "switch1".to_string(),
                neighbor_ip: Some("10.0.0.2".to_string()),
                neighbor_interface: Some("Gi1/0/1".to_string()),
                neighbor_platform: Some("Cisco".to_string()),
                protocol: "lldp".to_string(),
            }],
            discovery_method: "snmp-lldp".to_string(),
            nmap: None,
            error: None,
        };

        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("\"sysName\""));
        assert!(json.contains("\"discoveryMethod\""));
        assert!(json.contains("\"neighbors\""));
        assert!(json.contains("\"localInterface\""));
    }

    #[test]
    fn test_hop_resolution_result_serialization() {
        let result = HopResolutionResult {
            hop_number: 3,
            ip: "10.0.0.1".to_string(),
            resolved: true,
            source: Some("netbox".to_string()),
            parent_device: Some(ParentDeviceInfo {
                hostname: "core-rtr-01".to_string(),
                management_ip: "10.0.0.254".to_string(),
                interface_name: Some("GigabitEthernet0/1".to_string()),
                device_type: Some("Router".to_string()),
                platform: Some("Cisco IOS".to_string()),
            }),
            neighbors: Vec::new(),
            nmap: None,
            error: None,
        };

        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("\"hopNumber\":3"));
        assert!(json.contains("\"resolved\":true"));
        assert!(json.contains("\"parentDevice\""));
        assert!(json.contains("\"managementIp\""));
    }

    #[test]
    fn test_discovery_capabilities_serialization() {
        let caps = DiscoveryCapabilities {
            nmap_available: true,
            nmap_sudo: false,
            snmp_available: true,
        };

        let json = serde_json::to_string(&caps).unwrap();
        assert!(json.contains("\"nmapAvailable\":true"));
        assert!(json.contains("\"nmapSudo\":false"));
        assert!(json.contains("\"snmpAvailable\":true"));
    }
}
