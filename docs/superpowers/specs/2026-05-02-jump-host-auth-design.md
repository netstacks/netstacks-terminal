# Jump Host Authentication — Design

**Date:** 2026-05-02
**Status:** Approved for implementation
**Touches:** `agent/src/{terminal.rs,ws.rs,ssh/mod.rs,tunnels/mod.rs,models.rs,providers/local.rs}`, `frontend/src/{components/SettingsPanel.tsx,components/SessionSettingsDialog.tsx,api/profiles.ts}`

## Problem

Sessions configured with a jump host do not authenticate to the target device using the credentials saved on the session. The PTY-based `ssh -J` path in `agent/src/terminal.rs:188-278` silently drops the device password and shares a single `-i <key>` between both hops. The jump host's own credentials are never even loaded — `resolve_jump_host_params` (`agent/src/ws.rs:626-647`) returns only `(host, port, username)`. Tunnels (`agent/src/tunnels/mod.rs:92-175`) have a parallel bug: `get_or_create_connection` keys on `jump_host_id` for pooling but never actually reads it when building the SSH connection, so jump-host tunnels silently bypass the jump host.

Symptoms observed in the field:

- "Jump server part seems to work" — opportunistic auth via `~/.ssh/config`, `ssh-agent`, or accidentally the device's `-i` key
- "Creds for the session through the jump server are different than what's set" — they are: nothing the user configured for the device hop is actually transmitted

Additionally, jump host membership is currently a **session-level** attribute, which forces the user to repeat the configuration on every session that lives behind the same bastion.

## Goals

1. Make the device hop authenticate with the device-side credentials the user configured on the session's profile.
2. Make the jump hop authenticate with the jump host's own profile credentials (loaded from the vault).
3. Allow a credential profile to declare a default jump host so it doesn't need to be set per-session.
4. Apply the same fix to tunnels, which share the same broken pattern.
5. Surface clear, actionable error messages naming the artifacts (profile, jump host) involved in any failure.

## Non-Goals

- Multi-hop chaining (jump → jump → device). Single hop only, enforced at save time.
- Forcing-direct from a session when its profile has a jump host configured. To connect direct, change the profile or use a different one.
- Changing host-key TOFU behavior, vault encryption, or any other auth surface beyond the jump path.

## Architecture

### High level

Replace the PTY-based `ssh -J` path with a native russh ProxyJump implementation. The jump branch becomes a special case of the same `SshSession` that the direct path already uses, so PTY management, resize, host-key TOFU, and reader plumbing remain unchanged downstream. Tunnels reuse the same building block.

### New module: `agent/src/ssh/jump.rs`

```rust
/// Connect to a jump host, then open a direct-tcpip channel to the target,
/// then run a russh client over that channel and authenticate to the target.
/// Returns the target's russh client handle, ready for shell or channel use.
pub async fn connect_via_jump(
    target: &SshConfig,
    jump: &SshConfig,
    host_key_store: Arc<Mutex<HostKeyStore>>,
    approvals: Option<Arc<HostKeyApprovalService>>,
) -> Result<client::Handle<ClientHandler>, SshError>;
```

Implementation steps:

1. Authenticate to the jump using the existing `connect_and_authenticate_with_approvals(jump_config, ...)`.
2. Open a `direct-tcpip` channel from jump → `target.host:target.port` via `jump_handle.channel_open_direct_tcpip(...)`.
3. Wrap the channel as `AsyncRead + AsyncWrite` (russh's channel exposes the necessary traits via `into_stream()` / equivalent for v0.55).
4. Build a russh client over the wrapped stream using `russh::client::connect_stream(config, stream, handler)`.
5. Authenticate to the target using the same auth helpers `connect_and_authenticate` already invokes.
6. Return the target handle. The jump handle is held by a background task tied to the target session so the channel stays open.

### Modified: `agent/src/ssh/mod.rs`

Add a sibling constructor:

```rust
impl SshSession {
    pub async fn connect_via_jump(
        target: SshConfig,
        jump: SshConfig,
        cols: u32,
        rows: u32,
    ) -> Result<Self, SshError>;
}
```

Identical to `connect()` after step 1: it opens a session channel, requests PTY + shell, spawns the existing I/O loop. The only difference is the source of the `handle`.

### Modified: `agent/src/terminal.rs`

The jump branch in `new_ssh` (lines 186-278) is deleted entirely. The direct-vs-jump decision moves to a single switch:

```rust
let session = if let Some(jump_cfg) = jump_config {
    SshSession::connect_via_jump(target_cfg, jump_cfg, cols, rows).await?
} else {
    SshSession::connect(target_cfg, cols, rows).await?
};
```

Both branches now produce a `SessionKind::Ssh`. `SessionKind::Local` is no longer used for SSH-over-jump. The PTY/`CommandBuilder` import block is removed from this code path (still used for the local terminal).

### Modified: `agent/src/tunnels/mod.rs`

There are two creation paths that both reach `TunnelManager::start_tunnel`, and both must keep working:

1. **Standalone tunnels** — long-lived, managed under Settings → Tunnels, persisted in the database. ID format: any UUID. Lifecycle: `start_all_auto` on agent boot, manual start/stop via API.
2. **Session-attached tunnels** — short-lived, defined as `port_forwards` on a `Session`, materialized into ephemeral `Tunnel` objects in `ws.rs:196-214` when the SSH session connects. ID format: `session:<session_id>:<fwd_id>`. Lifecycle: started right after the SSH session opens, stopped in the cleanup block at `ws.rs:248-253` when the WebSocket closes.

The fix touches a single bottleneck — `get_or_create_connection` — so both paths benefit from one change. Care is needed at the session-tunnels creation site so it doesn't lose the new jump inheritance.

`get_or_create_connection` resolves the effective jump and uses the new helper:

```rust
async fn get_or_create_connection(&self, key: &ConnectionKey, tunnel_id: &str)
    -> Result<Arc<Mutex<PooledConnection>>, String>
{
    // ... existing pool lookup, profile + credential resolution for target ...

    let handle = if let Some(jump_id) = effective_jump_id_for_pool(key, &profile) {
        let jump_cfg = build_jump_ssh_config(&jump_id, &self.provider).await?;
        connect_via_jump(&target_cfg, &jump_cfg, ...).await?
    } else {
        connect_and_authenticate(&target_cfg, false).await?
    };
    // ... existing pool insertion ...
}
```

`ConnectionKey` is updated to use the **effective** jump host id (resolved from tunnel + profile) so two tunnels sharing the same profile-default jump pool together.

**Session-attached tunnels** (`ws.rs:196-214`) currently hardcode `jump_host_id: None` on the materialized `Tunnel`. This is changed to the SSH session's already-resolved effective jump (`SshParams.jump_host_id_effective`, a new field carrying the resolved id alongside the existing host/port/username). Result: session tunnels follow the same jump path as the terminal session itself, sharing the pooled jump connection. Standalone tunnels continue to read `Tunnel.jump_host_id` from the database with profile-fallback semantics — no behavior change for tunnels that already had an explicit `jump_host_id`, but tunnels with `None` now inherit the profile default (the bug fix).

**Pool sharing across both paths:** because the key uses the effective jump id, a session-attached tunnel and a standalone tunnel that resolve to the same `(host, port, profile, jump)` will share one pooled SSH connection. This matches the original intent of pooling by `jump_host_id`.

## Data Model

### `CredentialProfile`

Add nullable column:

```sql
ALTER TABLE credential_profiles
    ADD COLUMN jump_host_id TEXT NULL
    REFERENCES jump_hosts(id) ON DELETE SET NULL;
```

Rust additions in `agent/src/models.rs`:

```rust
pub struct CredentialProfile {
    // ... existing fields ...
    pub jump_host_id: Option<String>,
}
pub struct NewCredentialProfile     { /* ... */ pub jump_host_id: Option<String>, }
pub struct UpdateCredentialProfile  { /* ... */ pub jump_host_id: Option<Option<String>>, }
```

`Option<Option<...>>` on the update variant matches the existing pattern (`Option<None>` clears, `Some(Some(id))` sets, `None` leaves unchanged).

### `Session`

No schema change. `Session.jump_host_id` already exists. Semantics change:

- `Some(id)` → session overrides profile, uses this jump host
- `None` → inherit from `profile.jump_host_id` (which itself may be `None` for direct)

Two-state model, as agreed: a session cannot force-direct away from a profile-level jump. To connect direct, edit the profile or pick a different profile.

### `Tunnel`

No schema change. Same two-state semantics applied to `Tunnel.jump_host_id`.

### `SshParams` (in `agent/src/ws.rs`)

Add jump credential fields and the resolved jump id (so session-attached tunnels can inherit the same jump without re-resolving):

```rust
struct SshParams {
    // ... existing fields ...
    jump_host_id_effective: Option<String>, // NEW — resolved id (session override or profile default)
    jump_host: Option<String>,
    jump_port: Option<u16>,
    jump_username: Option<String>,
    jump_password: Option<String>,          // NEW
    jump_key_path: Option<String>,          // NEW
    jump_key_passphrase: Option<String>,    // NEW
    jump_legacy_ssh: bool,                  // NEW
}
```

## Resolution

Replace `resolve_jump_host_params` with a richer helper that returns full credential context:

```rust
struct JumpResolution {
    jump_host: JumpHost,
    jump_profile: CredentialProfile,
    jump_credential: Option<ProfileCredential>,
}

async fn resolve_effective_jump(
    session_jump_id: Option<&str>,         // e.g. session.jump_host_id, or tunnel.jump_host_id
    profile_jump_id: Option<&str>,         // profile.jump_host_id
    app_state: &Arc<AppState>,
) -> Result<Option<JumpResolution>, String> {
    let id = session_jump_id.or(profile_jump_id);
    let Some(id) = id else { return Ok(None); };

    let jump_host    = app_state.provider.get_jump_host(id).await?;
    let jump_profile = app_state.provider.get_profile(&jump_host.profile_id).await?;
    let jump_cred    = app_state.provider.get_profile_credential(&jump_host.profile_id).await?;
    Ok(Some(JumpResolution { jump_host, jump_profile, jump_credential: jump_cred }))
}
```

`get_ssh_params_with_vault` calls this and populates the new `SshParams.jump_*` fields. The same helper is reused by `TunnelManager`.

## Save-time Validation

Implemented in `agent/src/providers/local.rs::create_credential_profile` and `update_credential_profile`. Two checks fire when `profile.jump_host_id` is being set to `Some(id)`:

**Check 1 — chosen jump's profile is itself a leaf:**

```
let jump_host    = get_jump_host(id);
let jump_profile = get_profile(jump_host.profile_id);
if jump_profile.jump_host_id.is_some() {
    return Err(format!(
        "Cannot set jump host '{jump_name}' on profile '{this_name}' — \
         '{jump_name}' uses profile '{jump_profile_name}' which itself has a jump host \
         configured ('{inner_jump_name}'). Jump hosts cannot be chained. \
         Clear the jump host on profile '{jump_profile_name}' first.",
        ...
    ));
}
```

**Check 2 — this profile is not in use as a jump host's auth profile:**

```
let consumers = list_jump_hosts_using_profile(self.id);
if !consumers.is_empty() {
    let names = consumers.iter().map(|j| j.name).join(", ");
    return Err(format!(
        "Cannot set a jump host on profile '{this_name}' — \
         this profile is used as the auth profile for jump host(s): {names}. \
         Jump hosts cannot be chained. \
         Remove the jump host setting from this profile, \
         or detach this profile from those jump hosts first."
    ));
}
```

A symmetric check fires in `create_jump_host` / `update_jump_host` when a JumpHost is being created or pointed at a profile that already has `jump_host_id` set.

All three error messages name the artifacts by user-visible name, never UUID.

## Frontend

### Profile editor (`frontend/src/components/SettingsPanel.tsx`)

Add a "Jump Host" select beneath the auth fields:

- Options: `(None — direct connect)` plus each configured jump host by name
- Help text: *"Sessions and tunnels using this profile will connect through this jump host by default. Can be overridden per-session or per-tunnel."*
- Disabled state with tooltip when this profile is currently used as a jump host's auth profile (server returns this metadata via existing profile endpoint or a small new field)

### Session settings (`frontend/src/components/SessionSettingsDialog.tsx`)

Existing "Jump Host" select stays. Top option becomes `Inherit from profile (<resolved jump name | "direct">)` (selected when `session.jump_host_id` is null). Other options unchanged. The help text near the field gets a one-liner explaining inheritance.

### Tunnel UI

`SettingsTunnels.tsx` gets the same inherit-or-override select for `Tunnel.jump_host_id`, mirroring sessions.

### API DTOs (`frontend/src/api/profiles.ts` and equivalents)

Add `jump_host_id?: string | null` to profile create/update payloads. No new endpoints — existing CRUD covers it.

## Error Surfaces

All returned to the frontend as `ServerMessage::Error` (terminal sessions) or as the existing tunnel error fields. Each names artifacts by user-facing name.

| Failure point | Message template |
|---|---|
| Jump TCP connect fails | `Could not reach jump host '<name>' at <host>:<port>: <io error>` |
| Jump auth fails | `Authentication to jump host '<name>' (<user>@<host>) failed: <reason>. Check credentials in profile '<jump-profile>'.` |
| `direct-tcpip` open fails | `Jump host '<name>' refused to open a tunnel to <target>:<port> (<reason>). Check that the jump host permits TCP forwarding (AllowTcpForwarding yes).` |
| Target auth fails through jump | `Authentication to <target>:<port> via jump '<name>' failed: <reason>. Check credentials in profile '<target-profile>'.` |
| Jump host record missing | `Jump host '<id>' referenced by session/profile no longer exists. Edit the session or profile to fix.` |
| Vault locked while resolving jump cred | `Vault is locked — cannot read credentials for jump host '<name>'. Unlock in Settings > Security.` |
| Save-time chain rejection | (See "Save-time Validation" section above for full text) |

## Testing

### Unit tests (Rust)

- `resolve_effective_jump`: session-override-wins, profile-fallback, none-when-both-null, missing-jump-host error path, missing-profile error path, vault-locked error path
- Profile save validation: rejects setting `jump_host_id` when this profile is already used as a JumpHost's auth profile (specific message)
- Profile save validation: rejects setting `jump_host_id` to a JumpHost whose profile already has a `jump_host_id` (specific message)
- JumpHost save validation: symmetric checks
- `connect_via_jump`: covered with an in-process `russh::server` instance acting as both jump and target (pattern already established in `agent/tests/`). Cases: key-on-jump + password-on-target, password-on-jump + key-on-target, jump-auth-failure, target-auth-failure, jump-refuses-direct-tcpip
- Tunnel `get_or_create_connection`: resolves effective jump, opens via `connect_via_jump`, pool key uses effective jump id
- Tunnel pool key equality: standalone tunnel and session-attached tunnel resolving to the same `(host, port, profile, effective_jump)` produce equal `ConnectionKey` and share a pooled connection

### Integration tests

- WS handler with mocked provider: session uses profile with `jump_host_id`, asserts `SshParams.jump_*` fields populated from the jump's profile credential
- Same with session override populated — asserts session's jump wins
- **Standalone tunnel** start with profile-default jump — asserts pool keyed on effective jump id, asserts data flows via jump
- **Session-attached tunnel** start with profile-default jump (no explicit `jump_host_id` on the materialized `Tunnel`) — asserts the inherited jump is applied and the tunnel shares the SSH session's pooled connection
- Session-attached tunnel + standalone tunnel pointing at the same target via the same jump — asserts a single pooled SSH connection is shared
- Regression: existing standalone tunnel with explicit `jump_host_id` — behavior unchanged after the fix (now actually using the jump, where before it silently bypassed)

### Frontend tests (Vitest)

- Profile editor renders new dropdown listing existing jump hosts
- Profile editor disables dropdown with explanatory tooltip when this profile is used as a jump's auth profile
- Session dialog renders "Inherit from profile (<name>)" label correctly
- Tunnel form mirrors session inherit-or-override behavior

## Migration & Backward Compatibility

- Single DB migration adds `jump_host_id TEXT NULL` to `credential_profiles`. Default NULL → existing profiles behave exactly as before.
- Existing sessions with `Session.jump_host_id` set: behavior is identical (session-override semantics).
- Existing tunnels with `Tunnel.jump_host_id` set: now actually go through the jump host (this is the bug fix). No data migration needed.
- The PTY-based `ssh -J` path is deleted. No dual code paths to maintain.
- Removed dead code:
  - The `Note: Password auth through jump host would require sshpass` comment block in `terminal.rs`
  - `SessionKind::Local` usage in the SSH path (the variant remains for the local terminal)

## Out of Scope (call-out for future work)

- **Multi-hop / chained jumps.** Single hop only by design, enforced at save time. Adding multi-hop later means relaxing the save-time check and recursing in `connect_via_jump`.
- **Per-session force-direct override** when profile has a jump. Decided against in brainstorming. Can be added later as a tri-state on `Session.jump_host_id` (sentinel value or sibling boolean) without breaking the current schema.
