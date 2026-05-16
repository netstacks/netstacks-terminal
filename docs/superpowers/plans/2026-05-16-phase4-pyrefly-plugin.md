# Phase 4: Pyrefly Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** SKELETON — task headings only. Flesh out before execution.

**Goal:** Ship the first concrete LSP: add a Pyrefly built-in descriptor (both registries), implement on-demand download with SHA-256 verification + wheel extraction in the agent, expose progress via SSE, and surface a first-run install banner in `WorkspaceCodeEditor` and `ScriptEditor` for `.py` files.

**Architecture:** Pyrefly is fetched from PyPI wheels (cross-platform support, including Windows). The agent's `install.rs` module is generic over plugin descriptors — Pyrefly is just the first caller. Downloads stream to a temp file; SHA verified against the pinned per-platform hash in the descriptor; the binary is extracted to `{dataDir}/lsp/pyrefly/{version}/`; `chmod +x` set on Unix; `--version` smoke test confirms it runs. Progress is emitted via Server-Sent Events on a sibling endpoint. Frontend's `useLspClient` notices `Not installed`, mounts a banner; clicking Install calls the install endpoint and subscribes to the SSE stream.

**Tech Stack:** Rust (`reqwest` for streaming download, `zip` crate for wheel extraction, `sha2` for hashing). TypeScript (React banner component, EventSource for SSE).

---

## Phase Map (for context — this plan is Phase 4 only)

- Phase 1: Client-Side Language Features
- Phase 2: Agent LSP Foundation
- Phase 3: Frontend LSP Client
- **Phase 4: Pyrefly Plugin** ← you are here
- Phase 5: Settings UI (full CRUD for LSP plugins)
- Phase 6: Polish (loose-file mode, Enterprise banner, E2E)

---

## File Structure (planned)

**New files:**
- `agent/src/lsp/install.rs` — generic on-demand installer (download, verify, extract, smoke test)
- `agent/src/lsp/wheel.rs` — Python wheel (ZIP) extraction helper
- `agent/tests/install.rs` — install integration test with a mock HTTP server serving a fixture wheel
- `frontend/src/components/lsp/LspInstallBanner.tsx` — non-blocking banner that appears at the top of an editor when a plugin is `Not installed`
- `frontend/src/components/lsp/__tests__/LspInstallBanner.test.tsx` — banner state tests

**Modified files:**
- `agent/Cargo.toml` — add `reqwest` (streaming), `zip`, `sha2` (if not present)
- `agent/src/lsp/plugins.rs` — add the Pyrefly built-in descriptor with per-platform URLs + SHA-256 hashes pinned to a specific Pyrefly version
- `agent/src/lsp/routes.rs` — add `POST /lsp/plugins/{id}/install`, `DELETE /lsp/plugins/{id}`, `GET /lsp/plugins/{id}/install-progress` (SSE)
- `frontend/src/lsp/plugins.ts` — add the Pyrefly descriptor (mirrors agent)
- `frontend/src/lsp/installationApi.ts` — add `install(pluginId)`, `subscribeToInstallProgress(pluginId)` (EventSource wrapper)
- `frontend/src/lsp/useLspClient.ts` — when status is `Not installed`, surface a `needsInstall` flag so the editor can render `LspInstallBanner`
- `frontend/src/components/workspace/WorkspaceCodeEditor.tsx` — render `LspInstallBanner` when `needsInstall` is true
- `frontend/src/components/ScriptEditor.tsx` — same banner rendering

---

## Tasks (to be detailed before execution)

### Task 1: Inspect a real Pyrefly wheel to confirm the binary's path inside the ZIP (likely `pyrefly-1.0.0.data/scripts/pyrefly` or `pyrefly/bin/pyrefly`) — pin the value in the descriptor
### Task 2: Add the Pyrefly descriptor (agent + frontend) with platform→{url,sha256,binaryPath} table for all 6 supported platforms (macOS x86_64+arm64, Linux x86_64+arm64, Windows x86_64+arm64)
### Task 3: Implement `wheel.rs` ZIP extraction (test against a fixture wheel checked into `agent/tests/fixtures/`)
### Task 4: Implement `install.rs` — streaming download, SHA verify, extract, chmod, smoke test (`--version`)
### Task 5: Add `POST /lsp/plugins/{id}/install` route + concurrency guard (per-plugin mutex; 409 if already in progress)
### Task 6: Add SSE progress endpoint emitting `{ phase, bytesDownloaded, totalBytes }` events
### Task 7: Add `DELETE /lsp/plugins/{id}` route (uninstall: stop active sessions, remove binary directory, set state to `Not installed`)
### Task 8: Integration test: mock HTTP server serves a fake "pyrefly" wheel; full install flow runs end-to-end; SHA mismatch case rejects + leaves no partial files
### Task 9: Build `LspInstallBanner.tsx` — three states (offer / installing / error); persistence of "Don't ask again" flag in app config
### Task 10: Wire the banner into `WorkspaceCodeEditor.tsx` and `ScriptEditor.tsx` (conditional render based on `needsInstall`)
### Task 11: Connect EventSource to the SSE progress stream from the banner; render percentage
### Task 12: Air-gapped escape hatch — agent checks the expected binary path on startup; if a valid binary is already present (e.g. user manually placed it), it's adopted as `Installed` without a download
### Task 13: End-to-end smoke test on three platforms (macOS, Linux, Windows): install Pyrefly via the banner, open a Python file with a bad import, assert a diagnostic appears

---

## Done criteria

- A user with a fresh NetStacks install can open a `.py` file in a workspace, see the banner, click Install, watch progress, and within ~15 seconds see real diagnostics from Pyrefly.
- The Pyrefly binary lives under `{dataDir}/lsp/pyrefly/{version}/` (not in the app bundle).
- SHA mismatch in download is rejected without partial files.
- Uninstall via `DELETE /lsp/plugins/pyrefly` cleanly tears down sessions and removes the binary.
- "Don't ask again" persists across sessions.
- All three platforms work (manual smoke test).

---

**Flesh out this plan before execution by adding full step-by-step content to each task.**
