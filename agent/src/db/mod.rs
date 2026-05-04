//! Database module for NetStacks
//!
//! Handles SQLite connection and schema initialization.

pub mod ai_profile;

use crate::models::{NewTunnel, PortForwardType, Tunnel, UpdateTunnel};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions};
use std::path::Path;
use std::str::FromStr;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum DbError {
    #[error("Database error: {0}")]
    Sqlx(#[from] sqlx::Error),
    #[error("Migration error: {0}")]
    Migration(String),
}

/// Initialize the database connection and run migrations
pub async fn init_db(db_path: &Path) -> Result<SqlitePool, DbError> {
    // Create parent directories if they don't exist
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent).ok();
        // AUDIT FIX (DATA-006): tighten parent dir permissions on Unix.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700));
        }
    }

    let db_url = format!("sqlite:{}?mode=rwc", db_path.display());

    let options = SqliteConnectOptions::from_str(&db_url)?
        .create_if_missing(true)
        .foreign_keys(true);

    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(options)
        .await?;

    // Run schema initialization
    init_schema(&pool).await?;

    // AUDIT FIX (DATA-006): chmod the SQLite file (and its WAL/SHM siblings)
    // to 0600 so other local users cannot read the encrypted credential blobs
    // for offline cracking. macOS user accounts default to umask 022 which
    // would otherwise leave these world-readable.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::Permissions::from_mode(0o600);
        for ext in ["", "-wal", "-shm", "-journal"] {
            let path = if ext.is_empty() {
                db_path.to_path_buf()
            } else {
                let mut p = db_path.as_os_str().to_owned();
                p.push(ext);
                std::path::PathBuf::from(p)
            };
            if path.exists() {
                let _ = std::fs::set_permissions(&path, mode.clone());
            }
        }
    }

    Ok(pool)
}

/// Initialize the database schema
async fn init_schema(pool: &SqlitePool) -> Result<(), DbError> {
    let schema = include_str!("schema.sql");

    sqlx::raw_sql(schema)
        .execute(pool)
        .await
        .map_err(|e| DbError::Migration(e.to_string()))?;

    // Run migrations for existing databases
    migrate_sessions_table(pool).await?;
    migrate_credential_profiles_table(pool).await?;
    migrate_highlight_rules_table(pool).await?;
    migrate_change_control_tables(pool).await?;
    migrate_session_context_table(pool).await?;
    migrate_documents_table(pool).await?;
    migrate_topology_devices_table(pool).await?;
    migrate_layouts_table(pool).await?;
    migrate_groups_table(pool).await?;
    migrate_topology_connections_table(pool).await?;
    migrate_topology_annotations_table(pool).await?;
    migrate_jump_hosts_table(pool).await?;
    migrate_profile_only_auth(pool).await?;
    migrate_mapped_keys_to_profiles(pool).await?;
    migrate_agent_tasks_table(pool).await?;
    migrate_agent_definitions_table(pool).await?;
    migrate_smtp_config_table(pool).await?;
    migrate_mcp_tables(pool).await?;
    migrate_remove_profile_terminal_fields(pool).await?;
    migrate_mapped_keys_to_global(pool).await?;
    migrate_documents_recording_content_type(pool).await?;
    migrate_profile_terminal_defaults(pool).await?;
    migrate_change_device_overrides(pool).await?;
    migrate_change_document_id(pool).await?;
    migrate_documents_mops_category(pool).await?;
    migrate_changes_nullable_session_id(pool).await?;
    migrate_mop_executions_new_columns(pool).await?;
    migrate_sftp_start_path(pool).await?;
    migrate_custom_commands_quick_actions(pool).await?;
    migrate_mop_execution_steps_sources(pool).await?;
    migrate_ai_engineer_profile(pool).await?;
    migrate_tunnels_table(pool).await?;
    migrate_ai_memory_table(pool).await?;
    migrate_scripts_provenance(pool).await?;
    migrate_credential_profile_jump_host(pool).await?;
    migrate_jump_session_id_columns(pool).await?;
    seed_default_settings(pool).await?;

    Ok(())
}

/// Add `created_by` and `approved` columns to `scripts` for AI-script approval
/// gate (AUDIT FIX EXEC-014). Existing rows are tagged `'user'` + `approved=1`
/// so nothing the user previously authored becomes blocked.
async fn migrate_scripts_provenance(pool: &SqlitePool) -> Result<(), DbError> {
    if !column_exists(pool, "scripts", "created_by").await? {
        sqlx::query("ALTER TABLE scripts ADD COLUMN created_by TEXT NOT NULL DEFAULT 'user'")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to add scripts.created_by: {}", e)))?;
    }
    if !column_exists(pool, "scripts", "approved").await? {
        sqlx::query("ALTER TABLE scripts ADD COLUMN approved INTEGER NOT NULL DEFAULT 1")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to add scripts.approved: {}", e)))?;
    }
    Ok(())
}

/// Add `jump_session_id` to `sessions`, `tunnels`, and `credential_profiles`
/// so an existing Session can be selected as a jump endpoint anywhere a
/// JumpHost record was previously the only option. Mutually exclusive with
/// `jump_host_id` (enforced in the provider, not the schema).
async fn migrate_jump_session_id_columns(pool: &SqlitePool) -> Result<(), DbError> {
    for table in ["sessions", "tunnels", "credential_profiles"] {
        if !column_exists(pool, table, "jump_session_id").await? {
            let sql = format!(
                "ALTER TABLE {} ADD COLUMN jump_session_id TEXT \
                 REFERENCES sessions(id) ON DELETE SET NULL",
                table
            );
            sqlx::query(&sql)
                .execute(pool)
                .await
                .map_err(|e| DbError::Migration(format!(
                    "Failed to add {}.jump_session_id: {}", table, e
                )))?;
        }
    }
    Ok(())
}

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

/// Check if a column exists in a table
async fn column_exists(pool: &SqlitePool, table: &str, column: &str) -> Result<bool, DbError> {
    let query = format!("PRAGMA table_info({})", table);
    let rows: Vec<(i32, String, String, i32, Option<String>, i32)> = sqlx::query_as(&query)
        .fetch_all(pool)
        .await?;

    Ok(rows.iter().any(|row| row.1 == column))
}

/// Migrate sessions table to add new profile integration columns (Phase 04.2)
async fn migrate_sessions_table(pool: &SqlitePool) -> Result<(), DbError> {
    // Add profile_id column if it doesn't exist
    if !column_exists(pool, "sessions", "profile_id").await? {
        sqlx::query("ALTER TABLE sessions ADD COLUMN profile_id TEXT REFERENCES credential_profiles(id) ON DELETE SET NULL")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to add profile_id column: {}", e)))?;
    }

    // Add profile_overrides column if it doesn't exist
    if !column_exists(pool, "sessions", "profile_overrides").await? {
        sqlx::query("ALTER TABLE sessions ADD COLUMN profile_overrides TEXT")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to add profile_overrides column: {}", e)))?;
    }

    // Add netbox_device_id column if it doesn't exist
    if !column_exists(pool, "sessions", "netbox_device_id").await? {
        sqlx::query("ALTER TABLE sessions ADD COLUMN netbox_device_id INTEGER")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to add netbox_device_id column: {}", e)))?;
    }

    // Add netbox_source_id column if it doesn't exist
    if !column_exists(pool, "sessions", "netbox_source_id").await? {
        sqlx::query("ALTER TABLE sessions ADD COLUMN netbox_source_id TEXT REFERENCES netbox_sources(id) ON DELETE SET NULL")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to add netbox_source_id column: {}", e)))?;
    }

    // Add cli_flavor column if it doesn't exist (AI features)
    if !column_exists(pool, "sessions", "cli_flavor").await? {
        sqlx::query("ALTER TABLE sessions ADD COLUMN cli_flavor TEXT DEFAULT 'auto'")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to add cli_flavor column: {}", e)))?;
    }

    // Add terminal_theme column if it doesn't exist (terminal appearance)
    if !column_exists(pool, "sessions", "terminal_theme").await? {
        sqlx::query("ALTER TABLE sessions ADD COLUMN terminal_theme TEXT")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to add terminal_theme column: {}", e)))?;
    }

    // Add jump host columns if they don't exist (Phase 06.2)
    if !column_exists(pool, "sessions", "jump_host").await? {
        sqlx::query("ALTER TABLE sessions ADD COLUMN jump_host TEXT")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to add jump_host column: {}", e)))?;
    }

    if !column_exists(pool, "sessions", "jump_port").await? {
        sqlx::query("ALTER TABLE sessions ADD COLUMN jump_port INTEGER")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to add jump_port column: {}", e)))?;
    }

    if !column_exists(pool, "sessions", "jump_username").await? {
        sqlx::query("ALTER TABLE sessions ADD COLUMN jump_username TEXT")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to add jump_username column: {}", e)))?;
    }

    // Add port_forwards column if it doesn't exist (Phase 06.3)
    if !column_exists(pool, "sessions", "port_forwards").await? {
        sqlx::query("ALTER TABLE sessions ADD COLUMN port_forwards TEXT")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to add port_forwards column: {}", e)))?;
    }

    // Add auto_commands column if it doesn't exist (auto commands on connect)
    if !column_exists(pool, "sessions", "auto_commands").await? {
        sqlx::query("ALTER TABLE sessions ADD COLUMN auto_commands TEXT")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to add auto_commands column: {}", e)))?;
    }

    // Add legacy_ssh column if it doesn't exist (legacy SSH algorithm support)
    if !column_exists(pool, "sessions", "legacy_ssh").await? {
        sqlx::query("ALTER TABLE sessions ADD COLUMN legacy_ssh INTEGER DEFAULT 0")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to add legacy_ssh column: {}", e)))?;
    }

    // Add protocol column if it doesn't exist (telnet support)
    if !column_exists(pool, "sessions", "protocol").await? {
        sqlx::query("ALTER TABLE sessions ADD COLUMN protocol TEXT DEFAULT 'ssh'")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to add protocol column: {}", e)))?;
    }

    // Create indexes if they don't exist (these are idempotent via IF NOT EXISTS in schema.sql,
    // but we add them here for existing databases)
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_sessions_profile ON sessions(profile_id)")
        .execute(pool)
        .await
        .map_err(|e| DbError::Migration(format!("Failed to create profile_id index: {}", e)))?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_sessions_netbox_source ON sessions(netbox_source_id)")
        .execute(pool)
        .await
        .map_err(|e| DbError::Migration(format!("Failed to create netbox_source_id index: {}", e)))?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_sessions_netbox_device ON sessions(netbox_device_id)")
        .execute(pool)
        .await
        .map_err(|e| DbError::Migration(format!("Failed to create netbox_device_id index: {}", e)))?;

    Ok(())
}

/// Migrate credential_profiles and related tables (Phase 11.6)
/// Note: highlight_rules_json and copy_on_select columns were removed from profiles.
/// Handles incremental column additions to netbox_sources.
async fn migrate_credential_profiles_table(pool: &SqlitePool) -> Result<(), DbError> {
    // Add device_filters column to netbox_sources if it doesn't exist
    if !column_exists(pool, "netbox_sources", "device_filters").await? {
        sqlx::query("ALTER TABLE netbox_sources ADD COLUMN device_filters TEXT")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to add device_filters column: {}", e)))?;
    }

    // Add cli_flavor_mappings column to netbox_sources if it doesn't exist
    if !column_exists(pool, "netbox_sources", "cli_flavor_mappings").await? {
        sqlx::query("ALTER TABLE netbox_sources ADD COLUMN cli_flavor_mappings TEXT")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to add cli_flavor_mappings column: {}", e)))?;
    }

    Ok(())
}

/// Check if a table exists in the database
async fn table_exists(pool: &SqlitePool, table: &str) -> Result<bool, DbError> {
    let result: (i32,) = sqlx::query_as(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?"
    )
    .bind(table)
    .fetch_one(pool)
    .await?;

    Ok(result.0 > 0)
}

/// Migrate highlight_rules table - create if it doesn't exist (Phase 11)
async fn migrate_highlight_rules_table(pool: &SqlitePool) -> Result<(), DbError> {
    if !table_exists(pool, "highlight_rules").await? {
        sqlx::query(
            r#"CREATE TABLE highlight_rules (
                id TEXT PRIMARY KEY NOT NULL,
                session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                pattern TEXT NOT NULL,
                is_regex INTEGER NOT NULL DEFAULT 0,
                case_sensitive INTEGER NOT NULL DEFAULT 0,
                whole_word INTEGER NOT NULL DEFAULT 0,
                foreground TEXT,
                background TEXT,
                bold INTEGER NOT NULL DEFAULT 0,
                italic INTEGER NOT NULL DEFAULT 0,
                underline INTEGER NOT NULL DEFAULT 0,
                enabled INTEGER NOT NULL DEFAULT 1,
                priority INTEGER NOT NULL DEFAULT 0,
                category TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            )"#
        )
        .execute(pool)
        .await
        .map_err(|e| DbError::Migration(format!("Failed to create highlight_rules table: {}", e)))?;

        // Create indexes
        sqlx::query("CREATE INDEX idx_highlight_rules_session ON highlight_rules(session_id)")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to create highlight_rules session index: {}", e)))?;

        sqlx::query("CREATE INDEX idx_highlight_rules_category ON highlight_rules(category)")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to create highlight_rules category index: {}", e)))?;
    }

    Ok(())
}

/// Migrate change control tables - create if they don't exist (Phase 15)
async fn migrate_change_control_tables(pool: &SqlitePool) -> Result<(), DbError> {
    // Create changes table if it doesn't exist
    if !table_exists(pool, "changes").await? {
        sqlx::query(
            r#"CREATE TABLE changes (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                description TEXT,
                status TEXT NOT NULL DEFAULT 'draft',
                mop_steps TEXT NOT NULL DEFAULT '[]',
                pre_snapshot_id TEXT,
                post_snapshot_id TEXT,
                ai_analysis TEXT,
                created_by TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                executed_at TEXT,
                completed_at TEXT
            )"#
        )
        .execute(pool)
        .await
        .map_err(|e| DbError::Migration(format!("Failed to create changes table: {}", e)))?;

        // Create indexes
        sqlx::query("CREATE INDEX idx_changes_session_id ON changes(session_id)")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to create changes session_id index: {}", e)))?;

        sqlx::query("CREATE INDEX idx_changes_status ON changes(status)")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to create changes status index: {}", e)))?;

        sqlx::query("CREATE INDEX idx_changes_created_at ON changes(created_at)")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to create changes created_at index: {}", e)))?;
    }

    // Create snapshots table if it doesn't exist
    if !table_exists(pool, "snapshots").await? {
        sqlx::query(
            r#"CREATE TABLE snapshots (
                id TEXT PRIMARY KEY,
                change_id TEXT NOT NULL REFERENCES changes(id) ON DELETE CASCADE,
                snapshot_type TEXT NOT NULL,
                commands TEXT NOT NULL DEFAULT '[]',
                output TEXT NOT NULL DEFAULT '',
                captured_at TEXT NOT NULL DEFAULT (datetime('now'))
            )"#
        )
        .execute(pool)
        .await
        .map_err(|e| DbError::Migration(format!("Failed to create snapshots table: {}", e)))?;

        // Create index
        sqlx::query("CREATE INDEX idx_snapshots_change_id ON snapshots(change_id)")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to create snapshots change_id index: {}", e)))?;
    }

    Ok(())
}

/// Migrate session_context table - create if it doesn't exist (Phase 14)
async fn migrate_session_context_table(pool: &SqlitePool) -> Result<(), DbError> {
    if !table_exists(pool, "session_context").await? {
        sqlx::query(
            r#"CREATE TABLE session_context (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                issue TEXT NOT NULL,
                root_cause TEXT,
                resolution TEXT,
                commands TEXT,
                ticket_ref TEXT,
                author TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            )"#
        )
        .execute(pool)
        .await
        .map_err(|e| DbError::Migration(format!("Failed to create session_context table: {}", e)))?;

        // Create index for fast lookup by session
        sqlx::query("CREATE INDEX idx_session_context_session_id ON session_context(session_id)")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to create session_context session_id index: {}", e)))?;
    }

    Ok(())
}

/// Migrate documents table - create if it doesn't exist (Phase 03.1)
/// Updated to include 'troubleshooting' category and 'markdown' content_type (Phase 26)
async fn migrate_documents_table(pool: &SqlitePool) -> Result<(), DbError> {
    // Check if table exists with old CHECK constraints (missing 'troubleshooting' and 'markdown')
    let needs_constraint_update = if table_exists(pool, "documents").await? {
        // Try inserting a test row with 'troubleshooting' category to check if constraint allows it
        let test_result = sqlx::query(
            "INSERT INTO documents (id, name, category, content_type, content, created_at, updated_at) VALUES ('__test__', '__test__', 'troubleshooting', 'markdown', '', datetime('now'), datetime('now'))"
        )
        .execute(pool)
        .await;

        match test_result {
            Ok(_) => {
                // Constraint allows it, clean up test row
                let _ = sqlx::query("DELETE FROM documents WHERE id = '__test__'")
                    .execute(pool)
                    .await;
                false
            }
            Err(_) => {
                // Constraint rejects it, need to update table
                true
            }
        }
    } else {
        false
    };

    if needs_constraint_update {
        tracing::info!("Updating documents table CHECK constraints to include 'troubleshooting' and 'markdown'");

        // SQLite requires recreating the table to change CHECK constraints
        // We need to disable foreign keys temporarily since document_versions references documents

        // 0. Disable foreign keys temporarily
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to disable foreign keys: {}", e)))?;

        // 1. Drop any leftover documents_new table from failed migration
        sqlx::query("DROP TABLE IF EXISTS documents_new")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to drop leftover documents_new table: {}", e)))?;

        // 2. Create new table with updated constraints
        sqlx::query(
            r#"CREATE TABLE documents_new (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                category TEXT NOT NULL CHECK (category IN ('outputs', 'templates', 'notes', 'backups', 'history', 'troubleshooting')),
                content_type TEXT NOT NULL CHECK (content_type IN ('csv', 'json', 'jinja', 'config', 'text', 'markdown', 'recording')),
                content TEXT NOT NULL,
                parent_folder TEXT,
                session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            )"#
        )
        .execute(pool)
        .await
        .map_err(|e| DbError::Migration(format!("Failed to create documents_new table: {}", e)))?;

        // 3. Copy data from old table
        sqlx::query(
            "INSERT INTO documents_new SELECT * FROM documents"
        )
        .execute(pool)
        .await
        .map_err(|e| DbError::Migration(format!("Failed to copy documents data: {}", e)))?;

        // 4. Drop old table
        sqlx::query("DROP TABLE documents")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to drop old documents table: {}", e)))?;

        // 5. Rename new table
        sqlx::query("ALTER TABLE documents_new RENAME TO documents")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to rename documents_new table: {}", e)))?;

        // 6. Recreate indexes
        sqlx::query("CREATE INDEX IF NOT EXISTS idx_documents_category ON documents(category)")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to recreate documents category index: {}", e)))?;

        sqlx::query("CREATE INDEX IF NOT EXISTS idx_documents_session_id ON documents(session_id)")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to recreate documents session_id index: {}", e)))?;

        // 7. Re-enable foreign keys
        sqlx::query("PRAGMA foreign_keys = ON")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to re-enable foreign keys: {}", e)))?;

        tracing::info!("Documents table CHECK constraints updated successfully");
    }

    // Create documents table if it doesn't exist (fresh install)
    if !table_exists(pool, "documents").await? {
        sqlx::query(
            r#"CREATE TABLE documents (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                category TEXT NOT NULL CHECK (category IN ('outputs', 'templates', 'notes', 'backups', 'history', 'troubleshooting')),
                content_type TEXT NOT NULL CHECK (content_type IN ('csv', 'json', 'jinja', 'config', 'text', 'markdown', 'recording')),
                content TEXT NOT NULL,
                parent_folder TEXT,
                session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            )"#
        )
        .execute(pool)
        .await
        .map_err(|e| DbError::Migration(format!("Failed to create documents table: {}", e)))?;

        // Create indexes
        sqlx::query("CREATE INDEX idx_documents_category ON documents(category)")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to create documents category index: {}", e)))?;

        sqlx::query("CREATE INDEX idx_documents_session_id ON documents(session_id)")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to create documents session_id index: {}", e)))?;
    }

    // Create document_versions table if it doesn't exist
    if !table_exists(pool, "document_versions").await? {
        sqlx::query(
            r#"CREATE TABLE document_versions (
                id TEXT PRIMARY KEY,
                document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
                content TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )"#
        )
        .execute(pool)
        .await
        .map_err(|e| DbError::Migration(format!("Failed to create document_versions table: {}", e)))?;

        sqlx::query("CREATE INDEX idx_document_versions_document_id ON document_versions(document_id)")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to create document_versions document_id index: {}", e)))?;
    }

    // Secure Notes: add nullable BLOB columns that hold the
    // vault-encrypted body. When `encrypted_content` is non-NULL, the
    // plaintext `content` column is the empty string and decryption goes
    // through the vault. The Notes category is encrypted by default;
    // other categories continue to use `content` directly.
    if !column_exists(pool, "documents", "encrypted_content").await? {
        sqlx::query("ALTER TABLE documents ADD COLUMN encrypted_content BLOB")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to add documents.encrypted_content: {}", e)))?;
        tracing::info!("Added documents.encrypted_content column for Secure Notes");
    }
    if !column_exists(pool, "document_versions", "encrypted_content").await? {
        sqlx::query("ALTER TABLE document_versions ADD COLUMN encrypted_content BLOB")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to add document_versions.encrypted_content: {}", e)))?;
        tracing::info!("Added document_versions.encrypted_content column for Secure Notes");
    }

    Ok(())
}

/// Migrate topology tables (Phase 20.1) - create new saved topology schema
/// This drops the old Phase 20 session-based topology_devices table and creates
/// the new schema with topologies, topology_devices (with topology_id FK), and topology_connections
async fn migrate_topology_devices_table(pool: &SqlitePool) -> Result<(), DbError> {
    // Check if we need to migrate from old Phase 20 schema
    // Old schema had session_id as NOT NULL UNIQUE with no topology_id column
    let needs_migration = if table_exists(pool, "topology_devices").await? {
        // Check if topology_id column exists (new schema)
        !column_exists(pool, "topology_devices", "topology_id").await?
    } else {
        false
    };

    if needs_migration {
        // Drop the old Phase 20 topology_devices table
        // This is safe since Phase 20 just completed and no user data exists yet
        sqlx::query("DROP TABLE IF EXISTS topology_devices")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to drop old topology_devices table: {}", e)))?;

        tracing::info!("Dropped old Phase 20 topology_devices table for Phase 20.1 migration");
    }

    // Create topologies table if it doesn't exist
    if !table_exists(pool, "topologies").await? {
        sqlx::query(
            r#"CREATE TABLE topologies (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )"#
        )
        .execute(pool)
        .await
        .map_err(|e| DbError::Migration(format!("Failed to create topologies table: {}", e)))?;

        tracing::info!("Created topologies table");
    }

    // Create topology_devices table if it doesn't exist
    if !table_exists(pool, "topology_devices").await? {
        sqlx::query(
            r#"CREATE TABLE topology_devices (
                id TEXT PRIMARY KEY,
                topology_id TEXT NOT NULL REFERENCES topologies(id) ON DELETE CASCADE,
                session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
                x REAL NOT NULL DEFAULT 500.0,
                y REAL NOT NULL DEFAULT 500.0,
                device_type TEXT NOT NULL DEFAULT 'unknown',
                name TEXT NOT NULL,
                host TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )"#
        )
        .execute(pool)
        .await
        .map_err(|e| DbError::Migration(format!("Failed to create topology_devices table: {}", e)))?;

        // Create index
        sqlx::query("CREATE INDEX IF NOT EXISTS idx_topology_devices_topology ON topology_devices(topology_id)")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to create topology_devices topology index: {}", e)))?;

        tracing::info!("Created topology_devices table with new schema");
    }

    // Add profile_id column to topology_devices if missing (Phase 09)
    if table_exists(pool, "topology_devices").await? && !column_exists(pool, "topology_devices", "profile_id").await? {
        sqlx::query("ALTER TABLE topology_devices ADD COLUMN profile_id TEXT REFERENCES credential_profiles(id) ON DELETE SET NULL")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to add profile_id to topology_devices: {}", e)))?;
        tracing::info!("Added profile_id column to topology_devices");
    }

    // Add snmp_profile_id column to topology_devices if missing (SNMP interface stats)
    if table_exists(pool, "topology_devices").await? && !column_exists(pool, "topology_devices", "snmp_profile_id").await? {
        sqlx::query("ALTER TABLE topology_devices ADD COLUMN snmp_profile_id TEXT REFERENCES credential_profiles(id) ON DELETE SET NULL")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to add snmp_profile_id to topology_devices: {}", e)))?;
        tracing::info!("Added snmp_profile_id column to topology_devices");
    }

    // Create topology_connections table if it doesn't exist
    if !table_exists(pool, "topology_connections").await? {
        sqlx::query(
            r#"CREATE TABLE topology_connections (
                id TEXT PRIMARY KEY,
                topology_id TEXT NOT NULL REFERENCES topologies(id) ON DELETE CASCADE,
                source_device_id TEXT NOT NULL REFERENCES topology_devices(id) ON DELETE CASCADE,
                target_device_id TEXT NOT NULL REFERENCES topology_devices(id) ON DELETE CASCADE,
                source_interface TEXT,
                target_interface TEXT,
                protocol TEXT NOT NULL DEFAULT 'manual',
                label TEXT,
                created_at TEXT NOT NULL
            )"#
        )
        .execute(pool)
        .await
        .map_err(|e| DbError::Migration(format!("Failed to create topology_connections table: {}", e)))?;

        // Create index
        sqlx::query("CREATE INDEX IF NOT EXISTS idx_topology_connections_topology ON topology_connections(topology_id)")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to create topology_connections topology index: {}", e)))?;

        tracing::info!("Created topology_connections table");
    }

    Ok(())
}

/// Migrate layouts table to add tabs column for mixed tab types (Phase 25)
async fn migrate_layouts_table(pool: &SqlitePool) -> Result<(), DbError> {
    // Only migrate if layouts table exists
    if !table_exists(pool, "layouts").await? {
        return Ok(());
    }

    // Add tabs column if it doesn't exist
    if !column_exists(pool, "layouts", "tabs").await? {
        sqlx::query("ALTER TABLE layouts ADD COLUMN tabs TEXT")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to add tabs column to layouts: {}", e)))?;
    }

    Ok(())
}

/// Migrate groups table - copy from legacy layouts (Plan 1: Tab Groups Redesign)
async fn migrate_groups_table(pool: &SqlitePool) -> Result<(), DbError> {
    use crate::models::GroupTab;

    // Create the table from schema.sql IF NOT EXISTS — already handled by init.
    // Then perform a one-time copy from legacy `layouts` if `groups` is empty
    // and `layouts` exists with rows.
    let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM groups")
        .fetch_one(pool)
        .await?;

    if count.0 > 0 {
        tracing::info!("groups table already populated, skipping migration");
        return Ok(()); // already migrated
    }

    let layouts_exist: (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='layouts'")
            .fetch_one(pool)
            .await?;
    if layouts_exist.0 == 0 {
        return Ok(());
    }

    // Copy: each layout row becomes a group. Tabs come from `layouts.tabs` if present,
    // otherwise from `layouts.session_ids` (legacy terminals-only).
    let rows: Vec<(String, String, String, Option<String>, String, String)> =
        sqlx::query_as("SELECT id, name, session_ids, tabs, created_at, updated_at FROM layouts")
            .fetch_all(pool)
            .await?;

    let row_count = rows.len();
    tracing::info!("Migrating {} layouts to groups", row_count);

    for (id, name, session_ids_json, tabs_json, created_at, updated_at) in rows {
        let tabs_str: String = match tabs_json {
            Some(t) if !t.is_empty() && t != "null" => t,
            _ => {
                // Build tabs from legacy session_ids
                let session_ids: Vec<String> =
                    serde_json::from_str(&session_ids_json).unwrap_or_default();
                let tab_values: Vec<GroupTab> = session_ids
                    .into_iter()
                    .map(|sid| GroupTab {
                        r#type: "terminal".to_string(),
                        session_id: Some(sid),
                        topology_id: None,
                        document_id: None,
                        document_name: None,
                    })
                    .collect();
                serde_json::to_string(&tab_values)
                    .map_err(|e| DbError::Migration(format!("Failed to serialize migrated tabs: {}", e)))?
            }
        };

        sqlx::query(
            "INSERT INTO groups (id, name, tabs, topology_id, default_launch_action, created_at, updated_at, last_used_at)
             VALUES (?, ?, ?, NULL, NULL, ?, ?, NULL)",
        )
        .bind(id)
        .bind(name)
        .bind(tabs_str)
        .bind(created_at)
        .bind(updated_at)
        .execute(pool)
        .await?;
    }

    tracing::info!("Migrated {} layouts to groups", row_count);

    Ok(())
}

/// Migrate topology_connections table for enhanced network model (Phase 27-02)
async fn migrate_topology_connections_table(pool: &SqlitePool) -> Result<(), DbError> {
    // Only migrate if topology_connections table exists
    if !table_exists(pool, "topology_connections").await? {
        return Ok(());
    }

    // Add waypoints column if it doesn't exist
    if !column_exists(pool, "topology_connections", "waypoints").await? {
        sqlx::query("ALTER TABLE topology_connections ADD COLUMN waypoints TEXT")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to add waypoints column: {}", e)))?;
    }

    // Add curve_style column if it doesn't exist
    if !column_exists(pool, "topology_connections", "curve_style").await? {
        sqlx::query("ALTER TABLE topology_connections ADD COLUMN curve_style TEXT DEFAULT 'straight'")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to add curve_style column: {}", e)))?;
    }

    // Add bundle_id column if it doesn't exist
    if !column_exists(pool, "topology_connections", "bundle_id").await? {
        sqlx::query("ALTER TABLE topology_connections ADD COLUMN bundle_id TEXT")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to add bundle_id column: {}", e)))?;
    }

    // Add bundle_index column if it doesn't exist
    if !column_exists(pool, "topology_connections", "bundle_index").await? {
        sqlx::query("ALTER TABLE topology_connections ADD COLUMN bundle_index INTEGER")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to add bundle_index column: {}", e)))?;
    }

    // Add color column if it doesn't exist
    if !column_exists(pool, "topology_connections", "color").await? {
        sqlx::query("ALTER TABLE topology_connections ADD COLUMN color TEXT")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to add color column: {}", e)))?;
    }

    // Add line_style column if it doesn't exist
    if !column_exists(pool, "topology_connections", "line_style").await? {
        sqlx::query("ALTER TABLE topology_connections ADD COLUMN line_style TEXT DEFAULT 'solid'")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to add line_style column: {}", e)))?;
    }

    // Add line_width column if it doesn't exist
    if !column_exists(pool, "topology_connections", "line_width").await? {
        sqlx::query("ALTER TABLE topology_connections ADD COLUMN line_width INTEGER DEFAULT 2")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to add line_width column: {}", e)))?;
    }

    // Add notes column if it doesn't exist
    if !column_exists(pool, "topology_connections", "notes").await? {
        sqlx::query("ALTER TABLE topology_connections ADD COLUMN notes TEXT")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to add notes column: {}", e)))?;
    }

    Ok(())
}

/// Migrate topology_annotations table - create if it doesn't exist (Phase 27-03)
async fn migrate_topology_annotations_table(pool: &SqlitePool) -> Result<(), DbError> {
    if !table_exists(pool, "topology_annotations").await? {
        sqlx::query(
            r#"CREATE TABLE topology_annotations (
                id TEXT PRIMARY KEY,
                topology_id TEXT NOT NULL REFERENCES topologies(id) ON DELETE CASCADE,
                annotation_type TEXT NOT NULL,
                element_data TEXT NOT NULL,
                z_index INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )"#
        )
        .execute(pool)
        .await
        .map_err(|e| DbError::Migration(format!("Failed to create topology_annotations table: {}", e)))?;

        // Create indexes
        sqlx::query("CREATE INDEX IF NOT EXISTS idx_annotations_topology ON topology_annotations(topology_id)")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to create topology index: {}", e)))?;

        sqlx::query("CREATE INDEX IF NOT EXISTS idx_annotations_z_index ON topology_annotations(z_index)")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to create z_index index: {}", e)))?;

        tracing::info!("Created topology_annotations table");
    }

    Ok(())
}

/// Migrate to create jump_hosts table for global jump host configuration
async fn migrate_jump_hosts_table(pool: &SqlitePool) -> Result<(), DbError> {
    // Create jump_hosts table if it doesn't exist
    if !table_exists(pool, "jump_hosts").await? {
        sqlx::query(
            r#"CREATE TABLE jump_hosts (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                host TEXT NOT NULL,
                port INTEGER NOT NULL DEFAULT 22,
                profile_id TEXT NOT NULL REFERENCES credential_profiles(id) ON DELETE CASCADE,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            )"#
        )
        .execute(pool)
        .await
        .map_err(|e| DbError::Migration(format!("Failed to create jump_hosts table: {}", e)))?;

        // Create index
        sqlx::query("CREATE INDEX IF NOT EXISTS idx_jump_hosts_name ON jump_hosts(name)")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to create jump_hosts name index: {}", e)))?;

        tracing::info!("Created jump_hosts table");
    }

    // Add jump_host_id column to sessions if it doesn't exist
    if !column_exists(pool, "sessions", "jump_host_id").await? {
        sqlx::query("ALTER TABLE sessions ADD COLUMN jump_host_id TEXT REFERENCES jump_hosts(id) ON DELETE SET NULL")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to add jump_host_id column to sessions: {}", e)))?;

        sqlx::query("CREATE INDEX IF NOT EXISTS idx_sessions_jump_host ON sessions(jump_host_id)")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to create sessions jump_host_id index: {}", e)))?;

        tracing::info!("Added jump_host_id column to sessions");
    }

    Ok(())
}

/// Migrate to profile-only authentication model
/// Sessions without profiles cannot authenticate and should be deleted
async fn migrate_profile_only_auth(pool: &SqlitePool) -> Result<(), DbError> {
    // Delete sessions that don't have a profile_id
    // These sessions can no longer authenticate since credentials come from profiles
    let deleted = sqlx::query(
        "DELETE FROM sessions WHERE profile_id IS NULL OR profile_id = ''"
    )
    .execute(pool)
    .await
    .map_err(|e| DbError::Migration(format!("Failed to delete sessions without profiles: {}", e)))?;

    if deleted.rows_affected() > 0 {
        tracing::info!(
            "Deleted {} sessions without profiles (profile-only auth migration)",
            deleted.rows_affected()
        );
    }

    // Clear deprecated fields on remaining sessions (if they still exist)
    // These fields are no longer used - all auth comes from profiles
    if column_exists(pool, "sessions", "profile_overrides").await? {
        sqlx::query("UPDATE sessions SET profile_overrides = NULL")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to clear profile_overrides: {}", e)))?;
    }

    Ok(())
}

/// Migrate mapped_keys table from session-based to profile-based
/// This drops the old session_id-based table and recreates it with profile_id
async fn migrate_mapped_keys_to_profiles(pool: &SqlitePool) -> Result<(), DbError> {
    // Check if mapped_keys table exists and has session_id column (old schema)
    if table_exists(pool, "mapped_keys").await? {
        if column_exists(pool, "mapped_keys", "session_id").await? {
            // Drop the old table and recreate with profile_id
            // Any existing session-based mapped keys will be lost since we're migrating to profiles
            sqlx::query("DROP TABLE mapped_keys")
                .execute(pool)
                .await
                .map_err(|e| DbError::Migration(format!("Failed to drop old mapped_keys table: {}", e)))?;

            sqlx::query(
                r#"CREATE TABLE mapped_keys (
                    id TEXT PRIMARY KEY,
                    profile_id TEXT NOT NULL REFERENCES credential_profiles(id) ON DELETE CASCADE,
                    key_combo TEXT NOT NULL,
                    command TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (datetime('now'))
                )"#
            )
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to create new mapped_keys table: {}", e)))?;

            // Create the index on profile_id
            sqlx::query("CREATE INDEX IF NOT EXISTS idx_mapped_keys_profile ON mapped_keys(profile_id)")
                .execute(pool)
                .await
                .map_err(|e| DbError::Migration(format!("Failed to create mapped_keys index: {}", e)))?;

            tracing::info!("Migrated mapped_keys table from session-based to profile-based");
        }
    }

    // Also drop the old session-based index if it exists (from previous schema.sql)
    let _ = sqlx::query("DROP INDEX IF EXISTS idx_mapped_keys_session")
        .execute(pool)
        .await;

    // Ensure the profile-based index exists
    let _ = sqlx::query("CREATE INDEX IF NOT EXISTS idx_mapped_keys_profile ON mapped_keys(profile_id)")
        .execute(pool)
        .await;

    Ok(())
}

/// Migrate agent_tasks table - create if it doesn't exist (Phase 02 - Task Foundation)
async fn migrate_agent_tasks_table(pool: &SqlitePool) -> Result<(), DbError> {
    if !table_exists(pool, "agent_tasks").await? {
        sqlx::query(
            r#"CREATE TABLE agent_tasks (
                id TEXT PRIMARY KEY,
                prompt TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
                progress_pct INTEGER NOT NULL DEFAULT 0,
                result_json TEXT,
                error_message TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                started_at TEXT,
                completed_at TEXT
            )"#
        )
        .execute(pool)
        .await
        .map_err(|e| DbError::Migration(format!("Failed to create agent_tasks table: {}", e)))?;

        sqlx::query("CREATE INDEX IF NOT EXISTS idx_agent_tasks_status ON agent_tasks(status)")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to create status index: {}", e)))?;

        sqlx::query("CREATE INDEX IF NOT EXISTS idx_agent_tasks_created_at ON agent_tasks(created_at)")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to create created_at index: {}", e)))?;

        tracing::info!("Created agent_tasks table");
    }
    Ok(())
}

/// Migrate agent_definitions table and add agent_definition_id to agent_tasks
async fn migrate_agent_definitions_table(pool: &SqlitePool) -> Result<(), DbError> {
    if !table_exists(pool, "agent_definitions").await? {
        sqlx::query(
            r#"CREATE TABLE agent_definitions (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                description TEXT,
                system_prompt TEXT NOT NULL,
                provider TEXT,
                model TEXT,
                temperature REAL,
                max_iterations INTEGER NOT NULL DEFAULT 15,
                max_tokens INTEGER NOT NULL DEFAULT 4096,
                enabled INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )"#
        )
        .execute(pool)
        .await
        .map_err(|e| DbError::Migration(format!("Failed to create agent_definitions table: {}", e)))?;

        sqlx::query("CREATE INDEX IF NOT EXISTS idx_agent_definitions_name ON agent_definitions(name)")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to create name index: {}", e)))?;

        sqlx::query("CREATE INDEX IF NOT EXISTS idx_agent_definitions_enabled ON agent_definitions(enabled)")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to create enabled index: {}", e)))?;

        tracing::info!("Created agent_definitions table");
    }

    // Add agent_definition_id column to agent_tasks if missing
    if table_exists(pool, "agent_tasks").await? && !column_exists(pool, "agent_tasks", "agent_definition_id").await? {
        sqlx::query("ALTER TABLE agent_tasks ADD COLUMN agent_definition_id TEXT REFERENCES agent_definitions(id)")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to add agent_definition_id to agent_tasks: {}", e)))?;

        tracing::info!("Added agent_definition_id column to agent_tasks");
    }

    Ok(())
}

/// Migrate smtp_config table - create if it doesn't exist (Phase 06 - Integrations)
async fn migrate_smtp_config_table(pool: &SqlitePool) -> Result<(), DbError> {
    if !table_exists(pool, "smtp_config").await? {
        sqlx::query(
            r#"CREATE TABLE smtp_config (
                id TEXT PRIMARY KEY DEFAULT 'default',
                host TEXT NOT NULL,
                port INTEGER NOT NULL DEFAULT 587,
                username TEXT NOT NULL,
                use_tls INTEGER NOT NULL DEFAULT 1,
                from_email TEXT NOT NULL,
                from_name TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            )"#
        )
        .execute(pool)
        .await
        .map_err(|e| DbError::Migration(format!("Failed to create smtp_config table: {}", e)))?;

        tracing::info!("Created smtp_config table");
    }
    Ok(())
}

/// Migrate MCP tables - create mcp_servers and mcp_tools tables (Phase 06-03)
async fn migrate_mcp_tables(pool: &SqlitePool) -> Result<(), DbError> {
    // Create mcp_servers table if it doesn't exist
    if !table_exists(pool, "mcp_servers").await? {
        sqlx::query(
            r#"CREATE TABLE mcp_servers (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                command TEXT NOT NULL,
                args TEXT NOT NULL DEFAULT '[]',
                enabled INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            )"#
        )
        .execute(pool)
        .await
        .map_err(|e| DbError::Migration(format!("Failed to create mcp_servers table: {}", e)))?;

        tracing::info!("Created mcp_servers table");
    }

    // Add transport_type column if it doesn't exist
    if !column_exists(pool, "mcp_servers", "transport_type").await? {
        sqlx::query("ALTER TABLE mcp_servers ADD COLUMN transport_type TEXT NOT NULL DEFAULT 'stdio'")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to add transport_type column: {}", e)))?;
    }

    // Add url column if it doesn't exist
    if !column_exists(pool, "mcp_servers", "url").await? {
        sqlx::query("ALTER TABLE mcp_servers ADD COLUMN url TEXT")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to add url column: {}", e)))?;
    }

    // Add auth_type column if it doesn't exist
    if !column_exists(pool, "mcp_servers", "auth_type").await? {
        sqlx::query("ALTER TABLE mcp_servers ADD COLUMN auth_type TEXT NOT NULL DEFAULT 'none'")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to add auth_type column: {}", e)))?;
    }

    // Add auth_token column if it doesn't exist (legacy plaintext column —
    // retained for backwards-compatible reads only; new writes go to
    // auth_token_encrypted, see CRYPTO-002 below).
    if !column_exists(pool, "mcp_servers", "auth_token").await? {
        sqlx::query("ALTER TABLE mcp_servers ADD COLUMN auth_token TEXT")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to add auth_token column: {}", e)))?;
    }

    // AUDIT FIX (CRYPTO-002): vault-encrypted MCP auth token. The previous
    // schema kept the API token in plaintext TEXT, which meant any local
    // read of `netstacks.db` exfiltrated MCP tokens with no master-password
    // crack. New writes are AES-256-GCM-encrypted with the vault key and
    // stored as BLOB in this column; the plaintext column is left in place
    // until a future migration phase clears it after re-encryption.
    if !column_exists(pool, "mcp_servers", "auth_token_encrypted").await? {
        sqlx::query("ALTER TABLE mcp_servers ADD COLUMN auth_token_encrypted BLOB")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to add auth_token_encrypted column: {}", e)))?;
    }

    // Add server_type column if it doesn't exist
    if !column_exists(pool, "mcp_servers", "server_type").await? {
        sqlx::query("ALTER TABLE mcp_servers ADD COLUMN server_type TEXT NOT NULL DEFAULT 'custom'")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to add server_type column: {}", e)))?;
    }

    // Create mcp_tools table if it doesn't exist
    if !table_exists(pool, "mcp_tools").await? {
        sqlx::query(
            r#"CREATE TABLE mcp_tools (
                id TEXT PRIMARY KEY,
                server_id TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                description TEXT,
                input_schema TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(server_id, name)
            )"#
        )
        .execute(pool)
        .await
        .map_err(|e| DbError::Migration(format!("Failed to create mcp_tools table: {}", e)))?;

        // Create indexes
        sqlx::query("CREATE INDEX IF NOT EXISTS idx_mcp_tools_server ON mcp_tools(server_id)")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to create mcp_tools server index: {}", e)))?;

        sqlx::query("CREATE INDEX IF NOT EXISTS idx_mcp_tools_enabled ON mcp_tools(enabled)")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to create mcp_tools enabled index: {}", e)))?;

        tracing::info!("Created mcp_tools table");
    }

    Ok(())
}

/// Migrate mapped_keys from profile-scoped to global (user-wide).
/// Recreates the table without profile_id FK, adds description and UNIQUE on key_combo.
/// Deduplicates by keeping first occurrence per key_combo.
async fn migrate_mapped_keys_to_global(pool: &SqlitePool) -> Result<(), DbError> {
    // Guard: only run if profile_id column still exists
    if !column_exists(pool, "mapped_keys", "profile_id").await? {
        // Also ensure description column exists (for fresh DBs upgraded to new schema)
        if !column_exists(pool, "mapped_keys", "description").await? {
            sqlx::query("ALTER TABLE mapped_keys ADD COLUMN description TEXT")
                .execute(pool)
                .await
                .map_err(|e| DbError::Migration(format!("Failed to add description column: {}", e)))?;
        }
        return Ok(());
    }

    // Rename old table
    sqlx::query("ALTER TABLE mapped_keys RENAME TO mapped_keys_old")
        .execute(pool)
        .await
        .map_err(|e| DbError::Migration(format!("Failed to rename mapped_keys: {}", e)))?;

    // Create new global table
    sqlx::query(
        r#"CREATE TABLE mapped_keys (
            id TEXT PRIMARY KEY,
            key_combo TEXT NOT NULL UNIQUE,
            command TEXT NOT NULL,
            description TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )"#
    )
    .execute(pool)
    .await
    .map_err(|e| DbError::Migration(format!("Failed to create new mapped_keys table: {}", e)))?;

    // Migrate data with deduplication (keep first occurrence per key_combo)
    sqlx::query(
        r#"INSERT OR IGNORE INTO mapped_keys (id, key_combo, command, created_at)
           SELECT id, key_combo, command, created_at
           FROM mapped_keys_old
           ORDER BY created_at ASC"#
    )
    .execute(pool)
    .await
    .map_err(|e| DbError::Migration(format!("Failed to migrate mapped_keys data: {}", e)))?;

    // Drop old table and index
    sqlx::query("DROP TABLE mapped_keys_old")
        .execute(pool)
        .await
        .map_err(|e| DbError::Migration(format!("Failed to drop old mapped_keys table: {}", e)))?;

    let _ = sqlx::query("DROP INDEX IF EXISTS idx_mapped_keys_profile")
        .execute(pool)
        .await;

    tracing::info!("Migrated mapped_keys from profile-scoped to global");

    Ok(())
}

/// Remove terminal/automation fields from credential_profiles (cleanup)
/// These fields were dead code or duplicated by session/global settings.
async fn migrate_remove_profile_terminal_fields(pool: &SqlitePool) -> Result<(), DbError> {
    let columns = [
        "font_size_override",
        "copy_on_select",
        "environment_vars",
        "startup_commands",
        "highlight_rules_json",
    ];

    let mut dropped = 0;
    for col in columns {
        if column_exists(pool, "credential_profiles", col).await? {
            sqlx::query(&format!(
                "ALTER TABLE credential_profiles DROP COLUMN {}",
                col
            ))
            .execute(pool)
            .await
            .map_err(|e| {
                DbError::Migration(format!(
                    "Failed to drop column {} from credential_profiles: {}",
                    col, e
                ))
            })?;
            dropped += 1;
        }
    }

    if dropped > 0 {
        tracing::info!("Removed {} legacy columns from credential_profiles", dropped);
    }

    Ok(())
}

/// Migrate documents table to add 'recording' content_type CHECK constraint
async fn migrate_documents_recording_content_type(pool: &SqlitePool) -> Result<(), DbError> {
    if !table_exists(pool, "documents").await? {
        return Ok(());
    }

    // Test if 'recording' content_type is allowed by current CHECK constraint
    let test_result = sqlx::query(
        "INSERT INTO documents (id, name, category, content_type, content, created_at, updated_at) VALUES ('__test_rec__', '__test__', 'outputs', 'recording', '', datetime('now'), datetime('now'))"
    )
    .execute(pool)
    .await;

    match test_result {
        Ok(_) => {
            // Constraint already allows 'recording', clean up
            let _ = sqlx::query("DELETE FROM documents WHERE id = '__test_rec__'")
                .execute(pool)
                .await;
            return Ok(());
        }
        Err(_) => {
            // Need to update constraint
        }
    }

    tracing::info!("Updating documents table CHECK constraint to include 'recording' content_type");

    sqlx::query("PRAGMA foreign_keys = OFF")
        .execute(pool)
        .await
        .map_err(|e| DbError::Migration(format!("Failed to disable foreign keys: {}", e)))?;

    sqlx::query("DROP TABLE IF EXISTS documents_new")
        .execute(pool)
        .await
        .map_err(|e| DbError::Migration(format!("Failed to drop leftover documents_new: {}", e)))?;

    sqlx::query(
        r#"CREATE TABLE documents_new (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            category TEXT NOT NULL CHECK (category IN ('outputs', 'templates', 'notes', 'backups', 'history', 'troubleshooting')),
            content_type TEXT NOT NULL CHECK (content_type IN ('csv', 'json', 'jinja', 'config', 'text', 'markdown', 'recording')),
            content TEXT NOT NULL,
            parent_folder TEXT,
            session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )"#
    )
    .execute(pool)
    .await
    .map_err(|e| DbError::Migration(format!("Failed to create documents_new: {}", e)))?;

    sqlx::query("INSERT INTO documents_new SELECT * FROM documents")
        .execute(pool)
        .await
        .map_err(|e| DbError::Migration(format!("Failed to copy documents data: {}", e)))?;

    sqlx::query("DROP TABLE documents")
        .execute(pool)
        .await
        .map_err(|e| DbError::Migration(format!("Failed to drop old documents table: {}", e)))?;

    sqlx::query("ALTER TABLE documents_new RENAME TO documents")
        .execute(pool)
        .await
        .map_err(|e| DbError::Migration(format!("Failed to rename documents_new: {}", e)))?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_documents_category ON documents(category)")
        .execute(pool)
        .await
        .map_err(|e| DbError::Migration(format!("Failed to recreate category index: {}", e)))?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_documents_session_id ON documents(session_id)")
        .execute(pool)
        .await
        .map_err(|e| DbError::Migration(format!("Failed to recreate session_id index: {}", e)))?;

    sqlx::query("PRAGMA foreign_keys = ON")
        .execute(pool)
        .await
        .map_err(|e| DbError::Migration(format!("Failed to re-enable foreign keys: {}", e)))?;

    tracing::info!("Documents table CHECK constraint updated to include 'recording'");

    Ok(())
}

/// Re-add terminal default fields to credential_profiles
/// These were previously removed as dead code but are now properly wired.
async fn migrate_profile_terminal_defaults(pool: &SqlitePool) -> Result<(), DbError> {
    let columns = [
        ("terminal_theme", "TEXT"),
        ("default_font_size", "INTEGER"),
        ("default_font_family", "TEXT"),
        ("scrollback_lines", "INTEGER NOT NULL DEFAULT 10000"),
        ("local_echo", "INTEGER NOT NULL DEFAULT 0"),
        ("auto_reconnect", "INTEGER NOT NULL DEFAULT 1"),
        ("reconnect_delay", "INTEGER NOT NULL DEFAULT 5"),
        ("cli_flavor", "TEXT NOT NULL DEFAULT 'auto'"),
        ("auto_commands", "TEXT"),
    ];

    for (col, col_type) in columns {
        if !column_exists(pool, "credential_profiles", col).await? {
            sqlx::query(&format!(
                "ALTER TABLE credential_profiles ADD COLUMN {} {}",
                col, col_type
            ))
            .execute(pool)
            .await
            .map_err(|e| {
                DbError::Migration(format!(
                    "Failed to add {} column to credential_profiles: {}",
                    col, e
                ))
            })?;
        }
    }

    tracing::info!("Ensured terminal default columns exist on credential_profiles");

    Ok(())
}

/// Add device_overrides column to changes table for per-device step customization
async fn migrate_change_device_overrides(pool: &SqlitePool) -> Result<(), DbError> {
    if table_exists(pool, "changes").await? && !column_exists(pool, "changes", "device_overrides").await? {
        sqlx::query("ALTER TABLE changes ADD COLUMN device_overrides TEXT")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to add device_overrides column: {}", e)))?;

        tracing::info!("Added device_overrides column to changes table");
    }
    Ok(())
}

/// Add document_id column to changes table for linking MOP documents
async fn migrate_change_document_id(pool: &SqlitePool) -> Result<(), DbError> {
    if table_exists(pool, "changes").await? && !column_exists(pool, "changes", "document_id").await? {
        sqlx::query("ALTER TABLE changes ADD COLUMN document_id TEXT")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to add document_id column: {}", e)))?;

        tracing::info!("Added document_id column to changes table");
    }
    Ok(())
}

/// Add 'mops' category to documents table CHECK constraint for MOP package exports
async fn migrate_documents_mops_category(pool: &SqlitePool) -> Result<(), DbError> {
    if !table_exists(pool, "documents").await? {
        return Ok(());
    }

    // Test if 'mops' category is allowed by current CHECK constraint
    let test_result = sqlx::query(
        "INSERT INTO documents (id, name, category, content_type, content, created_at, updated_at) VALUES ('__test_mops__', '__test__', 'mops', 'json', '', datetime('now'), datetime('now'))"
    )
    .execute(pool)
    .await;

    match test_result {
        Ok(_) => {
            let _ = sqlx::query("DELETE FROM documents WHERE id = '__test_mops__'")
                .execute(pool)
                .await;
            return Ok(());
        }
        Err(_) => {}
    }

    tracing::info!("Updating documents table CHECK constraint to include 'mops' category");

    sqlx::query("PRAGMA foreign_keys = OFF")
        .execute(pool)
        .await
        .map_err(|e| DbError::Migration(format!("Failed to disable foreign keys: {}", e)))?;

    sqlx::query("DROP TABLE IF EXISTS documents_new")
        .execute(pool)
        .await
        .map_err(|e| DbError::Migration(format!("Failed to drop leftover documents_new: {}", e)))?;

    sqlx::query(
        r#"CREATE TABLE documents_new (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            category TEXT NOT NULL CHECK (category IN ('outputs', 'templates', 'notes', 'backups', 'history', 'troubleshooting', 'mops')),
            content_type TEXT NOT NULL CHECK (content_type IN ('csv', 'json', 'jinja', 'config', 'text', 'markdown', 'recording')),
            content TEXT NOT NULL,
            parent_folder TEXT,
            session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )"#
    )
    .execute(pool)
    .await
    .map_err(|e| DbError::Migration(format!("Failed to create documents_new: {}", e)))?;

    sqlx::query("INSERT INTO documents_new SELECT * FROM documents")
        .execute(pool)
        .await
        .map_err(|e| DbError::Migration(format!("Failed to copy documents data: {}", e)))?;

    sqlx::query("DROP TABLE documents")
        .execute(pool)
        .await
        .map_err(|e| DbError::Migration(format!("Failed to drop old documents table: {}", e)))?;

    sqlx::query("ALTER TABLE documents_new RENAME TO documents")
        .execute(pool)
        .await
        .map_err(|e| DbError::Migration(format!("Failed to rename documents_new: {}", e)))?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_documents_category ON documents(category)")
        .execute(pool)
        .await
        .map_err(|e| DbError::Migration(format!("Failed to recreate category index: {}", e)))?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_documents_session_id ON documents(session_id)")
        .execute(pool)
        .await
        .map_err(|e| DbError::Migration(format!("Failed to recreate session_id index: {}", e)))?;

    sqlx::query("PRAGMA foreign_keys = ON")
        .execute(pool)
        .await
        .map_err(|e| DbError::Migration(format!("Failed to re-enable foreign keys: {}", e)))?;

    tracing::info!("Documents table CHECK constraint updated to include 'mops'");

    Ok(())
}

/// Make changes.session_id nullable so imported MOPs don't need a session
async fn migrate_changes_nullable_session_id(pool: &SqlitePool) -> Result<(), DbError> {
    if !table_exists(pool, "changes").await? {
        return Ok(());
    }

    // Check if session_id is already nullable by inserting a test row with NULL session_id
    let test_result = sqlx::query(
        "INSERT INTO changes (id, session_id, name, status, mop_steps, created_by, created_at, updated_at) VALUES ('__test_null_sid__', NULL, '__test__', 'draft', '[]', '__test__', datetime('now'), datetime('now'))"
    )
    .execute(pool)
    .await;

    match test_result {
        Ok(_) => {
            let _ = sqlx::query("DELETE FROM changes WHERE id = '__test_null_sid__'")
                .execute(pool)
                .await;
            return Ok(());
        }
        Err(_) => {}
    }

    tracing::info!("Making changes.session_id nullable for imported MOPs");

    sqlx::query("PRAGMA foreign_keys = OFF")
        .execute(pool)
        .await
        .map_err(|e| DbError::Migration(format!("Failed to disable foreign keys: {}", e)))?;

    sqlx::query("DROP TABLE IF EXISTS changes_new")
        .execute(pool)
        .await
        .map_err(|e| DbError::Migration(format!("Failed to drop leftover changes_new: {}", e)))?;

    sqlx::query(
        r#"CREATE TABLE changes_new (
            id TEXT PRIMARY KEY,
            session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            description TEXT,
            status TEXT NOT NULL DEFAULT 'draft',
            mop_steps TEXT NOT NULL DEFAULT '[]',
            pre_snapshot_id TEXT,
            post_snapshot_id TEXT,
            ai_analysis TEXT,
            created_by TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            executed_at TEXT,
            completed_at TEXT,
            device_overrides TEXT,
            document_id TEXT
        )"#,
    )
    .execute(pool)
    .await
    .map_err(|e| DbError::Migration(format!("Failed to create changes_new: {}", e)))?;

    sqlx::query("INSERT INTO changes_new SELECT * FROM changes")
        .execute(pool)
        .await
        .map_err(|e| DbError::Migration(format!("Failed to copy changes data: {}", e)))?;

    sqlx::query("DROP TABLE changes")
        .execute(pool)
        .await
        .map_err(|e| DbError::Migration(format!("Failed to drop old changes table: {}", e)))?;

    sqlx::query("ALTER TABLE changes_new RENAME TO changes")
        .execute(pool)
        .await
        .map_err(|e| DbError::Migration(format!("Failed to rename changes_new: {}", e)))?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_changes_session_id ON changes(session_id)")
        .execute(pool)
        .await
        .map_err(|e| DbError::Migration(format!("Failed to recreate session_id index: {}", e)))?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_changes_status ON changes(status)")
        .execute(pool)
        .await
        .map_err(|e| DbError::Migration(format!("Failed to recreate status index: {}", e)))?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_changes_created_at ON changes(created_at)")
        .execute(pool)
        .await
        .map_err(|e| DbError::Migration(format!("Failed to recreate created_at index: {}", e)))?;

    sqlx::query("PRAGMA foreign_keys = ON")
        .execute(pool)
        .await
        .map_err(|e| DbError::Migration(format!("Failed to re-enable foreign keys: {}", e)))?;

    tracing::info!("Changes table session_id is now nullable");

    Ok(())
}

/// Add missing columns to mop_executions for plan_id, on_failure, pause settings
async fn migrate_mop_executions_new_columns(pool: &SqlitePool) -> Result<(), DbError> {
    if !table_exists(pool, "mop_executions").await? {
        return Ok(());
    }

    let columns = [
        ("plan_id", "TEXT"),
        ("on_failure", "TEXT NOT NULL DEFAULT 'pause'"),
        ("pause_after_pre_checks", "INTEGER NOT NULL DEFAULT 1"),
        ("pause_after_changes", "INTEGER NOT NULL DEFAULT 1"),
        ("pause_after_post_checks", "INTEGER NOT NULL DEFAULT 1"),
    ];

    for (col, def) in &columns {
        if !column_exists(pool, "mop_executions", col).await? {
            let sql = format!("ALTER TABLE mop_executions ADD COLUMN {} {}", col, def);
            sqlx::query(&sql)
                .execute(pool)
                .await
                .map_err(|e| DbError::Migration(format!("Failed to add {} column: {}", col, e)))?;
        }
    }

    Ok(())
}

/// Add sftp_start_path column to sessions table
async fn migrate_sftp_start_path(pool: &SqlitePool) -> Result<(), DbError> {
    if !column_exists(pool, "sessions", "sftp_start_path").await? {
        sqlx::query("ALTER TABLE sessions ADD COLUMN sftp_start_path TEXT")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to add sftp_start_path column: {}", e)))?;
    }
    Ok(())
}

/// Add action_type, quick_action_id, quick_action_variable columns to custom_commands table
async fn migrate_custom_commands_quick_actions(pool: &SqlitePool) -> Result<(), DbError> {
    if !column_exists(pool, "custom_commands", "action_type").await? {
        sqlx::query("ALTER TABLE custom_commands ADD COLUMN action_type TEXT NOT NULL DEFAULT 'terminal'")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to add action_type column: {}", e)))?;
    }
    if !column_exists(pool, "custom_commands", "quick_action_id").await? {
        sqlx::query("ALTER TABLE custom_commands ADD COLUMN quick_action_id TEXT")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to add quick_action_id column: {}", e)))?;
    }
    if !column_exists(pool, "custom_commands", "quick_action_variable").await? {
        sqlx::query("ALTER TABLE custom_commands ADD COLUMN quick_action_variable TEXT")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to add quick_action_variable column: {}", e)))?;
    }
    if !column_exists(pool, "custom_commands", "script_id").await? {
        sqlx::query("ALTER TABLE custom_commands ADD COLUMN script_id TEXT")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to add script_id column: {}", e)))?;
    }
    Ok(())
}

/// Add execution_source routing fields to mop_execution_steps
async fn migrate_mop_execution_steps_sources(pool: &SqlitePool) -> Result<(), DbError> {
    let columns = [
        ("execution_source", "TEXT NOT NULL DEFAULT 'cli'"),
        ("quick_action_id", "TEXT"),
        ("quick_action_variables", "TEXT"),
        ("script_id", "TEXT"),
        ("script_args", "TEXT"),
        ("paired_step_id", "TEXT"),
        ("output_format", "TEXT"),
    ];
    for (col, col_type) in &columns {
        if !column_exists(pool, "mop_execution_steps", col).await? {
            let sql = format!("ALTER TABLE mop_execution_steps ADD COLUMN {} {}", col, col_type);
            sqlx::query(&sql)
                .execute(pool)
                .await
                .map_err(|e| DbError::Migration(format!("Failed to add {} column: {}", col, e)))?;
        }
    }
    Ok(())
}

/// Migrate: add ai_engineer_profile table for existing databases
async fn migrate_ai_engineer_profile(pool: &SqlitePool) -> Result<(), DbError> {
    if !table_exists(pool, "ai_engineer_profile").await? {
        sqlx::query(
            "CREATE TABLE ai_engineer_profile (
                id INTEGER PRIMARY KEY,
                name TEXT,
                behavior_mode TEXT DEFAULT 'assistant',
                autonomy_level TEXT DEFAULT 'suggest',
                vendor_weights TEXT DEFAULT '{}',
                domain_focus TEXT DEFAULT '{}',
                cert_perspective TEXT DEFAULT 'vendor-neutral',
                verbosity TEXT DEFAULT 'balanced',
                risk_tolerance TEXT DEFAULT 'conservative',
                troubleshooting_method TEXT DEFAULT 'top-down',
                syntax_style TEXT DEFAULT 'full',
                user_experience_level TEXT DEFAULT 'mid',
                environment_type TEXT DEFAULT 'production',
                safety_rules TEXT DEFAULT '[]',
                communication_style TEXT,
                onboarding_completed BOOLEAN DEFAULT 0,
                compiled_segments TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )"
        )
        .execute(pool)
        .await
        .map_err(|e| DbError::Migration(format!("Failed to create ai_engineer_profile table: {}", e)))?;
    }
    Ok(())
}

/// Migrate ai_memory table - create if it doesn't exist
async fn migrate_ai_memory_table(pool: &SqlitePool) -> Result<(), DbError> {
    if !table_exists(pool, "ai_memory").await? {
        sqlx::query(
            r#"CREATE TABLE ai_memory (
                id TEXT PRIMARY KEY,
                content TEXT NOT NULL,
                category TEXT NOT NULL DEFAULT 'general',
                source TEXT NOT NULL DEFAULT 'ai',
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            )"#
        )
        .execute(pool)
        .await
        .map_err(|e| DbError::Migration(format!("Failed to create ai_memory table: {}", e)))?;

        sqlx::query("CREATE INDEX idx_ai_memory_category ON ai_memory(category)")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to create ai_memory category index: {}", e)))?;

        sqlx::query("CREATE INDEX idx_ai_memory_created_at ON ai_memory(created_at)")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to create ai_memory created_at index: {}", e)))?;
    }

    Ok(())
}

/// Seed default settings (idempotent)
async fn seed_default_settings(pool: &SqlitePool) -> Result<(), DbError> {
    // Seed ai.terminal_mode setting with default value of "false"
    sqlx::query(
        "INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('ai.terminal_mode', 'false', datetime('now'))"
    )
    .execute(pool)
    .await
    .map_err(|e| DbError::Migration(format!("Failed to seed ai.terminal_mode setting: {}", e)))?;

    Ok(())
}

/// Migrate tunnels table - created by schema.sql CREATE TABLE IF NOT EXISTS
async fn migrate_tunnels_table(_pool: &SqlitePool) -> Result<(), DbError> {
    // Table is created by schema.sql CREATE TABLE IF NOT EXISTS
    Ok(())
}

/// Validate the jump refs about to be written to a tunnel row.
/// Enforces mutual exclusion of `jump_host_id` / `jump_session_id` and the
/// "session-as-jump must be a leaf" rule (target session and its profile
/// must not themselves have any jump configured).
///
/// Pass `entity_id = Some(id)` on update so self-reference is detected,
/// `None` on create. `entity_name` is used in error messages.
pub(crate) async fn validate_tunnel_jump_refs(
    pool: &SqlitePool,
    entity_id: Option<&str>,
    entity_name: &str,
    jump_host_id: Option<&str>,
    jump_session_id: Option<&str>,
) -> Result<(), DbError> {
    validate_jump_refs_inner(pool, "tunnel", entity_id, entity_name, jump_host_id, jump_session_id).await
}

/// Same validation, exposed for sessions/profiles writes living in the
/// provider layer. The `entity_kind` is "session" / "profile" / "tunnel"
/// and only flavors the error message.
pub async fn validate_entity_jump_refs(
    pool: &SqlitePool,
    entity_kind: &str,
    entity_id: Option<&str>,
    entity_name: &str,
    jump_host_id: Option<&str>,
    jump_session_id: Option<&str>,
) -> Result<(), DbError> {
    validate_jump_refs_inner(pool, entity_kind, entity_id, entity_name, jump_host_id, jump_session_id).await
}

async fn validate_jump_refs_inner(
    pool: &SqlitePool,
    entity_kind: &str,
    entity_id: Option<&str>,
    entity_name: &str,
    jump_host_id: Option<&str>,
    jump_session_id: Option<&str>,
) -> Result<(), DbError> {
    // Mutual exclusion.
    if jump_host_id.is_some() && jump_session_id.is_some() {
        return Err(DbError::Migration(format!(
            "{} '{}' has both jump_host_id and jump_session_id set — pick one.",
            entity_kind, entity_name
        )));
    }

    let Some(target_session_id) = jump_session_id else {
        return Ok(());
    };

    // Self-reference check.
    if Some(target_session_id) == entity_id {
        return Err(DbError::Migration(format!(
            "{} '{}' cannot use itself as a jump session.",
            entity_kind, entity_name
        )));
    }

    // Target session must exist and be a leaf.
    let row: Option<(String, Option<String>, Option<String>, String)> = sqlx::query_as(
        "SELECT s.name, s.jump_host_id, s.jump_session_id, s.profile_id \
         FROM sessions s WHERE s.id = ?"
    )
    .bind(target_session_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| DbError::Migration(e.to_string()))?;

    let Some((session_name, s_jh_id, s_js_id, s_profile_id)) = row else {
        return Err(DbError::Migration(format!(
            "{} '{}' references jump session '{}' which does not exist.",
            entity_kind, entity_name, target_session_id
        )));
    };

    if s_jh_id.is_some() || s_js_id.is_some() {
        return Err(DbError::Migration(format!(
            "{} '{}' cannot use session '{}' as a jump — that session itself has a jump configured. \
             Multi-hop jumps are not supported. Clear the jump on session '{}' first.",
            entity_kind, entity_name, session_name, session_name
        )));
    }

    // Target session's auth profile must also be a leaf.
    let prof: Option<(String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT name, jump_host_id, jump_session_id FROM credential_profiles WHERE id = ?"
    )
    .bind(&s_profile_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| DbError::Migration(e.to_string()))?;

    if let Some((profile_name, p_jh_id, p_js_id)) = prof {
        if p_jh_id.is_some() || p_js_id.is_some() {
            return Err(DbError::Migration(format!(
                "{} '{}' cannot use session '{}' as a jump — its auth profile '{}' has a jump configured. \
                 Multi-hop jumps are not supported. Clear the jump on profile '{}' first.",
                entity_kind, entity_name, session_name, profile_name, profile_name
            )));
        }
    }

    Ok(())
}

/// Symmetric check: when modifying a session/profile to add a jump, if
/// that session is already referenced as someone else's jump_session, reject.
/// This prevents creating a chain by editing the leaf to no longer be a leaf.
pub async fn validate_session_not_used_as_jump(
    pool: &SqlitePool,
    session_id: &str,
    new_jump_host_id: Option<&str>,
    new_jump_session_id: Option<&str>,
) -> Result<(), DbError> {
    if new_jump_host_id.is_none() && new_jump_session_id.is_none() {
        return Ok(()); // becoming a leaf is fine
    }

    let dependents: Vec<(String, String)> = sqlx::query_as(
        "SELECT 'session' AS kind, name FROM sessions WHERE jump_session_id = ? AND id <> ? \
         UNION ALL \
         SELECT 'tunnel'  AS kind, name FROM tunnels  WHERE jump_session_id = ? \
         UNION ALL \
         SELECT 'profile' AS kind, name FROM credential_profiles WHERE jump_session_id = ?"
    )
    .bind(session_id).bind(session_id).bind(session_id).bind(session_id)
    .fetch_all(pool)
    .await
    .map_err(|e| DbError::Migration(e.to_string()))?;

    if !dependents.is_empty() {
        let names: Vec<String> = dependents.iter().map(|(k, n)| format!("{} '{}'", k, n)).collect();
        return Err(DbError::Migration(format!(
            "Cannot add a jump to this session — it is currently used as a jump by: {}. \
             Multi-hop jumps are not supported. Detach those references first.",
            names.join(", ")
        )));
    }
    Ok(())
}

// === Tunnel CRUD ===

#[derive(sqlx::FromRow)]
struct TunnelRow {
    id: String,
    name: String,
    host: String,
    port: i64,
    profile_id: String,
    jump_host_id: Option<String>,
    jump_session_id: Option<String>,
    forward_type: String,
    local_port: i64,
    bind_address: String,
    remote_host: Option<String>,
    remote_port: Option<i64>,
    auto_start: bool,
    auto_reconnect: bool,
    max_retries: i64,
    enabled: bool,
    created_at: String,
    updated_at: String,
}

impl TunnelRow {
    fn into_tunnel(self) -> Tunnel {
        Tunnel {
            id: self.id,
            name: self.name,
            host: self.host,
            port: self.port as u16,
            profile_id: self.profile_id,
            jump_host_id: self.jump_host_id,
            jump_session_id: self.jump_session_id,
            forward_type: match self.forward_type.as_str() {
                "remote" => PortForwardType::Remote,
                "dynamic" => PortForwardType::Dynamic,
                _ => PortForwardType::Local,
            },
            local_port: self.local_port as u16,
            bind_address: self.bind_address,
            remote_host: self.remote_host,
            remote_port: self.remote_port.map(|p| p as u16),
            auto_start: self.auto_start,
            auto_reconnect: self.auto_reconnect,
            max_retries: self.max_retries as u32,
            enabled: self.enabled,
            created_at: self.created_at,
            updated_at: self.updated_at,
        }
    }
}

const TUNNEL_COLUMNS: &str = "id, name, host, port, profile_id, jump_host_id, jump_session_id, \
    forward_type, local_port, bind_address, remote_host, remote_port, \
    auto_start, auto_reconnect, max_retries, enabled, created_at, updated_at";

pub async fn list_tunnels(pool: &SqlitePool) -> Result<Vec<Tunnel>, DbError> {
    let query = format!("SELECT {} FROM tunnels ORDER BY name", TUNNEL_COLUMNS);
    let rows: Vec<TunnelRow> = sqlx::query_as(&query)
        .fetch_all(pool)
        .await?;

    Ok(rows.into_iter().map(|r| r.into_tunnel()).collect())
}

pub async fn get_tunnel(pool: &SqlitePool, id: &str) -> Result<Tunnel, DbError> {
    let query = format!("SELECT {} FROM tunnels WHERE id = ?", TUNNEL_COLUMNS);
    let row: TunnelRow = sqlx::query_as(&query)
        .bind(id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| DbError::Sqlx(sqlx::Error::RowNotFound))?;

    Ok(row.into_tunnel())
}

pub async fn create_tunnel(pool: &SqlitePool, new: NewTunnel) -> Result<Tunnel, DbError> {
    let id = uuid::Uuid::new_v4().to_string();
    let forward_type_str = match new.forward_type {
        PortForwardType::Local => "local",
        PortForwardType::Remote => "remote",
        PortForwardType::Dynamic => "dynamic",
    };

    // Validate tunnel jump references before insert.
    validate_tunnel_jump_refs(
        pool,
        None, // no existing id on create
        &new.name,
        new.jump_host_id.as_deref(),
        new.jump_session_id.as_deref(),
    ).await?;

    sqlx::query(
        "INSERT INTO tunnels (id, name, host, port, profile_id, jump_host_id, jump_session_id, \
         forward_type, local_port, bind_address, remote_host, remote_port, \
         auto_start, auto_reconnect, max_retries, enabled) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)"
    )
    .bind(&id).bind(&new.name).bind(&new.host)
    .bind(new.port as i64).bind(&new.profile_id)
    .bind(&new.jump_host_id).bind(&new.jump_session_id)
    .bind(forward_type_str).bind(new.local_port as i64).bind(&new.bind_address)
    .bind(&new.remote_host).bind(new.remote_port.map(|p| p as i64))
    .bind(new.auto_start).bind(new.auto_reconnect)
    .bind(new.max_retries as i64)
    .execute(pool)
    .await?;

    get_tunnel(pool, &id).await
}

pub async fn update_tunnel(pool: &SqlitePool, id: &str, update: UpdateTunnel) -> Result<Tunnel, DbError> {
    let existing = get_tunnel(pool, id).await?;

    let forward_type_str = match update.forward_type.unwrap_or(existing.forward_type) {
        PortForwardType::Local => "local",
        PortForwardType::Remote => "remote",
        PortForwardType::Dynamic => "dynamic",
    };

    let new_name = update.name.clone().unwrap_or_else(|| existing.name.clone());
    let new_jump_host_id = update.jump_host_id.clone().unwrap_or(existing.jump_host_id.clone());
    let new_jump_session_id = update.jump_session_id.clone().unwrap_or(existing.jump_session_id.clone());

    // Validate the resulting jump refs.
    validate_tunnel_jump_refs(
        pool,
        Some(id),
        &new_name,
        new_jump_host_id.as_deref(),
        new_jump_session_id.as_deref(),
    ).await?;

    sqlx::query(
        "UPDATE tunnels SET name = ?, host = ?, port = ?, profile_id = ?, jump_host_id = ?, jump_session_id = ?, \
         forward_type = ?, local_port = ?, bind_address = ?, remote_host = ?, remote_port = ?, \
         auto_start = ?, auto_reconnect = ?, max_retries = ?, enabled = ?, \
         updated_at = datetime('now') WHERE id = ?"
    )
    .bind(new_name)
    .bind(update.host.unwrap_or(existing.host))
    .bind(update.port.unwrap_or(existing.port) as i64)
    .bind(update.profile_id.unwrap_or(existing.profile_id))
    .bind(&new_jump_host_id)
    .bind(&new_jump_session_id)
    .bind(forward_type_str)
    .bind(update.local_port.unwrap_or(existing.local_port) as i64)
    .bind(update.bind_address.unwrap_or(existing.bind_address))
    .bind(update.remote_host.unwrap_or(existing.remote_host))
    .bind(update.remote_port.unwrap_or(existing.remote_port).map(|p| p as i64))
    .bind(update.auto_start.unwrap_or(existing.auto_start))
    .bind(update.auto_reconnect.unwrap_or(existing.auto_reconnect))
    .bind(update.max_retries.unwrap_or(existing.max_retries) as i64)
    .bind(update.enabled.unwrap_or(existing.enabled))
    .bind(id)
    .execute(pool)
    .await?;

    get_tunnel(pool, id).await
}

pub async fn delete_tunnel(pool: &SqlitePool, id: &str) -> Result<(), DbError> {
    let result = sqlx::query("DELETE FROM tunnels WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;

    if result.rows_affected() == 0 {
        return Err(DbError::Sqlx(sqlx::Error::RowNotFound));
    }
    Ok(())
}

/// Get the default database path
pub fn default_db_path() -> std::path::PathBuf {
    let data_dir = dirs::data_local_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("netstacks");

    data_dir.join("netstacks.db")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn test_init_db() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("test.db");

        let pool = init_db(&db_path).await.unwrap();

        // Verify tables exist
        let result: (i32,) = sqlx::query_as("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='sessions'")
            .fetch_one(&pool)
            .await
            .unwrap();

        assert_eq!(result.0, 1);
    }
}
