# Phase 5: Settings UI for LSP Plugin CRUD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** SKELETON — task headings only. Flesh out before execution.

**Goal:** Add a full-CRUD "Language Features" sub-tab to the existing Workspaces settings panel: list built-in + user-added plugins, install/uninstall built-ins, set custom command overrides, add/edit/delete user-defined plugins, and verify candidate commands with a "Test connection" button.

**Architecture:** New `LanguageFeaturesTab.tsx` rendered inside the existing Workspaces settings container. Single table view auto-generated from the plugin descriptor list returned by `GET /lsp/plugins`. Each row delegates to `LspPluginRow.tsx` which handles built-in vs user-added affordances. `AddCustomPluginDialog.tsx` is a modal form with a "Test connection" button that calls `POST /lsp/plugins/test`. User-added plugins persist to the SQLite table created in Phase 2 migration; CRUD goes through the new REST endpoints. Custom command overrides on built-ins also persist via the same `PUT /lsp/plugins/{id}` endpoint.

**Tech Stack:** React, TypeScript, existing settings panel components, existing axios client.

---

## Phase Map (for context — this plan is Phase 5 only)

- Phase 1: Client-Side Language Features
- Phase 2: Agent LSP Foundation
- Phase 3: Frontend LSP Client
- Phase 4: Pyrefly Plugin
- **Phase 5: Settings UI** ← you are here
- Phase 6: Polish (loose-file mode, Enterprise banner, E2E)

---

## File Structure (planned)

**New files:**
- `frontend/src/components/settings/LanguageFeaturesTab.tsx` — sub-tab container, fetches plugin list
- `frontend/src/components/settings/LspPluginRow.tsx` — one row per plugin (built-in or user-added)
- `frontend/src/components/settings/AddCustomPluginDialog.tsx` — Add/Edit form modal
- `frontend/src/components/settings/__tests__/LspPluginRow.test.tsx` — row state tests (built-in actions vs user-added)
- `frontend/src/components/settings/__tests__/AddCustomPluginDialog.test.tsx` — form validation + Test connection flow

**Modified files:**
- `agent/src/lsp/routes.rs` — add `POST /lsp/plugins` (create user-added), `PUT /lsp/plugins/{id}` (update — built-in: override only, user-added: full), `POST /lsp/plugins/test` (spawn candidate command, send `initialize`, return success/stderr)
- `agent/src/lsp/host.rs` — CRUD methods for user-added plugins backed by SQLite
- `frontend/src/lsp/installationApi.ts` — add `createUserPlugin`, `updatePlugin`, `deletePlugin`, `testPluginCommand`
- `frontend/src/components/settings/SettingsPanel.tsx` (or the existing Workspaces tab container) — add the new sub-tab

---

## Tasks (to be detailed before execution)

### Task 1: Add `POST /lsp/plugins/test` to the agent — spawns candidate command, sends LSP `initialize`, times out at 5s, returns `{success, errorMessage?, stderr?}`
### Task 2: Add `POST /lsp/plugins` (create user-added) + persist to SQLite (mutex for concurrent writes)
### Task 3: Add `PUT /lsp/plugins/{id}` — for built-in: writes only the override fields to a separate `lsp_plugin_overrides` table; for user-added: updates the row
### Task 4: Add `DELETE /lsp/plugins/{id}` semantics for user-added (full removal, distinct from uninstall built-in binary from Phase 4)
### Task 5: Add `createUserPlugin`, `updatePlugin`, `deletePlugin`, `testPluginCommand` to `installationApi.ts`
### Task 6: Build `LspPluginRow.tsx` — renders status, Install/Uninstall/Edit/Delete buttons based on `source` and `installStatus`
### Task 7: Build `AddCustomPluginDialog.tsx` — form with display name, language autocomplete (monaco.languages.getLanguages()), extensions, command, args, env vars; Test connection button shows result inline; Save disabled until Test passes
### Task 8: Build `LanguageFeaturesTab.tsx` — fetches `GET /lsp/plugins`, renders sorted list (built-ins first), Add button at bottom
### Task 9: Wire the new tab into the existing Workspaces settings container
### Task 10: Built-in plugin version-skew UI — when descriptor's pinned version > installed version, render an "Update Pyrefly v1.0.0 → v1.1.0" button on the row; clicking it triggers reinstall against the new pinned URL/SHA
### Task 11: E2E test: add a custom plugin (point at a known-good fake LSP from Phase 2's fixture), verify it appears in the list and the agent picks it up on next session

---

## Done criteria

- A user can open `Settings → Workspaces → Language Features` and see Pyrefly listed (built-in, status reflects current install state).
- Clicking "+ Add Language Server" lets the user enter a custom plugin, test it, and save. The new plugin survives an agent restart.
- Editing a built-in's custom command override actually changes which command the next session spawns.
- Uninstalling Pyrefly from this tab does the same thing as the banner's "Uninstall" — sessions tear down, binary deleted, status returns to `Not installed`.
- Deleting a user-added plugin removes it from the DB and the list.

---

**Flesh out this plan before execution by adding full step-by-step content to each task.**
