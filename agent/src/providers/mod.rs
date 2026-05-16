//! Data provider abstraction for NetStacks
//!
//! All data access goes through the DataProvider trait.
//! - Single User: LocalDataProvider (SQLite + encrypted vault)
//! - Enterprise: ControllerDataProvider (API calls to Controller)

use async_trait::async_trait;
use thiserror::Error;

use crate::models::*;

pub mod local;
pub use local::LocalDataProvider;

#[derive(Error, Debug)]
pub enum ProviderError {
    #[error("Not found: {0}")]
    NotFound(String),
    #[error("Database error: {0}")]
    Database(String),
    #[error("Vault is locked - unlock with master password first")]
    VaultLocked,
    #[error("Invalid master password")]
    InvalidPassword,
    #[error("Encryption error: {0}")]
    Encryption(String),
    #[error("Access denied")]
    _AccessDenied,
    #[error("Validation error: {0}")]
    Validation(String),
    #[error("Conflict: {0}")]
    Conflict(String),
}

/// All data access goes through this trait
#[async_trait]
pub trait DataProvider: Send + Sync {
    // === Sessions ===

    /// List all sessions
    async fn list_sessions(&self) -> Result<Vec<Session>, ProviderError>;

    /// Get a session by ID
    async fn get_session(&self, id: &str) -> Result<Session, ProviderError>;

    /// Create a new session
    async fn create_session(&self, session: NewSession) -> Result<Session, ProviderError>;

    /// Update a session
    async fn update_session(
        &self,
        id: &str,
        update: UpdateSession,
    ) -> Result<Session, ProviderError>;

    /// Delete a session
    async fn delete_session(&self, id: &str) -> Result<(), ProviderError>;

    /// Bulk delete sessions in a single transaction. Returns (deleted,
    /// failed) counts. If any single delete fails, the transaction is
    /// rolled back and the function returns the error — callers that
    /// want partial-success semantics should fall back to looping
    /// `delete_session` themselves. Default impl delegates to that loop
    /// so providers without transactional storage don't have to
    /// implement this.
    async fn bulk_delete_sessions(
        &self,
        ids: &[String],
    ) -> Result<(usize, usize), ProviderError> {
        let mut deleted = 0usize;
        let mut failed = 0usize;
        for id in ids {
            match self.delete_session(id).await {
                Ok(_) => deleted += 1,
                Err(e) => {
                    tracing::warn!("Failed to delete session {}: {:?}", id, e);
                    failed += 1;
                }
            }
        }
        Ok((deleted, failed))
    }

    /// Update last connected timestamp
    async fn _touch_session(&self, id: &str) -> Result<(), ProviderError>;

    /// Find every session/tunnel/profile that uses the given session as
    /// its `jump_session_id`. Used by the SessionSettingsDialog to render
    /// a "Used as jump by N" hint and (future) gate session deletion.
    async fn find_session_jump_dependents(
        &self,
        session_id: &str,
    ) -> Result<crate::models::JumpDependents, ProviderError>;

    // === Folders ===

    /// List all folders, optionally filtered by scope
    async fn list_folders(&self, scope: Option<&str>) -> Result<Vec<Folder>, ProviderError>;

    /// Get a folder by ID
    async fn get_folder(&self, id: &str) -> Result<Folder, ProviderError>;

    /// Create a new folder
    async fn create_folder(&self, folder: NewFolder) -> Result<Folder, ProviderError>;

    /// Update a folder
    async fn update_folder(&self, id: &str, update: UpdateFolder)
        -> Result<Folder, ProviderError>;

    /// Delete a folder (sessions move to root)
    async fn delete_folder(&self, id: &str) -> Result<(), ProviderError>;

    // === Credentials ===

    /// Check if the vault is unlocked
    fn is_unlocked(&self) -> bool;

    /// Check if a master password has been set
    async fn has_master_password(&self) -> Result<bool, ProviderError>;

    /// Set the master password (first time setup)
    async fn set_master_password(&self, password: &str) -> Result<(), ProviderError>;

    /// Rotate the master password. Verifies the old password, re-encrypts
    /// every vault blob (credentials, API tokens, secure-note bodies, etc.)
    /// under a freshly-derived key, and atomically swaps the verification
    /// record. Vault must be unlocked. On any failure mid-rotation, the
    /// transaction rolls back and the stored data stays under the old key.
    async fn change_master_password(
        &self,
        old_password: &str,
        new_password: &str,
    ) -> Result<(), ProviderError>;

    /// Wipe every vault-encrypted value (credentials, API keys, NetBox /
    /// LibreNMS tokens, API-resource credentials, Quick-Action keys, secure
    /// notes) and clear the master-password record. Vault is left locked
    /// and back in the "no master password" state. Requires the current
    /// password as confirmation.
    async fn wipe_vault(&self, confirm_password: &str) -> Result<(), ProviderError>;

    /// Unlock the vault with the master password
    async fn unlock(&self, password: &str) -> Result<(), ProviderError>;

    /// Lock the vault
    fn lock(&self);

    /// Encrypt a plain string with the unlocked vault. Returned bytes are
    /// `salt || nonce || ciphertext` and round-trip via `vault_decrypt_string`.
    /// Used by callers (e.g. Secure Notes) that store opaque encrypted blobs
    /// in their own tables instead of the credential vault.
    fn vault_encrypt_string(&self, value: &str) -> Result<Vec<u8>, ProviderError>;

    /// Decrypt bytes previously produced by `vault_encrypt_string`.
    fn vault_decrypt_string(&self, encrypted: &[u8]) -> Result<String, ProviderError>;

    /// Get credential for a session (vault must be unlocked)
    async fn _get_credential(&self, session_id: &str) -> Result<Option<_Credential>, ProviderError>;

    /// Store credential for a session (vault must be unlocked)
    async fn store_credential(
        &self,
        session_id: &str,
        credential: NewCredential,
    ) -> Result<(), ProviderError>;

    /// Delete credential for a session
    async fn delete_credential(&self, session_id: &str) -> Result<(), ProviderError>;

    // === Mapped Keys (Global) ===

    /// List all mapped keys
    async fn list_mapped_keys(&self) -> Result<Vec<MappedKey>, ProviderError>;

    /// Create a mapped key
    async fn create_mapped_key(&self, key: NewMappedKey) -> Result<MappedKey, ProviderError>;

    /// Update a mapped key
    async fn update_mapped_key(
        &self,
        key_id: &str,
        update: UpdateMappedKey,
    ) -> Result<MappedKey, ProviderError>;

    /// Delete a mapped key
    async fn delete_mapped_key(&self, key_id: &str) -> Result<(), ProviderError>;

    // === Custom Commands ===

    /// List all custom commands
    async fn list_custom_commands(&self) -> Result<Vec<CustomCommand>, ProviderError>;

    /// Create a custom command
    async fn create_custom_command(&self, cmd: NewCustomCommand) -> Result<CustomCommand, ProviderError>;

    /// Update a custom command
    async fn update_custom_command(&self, id: &str, update: UpdateCustomCommand) -> Result<CustomCommand, ProviderError>;

    /// Delete a custom command
    async fn delete_custom_command(&self, id: &str) -> Result<(), ProviderError>;

    // === Snippets ===

    /// List snippets (session-specific if session_id provided, global if None)
    async fn list_snippets(&self, session_id: Option<&str>) -> Result<Vec<Snippet>, ProviderError>;

    /// Create a snippet
    async fn create_snippet(
        &self,
        session_id: Option<&str>,
        snippet: NewSnippet,
    ) -> Result<Snippet, ProviderError>;

    /// Delete a snippet
    async fn delete_snippet(&self, id: &str) -> Result<(), ProviderError>;

    /// Update an existing snippet's name / command / sort_order.
    /// Fetch-modify-write so callers can patch just the fields they care
    /// about without overwriting siblings.
    async fn update_snippet(
        &self,
        id: &str,
        update: UpdateSnippet,
    ) -> Result<Snippet, ProviderError>;

    // === Connection Mode ===

    /// Get the connection mode (Local or Controller)
    fn connection_mode(&self) -> ConnectionMode;

    /// Get a reference to the database pool for direct queries
    /// Only available for LocalDataProvider
    fn get_pool(&self) -> &sqlx::sqlite::SqlitePool;

    // === Connection History ===

    /// List recent connection history entries
    async fn list_history(&self, limit: i32) -> Result<Vec<ConnectionHistory>, ProviderError>;

    /// Create a new connection history entry
    async fn create_history(
        &self,
        entry: NewConnectionHistory,
    ) -> Result<ConnectionHistory, ProviderError>;

    /// Delete a connection history entry
    async fn delete_history(&self, id: &str) -> Result<(), ProviderError>;

    // === Export/Import ===

    /// Export all sessions and folders
    async fn export_all(&self) -> Result<ExportData, ProviderError>;

    /// Export a folder and its contents
    async fn export_folder(&self, folder_id: &str) -> Result<ExportData, ProviderError>;

    /// Export a single session
    async fn export_session(&self, session_id: &str) -> Result<ExportData, ProviderError>;

    /// Import sessions and folders from export data
    async fn import_data(&self, data: ExportData) -> Result<ImportResult, ProviderError>;

    // === Settings ===

    /// Get a setting value by key
    async fn get_setting(&self, key: &str) -> Result<serde_json::Value, ProviderError>;

    /// Set a setting value
    async fn set_setting(&self, key: &str, value: serde_json::Value) -> Result<(), ProviderError>;

    // === Credential Profiles ===

    /// List all credential profiles
    async fn list_profiles(&self) -> Result<Vec<CredentialProfile>, ProviderError>;

    /// Get a credential profile by ID
    async fn get_profile(&self, id: &str) -> Result<CredentialProfile, ProviderError>;

    /// Create a new credential profile
    async fn create_profile(&self, profile: NewCredentialProfile) -> Result<CredentialProfile, ProviderError>;

    /// Update an existing credential profile
    async fn update_profile(&self, id: &str, update: UpdateCredentialProfile) -> Result<CredentialProfile, ProviderError>;

    /// Delete a credential profile
    async fn delete_profile(&self, id: &str) -> Result<(), ProviderError>;

    /// Get profile credential from vault
    async fn get_profile_credential(&self, profile_id: &str) -> Result<Option<ProfileCredential>, ProviderError>;

    /// Store profile credential in vault
    async fn store_profile_credential(&self, profile_id: &str, credential: ProfileCredential) -> Result<(), ProviderError>;

    /// Delete profile credential from vault
    async fn delete_profile_credential(&self, profile_id: &str) -> Result<(), ProviderError>;

    // === Jump Hosts (Global Proxy Configuration) ===

    /// List all jump hosts
    async fn list_jump_hosts(&self) -> Result<Vec<JumpHost>, ProviderError>;

    /// Get a jump host by ID
    async fn get_jump_host(&self, id: &str) -> Result<JumpHost, ProviderError>;

    /// Create a new jump host
    async fn create_jump_host(&self, jump_host: NewJumpHost) -> Result<JumpHost, ProviderError>;

    /// Update an existing jump host
    async fn update_jump_host(&self, id: &str, update: UpdateJumpHost) -> Result<JumpHost, ProviderError>;

    /// Delete a jump host
    async fn delete_jump_host(&self, id: &str) -> Result<(), ProviderError>;

    // === NetBox Sources ===

    /// List all NetBox sources
    async fn list_netbox_sources(&self) -> Result<Vec<NetBoxSource>, ProviderError>;

    /// Get a NetBox source by ID
    async fn get_netbox_source(&self, id: &str) -> Result<NetBoxSource, ProviderError>;

    /// Create a new NetBox source
    async fn create_netbox_source(&self, source: NewNetBoxSource) -> Result<NetBoxSource, ProviderError>;

    /// Update an existing NetBox source
    async fn update_netbox_source(&self, id: &str, update: UpdateNetBoxSource) -> Result<NetBoxSource, ProviderError>;

    /// Delete a NetBox source
    async fn delete_netbox_source(&self, id: &str) -> Result<(), ProviderError>;

    /// Get NetBox API token from vault
    async fn get_netbox_token(&self, source_id: &str) -> Result<Option<String>, ProviderError>;

    /// Store NetBox API token in vault
    async fn store_netbox_token(&self, source_id: &str, token: &str) -> Result<(), ProviderError>;

    // === LibreNMS Sources (Phase 22) ===

    /// List all LibreNMS sources
    async fn list_librenms_sources(&self) -> Result<Vec<LibreNmsSource>, ProviderError>;

    /// Get a LibreNMS source by ID
    async fn get_librenms_source(&self, id: &str) -> Result<LibreNmsSource, ProviderError>;

    /// Create a new LibreNMS source
    async fn create_librenms_source(&self, source: NewLibreNmsSource) -> Result<LibreNmsSource, ProviderError>;

    /// Delete a LibreNMS source
    async fn delete_librenms_source(&self, id: &str) -> Result<(), ProviderError>;

    /// Get LibreNMS API token from vault
    async fn get_librenms_token(&self, source_id: &str) -> Result<Option<String>, ProviderError>;

    /// Store LibreNMS API token in vault
    async fn store_librenms_token(&self, source_id: &str, token: &str) -> Result<(), ProviderError>;

    // === Netdisco Sources (Phase 22) ===

    /// List all Netdisco sources
    async fn list_netdisco_sources(&self) -> Result<Vec<NetdiscoSource>, ProviderError>;

    /// Get a Netdisco source by ID
    async fn get_netdisco_source(&self, id: &str) -> Result<NetdiscoSource, ProviderError>;

    /// Create a new Netdisco source
    async fn create_netdisco_source(&self, source: NewNetdiscoSource) -> Result<NetdiscoSource, ProviderError>;

    /// Update an existing Netdisco source
    async fn update_netdisco_source(&self, id: &str, update: UpdateNetdiscoSource) -> Result<NetdiscoSource, ProviderError>;

    /// Delete a Netdisco source
    async fn delete_netdisco_source(&self, id: &str) -> Result<(), ProviderError>;

    // === API Keys (Vault-stored) ===

    /// Get an API key from vault (for AI providers, integrations, etc.)
    async fn get_api_key(&self, key_type: &str) -> Result<Option<String>, ProviderError>;

    /// Store an API key in vault
    async fn store_api_key(&self, key_type: &str, api_key: &str) -> Result<(), ProviderError>;

    /// Delete an API key from vault
    async fn delete_api_key(&self, key_type: &str) -> Result<(), ProviderError>;

    /// Check if an API key exists in vault (without decrypting)
    async fn has_api_key(&self, key_type: &str) -> Result<bool, ProviderError>;

    // === MCP Auth Tokens (Vault-stored — AUDIT FIX CRYPTO-002) ===

    /// Store an MCP server's auth token in the vault. Requires the vault to
    /// be unlocked. Also clears the legacy plaintext `auth_token` column for
    /// the same server so the migration is one-way.
    async fn store_mcp_auth_token(&self, server_id: &str, token: &str) -> Result<(), ProviderError>;

    /// Retrieve an MCP server's auth token. Returns:
    ///   - Ok(Some(token)) if a token exists (decrypted from vault, OR
    ///     read from the legacy plaintext column with a warning logged)
    ///   - Ok(None) if no token is configured for that server
    ///   - Err(VaultLocked) if an encrypted token exists but the vault is locked
    async fn get_mcp_auth_token(&self, server_id: &str) -> Result<Option<String>, ProviderError>;

    /// Delete an MCP server's auth token (both encrypted and any legacy
    /// plaintext copy).
    async fn delete_mcp_auth_token(&self, server_id: &str) -> Result<(), ProviderError>;

    /// Check whether a token exists for a server (encrypted OR legacy
    /// plaintext) without attempting decryption. Used by the auto-connect
    /// path to decide whether to defer until vault unlock.
    async fn mcp_server_has_token(&self, server_id: &str) -> Result<bool, ProviderError>;

    // === Recordings ===

    /// List all recordings, optionally filtered by session ID
    async fn list_recordings(&self, session_id: Option<&str>) -> Result<Vec<Recording>, ProviderError>;

    /// Get a recording by ID
    async fn get_recording(&self, id: &str) -> Result<Recording, ProviderError>;

    /// Create a new recording
    async fn create_recording(&self, recording: NewRecording) -> Result<Recording, ProviderError>;

    /// Update a recording
    async fn update_recording(&self, id: &str, update: UpdateRecording) -> Result<Recording, ProviderError>;

    /// Delete a recording
    async fn delete_recording(&self, id: &str) -> Result<(), ProviderError>;

    // === Highlight Rules ===

    /// List highlight rules (optionally filtered by session_id)
    async fn list_highlight_rules(&self, session_id: Option<&str>) -> Result<Vec<HighlightRule>, ProviderError>;

    /// Get a highlight rule by ID
    async fn get_highlight_rule(&self, id: &str) -> Result<HighlightRule, ProviderError>;

    /// Create a new highlight rule
    async fn create_highlight_rule(&self, rule: NewHighlightRule) -> Result<HighlightRule, ProviderError>;

    /// Update an existing highlight rule
    async fn update_highlight_rule(&self, id: &str, update: UpdateHighlightRule) -> Result<HighlightRule, ProviderError>;

    /// Delete a highlight rule
    async fn delete_highlight_rule(&self, id: &str) -> Result<(), ProviderError>;

    /// Get effective rules for a session (merged global + session-specific, sorted by priority)
    async fn get_effective_highlight_rules(&self, session_id: &str) -> Result<Vec<HighlightRule>, ProviderError>;

    // === Change Control (Phase 15) ===

    /// List changes, optionally filtered by session ID
    async fn list_changes(&self, session_id: Option<&str>) -> Result<Vec<Change>, ProviderError>;

    /// Get a change by ID
    async fn get_change(&self, id: &str) -> Result<Change, ProviderError>;

    /// Create a new change
    async fn create_change(&self, change: NewChange) -> Result<Change, ProviderError>;

    /// Update an existing change
    async fn update_change(&self, id: &str, update: UpdateChange) -> Result<Change, ProviderError>;

    /// Delete a change (only allowed if status is 'draft')
    async fn delete_change(&self, id: &str) -> Result<(), ProviderError>;

    // === Snapshots ===

    /// List snapshots for a change
    async fn list_snapshots(&self, change_id: &str) -> Result<Vec<Snapshot>, ProviderError>;

    /// Get a snapshot by ID
    async fn get_snapshot(&self, id: &str) -> Result<Snapshot, ProviderError>;

    /// Create a new snapshot
    async fn create_snapshot(&self, snapshot: NewSnapshot) -> Result<Snapshot, ProviderError>;

    /// Delete a snapshot
    async fn delete_snapshot(&self, id: &str) -> Result<(), ProviderError>;

    // === Session Context (Phase 14) ===

    /// List context entries for a session
    async fn list_session_context(&self, session_id: &str) -> Result<Vec<SessionContext>, ProviderError>;

    /// Get a session context entry by ID
    async fn get_session_context(&self, id: &str) -> Result<SessionContext, ProviderError>;

    /// Create a new session context entry
    async fn create_session_context(&self, context: NewSessionContext) -> Result<SessionContext, ProviderError>;

    /// Update a session context entry
    async fn update_session_context(&self, id: &str, update: UpdateSessionContext) -> Result<SessionContext, ProviderError>;

    /// Delete a session context entry
    async fn delete_session_context(&self, id: &str) -> Result<(), ProviderError>;

    // === Saved Topologies (Phase 20.1) ===

    /// List all saved topologies
    async fn list_topologies(&self) -> Result<Vec<SavedTopology>, ProviderError>;

    /// Get a topology by ID
    async fn get_topology(&self, id: &str) -> Result<Option<SavedTopology>, ProviderError>;

    /// Create a new topology
    async fn create_topology(&self, name: &str) -> Result<SavedTopology, ProviderError>;

    /// Update a topology name
    async fn update_topology(&self, id: &str, name: &str) -> Result<(), ProviderError>;

    /// Delete a topology (cascades to devices and connections)
    async fn delete_topology(&self, id: &str) -> Result<(), ProviderError>;

    /// Move a topology to a folder and/or reorder
    async fn move_topology(&self, id: &str, folder_id: Option<String>, sort_order: f64) -> Result<(), ProviderError>;

    /// Bulk delete multiple topologies, returns (deleted, failed) counts
    async fn bulk_delete_topologies(&self, ids: &[String]) -> Result<(i32, i32), ProviderError>;

    /// Get devices for a topology
    async fn get_topology_devices(&self, topology_id: &str) -> Result<Vec<TopologyDevice>, ProviderError>;

    /// Add a device to a topology from a session
    async fn add_topology_device(&self, topology_id: &str, session: &Session) -> Result<TopologyDevice, ProviderError>;

    /// Add a discovered device (not linked to a session)
    async fn add_discovered_device(
        &self,
        topology_id: &str,
        name: &str,
        host: &str,
        device_type: &str,
        x: f64,
        y: f64,
        profile_id: Option<&str>,
        snmp_profile_id: Option<&str>,
    ) -> Result<TopologyDevice, ProviderError>;

    /// Update topology device position
    async fn update_topology_device_position(&self, device_id: &str, x: f64, y: f64) -> Result<(), ProviderError>;

    /// Update topology device type
    async fn update_topology_device_type(&self, device_id: &str, device_type: &str) -> Result<(), ProviderError>;

    /// Update topology device details (enrichment from AI discovery)
    async fn update_topology_device_details(&self, device_id: &str, details: &crate::models::UpdateTopologyDeviceDetails) -> Result<(), ProviderError>;

    /// Delete a topology device
    async fn delete_topology_device(&self, device_id: &str) -> Result<(), ProviderError>;

    /// Get connections for a topology
    async fn get_topology_connections(&self, topology_id: &str) -> Result<Vec<TopologyConnection>, ProviderError>;

    /// Create a connection between devices
    async fn create_topology_connection(&self, topology_id: &str, req: &CreateConnectionRequest) -> Result<TopologyConnection, ProviderError>;

    /// Update an existing topology connection (waypoints, label, color, etc.)
    async fn update_topology_connection(
        &self,
        connection_id: &str,
        req: &UpdateConnectionRequest,
    ) -> Result<TopologyConnection, ProviderError>;

    /// Delete a topology connection
    async fn delete_topology_connection(&self, connection_id: &str) -> Result<(), ProviderError>;

    // === Layouts (Phase 25) ===

    /// List all saved layouts
    async fn list_layouts(&self) -> Result<Vec<Layout>, ProviderError>;

    /// Get a layout by ID
    async fn get_layout(&self, id: &str) -> Result<Option<Layout>, ProviderError>;

    /// Create a new layout
    async fn create_layout(&self, layout: Layout) -> Result<Layout, ProviderError>;

    /// Update an existing layout
    async fn update_layout(&self, layout: Layout) -> Result<Layout, ProviderError>;

    /// Delete a layout
    async fn delete_layout(&self, id: &str) -> Result<(), ProviderError>;

    // Tab Groups (Plan 1: Tab Groups Redesign)
    async fn list_groups(&self) -> Result<Vec<Group>, ProviderError>;

    async fn get_group(&self, id: &str) -> Result<Option<Group>, ProviderError>;

    async fn create_group(&self, group: Group) -> Result<Group, ProviderError>;

    async fn update_group(&self, group: Group) -> Result<Group, ProviderError>;

    async fn delete_group(&self, id: &str) -> Result<(), ProviderError>;

    // === API Resources ===

    /// List all API resources
    async fn list_api_resources(&self) -> Result<Vec<ApiResource>, ProviderError>;

    /// Get a single API resource by ID
    async fn get_api_resource(&self, id: &str) -> Result<Option<ApiResource>, ProviderError>;

    /// Create a new API resource
    async fn create_api_resource(&self, req: &CreateApiResourceRequest) -> Result<ApiResource, ProviderError>;

    /// Update an existing API resource
    async fn update_api_resource(&self, id: &str, req: &UpdateApiResourceRequest) -> Result<(), ProviderError>;

    /// Delete an API resource (cascades to quick actions)
    async fn delete_api_resource(&self, id: &str) -> Result<(), ProviderError>;

    /// Get decrypted credentials for an API resource (token, username, password)
    async fn get_api_resource_credentials(&self, id: &str) -> Result<Option<StoredApiResourceCredential>, ProviderError>;

    // === Quick Actions ===

    /// List all quick actions (sorted by sort_order, then name)
    async fn list_quick_actions(&self) -> Result<Vec<QuickAction>, ProviderError>;

    /// Get a single quick action by ID
    async fn get_quick_action(&self, id: &str) -> Result<Option<QuickAction>, ProviderError>;

    /// Create a new quick action
    async fn create_quick_action(&self, req: &CreateQuickActionRequest) -> Result<QuickAction, ProviderError>;

    /// Update an existing quick action
    async fn update_quick_action(&self, id: &str, req: &UpdateQuickActionRequest) -> Result<(), ProviderError>;

    /// Delete a quick action
    async fn delete_quick_action(&self, id: &str) -> Result<(), ProviderError>;

    // === Quick Prompts ===

    /// List all quick prompts (favorites first, then alphabetical)
    async fn list_quick_prompts(&self) -> Result<Vec<QuickPrompt>, ProviderError>;

    /// Get a single quick prompt by ID
    async fn get_quick_prompt(&self, id: &str) -> Result<Option<QuickPrompt>, ProviderError>;

    /// Create a new quick prompt
    async fn create_quick_prompt(&self, req: &CreateQuickPromptRequest) -> Result<QuickPrompt, ProviderError>;

    /// Update an existing quick prompt
    async fn update_quick_prompt(&self, id: &str, req: &UpdateQuickPromptRequest) -> Result<(), ProviderError>;

    /// Delete a quick prompt
    async fn delete_quick_prompt(&self, id: &str) -> Result<(), ProviderError>;

    // === Agent Definitions ===

    /// List all agent definitions (enabled first, then alphabetical)
    async fn list_agent_definitions(&self) -> Result<Vec<AgentDefinition>, ProviderError>;

    /// Get a single agent definition by ID
    async fn get_agent_definition(&self, id: &str) -> Result<Option<AgentDefinition>, ProviderError>;

    /// Create a new agent definition
    async fn create_agent_definition(&self, req: &CreateAgentDefinitionRequest) -> Result<AgentDefinition, ProviderError>;

    /// Update an existing agent definition
    async fn update_agent_definition(&self, id: &str, req: &UpdateAgentDefinitionRequest) -> Result<(), ProviderError>;

    /// Delete an agent definition
    async fn delete_agent_definition(&self, id: &str) -> Result<(), ProviderError>;

    // === Topology Annotations (Phase 27-03) ===

    /// Get all annotations for a topology
    async fn get_topology_annotations(&self, topology_id: &str) -> Result<Vec<TopologyAnnotation>, ProviderError>;

    /// Create an annotation
    async fn create_topology_annotation(&self, topology_id: &str, req: &crate::models::CreateAnnotationRequest) -> Result<TopologyAnnotation, ProviderError>;

    /// Update an annotation
    async fn update_topology_annotation(&self, annotation_id: &str, req: &crate::models::UpdateAnnotationRequest) -> Result<(), ProviderError>;

    /// Delete an annotation
    async fn delete_topology_annotation(&self, annotation_id: &str) -> Result<(), ProviderError>;

    /// Reorder annotations by z-index
    async fn reorder_topology_annotations(&self, topology_id: &str, id_order: &[String]) -> Result<(), ProviderError>;

    // === MOP Templates (Phase 30) ===

    /// List all MOP templates
    async fn list_mop_templates(&self) -> Result<Vec<MopTemplate>, ProviderError>;

    /// Get a MOP template by ID
    async fn get_mop_template(&self, id: &str) -> Result<MopTemplate, ProviderError>;

    /// Create a new MOP template
    async fn create_mop_template(&self, template: NewMopTemplate) -> Result<MopTemplate, ProviderError>;

    /// Update an existing MOP template
    async fn update_mop_template(&self, id: &str, update: UpdateMopTemplate) -> Result<MopTemplate, ProviderError>;

    /// Delete a MOP template
    async fn delete_mop_template(&self, id: &str) -> Result<(), ProviderError>;

    // === MOP Executions (Phase 30) ===

    /// List all MOP executions
    async fn list_mop_executions(&self) -> Result<Vec<MopExecution>, ProviderError>;

    /// Get a MOP execution by ID
    async fn get_mop_execution(&self, id: &str) -> Result<MopExecution, ProviderError>;

    /// Create a new MOP execution
    async fn create_mop_execution(&self, execution: NewMopExecution) -> Result<MopExecution, ProviderError>;

    /// Update an existing MOP execution
    async fn update_mop_execution(&self, id: &str, update: UpdateMopExecution) -> Result<MopExecution, ProviderError>;

    /// Delete a MOP execution
    async fn delete_mop_execution(&self, id: &str) -> Result<(), ProviderError>;

    // === MOP Execution Devices (Phase 30) ===

    /// List devices for a MOP execution
    async fn list_mop_execution_devices(&self, execution_id: &str) -> Result<Vec<MopExecutionDevice>, ProviderError>;

    /// Get a MOP execution device by ID
    async fn get_mop_execution_device(&self, id: &str) -> Result<MopExecutionDevice, ProviderError>;

    /// Create a new MOP execution device
    async fn create_mop_execution_device(&self, device: NewMopExecutionDevice) -> Result<MopExecutionDevice, ProviderError>;

    /// Update an existing MOP execution device
    async fn update_mop_execution_device(&self, id: &str, update: UpdateMopExecutionDevice) -> Result<MopExecutionDevice, ProviderError>;

    /// Delete a MOP execution device
    async fn _delete_mop_execution_device(&self, id: &str) -> Result<(), ProviderError>;

    // === MOP Execution Steps (Phase 30) ===

    /// List steps for a MOP execution device
    async fn list_mop_execution_steps(&self, execution_device_id: &str) -> Result<Vec<MopExecutionStep>, ProviderError>;

    /// Get a MOP execution step by ID
    async fn get_mop_execution_step(&self, id: &str) -> Result<MopExecutionStep, ProviderError>;

    /// Create a new MOP execution step
    /// Kept for parity with the bulk insert path; no external callers
    /// today since bulk_create_mop_execution_steps is the wrapped-in-tx
    /// route the api.rs handler uses.
    async fn _create_mop_execution_step(&self, step: NewMopExecutionStep) -> Result<MopExecutionStep, ProviderError>;

    /// Update an existing MOP execution step
    async fn update_mop_execution_step(&self, id: &str, update: UpdateMopExecutionStep) -> Result<MopExecutionStep, ProviderError>;

    /// Delete a MOP execution step
    async fn _delete_mop_execution_step(&self, id: &str) -> Result<(), ProviderError>;

    /// Bulk create MOP execution steps for a device
    async fn bulk_create_mop_execution_steps(&self, steps: Vec<NewMopExecutionStep>) -> Result<Vec<MopExecutionStep>, ProviderError>;
}
