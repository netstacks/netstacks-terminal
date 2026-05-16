# Phase 2: Agent LSP Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** SKELETON — task headings only. Flesh out before execution.

**Goal:** Build the generic plugin-shaped LSP host inside the local agent: plugin descriptor registry, per-`(plugin_id, workspace)` LSP session, WebSocket route that bridges Monaco ↔ a stdio LSP child process. Tested end-to-end with a fake stdio LSP binary so this phase ships before Pyrefly is wired in.

**Architecture:** New `agent/src/lsp/` module. `LspHost` owns the merged plugin registry (built-ins from `plugins.rs`, user-added from SQLite) and a map of active `LspSession`s. Each `LspSession` owns one tokio child process and N attached WebSocket clients, with stdio framed as LSP JSON-RPC. New axum routes mounted under `/lsp/*`. Bearer-token auth reuses the existing agent middleware. No language-specific code in this phase — all behavior is parameterized by plugin descriptors.

**Tech Stack:** Rust, tokio, axum, axum-tungstenite (for WS upgrade), serde, sqlx (existing), tokio's `Child` for stdio process management. Test fixture: a tiny Rust binary that speaks minimal LSP over stdio.

---

## Phase Map (for context — this plan is Phase 2 only)

- Phase 1: Client-Side Language Features (YANG + XML format)
- **Phase 2: Agent LSP Foundation** ← you are here
- Phase 3: Frontend LSP Client (monaco-languageclient hook)
- Phase 4: Pyrefly Plugin (on-demand download + first-run banner)
- Phase 5: Settings UI (full CRUD for LSP plugins)
- Phase 6: Polish (loose-file mode, Enterprise banner, E2E)

---

## File Structure (planned)

**New files:**
- `agent/src/lsp/mod.rs` — module re-exports
- `agent/src/lsp/types.rs` — `LspPlugin`, `InstallStatus`, request/response types (shared with frontend via serde JSON)
- `agent/src/lsp/plugins.rs` — built-in plugin registry (empty in Phase 2; Pyrefly added in Phase 4)
- `agent/src/lsp/host.rs` — `LspHost` struct, plugin registry merging, session map
- `agent/src/lsp/session.rs` — `LspSession`: child process lifecycle, WS attach/detach, stdio bridging
- `agent/src/lsp/routes.rs` — axum router exposing `/lsp/plugins`, `/lsp/{plugin_id}` WS
- `agent/tests/lsp_session.rs` — integration test against a fake stdio LSP binary
- `agent/tests/fixtures/fake-lsp/Cargo.toml` + `src/main.rs` — minimal stdio LSP that responds to `initialize` and echoes `textDocument/didOpen` as a fake diagnostic

**Modified files:**
- `agent/Cargo.toml` — add `axum-tungstenite` (or use existing axum 0.7 WS support); add `dashmap` if not present
- `agent/src/main.rs` — register `mod lsp;` and mount `lsp::routes::router()` under `/lsp`
- `agent/migrations/NNN-lsp-plugins.sql` — SQLite table for user-added plugins (descriptor shape mirrors Rust types)

---

## Tasks (to be detailed before execution)

### Task 1: Define plugin descriptor types (mirror frontend TypeScript shape)
### Task 2: Create empty built-in plugin registry + SQLite migration for user-added plugins
### Task 3: Implement `LspHost` with merged registry (built-in + DB), tested with table-driven unit tests
### Task 4: Build the fake stdio LSP test fixture binary
### Task 5: Implement `LspSession::spawn` + `attach_ws` + `detach_ws` + graceful shutdown — TDD'd against the fake fixture
### Task 6: Wire `/lsp/plugins` GET route (returns descriptor list + install status)
### Task 7: Wire `/lsp/{plugin_id}` WebSocket route with bearer auth, session creation, stdio bridging
### Task 8: Integration test: spawn fake LSP via WS, send `initialize`, assert response round-trips correctly
### Task 9: Test session sharing — two WS clients to the same `(plugin_id, workspace)` share one child process
### Task 10: Test graceful shutdown on agent stop (SIGTERM → SIGKILL escalation)
### Task 11: Implement auto-restart for crashed LSP children (single retry with backoff; emit `lsp-session-crashed` event for the frontend to surface)

---

## Done criteria

- A WebSocket client can connect to `wss://localhost:8080/lsp/test-plugin?workspace=/tmp/foo` with a valid bearer token, send LSP `initialize`, and receive an `initialized` response from the fake fixture.
- Two simultaneous WS clients to the same `(plugin_id, workspace)` share one child process.
- `GET /lsp/plugins` returns an empty list (no built-ins yet) plus any user-added entries from the DB.
- Cargo tests pass: `cargo test --package netstacks-agent lsp::`.
- No changes to the frontend.

---

**Flesh out this plan before execution by adding full step-by-step content (test code, implementation, commands, expected output) to each task.** Reference Phase 1 as the granularity model.
