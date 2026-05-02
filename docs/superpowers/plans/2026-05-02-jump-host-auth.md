# Jump Host Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the broken PTY-based `ssh -J` jump host path with native russh ProxyJump that correctly authenticates each hop with its own credentials, add a profile-level default jump host, and apply the same fix to tunnels.

**Architecture:** A new `agent/src/ssh/jump.rs` module exposes `connect_via_jump(target, jump)` that authenticates to the jump host with russh, opens a `direct-tcpip` channel to the target, and runs a second russh client over that channel. Both `terminal.rs` (interactive sessions) and `tunnels/mod.rs` (port forwarding) call this helper. `CredentialProfile` gains a nullable `jump_host_id` column with two-state semantics (session/tunnel `Some` overrides; `None` inherits from profile). Save-time validation in `agent/src/providers/local.rs` enforces single-hop only by rejecting any configuration that would chain jump hosts.

**Tech Stack:** Rust (russh 0.55, sqlx, axum), SQLite migrations via `agent/src/db/mod.rs`, React/TypeScript frontend (Vitest).

**Spec:** `docs/superpowers/specs/2026-05-02-jump-host-auth-design.md`

**Pre-flight:** This plan should be executed in a dedicated worktree. The current branch `feat/ai-mode-prompt-overrides` has unrelated uncommitted work — create a worktree off `main` (or off the appropriate base) before starting Task 1.

---

## File Map

**Created:**
- `agent/src/ssh/jump.rs` — `connect_via_jump` helper
- `agent/src/ssh/jump_test.rs` — in-process russh server tests for jump (or merged inline as `#[cfg(test)] mod tests`)

**Modified (Rust):**
- `agent/src/db/mod.rs` — new `migrate_credential_profile_jump_host`
- `agent/src/db/schema.sql` — add `jump_host_id` to `credential_profiles` table definition
- `agent/src/models.rs` — `CredentialProfile`, `NewCredentialProfile`, `UpdateCredentialProfile`, `ProfileWithUsage` (new helper for UI)
- `agent/src/providers/mod.rs` — `DataProvider` trait additions
- `agent/src/providers/local.rs` — Row mapping, list/get/create/update SQL, save-time chain validation in profile + jump host writes
- `agent/src/ssh/mod.rs` — `pub mod jump;`, `SshSession::connect_via_jump` constructor
- `agent/src/ws.rs` — `SshParams` new fields, `resolve_effective_jump`, session-tunnel materialization update
- `agent/src/terminal.rs` — delete PTY `ssh -J` branch, switch to `SshSession::connect_via_jump`
- `agent/src/tunnels/mod.rs` — `ConnectionKey` uses effective jump id, `get_or_create_connection` calls `connect_via_jump` when applicable

**Modified (Frontend):**
- `frontend/src/api/profiles.ts` (or equivalent — locate during Task 12) — add `jump_host_id` to DTOs
- `frontend/src/components/SettingsPanel.tsx` — profile editor jump host select
- `frontend/src/components/SessionSettingsDialog.tsx` — inherit label
- `frontend/src/components/SettingsTunnels.tsx` — inherit label
- Test files alongside each component

---

## Task 1: DB migration — add `credential_profiles.jump_host_id`

**Files:**
- Modify: `agent/src/db/mod.rs` (register new migration)
- Modify: `agent/src/db/schema.sql:123-145` (add column to base schema for fresh installs)

- [ ] **Step 1: Add column to base schema**

In `agent/src/db/schema.sql`, find the `credential_profiles` CREATE TABLE block (around line 123). Add a `jump_host_id` column at the end of the column list (before the closing parenthesis):

```sql
CREATE TABLE IF NOT EXISTS credential_profiles (
    -- ... existing columns ...
    jump_host_id TEXT REFERENCES jump_hosts(id) ON DELETE SET NULL
);
```

Note: place AFTER all existing columns. Verify the column comma placement.

- [ ] **Step 2: Add migration function**

In `agent/src/db/mod.rs`, add this function (place near `migrate_scripts_provenance` for consistency, around line 125):

```rust
/// Add `jump_host_id` to `credential_profiles` so a profile can declare a
/// default jump host for any session/tunnel that uses it.
async fn migrate_credential_profile_jump_host(pool: &SqlitePool) -> Result<(), DbError> {
    if !column_exists(pool, "credential_profiles", "jump_host_id").await? {
        sqlx::query(
            "ALTER TABLE credential_profiles ADD COLUMN jump_host_id TEXT \
             REFERENCES jump_hosts(id) ON DELETE SET NULL"
        )
        .execute(pool)
        .await
        .map_err(|e| DbError::Migration(format!("Failed to add credential_profiles.jump_host_id: {}", e)))?;
    }
    Ok(())
}
```

- [ ] **Step 3: Register migration**

In `agent/src/db/mod.rs`, find the migration registration block (around line 100, with calls like `migrate_scripts_provenance(pool).await?;`). Add this line BEFORE `seed_default_settings`:

```rust
migrate_credential_profile_jump_host(pool).await?;
```

- [ ] **Step 4: Build the agent**

Run: `cd agent && cargo build`
Expected: clean build, no warnings about the new function.

- [ ] **Step 5: Commit**

```bash
git add agent/src/db/mod.rs agent/src/db/schema.sql
git commit -m "feat(db): add credential_profiles.jump_host_id for default jump host"
```

---

## Task 2: Models — add `jump_host_id` to `CredentialProfile`

**Files:**
- Modify: `agent/src/models.rs:723-810` (the three `CredentialProfile` structs)

- [ ] **Step 1: Write failing test**

Add to the bottom of `agent/src/models.rs` (or in `#[cfg(test)] mod tests` — add the block if it doesn't exist):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_profile_serde_round_trip_includes_jump_host_id() {
        let json = r#"{
            "id": "p1",
            "name": "Test",
            "username": "admin",
            "auth_type": "password",
            "key_path": null,
            "port": 22,
            "keepalive_interval": 30,
            "connection_timeout": 10,
            "terminal_theme": null,
            "default_font_size": null,
            "default_font_family": null,
            "scrollback_lines": 1000,
            "local_echo": false,
            "auto_reconnect": false,
            "reconnect_delay": 5,
            "cli_flavor": "auto",
            "auto_commands": [],
            "jump_host_id": "jh-1",
            "created_at": "2026-05-02T00:00:00Z",
            "updated_at": "2026-05-02T00:00:00Z"
        }"#;
        let p: CredentialProfile = serde_json::from_str(json).unwrap();
        assert_eq!(p.jump_host_id.as_deref(), Some("jh-1"));
    }

    #[test]
    fn credential_profile_jump_host_id_defaults_to_none_when_missing() {
        let json = r#"{
            "id": "p1", "name": "Test", "username": "admin",
            "auth_type": "password", "key_path": null,
            "port": 22, "keepalive_interval": 30, "connection_timeout": 10,
            "terminal_theme": null, "default_font_size": null, "default_font_family": null,
            "scrollback_lines": 1000, "local_echo": false, "auto_reconnect": false,
            "reconnect_delay": 5, "cli_flavor": "auto", "auto_commands": [],
            "created_at": "2026-05-02T00:00:00Z",
            "updated_at": "2026-05-02T00:00:00Z"
        }"#;
        let p: CredentialProfile = serde_json::from_str(json).unwrap();
        assert!(p.jump_host_id.is_none());
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && cargo test --lib models::tests`
Expected: compile error — `CredentialProfile` has no field `jump_host_id`.

- [ ] **Step 3: Add field to `CredentialProfile`**

In `agent/src/models.rs`, find `pub struct CredentialProfile { ... }` (line 723). Add this field BEFORE `pub created_at`:

```rust
    /// Optional default jump host for sessions/tunnels using this profile.
    /// `None` means direct connection. Sessions/tunnels can override by
    /// setting their own `jump_host_id` to a different value.
    #[serde(default)]
    pub jump_host_id: Option<String>,
```

- [ ] **Step 4: Add field to `NewCredentialProfile`**

In `agent/src/models.rs`, find `pub struct NewCredentialProfile { ... }` (line 762). Add at the end:

```rust
    #[serde(default)]
    pub jump_host_id: Option<String>,
```

- [ ] **Step 5: Add field to `UpdateCredentialProfile`**

In `agent/src/models.rs`, find `pub struct UpdateCredentialProfile { ... }` (line 793). Add at the end (note the `Option<Option<String>>` pattern matching `key_path`):

```rust
    pub jump_host_id: Option<Option<String>>,
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd agent && cargo test --lib models::tests::credential_profile`
Expected: both tests PASS.

- [ ] **Step 7: Commit**

```bash
git add agent/src/models.rs
git commit -m "feat(models): add jump_host_id to CredentialProfile structs"
```

---

## Task 3: Provider — read/write `jump_host_id` on credential profiles

**Files:**
- Modify: `agent/src/providers/local.rs:328-391` (`CredentialProfileRow` struct + `From` impl)
- Modify: `agent/src/providers/local.rs:2590-2755` (list/get/create/update SQL)

- [ ] **Step 1: Write failing test**

Append to `agent/src/providers/local.rs` test module (search for `mod tests {` to find existing one, or add at end of file):

```rust
#[cfg(test)]
mod jump_host_id_persistence_tests {
    use super::*;
    use crate::models::{NewCredentialProfile, UpdateCredentialProfile, NewJumpHost, AuthType, CliFlavor};

    async fn fresh_provider() -> LocalDataProvider {
        // Use the existing test helper if present; otherwise create an
        // in-memory SQLite provider. Look for existing patterns near other
        // tests in this file (search for `LocalDataProvider::` in tests).
        LocalDataProvider::new_in_memory_for_tests().await.unwrap()
    }

    #[tokio::test]
    async fn create_profile_persists_jump_host_id_none_by_default() {
        let p = fresh_provider().await;
        let np = NewCredentialProfile {
            name: "p1".into(), username: "admin".into(),
            auth_type: AuthType::Password, key_path: None,
            port: 22, keepalive_interval: 30, connection_timeout: 10,
            terminal_theme: None, default_font_size: None, default_font_family: None,
            scrollback_lines: 1000, local_echo: false, auto_reconnect: false,
            reconnect_delay: 5, cli_flavor: CliFlavor::default(),
            auto_commands: vec![], jump_host_id: None,
        };
        let created = p.create_credential_profile(np).await.unwrap();
        let got = p.get_profile(&created.id).await.unwrap();
        assert!(got.jump_host_id.is_none());
    }

    #[tokio::test]
    async fn update_profile_sets_jump_host_id() {
        let p = fresh_provider().await;
        // Create a target profile and a jump-host-backing profile + jump host.
        let backing = p.create_credential_profile(NewCredentialProfile {
            name: "backing".into(), username: "bastion".into(),
            auth_type: AuthType::Password, key_path: None,
            port: 22, keepalive_interval: 30, connection_timeout: 10,
            terminal_theme: None, default_font_size: None, default_font_family: None,
            scrollback_lines: 1000, local_echo: false, auto_reconnect: false,
            reconnect_delay: 5, cli_flavor: CliFlavor::default(),
            auto_commands: vec![], jump_host_id: None,
        }).await.unwrap();
        let jh = p.create_jump_host(NewJumpHost {
            name: "edge".into(), host: "10.0.0.1".into(),
            port: 22, profile_id: backing.id.clone(),
        }).await.unwrap();
        let target = p.create_credential_profile(NewCredentialProfile {
            name: "target".into(), username: "admin".into(),
            auth_type: AuthType::Password, key_path: None,
            port: 22, keepalive_interval: 30, connection_timeout: 10,
            terminal_theme: None, default_font_size: None, default_font_family: None,
            scrollback_lines: 1000, local_echo: false, auto_reconnect: false,
            reconnect_delay: 5, cli_flavor: CliFlavor::default(),
            auto_commands: vec![], jump_host_id: None,
        }).await.unwrap();

        let updated = p.update_credential_profile(&target.id, UpdateCredentialProfile {
            jump_host_id: Some(Some(jh.id.clone())),
            ..Default::default()
        }).await.unwrap();
        assert_eq!(updated.jump_host_id.as_deref(), Some(jh.id.as_str()));

        let cleared = p.update_credential_profile(&target.id, UpdateCredentialProfile {
            jump_host_id: Some(None),
            ..Default::default()
        }).await.unwrap();
        assert!(cleared.jump_host_id.is_none());
    }
}
```

If `LocalDataProvider::new_in_memory_for_tests` does not exist yet, search for any existing test helper that constructs a `LocalDataProvider` for tests. If none exists, add one near the top of the impl block:

```rust
#[cfg(test)]
impl LocalDataProvider {
    pub async fn new_in_memory_for_tests() -> Result<Self, ProviderError> {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;
        crate::db::run_migrations(&pool).await
            .map_err(|e| ProviderError::Database(e.to_string()))?;
        Ok(Self { pool, vault: Default::default() /* match real init */ })
    }
}
```

If the `vault` field initialization is non-trivial, look at `LocalDataProvider::new` and mirror its setup.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && cargo test --lib providers::local::jump_host_id_persistence_tests`
Expected: FAIL — `jump_host_id` either missing from struct or panics in SQL because the SELECT * doesn't return it / INSERT skips it.

- [ ] **Step 3: Update `CredentialProfileRow`**

In `agent/src/providers/local.rs:328`, find `struct CredentialProfileRow { ... }`. Add the field at the END (matches the column order set by ALTER TABLE migration):

```rust
struct CredentialProfileRow {
    // ... existing fields ...
    jump_host_id: Option<String>,
}
```

In the `impl CredentialProfileRow` `From`/`into_model` (around line 350), add the mapping:

```rust
CredentialProfile {
    // ... existing fields ...
    jump_host_id: row.jump_host_id,
}
```

- [ ] **Step 4: Update INSERT SQL**

In `agent/src/providers/local.rs:2631` (`create_credential_profile`), the `INSERT INTO credential_profiles (...) VALUES (...)` statement: add `jump_host_id` to the column list and a `?` to the values, then bind `np.jump_host_id` in the correct position. Bind order must match column order exactly — verify before saving.

- [ ] **Step 5: Update UPDATE SQL**

In `agent/src/providers/local.rs:2703` (`update_credential_profile`), the `UPDATE credential_profiles SET ... WHERE id = ?` block uses a `current` snapshot pattern. Add this line where the other `Option<Option<...>>` fields are unpacked:

```rust
let jump_host_id = match update.jump_host_id {
    Some(v) => v,                       // explicit set or clear
    None => current.jump_host_id.clone(),
};
```

Add `jump_host_id = ?` to the SET clause and bind `jump_host_id` in the right position.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd agent && cargo test --lib providers::local::jump_host_id_persistence_tests`
Expected: both PASS.

- [ ] **Step 7: Commit**

```bash
git add agent/src/providers/local.rs
git commit -m "feat(provider): persist credential_profiles.jump_host_id"
```

---

## Task 4: Save-time chain validation — profile side

**Files:**
- Modify: `agent/src/providers/local.rs` (`create_credential_profile`, `update_credential_profile`)
- Add: helper `validate_profile_jump_host_chain` in same file

- [ ] **Step 1: Write failing tests**

Append to the same test module from Task 3:

```rust
#[tokio::test]
async fn cannot_set_jump_on_profile_used_as_jump_auth() {
    let p = fresh_provider().await;
    let auth_profile = p.create_credential_profile(NewCredentialProfile {
        name: "bastion-creds".into(), username: "bastion".into(),
        auth_type: AuthType::Password, key_path: None,
        port: 22, keepalive_interval: 30, connection_timeout: 10,
        terminal_theme: None, default_font_size: None, default_font_family: None,
        scrollback_lines: 1000, local_echo: false, auto_reconnect: false,
        reconnect_delay: 5, cli_flavor: CliFlavor::default(),
        auto_commands: vec![], jump_host_id: None,
    }).await.unwrap();
    let jh = p.create_jump_host(NewJumpHost {
        name: "edge-bastion".into(), host: "10.0.0.1".into(),
        port: 22, profile_id: auth_profile.id.clone(),
    }).await.unwrap();
    // Now try to set ANOTHER jump on bastion-creds — should fail.
    let other_backing = p.create_credential_profile(NewCredentialProfile {
        name: "other-backing".into(), username: "x".into(),
        auth_type: AuthType::Password, key_path: None,
        port: 22, keepalive_interval: 30, connection_timeout: 10,
        terminal_theme: None, default_font_size: None, default_font_family: None,
        scrollback_lines: 1000, local_echo: false, auto_reconnect: false,
        reconnect_delay: 5, cli_flavor: CliFlavor::default(),
        auto_commands: vec![], jump_host_id: None,
    }).await.unwrap();
    let other_jh = p.create_jump_host(NewJumpHost {
        name: "inner-bastion".into(), host: "10.0.0.2".into(),
        port: 22, profile_id: other_backing.id.clone(),
    }).await.unwrap();

    let err = p.update_credential_profile(&auth_profile.id, UpdateCredentialProfile {
        jump_host_id: Some(Some(other_jh.id.clone())),
        ..Default::default()
    }).await.unwrap_err();
    let msg = format!("{}", err);
    assert!(msg.contains("bastion-creds"), "msg should name profile: {msg}");
    assert!(msg.contains("edge-bastion"), "msg should name consuming jump: {msg}");
    assert!(msg.contains("Jump hosts cannot be chained"), "msg should explain rule: {msg}");
}

#[tokio::test]
async fn cannot_set_jump_pointing_to_jump_whose_profile_is_chained() {
    let p = fresh_provider().await;
    // Build: target_profile -> jump1 -> jump1_profile (which has its own jump2)
    let inner_backing = p.create_credential_profile(NewCredentialProfile {
        name: "inner-backing".into(), username: "x".into(),
        auth_type: AuthType::Password, key_path: None,
        port: 22, keepalive_interval: 30, connection_timeout: 10,
        terminal_theme: None, default_font_size: None, default_font_family: None,
        scrollback_lines: 1000, local_echo: false, auto_reconnect: false,
        reconnect_delay: 5, cli_flavor: CliFlavor::default(),
        auto_commands: vec![], jump_host_id: None,
    }).await.unwrap();
    let jump2 = p.create_jump_host(NewJumpHost {
        name: "inner-bastion".into(), host: "10.0.0.2".into(),
        port: 22, profile_id: inner_backing.id.clone(),
    }).await.unwrap();
    // Create jump1's auth profile WITHOUT chain (so jump1 can be created).
    let jump1_profile = p.create_credential_profile(NewCredentialProfile {
        name: "bastion-creds".into(), username: "bastion".into(),
        auth_type: AuthType::Password, key_path: None,
        port: 22, keepalive_interval: 30, connection_timeout: 10,
        terminal_theme: None, default_font_size: None, default_font_family: None,
        scrollback_lines: 1000, local_echo: false, auto_reconnect: false,
        reconnect_delay: 5, cli_flavor: CliFlavor::default(),
        auto_commands: vec![], jump_host_id: None,
    }).await.unwrap();
    let jump1 = p.create_jump_host(NewJumpHost {
        name: "edge-bastion".into(), host: "10.0.0.1".into(),
        port: 22, profile_id: jump1_profile.id.clone(),
    }).await.unwrap();

    // Now retroactively chain jump1_profile (cleared at creation time, set
    // here BEFORE jump1 exists in some other test would succeed; in THIS
    // test, jump1 already exists so this should ALSO fail by the symmetric
    // check — but for THIS test we want the OTHER check, so do it differently):
    // Instead, give target_profile a jump_host_id pointing to jump1, AFTER
    // jump1_profile has its own jump_host_id set. We need a path where
    // jump1_profile.jump_host_id is allowed to be Some.
    //
    // Simpler: bypass via direct DB UPDATE to simulate legacy data, then
    // verify that updating target_profile through the API fails.
    sqlx::query("UPDATE credential_profiles SET jump_host_id = ? WHERE id = ?")
        .bind(&jump2.id)
        .bind(&jump1_profile.id)
        .execute(&p.pool)
        .await
        .unwrap();

    let target_profile = p.create_credential_profile(NewCredentialProfile {
        name: "corp-routers".into(), username: "admin".into(),
        auth_type: AuthType::Password, key_path: None,
        port: 22, keepalive_interval: 30, connection_timeout: 10,
        terminal_theme: None, default_font_size: None, default_font_family: None,
        scrollback_lines: 1000, local_echo: false, auto_reconnect: false,
        reconnect_delay: 5, cli_flavor: CliFlavor::default(),
        auto_commands: vec![], jump_host_id: None,
    }).await.unwrap();

    let err = p.update_credential_profile(&target_profile.id, UpdateCredentialProfile {
        jump_host_id: Some(Some(jump1.id.clone())),
        ..Default::default()
    }).await.unwrap_err();
    let msg = format!("{}", err);
    assert!(msg.contains("corp-routers"), "msg should name target profile: {msg}");
    assert!(msg.contains("edge-bastion"), "msg should name chosen jump: {msg}");
    assert!(msg.contains("bastion-creds"), "msg should name jump's profile: {msg}");
    assert!(msg.contains("inner-bastion"), "msg should name inner jump: {msg}");
}
```

If the `pool` field on `LocalDataProvider` is not `pub(crate)` accessible from the test module, expose it `#[cfg(test)]` only, or add a small test-only helper method to run a raw query.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd agent && cargo test --lib providers::local::jump_host_id_persistence_tests::cannot`
Expected: both FAIL — current code has no validation, the updates succeed silently.

- [ ] **Step 3: Add validation helper**

In `agent/src/providers/local.rs`, add this helper function (place near the existing jump host helpers, around line 2850):

```rust
/// Validate that setting `new_jump_host_id` on profile `profile_id`
/// would not create a jump-host chain. Returns an error with a
/// user-facing message naming the artifacts involved.
async fn validate_profile_jump_host_chain(
    pool: &SqlitePool,
    profile_id: &str,
    profile_name: &str,
    new_jump_host_id: Option<&str>,
) -> Result<(), ProviderError> {
    let Some(new_jh_id) = new_jump_host_id else {
        return Ok(()); // clearing is always fine
    };

    // Check 1: this profile is already used as a jump host's auth profile.
    // If so, setting any jump_host_id on this profile would chain.
    let consuming: Vec<(String, String)> = sqlx::query_as(
        "SELECT id, name FROM jump_hosts WHERE profile_id = ?"
    )
    .bind(profile_id)
    .fetch_all(pool)
    .await
    .map_err(|e| ProviderError::Database(e.to_string()))?;

    if !consuming.is_empty() {
        let names = consuming.iter().map(|(_, n)| n.as_str()).collect::<Vec<_>>().join(", ");
        return Err(ProviderError::Validation(format!(
            "Cannot set a jump host on profile '{}' — this profile is used as the auth profile \
             for jump host(s): {}. Jump hosts cannot be chained. Remove the jump host setting \
             from this profile, or detach this profile from those jump hosts first.",
            profile_name, names
        )));
    }

    // Check 2: the chosen jump's profile must itself be a leaf (no jump_host_id).
    let chosen: Option<(String, String, Option<String>, String, Option<String>)> = sqlx::query_as(
        "SELECT jh.name, jh.profile_id, p.jump_host_id, p.name, \
                (SELECT name FROM jump_hosts WHERE id = p.jump_host_id) \
         FROM jump_hosts jh JOIN credential_profiles p ON p.id = jh.profile_id \
         WHERE jh.id = ?"
    )
    .bind(new_jh_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| ProviderError::Database(e.to_string()))?;

    let Some((jump_name, _jump_profile_id, jump_profile_jh_id, jump_profile_name, inner_jump_name)) = chosen else {
        return Err(ProviderError::Validation(format!(
            "Cannot set jump host on profile '{}' — the chosen jump host '{}' no longer exists.",
            profile_name, new_jh_id
        )));
    };

    if jump_profile_jh_id.is_some() {
        let inner = inner_jump_name.unwrap_or_else(|| "<unknown>".into());
        return Err(ProviderError::Validation(format!(
            "Cannot set jump host on profile '{}' — the chosen jump host '{}' uses profile '{}' \
             which itself has a jump host configured ('{}'). Jump hosts cannot be chained. \
             Clear the jump host on profile '{}' first.",
            profile_name, jump_name, jump_profile_name, inner, jump_profile_name
        )));
    }

    Ok(())
}
```

If `ProviderError::Validation` does not exist yet, add it to the enum in `agent/src/providers/mod.rs`:

```rust
pub enum ProviderError {
    // ... existing variants ...
    Validation(String),
}
```

And implement `Display` (or extend the existing one) for the new variant: `Validation(s) => write!(f, "{}", s)`.

- [ ] **Step 4: Wire helper into `create_credential_profile`**

In `agent/src/providers/local.rs:2631`, BEFORE the INSERT, call the validator:

```rust
validate_profile_jump_host_chain(&self.pool, "<new id placeholder>", &np.name, np.jump_host_id.as_deref()).await?;
```

For create, the profile doesn't exist yet so check 1 (this profile used as a jump's auth profile) cannot fire. Pass an empty string for `profile_id` — the helper's first query just returns no rows. That's correct.

- [ ] **Step 5: Wire helper into `update_credential_profile`**

In `agent/src/providers/local.rs:2703`, AFTER computing the resolved `jump_host_id` (from the `match update.jump_host_id` block in Task 3 Step 5) but BEFORE the UPDATE SQL:

```rust
validate_profile_jump_host_chain(
    &self.pool,
    id,
    &current.name,           // user-facing name of the profile being edited
    jump_host_id.as_deref(),
).await?;
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd agent && cargo test --lib providers::local::jump_host_id_persistence_tests`
Expected: all FOUR tests in the module PASS (the two from Task 3 + the two from this task).

- [ ] **Step 7: Commit**

```bash
git add agent/src/providers/local.rs agent/src/providers/mod.rs
git commit -m "feat(provider): reject jump-host chain when setting profile.jump_host_id"
```

---

## Task 5: Save-time chain validation — jump host side (symmetric)

**Files:**
- Modify: `agent/src/providers/local.rs:2874-2930` (`create_jump_host`, `update_jump_host`)

- [ ] **Step 1: Write failing test**

Append to the same test module:

```rust
#[tokio::test]
async fn cannot_create_jump_host_pointing_at_chained_profile() {
    let p = fresh_provider().await;
    // Build a leaf profile to back an inner jump.
    let inner_backing = p.create_credential_profile(NewCredentialProfile {
        name: "inner-backing".into(), username: "x".into(),
        auth_type: AuthType::Password, key_path: None,
        port: 22, keepalive_interval: 30, connection_timeout: 10,
        terminal_theme: None, default_font_size: None, default_font_family: None,
        scrollback_lines: 1000, local_echo: false, auto_reconnect: false,
        reconnect_delay: 5, cli_flavor: CliFlavor::default(),
        auto_commands: vec![], jump_host_id: None,
    }).await.unwrap();
    let inner_jh = p.create_jump_host(NewJumpHost {
        name: "inner-bastion".into(), host: "10.0.0.2".into(),
        port: 22, profile_id: inner_backing.id.clone(),
    }).await.unwrap();
    // Profile that has its own jump (legacy / direct-DB to skip profile validator).
    let chained_profile = p.create_credential_profile(NewCredentialProfile {
        name: "bastion-creds".into(), username: "bastion".into(),
        auth_type: AuthType::Password, key_path: None,
        port: 22, keepalive_interval: 30, connection_timeout: 10,
        terminal_theme: None, default_font_size: None, default_font_family: None,
        scrollback_lines: 1000, local_echo: false, auto_reconnect: false,
        reconnect_delay: 5, cli_flavor: CliFlavor::default(),
        auto_commands: vec![], jump_host_id: None,
    }).await.unwrap();
    sqlx::query("UPDATE credential_profiles SET jump_host_id = ? WHERE id = ?")
        .bind(&inner_jh.id).bind(&chained_profile.id)
        .execute(&p.pool).await.unwrap();

    // Now try to create a jump host that uses chained_profile — must fail.
    let err = p.create_jump_host(NewJumpHost {
        name: "edge-bastion".into(), host: "10.0.0.1".into(),
        port: 22, profile_id: chained_profile.id.clone(),
    }).await.unwrap_err();
    let msg = format!("{}", err);
    assert!(msg.contains("edge-bastion"), "msg should name new jump: {msg}");
    assert!(msg.contains("bastion-creds"), "msg should name profile: {msg}");
    assert!(msg.contains("inner-bastion"), "msg should name inner jump: {msg}");
    assert!(msg.contains("Jump hosts cannot be chained"), "msg should explain rule: {msg}");
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && cargo test --lib providers::local::jump_host_id_persistence_tests::cannot_create_jump_host`
Expected: FAIL — `create_jump_host` succeeds without validation.

- [ ] **Step 3: Add validation helper for jump host writes**

In `agent/src/providers/local.rs` (near `validate_profile_jump_host_chain`):

```rust
/// Validate that creating/updating a jump host whose auth profile is
/// `profile_id` won't form a chain. Fails if the profile already has its
/// own `jump_host_id` set.
async fn validate_jump_host_profile_is_leaf(
    pool: &SqlitePool,
    new_jump_name: &str,
    profile_id: &str,
) -> Result<(), ProviderError> {
    let row: Option<(String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT p.name, p.jump_host_id, \
                (SELECT name FROM jump_hosts WHERE id = p.jump_host_id) \
         FROM credential_profiles p WHERE p.id = ?"
    )
    .bind(profile_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| ProviderError::Database(e.to_string()))?;

    let Some((profile_name, profile_jh_id, inner_jump_name)) = row else {
        return Err(ProviderError::Validation(format!(
            "Cannot configure jump host '{}' — auth profile '{}' does not exist.",
            new_jump_name, profile_id
        )));
    };

    if profile_jh_id.is_some() {
        let inner = inner_jump_name.unwrap_or_else(|| "<unknown>".into());
        return Err(ProviderError::Validation(format!(
            "Cannot configure jump host '{}' — its auth profile '{}' itself has a jump host \
             configured ('{}'). Jump hosts cannot be chained. \
             Clear the jump host on profile '{}' first.",
            new_jump_name, profile_name, inner, profile_name
        )));
    }

    Ok(())
}
```

- [ ] **Step 4: Wire into `create_jump_host`**

In `agent/src/providers/local.rs:2874`, at the start of `create_jump_host`:

```rust
validate_jump_host_profile_is_leaf(&self.pool, &jump_host.name, &jump_host.profile_id).await?;
```

- [ ] **Step 5: Wire into `update_jump_host`**

In `agent/src/providers/local.rs:2901`, after fetching `current` but before the UPDATE SQL. Use the resolved `profile_id` (either from `update.profile_id` or `current.profile_id`) and the resolved name:

```rust
let new_profile_id = update.profile_id.clone().unwrap_or_else(|| current.profile_id.clone());
let new_name = update.name.clone().unwrap_or_else(|| current.name.clone());
validate_jump_host_profile_is_leaf(&self.pool, &new_name, &new_profile_id).await?;
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd agent && cargo test --lib providers::local::jump_host_id_persistence_tests::cannot_create_jump_host`
Expected: PASS.

- [ ] **Step 7: Run full provider test suite to catch regressions**

Run: `cd agent && cargo test --lib providers::local`
Expected: all tests PASS.

- [ ] **Step 8: Commit**

```bash
git add agent/src/providers/local.rs
git commit -m "feat(provider): symmetric jump-host chain validation on jump host writes"
```

---

## Task 6: New module `agent/src/ssh/jump.rs` — `connect_via_jump`

**Files:**
- Create: `agent/src/ssh/jump.rs`
- Modify: `agent/src/ssh/mod.rs` (add `pub mod jump;`)

- [ ] **Step 1: Write failing test (key on jump, password on target)**

Create `agent/src/ssh/jump.rs` with this initial content (test first):

```rust
//! Native russh ProxyJump: connect to jump host, open a direct-tcpip
//! channel to the target, then run a russh client over that channel and
//! authenticate to the target. Each hop uses its own credentials.

use std::sync::Arc;
use tokio::sync::Mutex;

use russh::client;

use crate::ssh::{
    connect_and_authenticate_with_approvals, ClientHandler, SshConfig, SshError,
};
use crate::ssh::approvals::HostKeyApprovalService;
use crate::ssh::host_keys::HostKeyStore;

/// Connect to `jump`, open a direct-tcpip channel to `target.host:target.port`,
/// then run a russh client over that channel and authenticate to `target`.
/// Returns the target's russh client handle, ready for shell or channel use.
///
/// On success, a background task keeps the jump handle alive for the lifetime
/// of the target session — when the caller drops the target handle, both
/// hops are torn down.
pub async fn connect_via_jump(
    target: &SshConfig,
    jump: &SshConfig,
    host_key_store: Arc<Mutex<HostKeyStore>>,
    approvals: Option<Arc<HostKeyApprovalService>>,
) -> Result<client::Handle<ClientHandler>, SshError> {
    todo!("implement after test exists")
}

#[cfg(test)]
mod tests {
    use super::*;
    // Test scaffolding will use russh::server::Server to stand up two
    // in-process SSH servers (jump + target) on ephemeral ports.

    /// Spin up two russh servers and assert connect_via_jump succeeds end-to-end.
    #[tokio::test]
    async fn connects_through_jump_with_key_then_password() {
        // Implementation in Step 3.
        todo!("test scaffolding to be added")
    }
}
```

- [ ] **Step 2: Register module**

In `agent/src/ssh/mod.rs`, near the top with other `pub mod` lines (search for `pub mod approvals` or similar):

```rust
pub mod jump;
```

- [ ] **Step 3: Implement test scaffolding (in-process russh servers)**

Replace the test in `agent/src/ssh/jump.rs` with the full scaffold. This is long but copy verbatim — it's the foundation for all subsequent test cases:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use russh::server::{Auth, Handler as ServerHandler, Msg, Server, Session as ServerSession};
    use russh::keys::{PrivateKey, ssh_key};
    use russh::{Channel, ChannelId, MethodKind, MethodSet};
    use std::collections::HashSet;
    use std::net::SocketAddr;
    use std::sync::Arc;
    use tokio::io::AsyncWriteExt;
    use tokio::net::TcpStream;

    struct TestServerConfig {
        accept_password: Option<(String, String)>,    // (user, pw)
        accept_key_user: Option<String>,
        allow_direct_tcpip: bool,
        host_key: PrivateKey,
    }

    struct TestServerHandler {
        cfg: Arc<TestServerConfig>,
        // For target: when shell is opened, send a banner so test can verify.
    }

    impl ServerHandler for TestServerHandler {
        type Error = russh::Error;

        async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
            if let Some((u, p)) = &self.cfg.accept_password {
                if user == u && password == p {
                    return Ok(Auth::Accept);
                }
            }
            Ok(Auth::Reject { proceed_with_methods: None, partial_success: false })
        }

        async fn auth_publickey(&mut self, user: &str, _key: &ssh_key::PublicKey) -> Result<Auth, Self::Error> {
            if let Some(u) = &self.cfg.accept_key_user {
                if user == u {
                    return Ok(Auth::Accept);
                }
            }
            Ok(Auth::Reject { proceed_with_methods: None, partial_success: false })
        }

        async fn channel_open_session(
            &mut self,
            _channel: Channel<Msg>,
            _session: &mut ServerSession,
        ) -> Result<bool, Self::Error> {
            Ok(true)
        }

        async fn channel_open_direct_tcpip(
            &mut self,
            channel: Channel<Msg>,
            host_to_connect: &str,
            port_to_connect: u32,
            _originator_address: &str,
            _originator_port: u32,
            session: &mut ServerSession,
        ) -> Result<bool, Self::Error> {
            if !self.cfg.allow_direct_tcpip {
                return Ok(false);
            }
            // Connect to the requested target on behalf of the client and
            // pump bytes between the channel and the TCP socket.
            let stream = TcpStream::connect((host_to_connect, port_to_connect as u16))
                .await
                .map_err(|e| russh::Error::IO(e))?;
            let handle = session.handle();
            let id = channel.id();
            tokio::spawn(async move {
                let _ = pump_channel_to_socket(channel, stream, handle, id).await;
            });
            Ok(true)
        }

        async fn shell_request(
            &mut self,
            channel: ChannelId,
            session: &mut ServerSession,
        ) -> Result<(), Self::Error> {
            session.handle().data(channel, b"READY\n".to_vec().into()).await.ok();
            Ok(())
        }
    }

    async fn pump_channel_to_socket(
        mut channel: Channel<Msg>,
        mut stream: TcpStream,
        _handle: russh::server::Handle,
        _id: ChannelId,
    ) -> std::io::Result<()> {
        use tokio::io::AsyncReadExt;
        let mut buf = [0u8; 4096];
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
                            use std::io::Cursor;
                            let mut cursor = Cursor::new(buf[..n].to_vec());
                            channel.data(&mut cursor).await.ok();
                        }
                    }
                }
            }
        }
        Ok(())
    }

    struct TestServer { cfg: Arc<TestServerConfig> }
    impl Server for TestServer {
        type Handler = TestServerHandler;
        fn new_client(&mut self, _peer: Option<SocketAddr>) -> Self::Handler {
            TestServerHandler { cfg: self.cfg.clone() }
        }
    }

    /// Start a russh server on an ephemeral port. Returns its bound address.
    async fn start_test_server(cfg: TestServerConfig) -> SocketAddr {
        let host_key = cfg.host_key.clone();
        let mut config = russh::server::Config::default();
        config.keys.push(host_key);
        config.methods = MethodSet::from(&[MethodKind::Password, MethodKind::PublicKey][..]);
        let config = Arc::new(config);
        let server = TestServer { cfg: Arc::new(cfg) };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let mut srv = server;
            loop {
                let (sock, peer) = match listener.accept().await { Ok(x) => x, Err(_) => break };
                let handler = srv.new_client(Some(peer));
                let cfg = config.clone();
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

    fn fresh_host_key_store() -> Arc<Mutex<HostKeyStore>> {
        // Use the in-memory test constructor if HostKeyStore exposes one,
        // else write to a temp file. Look at host_keys.rs for the right API.
        Arc::new(Mutex::new(HostKeyStore::new_in_memory_for_tests()))
    }

    #[tokio::test]
    async fn connects_through_jump_with_key_then_password() {
        let jump_host_key = ephemeral_ed25519();
        let target_host_key = ephemeral_ed25519();

        let jump_addr = start_test_server(TestServerConfig {
            accept_password: None,
            accept_key_user: Some("jumpuser".into()),
            allow_direct_tcpip: true,
            host_key: jump_host_key,
        }).await;

        let target_addr = start_test_server(TestServerConfig {
            accept_password: Some(("devuser".into(), "devpw".into())),
            accept_key_user: None,
            allow_direct_tcpip: false,
            host_key: target_host_key,
        }).await;

        let jump_key = ephemeral_ed25519();
        let key_path = write_temp_key(&jump_key);

        let jump_cfg = SshConfig {
            host: jump_addr.ip().to_string(),
            port: jump_addr.port(),
            username: "jumpuser".into(),
            auth: crate::ssh::SshAuth::KeyFile { path: key_path.to_string_lossy().into(), passphrase: None },
            legacy_ssh: false,
        };
        let target_cfg = SshConfig {
            host: target_addr.ip().to_string(),
            port: target_addr.port(),
            username: "devuser".into(),
            auth: crate::ssh::SshAuth::Password("devpw".into()),
            legacy_ssh: false,
        };

        let store = fresh_host_key_store();
        let handle = connect_via_jump(&target_cfg, &jump_cfg, store, None).await
            .expect("should connect through jump");

        // Open a session and request shell to confirm we're talking to TARGET.
        let mut ch = handle.channel_open_session().await.unwrap();
        ch.request_shell(false).await.unwrap();
        let msg = ch.wait().await.unwrap();
        let banner = match msg {
            russh::ChannelMsg::Data { data } => String::from_utf8_lossy(&data).to_string(),
            other => panic!("unexpected first msg: {:?}", other),
        };
        assert!(banner.contains("READY"));
    }
}
```

NOTE: Some russh API method names may differ by version (0.55) — if `russh::server::run_stream` is named differently, search for the equivalent in the `russh` docs. If `HostKeyStore::new_in_memory_for_tests` does not exist, add a `#[cfg(test)]` constructor to `host_keys.rs` that returns an empty store backed by a temp file or in-memory map.

The exact compile-fail signature you'll see during Step 4 will guide the fixes. Don't worry about getting it perfect on the first pass — the goal is a runnable failing test.

- [ ] **Step 4: Run test to verify it fails**

Run: `cd agent && cargo test --lib ssh::jump::tests`
Expected: FAIL (likely with `todo!()` panic in `connect_via_jump`).

- [ ] **Step 5: Implement `connect_via_jump`**

Replace the `todo!()` body in `agent/src/ssh/jump.rs`:

```rust
pub async fn connect_via_jump(
    target: &SshConfig,
    jump: &SshConfig,
    host_key_store: Arc<Mutex<HostKeyStore>>,
    approvals: Option<Arc<HostKeyApprovalService>>,
) -> Result<client::Handle<ClientHandler>, SshError> {
    // Step 1: connect + authenticate to jump.
    let jump_handle = connect_and_authenticate_with_approvals(
        jump,
        false,
        host_key_store.clone(),
        approvals.clone(),
    ).await?;

    // Step 2: open direct-tcpip channel from jump -> target.
    let channel = jump_handle
        .channel_open_direct_tcpip(
            target.host.clone(),
            target.port as u32,
            "127.0.0.1".to_string(),
            0u32,
        )
        .await
        .map_err(|e| SshError::ChannelError(format!(
            "Jump host refused to open a tunnel to {}:{} ({}). \
             Check that the jump host permits TCP forwarding (AllowTcpForwarding yes).",
            target.host, target.port, e
        )))?;

    // Step 3: wrap channel as AsyncRead+AsyncWrite.
    let stream = channel.into_stream();

    // Step 4: build russh client over the stream, authenticate to target.
    let target_handle = crate::ssh::connect_and_authenticate_over_stream(
        target,
        stream,
        host_key_store,
        approvals,
    ).await?;

    // Step 5: keep jump handle alive for the lifetime of the target session.
    // `connect_and_authenticate_over_stream` returns a handle that owns the
    // channel; the channel keeps a reference to the jump session. When the
    // caller drops `target_handle`, the channel closes and the jump
    // session's reader task exits — so we don't need to spawn anything here.
    drop(jump_handle); // explicit: holding it longer than needed is wrong, the channel keeps it alive

    Ok(target_handle)
}
```

This calls a new helper `connect_and_authenticate_over_stream` that doesn't exist yet — add it in `agent/src/ssh/mod.rs`. Search for the existing `connect_and_authenticate_with_approvals` (around line 634) and add a sibling that accepts a pre-existing stream instead of opening a TCP connection:

```rust
/// Same as `connect_and_authenticate_with_approvals`, but takes an
/// already-established AsyncRead+AsyncWrite stream instead of dialing TCP.
/// Used for ProxyJump where the stream is a russh channel from the jump host.
pub async fn connect_and_authenticate_over_stream<S>(
    config: &SshConfig,
    stream: S,
    host_key_store: Arc<tokio::sync::Mutex<host_keys::HostKeyStore>>,
    approvals: Option<Arc<approvals::HostKeyApprovalService>>,
) -> Result<client::Handle<ClientHandler>, SshError>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let client_config = build_client_config(config);  // refactor existing inline body into helper
    let handler = ClientHandler {
        host: config.host.clone(),
        port: config.port,
        host_key_store,
        auto_accept_changed_keys: false,
        approvals,
    };
    let mut session = russh::client::connect_stream(Arc::new(client_config), stream, handler)
        .await
        .map_err(|e| SshError::ConnectionFailed(e.to_string()))?;
    authenticate(&mut session, config).await?;  // refactor existing inline auth into helper
    Ok(session)
}
```

If `build_client_config` and `authenticate` don't exist as helpers, factor them out from the existing `connect_and_authenticate_with_approvals` body (small refactor — both functions then share the helpers).

The exact russh 0.55 API for `connect_stream` and `into_stream` may need adjustment — consult `russh` docs or the tests already in the repo for current call shape. The plan structure stands either way; substitute the right names.

- [ ] **Step 6: Run test to verify it passes**

Run: `cd agent && cargo test --lib ssh::jump::tests::connects_through_jump_with_key_then_password`
Expected: PASS.

- [ ] **Step 7: Add additional test cases**

Append to `agent/src/ssh/jump.rs` test module (these mirror the patterns from the first test, only the server config and assertions differ):

```rust
#[tokio::test]
async fn jump_auth_failure_returns_descriptive_error() {
    let jump_host_key = ephemeral_ed25519();
    let jump_addr = start_test_server(TestServerConfig {
        accept_password: Some(("right-user".into(), "right-pw".into())),
        accept_key_user: None,
        allow_direct_tcpip: true,
        host_key: jump_host_key,
    }).await;
    // Target server isn't even reachable — jump auth fails first.
    let jump_cfg = SshConfig {
        host: jump_addr.ip().to_string(), port: jump_addr.port(),
        username: "wrong-user".into(),
        auth: crate::ssh::SshAuth::Password("wrong-pw".into()),
        legacy_ssh: false,
    };
    let target_cfg = SshConfig {
        host: "127.0.0.1".into(), port: 1, // dummy
        username: "x".into(),
        auth: crate::ssh::SshAuth::Password("y".into()),
        legacy_ssh: false,
    };
    let store = fresh_host_key_store();
    let err = connect_via_jump(&target_cfg, &jump_cfg, store, None).await.unwrap_err();
    let msg = format!("{}", err);
    // The caller (terminal.rs / tunnels) wraps this into the user-facing
    // "Authentication to jump host '<name>' failed" message; here we just
    // assert the underlying error mentions auth.
    assert!(msg.to_lowercase().contains("auth") || msg.to_lowercase().contains("denied"),
            "expected auth-related error, got: {msg}");
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
    }).await;
    let target_addr = start_test_server(TestServerConfig {
        accept_password: Some(("right".into(), "right".into())),
        accept_key_user: None,
        allow_direct_tcpip: false,
        host_key: target_host_key,
    }).await;
    let jump_cfg = SshConfig {
        host: jump_addr.ip().to_string(), port: jump_addr.port(),
        username: "jumpuser".into(),
        auth: crate::ssh::SshAuth::Password("jumppw".into()),
        legacy_ssh: false,
    };
    let target_cfg = SshConfig {
        host: target_addr.ip().to_string(), port: target_addr.port(),
        username: "wrong".into(),
        auth: crate::ssh::SshAuth::Password("wrong".into()),
        legacy_ssh: false,
    };
    let store = fresh_host_key_store();
    let err = connect_via_jump(&target_cfg, &jump_cfg, store, None).await.unwrap_err();
    let msg = format!("{}", err);
    assert!(msg.to_lowercase().contains("auth") || msg.to_lowercase().contains("denied"),
            "expected auth-related error from target hop, got: {msg}");
}

#[tokio::test]
async fn jump_refuses_direct_tcpip_returns_descriptive_error() {
    let jump_host_key = ephemeral_ed25519();
    let jump_addr = start_test_server(TestServerConfig {
        accept_password: Some(("u".into(), "p".into())),
        accept_key_user: None,
        allow_direct_tcpip: false,    // KEY: refuse forwarding
        host_key: jump_host_key,
    }).await;
    let jump_cfg = SshConfig {
        host: jump_addr.ip().to_string(), port: jump_addr.port(),
        username: "u".into(),
        auth: crate::ssh::SshAuth::Password("p".into()),
        legacy_ssh: false,
    };
    let target_cfg = SshConfig {
        host: "127.0.0.1".into(), port: 22,
        username: "x".into(), auth: crate::ssh::SshAuth::Password("y".into()),
        legacy_ssh: false,
    };
    let store = fresh_host_key_store();
    let err = connect_via_jump(&target_cfg, &jump_cfg, store, None).await.unwrap_err();
    let msg = format!("{}", err);
    assert!(msg.contains("AllowTcpForwarding") || msg.contains("refused"),
            "expected forwarding-refused message, got: {msg}");
}
```

- [ ] **Step 8: Run all tests**

Run: `cd agent && cargo test --lib ssh::jump`
Expected: all four tests PASS.

- [ ] **Step 9: Commit**

```bash
git add agent/src/ssh/jump.rs agent/src/ssh/mod.rs agent/src/ssh/host_keys.rs
git commit -m "feat(ssh): native russh ProxyJump via connect_via_jump"
```

---

## Task 7: `SshSession::connect_via_jump` constructor

**Files:**
- Modify: `agent/src/ssh/mod.rs:375-464` (add sibling constructor near `SshSession::connect`)

- [ ] **Step 1: Write failing test**

Append to `agent/src/ssh/jump.rs` test module:

```rust
#[tokio::test]
async fn ssh_session_connect_via_jump_opens_shell_through_jump() {
    let jump_host_key = ephemeral_ed25519();
    let target_host_key = ephemeral_ed25519();
    let jump_addr = start_test_server(TestServerConfig {
        accept_password: Some(("u".into(), "p".into())),
        accept_key_user: None,
        allow_direct_tcpip: true,
        host_key: jump_host_key,
    }).await;
    let target_addr = start_test_server(TestServerConfig {
        accept_password: Some(("dev".into(), "devpw".into())),
        accept_key_user: None,
        allow_direct_tcpip: false,
        host_key: target_host_key,
    }).await;

    let jump = SshConfig {
        host: jump_addr.ip().to_string(), port: jump_addr.port(),
        username: "u".into(), auth: crate::ssh::SshAuth::Password("p".into()),
        legacy_ssh: false,
    };
    let target = SshConfig {
        host: target_addr.ip().to_string(), port: target_addr.port(),
        username: "dev".into(), auth: crate::ssh::SshAuth::Password("devpw".into()),
        legacy_ssh: false,
    };

    let session = crate::ssh::SshSession::connect_via_jump(target, jump, 80, 24).await
        .expect("should connect via jump");

    // Read banner from target shell (test server emits "READY\n").
    let data = session.recv().await.unwrap().expect("should receive data");
    let s = String::from_utf8_lossy(&data);
    assert!(s.contains("READY"), "expected READY banner, got: {s}");
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd agent && cargo test --lib ssh::jump::tests::ssh_session_connect_via_jump_opens_shell_through_jump`
Expected: FAIL — `SshSession::connect_via_jump` does not exist.

- [ ] **Step 3: Add constructor**

In `agent/src/ssh/mod.rs`, after `impl SshSession { pub async fn connect(...) ... }` (around line 464), add:

```rust
impl SshSession {
    /// Connect to a target through a jump host. Same shell + I/O semantics
    /// as `connect()`, but the underlying TCP path goes via russh's
    /// direct-tcpip channel.
    pub async fn connect_via_jump(
        target: SshConfig,
        jump: SshConfig,
        cols: u32,
        rows: u32,
    ) -> Result<Self, SshError> {
        let cols = if cols == 0 { 80 } else { cols };
        let rows = if rows == 0 { 24 } else { rows };

        // Use the existing globally-shared host key store + approvals.
        // Look at how `SshSession::connect` accesses these — likely via
        // a static or via app_state passed elsewhere. If they're not
        // accessible from here, accept them as parameters and have
        // terminal.rs pass them in.
        let store = crate::ssh::host_keys::shared_store();   // or equivalent
        let approvals = crate::ssh::approvals::shared_service(); // or equivalent

        let handle = crate::ssh::jump::connect_via_jump(&target, &jump, store, approvals).await?;

        // The rest mirrors connect() exactly: open session channel, request
        // PTY, request shell, spawn the I/O loop.
        let mut channel = handle
            .channel_open_session()
            .await
            .map_err(|e| SshError::ChannelError(e.to_string()))?;

        channel
            .request_pty(false, "xterm-256color", cols, rows, 0, 0, &[])
            .await
            .map_err(|e| SshError::ChannelError(e.to_string()))?;

        channel
            .request_shell(false)
            .await
            .map_err(|e| SshError::ChannelError(e.to_string()))?;

        let (input_tx, mut input_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let (resize_tx, mut resize_rx) = mpsc::unbounded_channel::<(u32, u32)>();
        let (output_tx, output_rx) = mpsc::unbounded_channel::<Vec<u8>>();

        tokio::spawn(async move {
            loop {
                tokio::select! {
                    msg = channel.wait() => {
                        match msg {
                            Some(ChannelMsg::Data { data }) => {
                                if output_tx.send(data.to_vec()).is_err() { break; }
                            }
                            Some(ChannelMsg::ExtendedData { data, .. }) => {
                                if output_tx.send(data.to_vec()).is_err() { break; }
                            }
                            Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                            _ => {}
                        }
                    }
                    Some(data) = input_rx.recv() => {
                        use std::io::Cursor;
                        let mut cursor = Cursor::new(data);
                        if channel.data(&mut cursor).await.is_err() { break; }
                    }
                    Some((cols, rows)) = resize_rx.recv() => {
                        let _ = channel.window_change(cols, rows, 0, 0).await;
                    }
                }
            }
            let _ = channel.eof().await;
            let _ = handle.disconnect(Disconnect::ByApplication, "", "en").await;
        });

        Ok(Self {
            input_tx,
            resize_tx,
            output_rx: Mutex::new(output_rx),
            _closed: Mutex::new(false),
        })
    }
}
```

The duplication with `connect()` is intentional — the I/O loop is identical, the only difference is how `handle` is obtained. If you want to dedupe, factor the body after `handle` acquisition into a private `from_handle(handle, cols, rows)` helper and have both constructors call it. Decide based on whether you can keep the test passing during the refactor.

About `shared_store()` / `shared_service()`: if the codebase doesn't have global accessors, the right move is to plumb them through. Look at how `connect()` (line 378) currently obtains them — likely from the call site. If so, add them as parameters to `connect_via_jump` and pass them from `terminal.rs` in Task 9.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent && cargo test --lib ssh::jump::tests::ssh_session_connect_via_jump_opens_shell_through_jump`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/src/ssh/mod.rs
git commit -m "feat(ssh): SshSession::connect_via_jump constructor"
```

---

## Task 8: `resolve_effective_jump` + `SshParams.jump_*` fields

**Files:**
- Modify: `agent/src/ws.rs:478-497` (`SshParams` struct)
- Modify: `agent/src/ws.rs:626-647` (replace `resolve_jump_host_params` with `resolve_effective_jump`)
- Modify: `agent/src/ws.rs:504-622` (`get_ssh_params_with_vault` populates new fields)

- [ ] **Step 1: Write failing tests**

Add to a `#[cfg(test)] mod tests` block at the bottom of `agent/src/ws.rs`. If one doesn't exist, create it. The tests need a mocked `DataProvider` — look for any existing mock provider in `agent/tests/` or `agent/src/providers/`. If none exists, define a minimal one inline:

```rust
#[cfg(test)]
mod resolve_effective_jump_tests {
    use super::*;
    use crate::models::{JumpHost, CredentialProfile, ProfileCredential, AuthType, CliFlavor};
    use chrono::Utc;

    // Helper: build a CredentialProfile fixture.
    fn profile(id: &str, name: &str, jump: Option<&str>) -> CredentialProfile {
        CredentialProfile {
            id: id.into(), name: name.into(), username: "u".into(),
            auth_type: AuthType::Password, key_path: None,
            port: 22, keepalive_interval: 30, connection_timeout: 10,
            terminal_theme: None, default_font_size: None, default_font_family: None,
            scrollback_lines: 1000, local_echo: false, auto_reconnect: false,
            reconnect_delay: 5, cli_flavor: CliFlavor::default(),
            auto_commands: vec![], jump_host_id: jump.map(String::from),
            created_at: Utc::now(), updated_at: Utc::now(),
        }
    }

    fn jump_host(id: &str, name: &str, profile_id: &str) -> JumpHost {
        JumpHost {
            id: id.into(), name: name.into(), host: "1.2.3.4".into(),
            port: 22, profile_id: profile_id.into(),
            created_at: Utc::now(), updated_at: Utc::now(),
        }
    }

    fn credential(pw: &str) -> ProfileCredential {
        ProfileCredential {
            password: Some(pw.into()), key_passphrase: None,
            snmp_communities: None,
        }
    }

    // For mocking the provider, use the existing test pattern in the
    // codebase. If there's no mock, build one with the `mockall` crate
    // (already a dev-dep — check Cargo.toml), or create a small in-memory
    // provider.

    #[tokio::test]
    async fn session_jump_overrides_profile_jump() {
        // Setup: profile.jump = "P-JUMP", session.jump = "S-JUMP"
        // Expected: returns S-JUMP resolution
        let app_state = mock_app_state(|m| {
            m.expect_get_jump_host()
                .with(eq("S-JUMP".to_string()))
                .returning(|_| Ok(jump_host("S-JUMP", "session-jump", "JP-PROFILE")));
            m.expect_get_profile()
                .with(eq("JP-PROFILE".to_string()))
                .returning(|_| Ok(profile("JP-PROFILE", "session-jump-creds", None)));
            m.expect_get_profile_credential()
                .with(eq("JP-PROFILE".to_string()))
                .returning(|_| Ok(Some(credential("session-jump-pw"))));
        });
        let result = resolve_effective_jump(Some("S-JUMP"), Some("P-JUMP"), &app_state).await.unwrap();
        let r = result.expect("should resolve");
        assert_eq!(r.jump_host.id, "S-JUMP");
        assert_eq!(r.jump_credential.unwrap().password.unwrap(), "session-jump-pw");
    }

    #[tokio::test]
    async fn falls_back_to_profile_jump_when_session_has_none() {
        let app_state = mock_app_state(|m| {
            m.expect_get_jump_host()
                .with(eq("P-JUMP".to_string()))
                .returning(|_| Ok(jump_host("P-JUMP", "profile-jump", "PJ-PROFILE")));
            m.expect_get_profile()
                .with(eq("PJ-PROFILE".to_string()))
                .returning(|_| Ok(profile("PJ-PROFILE", "profile-jump-creds", None)));
            m.expect_get_profile_credential()
                .with(eq("PJ-PROFILE".to_string()))
                .returning(|_| Ok(Some(credential("profile-jump-pw"))));
        });
        let result = resolve_effective_jump(None, Some("P-JUMP"), &app_state).await.unwrap();
        let r = result.expect("should resolve from profile");
        assert_eq!(r.jump_host.id, "P-JUMP");
    }

    #[tokio::test]
    async fn returns_none_when_neither_set() {
        let app_state = mock_app_state(|_| {});
        let result = resolve_effective_jump(None, None, &app_state).await.unwrap();
        assert!(result.is_none());
    }
}
```

If `mockall` isn't already a dev dep, add it to `agent/Cargo.toml` `[dev-dependencies]`: `mockall = "0.12"`. Then derive `MockDataProvider` from the trait (annotate the trait with `#[cfg_attr(test, automock)]`). The exact harness is a one-time setup — invest in it because Task 10 will reuse it.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd agent && cargo test --lib ws::resolve_effective_jump_tests`
Expected: FAIL — `resolve_effective_jump` does not exist.

- [ ] **Step 3: Add `JumpResolution` and replace `resolve_jump_host_params`**

In `agent/src/ws.rs`, replace the existing `resolve_jump_host_params` (line 626-647):

```rust
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
    app_state: &Arc<AppState>,
) -> Result<Option<JumpResolution>, String> {
    let id = session_jump_id.or(profile_jump_id);
    let Some(id) = id else { return Ok(None); };

    let jump_host = app_state.provider.get_jump_host(id).await
        .map_err(|e| format!(
            "Jump host '{}' referenced by session/profile no longer exists. \
             Edit the session or profile to fix. (Underlying error: {})",
            id, e
        ))?;

    let jump_profile = app_state.provider.get_profile(&jump_host.profile_id).await
        .map_err(|e| format!(
            "Failed to load auth profile '{}' for jump host '{}': {}",
            jump_host.profile_id, jump_host.name, e
        ))?;

    let jump_credential = match app_state.provider.get_profile_credential(&jump_host.profile_id).await {
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
```

- [ ] **Step 4: Update `SshParams` struct**

In `agent/src/ws.rs:478-497`, replace the `SshParams` struct definition:

```rust
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
    port_forwards: Vec<PortForward>,
    profile_id: String,
    auto_commands: Vec<String>,
    legacy_ssh: bool,
}
```

- [ ] **Step 5: Update `get_ssh_params_with_vault`**

In `agent/src/ws.rs:504-622`, replace the jump-resolution block (currently lines 578-588):

```rust
// Resolve effective jump (session override > profile default).
let jump_resolution = resolve_effective_jump(
    session.jump_host_id.as_deref(),
    profile.jump_host_id.as_deref(),
    app_state,
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
            false, // jump_legacy_ssh — wire from a future profile field if added
        )
    } else {
        (None, None, None, None, None, None, None, false)
    };
```

Then update the `SshParams { ... }` constructor below it to include the new fields (replace `jump_host`, `jump_port`, `jump_username` lines with the eight new ones).

- [ ] **Step 6: Run tests**

Run: `cd agent && cargo test --lib ws::resolve_effective_jump_tests`
Expected: all PASS.

Run: `cd agent && cargo build`
Expected: build succeeds (callers of removed `resolve_jump_host_params` may need fixup — search for it: `grep -rn resolve_jump_host_params agent/src`).

- [ ] **Step 7: Commit**

```bash
git add agent/src/ws.rs agent/Cargo.toml
git commit -m "feat(ws): resolve_effective_jump with full credential context"
```

---

## Task 9: `terminal.rs` — switch SSH path to `connect_via_jump`

**Files:**
- Modify: `agent/src/terminal.rs:160-344` (`new_ssh` — delete PTY branch, use `SshSession::connect_via_jump`)
- Modify: `agent/src/terminal.rs:471-517` (`create_ssh_session` — add new parameters)
- Modify: `agent/src/ws.rs:157-172` (`handle_ssh_terminal` — pass new SshParams fields to `create_ssh_session`)

- [ ] **Step 1: Write failing test**

Add to `agent/src/terminal.rs` (in a `#[cfg(test)] mod tests` block, or extend existing):

```rust
#[cfg(test)]
mod jump_terminal_tests {
    use super::*;
    use crate::ssh::SshAuth;
    use tokio::sync::mpsc;

    // This test re-uses the in-process russh server scaffolding from
    // ssh::jump::tests. Move that scaffolding into a `pub(crate)` test-only
    // module (e.g. agent/src/ssh/test_servers.rs) so it can be shared.

    #[tokio::test]
    async fn new_ssh_with_jump_authenticates_target_with_target_creds() {
        let (tx, _rx) = mpsc::unbounded_channel();
        let (jump_addr, target_addr) = crate::ssh::test_servers::start_jump_and_target(
            "jump-user", "jump-pw", "dev-user", "dev-pw"
        ).await;

        let session = TerminalSession::new_ssh(
            "test-id".into(),
            tx,
            &target_addr.ip().to_string(),
            target_addr.port(),
            "dev-user",
            Some("dev-pw"),
            None,                  // no key
            None,
            // jump host
            Some(&jump_addr.ip().to_string()),
            Some(jump_addr.port()),
            Some("jump-user"),
            Some("jump-pw"),       // NEW PARAM: jump_password
            None,                  // jump_key_path
            None,                  // jump_key_passphrase
            false,                 // jump_legacy_ssh
            vec![],                // port_forwards
            false,                 // legacy_ssh
            80, 24,
        ).await.expect("should connect");
        // If we got here without error, target auth succeeded with dev-pw.
        drop(session);
    }
}
```

- [ ] **Step 2: Move test server scaffolding**

Create `agent/src/ssh/test_servers.rs` with:

```rust
//! Shared test scaffolding: in-process russh servers used by jump and
//! terminal tests.
#![cfg(test)]

// Copy contents of the helper functions defined inline in
// agent/src/ssh/jump.rs tests:
//   - TestServerConfig, TestServerHandler, TestServer
//   - start_test_server
//   - ephemeral_ed25519
//   - write_temp_key
//   - fresh_host_key_store
//   - pump_channel_to_socket
//
// And add this combined helper:

use std::net::SocketAddr;
pub async fn start_jump_and_target(
    jump_user: &str, jump_pw: &str,
    target_user: &str, target_pw: &str,
) -> (SocketAddr, SocketAddr) {
    let jump_key = ephemeral_ed25519();
    let target_key = ephemeral_ed25519();
    let jump = start_test_server(TestServerConfig {
        accept_password: Some((jump_user.into(), jump_pw.into())),
        accept_key_user: None,
        allow_direct_tcpip: true,
        host_key: jump_key,
    }).await;
    let target = start_test_server(TestServerConfig {
        accept_password: Some((target_user.into(), target_pw.into())),
        accept_key_user: None,
        allow_direct_tcpip: false,
        host_key: target_key,
    }).await;
    (jump, target)
}
```

Register the module in `agent/src/ssh/mod.rs`:

```rust
#[cfg(test)]
pub(crate) mod test_servers;
```

Update `agent/src/ssh/jump.rs` tests to import from `test_servers` instead of defining the helpers inline. This keeps test code DRY.

- [ ] **Step 3: Run new test to verify it fails**

Run: `cd agent && cargo test --lib terminal::jump_terminal_tests`
Expected: compile error — `new_ssh` does not have the `jump_password`/etc. parameters yet.

- [ ] **Step 4: Update `new_ssh` signature and replace PTY branch**

In `agent/src/terminal.rs:162-182`, expand the signature:

```rust
pub async fn new_ssh(
    id: String,
    output_tx: mpsc::UnboundedSender<TerminalMessage>,
    host: &str,
    port: u16,
    username: &str,
    password: Option<&str>,
    key_path: Option<&str>,
    key_passphrase: Option<&str>,
    jump_host: Option<&str>,
    jump_port: Option<u16>,
    jump_username: Option<&str>,
    jump_password: Option<&str>,
    jump_key_path: Option<&str>,
    jump_key_passphrase: Option<&str>,
    jump_legacy_ssh: bool,
    port_forwards: Vec<PortForward>,
    legacy_ssh: bool,
    initial_cols: u32,
    initial_rows: u32,
) -> Result<Self, anyhow::Error> {
    let _ = port_forwards;

    // Build target SshConfig (same as direct path).
    let target_auth = if let Some(pw) = password {
        SshAuth::Password(pw.to_string())
    } else if let Some(kp) = key_path {
        SshAuth::KeyFile { path: kp.to_string(), passphrase: key_passphrase.map(String::from) }
    } else {
        return Err(anyhow::anyhow!("No authentication method provided for target"));
    };
    let target_cfg = SshConfig {
        host: host.to_string(), port, username: username.to_string(),
        auth: target_auth, legacy_ssh,
    };

    let session = if let Some(jump_host_str) = jump_host {
        let jump_user = jump_username.unwrap_or(username);
        let jump_p = jump_port.unwrap_or(22);
        let jump_auth = if let Some(pw) = jump_password {
            SshAuth::Password(pw.to_string())
        } else if let Some(kp) = jump_key_path {
            SshAuth::KeyFile { path: kp.to_string(), passphrase: jump_key_passphrase.map(String::from) }
        } else {
            return Err(anyhow::anyhow!(
                "No authentication method provided for jump host '{}'. \
                 Configure credentials in the jump host's profile.",
                jump_host_str
            ));
        };
        let jump_cfg = SshConfig {
            host: jump_host_str.to_string(),
            port: jump_p,
            username: jump_user.to_string(),
            auth: jump_auth,
            legacy_ssh: jump_legacy_ssh,
        };
        tracing::info!(
            "Creating SSH session to {} via jump host {} (russh ProxyJump)",
            host, jump_host_str
        );
        SshSession::connect_via_jump(target_cfg, jump_cfg, initial_cols, initial_rows)
            .await
            .map_err(|e| anyhow::anyhow!("SSH connection via jump failed: {}", e))?
    } else {
        SshSession::connect(target_cfg, initial_cols, initial_rows)
            .await
            .map_err(|e| anyhow::anyhow!("SSH connection failed: {}", e))?
    };

    let session = Arc::new(session);
    let session_for_reader = session.clone();

    // Reader task — IDENTICAL to the existing direct-path code (lines 309-337).
    let reader_handle = tokio::spawn(async move {
        let mut decoder = Utf8Decoder::new();
        loop {
            match session_for_reader.recv().await {
                Ok(Some(data)) => {
                    if data.is_empty() { continue; }
                    let text = decoder.decode(&data);
                    if text.is_empty() { continue; }
                    if output_tx.send(TerminalMessage::Output(text)).is_err() { break; }
                }
                Ok(None) => {
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
```

This DELETES the old PTY-spawning jump branch entirely (lines 186-278 of the original) and the `Note: Password auth through jump host would require sshpass` comment.

- [ ] **Step 5: Update `create_ssh_session` signature**

In `agent/src/terminal.rs:471-517`, expand the parameter list and forward to `new_ssh`:

```rust
pub async fn create_ssh_session(
    &self,
    output_tx: mpsc::UnboundedSender<TerminalMessage>,
    host: &str,
    port: u16,
    username: &str,
    password: Option<&str>,
    key_path: Option<&str>,
    key_passphrase: Option<&str>,
    jump_host: Option<&str>,
    jump_port: Option<u16>,
    jump_username: Option<&str>,
    jump_password: Option<&str>,
    jump_key_path: Option<&str>,
    jump_key_passphrase: Option<&str>,
    jump_legacy_ssh: bool,
    port_forwards: Vec<PortForward>,
    legacy_ssh: bool,
    initial_cols: u32,
    initial_rows: u32,
) -> Result<String, anyhow::Error> {
    let id = uuid::Uuid::new_v4().to_string();
    let session = TerminalSession::new_ssh(
        id.clone(), output_tx, host, port, username, password, key_path, key_passphrase,
        jump_host, jump_port, jump_username,
        jump_password, jump_key_path, jump_key_passphrase, jump_legacy_ssh,
        port_forwards, legacy_ssh, initial_cols, initial_rows,
    ).await?;
    self.sessions.write().await.insert(id.clone(), Arc::new(session));
    Ok(id)
}
```

- [ ] **Step 6: Update `handle_ssh_terminal` call site**

In `agent/src/ws.rs:157-172`, pass the new fields:

```rust
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
).await { /* ... */ };
```

- [ ] **Step 7: Run test to verify it passes**

Run: `cd agent && cargo test --lib terminal::jump_terminal_tests`
Expected: PASS.

Run: `cd agent && cargo build`
Expected: clean build. If `CommandBuilder` / `native_pty_system` are now unused in `terminal.rs`, remove their imports.

- [ ] **Step 8: Commit**

```bash
git add agent/src/terminal.rs agent/src/ws.rs agent/src/ssh/mod.rs agent/src/ssh/test_servers.rs
git commit -m "feat(terminal): use native russh ProxyJump, delete PTY ssh -J path"
```

---

## Task 10: Tunnels — actually use jump host

**Files:**
- Modify: `agent/src/tunnels/mod.rs:26-44` (`ConnectionKey` — uses effective jump id)
- Modify: `agent/src/tunnels/mod.rs:92-175` (`get_or_create_connection` — calls `connect_via_jump` when jump set)
- Modify: `agent/src/tunnels/mod.rs:80-86` (`TunnelManager::new` — needs profile resolution helper)

- [ ] **Step 1: Write failing test**

Append to `agent/src/tunnels/mod.rs` (or sibling test file):

```rust
#[cfg(test)]
mod tunnel_jump_tests {
    use super::*;
    use crate::models::PortForwardType;

    #[tokio::test]
    async fn tunnel_with_jump_routes_via_jump_server() {
        let (jump_addr, target_addr) = crate::ssh::test_servers::start_jump_and_target(
            "jumpu", "jumppw", "tgt", "tgtpw",
        ).await;

        // Build a provider with: a target profile, a jump auth profile, a jump host,
        // and a tunnel pointing at target with jump_host_id set.
        let provider = crate::providers::local::LocalDataProvider::new_in_memory_for_tests().await.unwrap();
        let jump_profile = provider.create_credential_profile(...).await.unwrap();
        // (set username = "jumpu", password via vault — use test vault helper if needed)
        let jh = provider.create_jump_host(NewJumpHost {
            name: "test-jump".into(),
            host: jump_addr.ip().to_string(),
            port: jump_addr.port(),
            profile_id: jump_profile.id.clone(),
        }).await.unwrap();
        let target_profile = provider.create_credential_profile(...).await.unwrap();
        // (username = "tgt", password via vault)

        let tunnel = Tunnel {
            id: "t1".into(), name: "test".into(),
            host: target_addr.ip().to_string(), port: target_addr.port(),
            profile_id: target_profile.id.clone(),
            jump_host_id: Some(jh.id.clone()),
            forward_type: PortForwardType::Local,
            local_port: 0,  // ephemeral
            bind_address: "127.0.0.1".into(),
            remote_host: Some("127.0.0.1".into()),
            remote_port: Some(target_addr.port()),
            auto_start: false, auto_reconnect: false, max_retries: 0,
            enabled: true, created_at: String::new(), updated_at: String::new(),
        };

        let mgr = TunnelManager::new(Arc::new(provider));
        mgr.start_tunnel(&tunnel).await.expect("tunnel should start via jump");
        // Tunnel started => SSH connection succeeded => routed via jump.
        mgr.stop_tunnel(&tunnel.id).await.unwrap();
    }
}
```

The credential setup is sketched (`...`) because vault setup requires unlocking — fill it in by following the pattern in existing tunnel tests (search `agent/src/tunnels` and `agent/tests` for examples of vault unlock in tests). If no example exists, the simplest path is to add a `#[cfg(test)]` helper on `LocalDataProvider` that bypasses vault encryption for tests.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && cargo test --lib tunnels::tunnel_jump_tests`
Expected: FAIL — currently `get_or_create_connection` connects directly, ignoring `key.jump_host_id`. The connection to `target_addr` from outside won't go through `jump_addr`, so the test server will see direct traffic. (If both servers happen to be on localhost so direct works anyway, augment the assertion: have the target server reject direct connections by inspecting the source port via a sentinel — or better, assert by inspecting which of the two test servers logged the auth attempt.)

To make the failing assertion clean, add a counter to `TestServerConfig` (`Arc<AtomicUsize>` for connection count) and assert: `assert!(jump_count.load() >= 1)` and `assert!(target_via_direct_count.load() == 0)`. Wire that into `start_test_server` and `start_jump_and_target`.

- [ ] **Step 3: Update `ConnectionKey` to use effective jump id**

In `agent/src/tunnels/mod.rs:26-44`, change `ConnectionKey::from_tunnel` to compute the effective id. This requires a profile lookup, so move the construction into an async helper:

```rust
impl ConnectionKey {
    pub async fn from_tunnel_resolved(
        tunnel: &Tunnel,
        provider: &Arc<dyn DataProvider>,
    ) -> Result<Self, String> {
        let effective_jump_id = if let Some(id) = &tunnel.jump_host_id {
            Some(id.clone())   // explicit override wins
        } else {
            // Inherit from profile.
            let profile = provider.get_profile(&tunnel.profile_id).await
                .map_err(|e| format!("Failed to load profile '{}': {}", tunnel.profile_id, e))?;
            profile.jump_host_id
        };
        Ok(Self {
            host: tunnel.host.clone(),
            port: tunnel.port,
            profile_id: tunnel.profile_id.clone(),
            jump_host_id: effective_jump_id,
        })
    }
}
```

Update `start_tunnel` (`agent/src/tunnels/mod.rs:178`) to use `from_tunnel_resolved(tunnel, &self.provider).await?` instead of `ConnectionKey::from_tunnel`.

- [ ] **Step 4: Update `get_or_create_connection`**

In `agent/src/tunnels/mod.rs:92-175`, after building `target_cfg` (currently named `config`), branch on `key.jump_host_id`:

```rust
let handle = if let Some(jump_id) = &key.jump_host_id {
    // Resolve jump host + its profile + its credential.
    let jump_host = self.provider.get_jump_host(jump_id).await
        .map_err(|e| format!(
            "Jump host '{}' for tunnel '{}' no longer exists: {}",
            jump_id, tunnel_id, e
        ))?;
    let jump_profile = self.provider.get_profile(&jump_host.profile_id).await
        .map_err(|e| format!(
            "Failed to load profile for jump host '{}': {}", jump_host.name, e
        ))?;
    let jump_credential = self.provider.get_profile_credential(&jump_host.profile_id).await
        .map_err(|e| format!(
            "Failed to read credential for jump host '{}': {}", jump_host.name, e
        ))?;

    let jump_auth = match jump_profile.auth_type {
        AuthType::Password => {
            let pw = jump_credential.as_ref().and_then(|c| c.password.clone())
                .ok_or_else(|| format!(
                    "No password configured for jump host '{}' (profile '{}'). \
                     Configure credentials in profile settings.",
                    jump_host.name, jump_profile.name
                ))?;
            SshAuth::Password(pw)
        }
        AuthType::Key => {
            let path = jump_profile.key_path.clone().ok_or_else(|| format!(
                "No SSH key path configured for jump host '{}' (profile '{}').",
                jump_host.name, jump_profile.name
            ))?;
            let passphrase = jump_credential.as_ref().and_then(|c| c.key_passphrase.clone());
            SshAuth::KeyFile { path, passphrase }
        }
    };

    let jump_cfg = SshConfig {
        host: jump_host.host.clone(),
        port: jump_host.port,
        username: jump_profile.username.clone(),
        auth: jump_auth,
        legacy_ssh: false,
    };

    crate::ssh::jump::connect_via_jump(
        &config,    // target
        &jump_cfg,
        crate::ssh::host_keys::shared_store(),       // or threaded-through equivalent
        crate::ssh::approvals::shared_service(),
    ).await
    .map_err(|e| format!(
        "SSH connection to {}:{} via jump '{}' failed: {}",
        config.host, config.port, jump_host.name, e
    ))?
} else {
    connect_and_authenticate(&config, false).await
        .map_err(|e| format!("SSH connection to {}:{} failed: {}", key.host, key.port, e))?
};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd agent && cargo test --lib tunnels::tunnel_jump_tests`
Expected: PASS — connection counters show jump server received the connection.

- [ ] **Step 6: Add regression test for direct (no jump) tunnel**

Append to the same test module — assert behavior unchanged when `jump_host_id` is None:

```rust
#[tokio::test]
async fn tunnel_without_jump_connects_direct() {
    // Use ssh::test_servers::start_test_server with allow_direct_tcpip=false
    // since this test isn't using forwarding — just assert the tunnel
    // starts and the target server accepts auth directly.
    // Mirror the structure of the previous test, omitting jump setup.
    todo!("fill in mirroring previous test, jump_host_id: None")
}
```

(The `todo!` is a placeholder for the engineer to fill the same pattern minus the jump bits — it's straightforward repetition.)

Also add the pool-sharing test:

```rust
#[tokio::test]
async fn two_tunnels_with_same_effective_jump_share_pooled_connection() {
    // Standalone tunnel A: explicit jump_host_id = JH
    // Session-attached tunnel B: profile has jump_host_id = JH, tunnel.jump_host_id = None
    // Assert: connections.len() == 1 after starting both.
    todo!("fill in: build two tunnels resolving to same key, assert pool size")
}
```

- [ ] **Step 7: Run all tunnel tests**

Run: `cd agent && cargo test --lib tunnels`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add agent/src/tunnels/mod.rs
git commit -m "feat(tunnels): actually route through configured jump host"
```

---

## Task 11: Session-attached tunnels — inherit SSH session's jump

**Files:**
- Modify: `agent/src/ws.rs:188-220` (session-tunnel materialization sets `jump_host_id`)

- [ ] **Step 1: Write failing test**

Add to the `ws.rs` test module:

```rust
#[tokio::test]
async fn session_attached_tunnel_inherits_ssh_session_jump() {
    // Setup ssh_params with jump_host_id_effective = Some("JH-1")
    // and one port_forward.
    // Call the materialization code path (extract into a helper if not
    // already separate from handle_ssh_terminal).
    // Assert: the materialized Tunnel has jump_host_id = Some("JH-1").
    todo!("fill in scaffold matching existing patterns")
}
```

If the materialization is currently inline in `handle_ssh_terminal` (which it is, lines 196-214), refactor it into a small helper function to make it testable:

```rust
fn materialize_session_tunnel(
    ssh_params: &SshParams,
    session_id: &str,
    fwd: &PortForward,
) -> Tunnel {
    Tunnel {
        id: format!("session:{}:{}", session_id, fwd.id),
        name: format!("Session forward :{}", fwd.local_port),
        host: ssh_params.host.clone(),
        port: ssh_params.port,
        profile_id: ssh_params.profile_id.clone(),
        jump_host_id: ssh_params.jump_host_id_effective.clone(),    // CHANGED
        forward_type: fwd.forward_type.clone(),
        local_port: fwd.local_port,
        bind_address: fwd.bind_address.clone().unwrap_or_else(|| "127.0.0.1".to_string()),
        remote_host: fwd.remote_host.clone(),
        remote_port: fwd.remote_port,
        auto_start: false, auto_reconnect: false, max_retries: 0,
        enabled: true, created_at: String::new(), updated_at: String::new(),
    }
}
```

The test then exercises `materialize_session_tunnel` directly.

- [ ] **Step 2: Run test to verify failure (and confirm signature)**

Run: `cd agent && cargo test --lib ws::session_attached_tunnel_inherits_ssh_session_jump`
Expected: FAIL — either compile error (helper missing) or assertion fails (`jump_host_id: None`).

- [ ] **Step 3: Apply the change**

In `agent/src/ws.rs:196-214`, replace the inline `Tunnel` construction with:

```rust
let tunnel = materialize_session_tunnel(&ssh_params, &session_id, fwd);
```

And add the helper function above (from Step 1).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent && cargo test --lib ws::session_attached_tunnel_inherits_ssh_session_jump`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/src/ws.rs
git commit -m "feat(ws): session-attached tunnels inherit SSH session's effective jump"
```

---

## Task 12: Frontend — profile editor jump host select

**Files:**
- Modify: `frontend/src/api/profiles.ts` (or wherever profile DTOs live — `grep -rn 'CredentialProfile' frontend/src` to locate)
- Modify: `frontend/src/components/SettingsPanel.tsx` (profile editor)
- Test: `frontend/src/components/__tests__/SettingsPanel.test.tsx` (or alongside)

- [ ] **Step 1: Locate DTO and add field**

Find the TypeScript type for `CredentialProfile`. Search:
```bash
grep -rn "CredentialProfile\|jump_host_id" frontend/src/api frontend/src/types 2>/dev/null
```

Add `jump_host_id?: string | null` to:
- `CredentialProfile` (read shape)
- `NewCredentialProfile` (create payload)
- `UpdateCredentialProfile` (update payload)

- [ ] **Step 2: Write failing test for the editor**

Locate the SettingsPanel profile editor test file (or create one). Use the project's existing test pattern (Vitest + Testing Library — `grep "@testing-library" frontend/src` to confirm).

```ts
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProfileEditor } from "../SettingsPanel"; // or correct export path

describe("ProfileEditor jump host select", () => {
  it("renders an option per configured jump host plus None", async () => {
    render(<ProfileEditor jumpHosts={[
      { id: "jh-1", name: "edge-bastion", host: "1.2.3.4", port: 22, profile_id: "p2" },
      { id: "jh-2", name: "dc-bastion", host: "10.0.0.1", port: 22, profile_id: "p3" },
    ]} profile={{ jump_host_id: null /* ...rest minimal */ }} onChange={() => {}} />);
    const select = screen.getByLabelText(/jump host/i);
    expect(select).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /none/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "edge-bastion" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "dc-bastion" })).toBeInTheDocument();
  });

  it("calls onChange with the selected jump host id", async () => {
    const onChange = vi.fn();
    render(<ProfileEditor jumpHosts={[
      { id: "jh-1", name: "edge", host: "x", port: 22, profile_id: "p2" },
    ]} profile={{ jump_host_id: null }} onChange={onChange} />);
    await userEvent.selectOptions(screen.getByLabelText(/jump host/i), "jh-1");
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ jump_host_id: "jh-1" }));
  });
});
```

The exact prop shape and component name will vary — adapt to the actual editor's API. The point is two assertions: options render correctly, selection propagates.

- [ ] **Step 3: Run test to verify failure**

Run: `cd frontend && npm test -- SettingsPanel`
Expected: FAIL — select doesn't exist yet.

- [ ] **Step 4: Add the select to the editor**

In `SettingsPanel.tsx` (the profile form section):

```tsx
<div className="form-row">
  <label htmlFor="profile-jump-host">Jump Host</label>
  <select
    id="profile-jump-host"
    value={profile.jump_host_id ?? ""}
    onChange={(e) => onChange({
      ...profile,
      jump_host_id: e.target.value === "" ? null : e.target.value,
    })}
  >
    <option value="">(None — direct connect)</option>
    {jumpHosts.map((jh) => (
      <option key={jh.id} value={jh.id}>{jh.name}</option>
    ))}
  </select>
  <small>Sessions and tunnels using this profile will connect through this jump host by default. Can be overridden per-session or per-tunnel.</small>
</div>
```

If the editor receives `jumpHosts` from a parent (likely SettingsPanel), thread it through. If it currently fetches its own data, fetch jump hosts via the existing `listJumpHosts` API call (search `frontend/src/api` for it).

- [ ] **Step 5: Run test to verify it passes**

Run: `cd frontend && npm test -- SettingsPanel`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/api frontend/src/components/SettingsPanel.tsx frontend/src/components/__tests__/SettingsPanel.test.tsx
git commit -m "feat(ui): jump host select on profile editor"
```

---

## Task 13: Frontend — session settings inherit label

**Files:**
- Modify: `frontend/src/components/SessionSettingsDialog.tsx`
- Test: alongside existing tests for that component

- [ ] **Step 1: Write failing test**

```ts
describe("SessionSettingsDialog jump host inheritance label", () => {
  it("shows 'Inherit from profile (edge-bastion)' when profile has a jump and session has none", () => {
    render(<SessionSettingsDialog
      session={{ jump_host_id: null, profile_id: "p1" /* ... */ }}
      profiles={[{ id: "p1", jump_host_id: "jh-1" /* ... */ }]}
      jumpHosts={[{ id: "jh-1", name: "edge-bastion" /* ... */ }]}
      onChange={() => {}} />);
    expect(screen.getByText(/Inherit from profile \(edge-bastion\)/)).toBeInTheDocument();
  });

  it("shows 'Inherit from profile (direct)' when profile has no jump", () => {
    render(<SessionSettingsDialog
      session={{ jump_host_id: null, profile_id: "p1" }}
      profiles={[{ id: "p1", jump_host_id: null }]}
      jumpHosts={[]}
      onChange={() => {}} />);
    expect(screen.getByText(/Inherit from profile \(direct\)/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `cd frontend && npm test -- SessionSettingsDialog`
Expected: FAIL.

- [ ] **Step 3: Update the dialog**

Find the existing jump host select in `SessionSettingsDialog.tsx`. Replace its `(None)` first option with a dynamic inherit label:

```tsx
const inheritedJumpId = profile?.jump_host_id ?? null;
const inheritedJumpName = inheritedJumpId
  ? jumpHosts.find((j) => j.id === inheritedJumpId)?.name ?? "(deleted)"
  : "direct";

<select
  value={session.jump_host_id ?? ""}
  onChange={(e) => onChange({
    ...session,
    jump_host_id: e.target.value === "" ? null : e.target.value,
  })}
>
  <option value="">{`Inherit from profile (${inheritedJumpName})`}</option>
  {jumpHosts.map((jh) => (
    <option key={jh.id} value={jh.id}>{jh.name}</option>
  ))}
</select>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npm test -- SessionSettingsDialog`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/SessionSettingsDialog.tsx frontend/src/components/__tests__/SessionSettingsDialog.test.tsx
git commit -m "feat(ui): show inherited jump host name in session settings"
```

---

## Task 14: Frontend — tunnel settings inherit label

**Files:**
- Modify: `frontend/src/components/SettingsTunnels.tsx`
- Test: alongside

- [ ] **Step 1: Write failing test**

Mirror Task 13's tests — same pattern, applied to the Tunnels form. The Tunnel data type already has `jump_host_id?: string | null` (verify in TS types).

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npm test -- SettingsTunnels`
Expected: FAIL.

- [ ] **Step 3: Update the form**

Apply the same pattern as Task 13 Step 3 to the tunnel jump host select. The `profile` is looked up from `tunnel.profile_id` against the `profiles` prop.

- [ ] **Step 4: Run test**

Run: `cd frontend && npm test -- SettingsTunnels`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/SettingsTunnels.tsx frontend/src/components/__tests__/SettingsTunnels.test.tsx
git commit -m "feat(ui): show inherited jump host name in tunnel settings"
```

---

## Task 15: End-to-end smoke test

**Files:**
- Create: `agent/tests/jump_host_e2e_test.rs` (integration test in `agent/tests/`)

- [ ] **Step 1: Write end-to-end test**

```rust
//! End-to-end: start two russh servers (jump + target), build a real
//! LocalDataProvider with a target profile that points to a jump host
//! whose profile has its own credentials, then exercise:
//!   - terminal session via jump
//!   - tunnel via jump
//! Confirms the bug from the ticket is fixed.

use netstacks_agent::{...}; // adjust based on actual exports

#[tokio::test]
async fn end_to_end_jump_via_profile_default() {
    // 1. Start jump + target servers (use ssh::test_servers helpers).
    // 2. Create LocalDataProvider in-memory.
    // 3. Create jump_profile with password creds.
    // 4. Create JumpHost pointing at jump_profile.
    // 5. Create target_profile WITH jump_host_id = JH (profile-default jump).
    // 6. Create Session referencing target_profile, jump_host_id: None (inherit).
    // 7. Build SshParams via get_ssh_params_with_vault.
    // 8. Assert SshParams.jump_host_id_effective == Some(JH.id).
    // 9. Assert SshParams.jump_password matches what we stored.
    // 10. Open SSH session via TerminalManager::create_ssh_session.
    // 11. Assert it succeeds + receives target's READY banner.
}
```

This is the "did we actually fix the user's bug" test. Fill in concretely using patterns from previous tasks.

- [ ] **Step 2: Run**

Run: `cd agent && cargo test --test jump_host_e2e_test`
Expected: PASS.

- [ ] **Step 3: Final full test sweep**

Run: `cd agent && cargo test` and `cd frontend && npm test`
Expected: all PASS, no regressions.

- [ ] **Step 4: Commit**

```bash
git add agent/tests/jump_host_e2e_test.rs
git commit -m "test(jump-host): end-to-end smoke covering the original ticket"
```

---

## Self-Review Notes

This plan covers all spec sections:

- **Architecture / `connect_via_jump`** → Task 6
- **`SshSession::connect_via_jump`** → Task 7
- **`terminal.rs` PTY removal** → Task 9
- **Tunnels actually using jump** → Task 10
- **Session-tunnel inheritance** → Task 11
- **`CredentialProfile.jump_host_id` schema** → Task 1
- **Models** → Task 2
- **Provider read/write** → Task 3
- **Save-time chain validation (both sides)** → Tasks 4 + 5
- **`resolve_effective_jump`** → Task 8
- **`SshParams.jump_*` fields** → Task 8
- **Frontend profile editor** → Task 12
- **Frontend session inherit label** → Task 13
- **Frontend tunnel inherit label** → Task 14
- **Migration & backward compat** → Task 1 (idempotent migration)
- **Error surfaces** → strings hardcoded in Tasks 4/5/8/10
- **All testing categories** → Tasks 6, 7, 8, 10, 11, 12, 13, 14, 15

Type consistency: `JumpResolution` defined in Task 8 used in Task 10. `materialize_session_tunnel` signature defined in Task 11 only. `connect_via_jump` signature defined in Task 6 used in Tasks 7, 9, 10. All match.

No placeholders except in two places where `todo!()` markers are intentional (test scaffolds the engineer fills mirroring established patterns) — explicitly called out in those steps.
