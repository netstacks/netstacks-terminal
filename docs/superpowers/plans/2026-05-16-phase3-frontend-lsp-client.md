# Phase 3: Frontend LSP Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** SKELETON — task headings only. Flesh out before execution.

**Goal:** Wire `monaco-languageclient` into the frontend behind a generic `useLspClient(language, workspace?)` hook, mirrored to the agent's plugin registry from Phase 2. Make every Monaco editor LSP-capable with a single hook call — no editor-specific code.

**Architecture:** New `frontend/src/lsp/` module. `plugins.ts` holds the built-in plugin registry (mirrors `agent/src/lsp/plugins.rs`). `useLspClient.ts` is a React hook: on mount it looks up the plugin by Monaco language id, queries `/lsp/plugins` for install status, opens a WebSocket to `/lsp/{id}?workspace=…` (or `?scratch=1` for loose-file mode), and constructs a `MonacoLanguageClient` wired to that WS. Reconnects on disconnect. `installationApi.ts` is a thin axios wrapper over the REST endpoints, returning typed promises.

**Tech Stack:** TypeScript, `monaco-languageclient` (new dependency), `vscode-jsonrpc` + `vscode-languageclient` (transitive), existing axios client, existing `@monaco-editor/react` and `monaco-editor`.

---

## Phase Map (for context — this plan is Phase 3 only)

- Phase 1: Client-Side Language Features (YANG + XML format)
- Phase 2: Agent LSP Foundation
- **Phase 3: Frontend LSP Client** ← you are here
- Phase 4: Pyrefly Plugin (on-demand download + first-run banner)
- Phase 5: Settings UI (full CRUD for LSP plugins)
- Phase 6: Polish (loose-file mode, Enterprise banner, E2E)

---

## File Structure (planned)

**New files:**
- `frontend/src/lsp/types.ts` — TS types mirroring `agent/src/lsp/types.rs` (LspPlugin, InstallStatus, etc.)
- `frontend/src/lsp/plugins.ts` — built-in plugin registry (empty in Phase 3; Pyrefly added in Phase 4)
- `frontend/src/lsp/installationApi.ts` — axios wrapper over `/lsp/plugins` REST
- `frontend/src/lsp/useLspClient.ts` — the React hook
- `frontend/src/lsp/__tests__/installationApi.test.ts` — axios mock tests
- `frontend/src/lsp/__tests__/plugins.test.ts` — registry merge tests (mock fetch for user-added entries)

**Modified files:**
- `frontend/package.json` — add `monaco-languageclient`, `vscode-jsonrpc`, `vscode-languageserver-protocol`
- `frontend/src/components/workspace/WorkspaceCodeEditor.tsx` — call `useLspClient(language, workspacePath)` in `onMount`
- `frontend/src/components/ScriptEditor.tsx` — call `useLspClient('python', scriptsDir)` in `onMount`

---

## Tasks (to be detailed before execution)

### Task 1: Add `monaco-languageclient` (and its peer deps) — find the version compatible with `monaco-editor@0.55.1`
### Task 2: Create TS plugin descriptor types (mirror Rust shape from Phase 2)
### Task 3: Create empty built-in plugin registry + fetch-and-merge with user-added from the agent
### Task 4: Write the `installationApi.ts` axios wrapper with typed responses
### Task 5: Implement `useLspClient(language, workspace?)` hook — opens WS, wires MonacoLanguageClient
### Task 6: Add auto-reconnect on WS close (1s backoff, max 5 attempts)
### Task 7: Wire the hook into `WorkspaceCodeEditor.tsx` (passes the workspace path)
### Task 8: Wire the hook into `ScriptEditor.tsx` (passes the scripts dir as workspace)
### Task 9: Manual smoke test with the Phase 2 fake LSP fixture — confirm `initialize` round-trip happens in the browser
### Task 10: Add vitest coverage for hook lifecycle (mount → connect → unmount → disconnect)

---

## Done criteria

- The hook compiles and type-checks against `monaco-editor@0.55.1`.
- With Phase 2's fake-LSP plugin registered as a built-in (for testing), opening a matching file extension in `WorkspaceCodeEditor` triggers a WS connection and an `initialize` request lands in the agent.
- WS disconnects auto-reconnect with backoff; LSP `didOpen` is replayed for open documents.
- Tests pass: `npx vitest run src/lsp/`.
- No production behavior change for users who don't yet have any LSP plugins installed (Pyrefly arrives in Phase 4).

---

**Flesh out this plan before execution by adding full step-by-step content to each task.** Reference Phase 1 as the granularity model.
