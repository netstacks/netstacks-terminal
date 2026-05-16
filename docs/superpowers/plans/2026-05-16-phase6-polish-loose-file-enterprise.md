# Phase 6: Polish — Loose-File Mode, Enterprise Banner, E2E Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** SKELETON — task headings only. Flesh out before execution.

**Goal:** Round out the LSP system: support loose-file mode (Python files opened in editors without a workspace), gracefully surface "Unavailable in Enterprise Mode" for Python LSP, add reconnect telemetry, add the scratch-dir cleanup sweep, and lock in coverage with Playwright E2E tests across the install banner, custom-plugin flow, and YANG/XML language features.

**Architecture:** Agent gains `LspSession::spawn_scratch` which creates a per-session UUID temp directory under `{dataDir}/lsp/scratch/{uuid}/`, writes the file into it, and uses that as the LSP workspace. Frontend `useLspClient` exposes loose-file mode when no workspace is passed. New Enterprise-mode banner shown by `useLspClient` when `requiresAuth === true && plugin.unavailableInEnterprise === true`. Scratch-dir cleanup runs on agent startup, sweeping anything older than 24 hours. Playwright tests under `tests/e2e/` cover the user-facing flows.

**Tech Stack:** Rust (`uuid`, `tempfile`), TypeScript (React), Playwright.

---

## Phase Map (for context — this plan is Phase 6 only)

- Phase 1: Client-Side Language Features
- Phase 2: Agent LSP Foundation
- Phase 3: Frontend LSP Client
- Phase 4: Pyrefly Plugin
- Phase 5: Settings UI
- **Phase 6: Polish** ← you are here

---

## File Structure (planned)

**New files:**
- `agent/src/lsp/scratch.rs` — scratch-dir lifecycle (create per-session, sweep on startup)
- `frontend/src/components/lsp/EnterpriseUnavailableBanner.tsx` — one-time, dismissable banner
- `frontend/src/components/lsp/__tests__/EnterpriseUnavailableBanner.test.tsx` — banner tests
- `tests/e2e/tests/lsp-install-banner.spec.ts` — open .py, see banner, install (mock download), see diagnostics
- `tests/e2e/tests/lsp-custom-plugin.spec.ts` — add custom plugin via Settings, open matching file, assert connection
- `tests/e2e/tests/yang-highlighting.spec.ts` — open .yang file, assert keyword token classes
- `tests/e2e/tests/xml-format.spec.ts` — open .xml file, run Format Document, assert reformatted content

**Modified files:**
- `agent/src/lsp/routes.rs` — accept `?scratch=1` on the WS endpoint and route to `LspSession::spawn_scratch`
- `agent/src/lsp/session.rs` — implement `spawn_scratch`; on disconnect, clean up scratch dir; on agent start, sweep stale scratch dirs (>24h old)
- `frontend/src/lsp/useLspClient.ts` — when called without a workspace, open WS with `?scratch=1` and pass current file content via `textDocument/didOpen` only (no workspace folder)
- `frontend/src/lsp/useLspClient.ts` — when plugin's `unavailableInEnterprise` is true and current mode is enterprise, render `EnterpriseUnavailableBanner` instead of attempting connection
- `frontend/src/components/DocumentTabEditor.tsx` — wire `useLspClient(language)` (no workspace; loose-file mode) for future-proofing
- `frontend/src/components/MonacoCopilotWidget.tsx` — verify it still works with LSP active (no regression test)

---

## Tasks (to be detailed before execution)

### Task 1: Implement `LspSession::spawn_scratch` — UUID temp dir under `{dataDir}/lsp/scratch/`, file written into it, workspace = scratch dir
### Task 2: Implement scratch-dir cleanup on disconnect (RAII guard pattern)
### Task 3: Implement scratch-dir startup sweep (>24h old directories deleted)
### Task 4: Update `useLspClient` to call `?scratch=1` when no workspace is passed; verify diagnostics still arrive in loose-file mode
### Task 5: Build `EnterpriseUnavailableBanner` — render conditions, "Don't show again" persistence
### Task 6: Update `useLspClient` to short-circuit in Enterprise mode for plugins flagged `unavailableInEnterprise`
### Task 7: Add Playwright E2E for the install banner (mock the download endpoint with a fixture binary)
### Task 8: Add Playwright E2E for the custom-plugin flow (point at the fake LSP fixture from Phase 2)
### Task 9: Add Playwright E2E for YANG highlighting (open .yang, assert token classes via Monaco's DOM)
### Task 10: Add Playwright E2E for XML format (open .xml, run Shift+Alt+F, assert reformatted DOM)
### Task 11: Verify Cmd+I (AI editing) still coexists with LSP — no regression in `useMonacoCopilot.ts`
### Task 12: Manual smoke test in Enterprise mode: open .py, confirm Enterprise banner shows, no agent calls made

---

## Done criteria

- Opening a `.py` file in `DocumentTabEditor` (no workspace) connects in loose-file mode and gets single-file diagnostics.
- Scratch dirs are cleaned up on session end; orphaned scratch dirs from a previous crashed run are swept on agent startup.
- Enterprise users see a clean "Python LSP isn't available in Enterprise Mode yet" banner and no download attempts happen.
- All four E2E specs pass.
- Cmd+I AI editing continues to work alongside LSP — no regressions.

---

**Flesh out this plan before execution by adding full step-by-step content to each task.**
