# NetStacks Terminal - Full Codebase Audit Report
**Date:** 2025-05-15
**Scope:** Frontend (React/TypeScript) + Backend (Rust/Axum) + Type alignment + API coverage

---

## CRITICAL - Fix Immediately

### C1. Unrestricted local file operations (RCE risk)
**Backend** `agent/src/api.rs:9282-9401`

`local_file_read`, `local_file_write`, `local_file_delete`, `local_file_rename`, `local_file_mkdir`, and `local_run_python` accept arbitrary filesystem paths with zero validation. Unlike `validate_log_path()` (confined to logs dir) and `validate_filepath()` in write_helpers.rs (blocks sensitive paths), these handlers read/write/delete any file the process can access. `local_run_python` executes arbitrary Python code — a direct RCE primitive if the bearer token leaks.

### C2. CORS allows any origin
**Backend** `agent/src/main.rs:570-573`

```rust
let cors = CorsLayer::new()
    .allow_origin(tower_http::cors::Any)
    .allow_methods(tower_http::cors::Any)
    .allow_headers(tower_http::cors::Any);
```

Any website in the user's browser can make cross-origin requests to `https://127.0.0.1:8080`. Combined with bearer token auth, this removes the browser's same-origin defense. Should restrict to Tauri's origin or localhost only.

### C3. CliFlavor serialization mismatch — `cisco-ios-xr` vs `cisco-xr`
**Backend** `agent/src/models.rs:189` — `CiscoIosXr` serializes as `"cisco-ios-xr"` via `rename_all = "kebab-case"`
**Frontend** `frontend/src/types/enrichment.ts:13` — uses `'cisco-xr'`

Devices detected as Cisco IOS-XR will fail to match any valid TypeScript union member. Commands sent with `"cisco-xr"` from the frontend will fail Rust deserialization. **Runtime failure for IOS-XR devices.**

### C4. MopExecutionDevice struct massively out of sync
**Backend** `agent/src/models.rs:2792-2805` — missing `device_id`, `credential_id`, `device_name`, `device_host`, `role`
**Frontend** `frontend/src/types/mop.ts:197-224` — has all these fields
**DB** `agent/src/db/schema.sql:537-542` — has all these columns

The Rust struct is significantly behind both the database schema and TypeScript types. Enterprise MOP execution will fail to serialize/deserialize correctly.

### C5. MopExecution.plan_revision missing from Rust model
**DB** `schema.sql:509` — `plan_revision INTEGER NOT NULL DEFAULT 1` exists
**Frontend** `types/mop.ts:119` — `plan_revision: number` (required)
**Backend** `models.rs` — field does not exist in `MopExecution` struct

Field will never be serialized from the backend, breaking frontend expectations.

### C6. TCP listener panics if port is taken
**Backend** `agent/src/main.rs:521`

```rust
let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
```

If port 8080 is already in use (eviction failed or race), the entire process panics with no user-facing error.

---

## MAJOR - Should Fix

### M1. TLS verification disabled unconditionally for all external connections
**Backend** `api.rs` (10+ locations), `discovery/integration_lookup.rs:54`, `ai/oauth2.rs:100`

`danger_accept_invalid_certs(true)` is hardcoded for all NetBox, LibreNMS, Netdisco, and OAuth2 connections. Should be per-source configurable (a `verify_ssl` boolean already exists on API resources in `quick_actions.rs:117`).

### M2. WebSocket code panics on serialization (15 instances)
**Backend** `agent/src/ws.rs`

~15 instances of `serde_json::to_string(...).unwrap()`. While unlikely to fail with these structs, production WebSocket code should not panic — use `.unwrap_or_else()` to degrade gracefully.

### M3. `std::sync::Mutex` poison panics
**Backend** `agent/src/tracked_router.rs:40,54,81,89`

Four `.lock().unwrap()` calls on a std Mutex. If any panic occurs while the lock is held, every subsequent access panics. Use `parking_lot::Mutex` or `.lock().unwrap_or_else(|e| e.into_inner())`.

### M4. ChangeStatus enum missing enterprise variants
**Backend** `models.rs:1415-1423` — 6 variants
**Frontend** `types/change.ts:3-13` — 9 variants (adds `pending_review`, `approved`, `rejected`)

Enterprise MOP statuses cannot be parsed by the local agent.

### M5. MopStepType missing `api_action` in TypeScript
**Backend** `models.rs:2881-2887` — has `ApiAction` variant
**Frontend** `types/change.ts:15` — only `pre_check | change | post_check | rollback`

Backend can produce step types the frontend cannot type-check.

### M6. MopExecution.plan_id optionality mismatch
**Backend** `models.rs:2663` — `plan_id: Option<String>`
**Frontend** `types/mop.ts:118` — `plan_id: string` (required)

Rust can send `null`, TypeScript expects non-null.

### M7. Session `legacy_ssh`/`protocol` missing from DB schema
Both Rust model and TypeScript have these fields, but the base `sessions` table schema does not have these columns. Relying on undocumented migrations.

### M8. Tauri environment detection inconsistency
**Frontend** uses two different property names:
- `'__TAURI__' in window` (v1 bridge) — `useMenuEvents.ts:11`, `appConfig.ts:54`
- `'__TAURI_INTERNALS__' in window` (v2) — `authStore.ts:39,77`, `SettingsConnection.tsx:130`

If the app is on Tauri v2, the `__TAURI__` checks silently return false.

### M9. `useBackgroundAIAgent` effects re-fire on every render
**Frontend** `hooks/useBackgroundAIAgent.ts:122,135`

`onComplete` and `onProgress` from options used in `useEffect` dependency arrays. If callers pass inline arrow functions, effects re-fire every render, potentially calling `onComplete` in a loop.

### M10. `useAiPilot` AbortController ref never passed to API calls
**Frontend** `hooks/useAiPilot.ts:146`

AbortController created and `abort()` called in `deactivate()`, but `sendChatMessage()` calls at lines 216, 279, 376 never receive the signal. Deactivating mid-flight won't cancel requests.

### M11. Module-level mutable `toolNameMap` — memory leak + collision risk
**Frontend** `hooks/useAIAgent.ts:328`

Module-level `Map` accumulates entries across all hook instances, never cleared. If two instances register MCP tools that produce the same 64-char truncated name, the second silently overwrites the first.

### M12. Unsafe JSON.parse of AI responses without validation
**Frontend** `hooks/useAiPilot.ts:218,281,378` and `hooks/useNextStepSuggestions.ts:110`

`JSON.parse(response)` output used directly with property access. If AI returns valid JSON with wrong structure, properties silently become `undefined` and propagate through the system.

### M13. `useNextStepSuggestions` state update after unmount
**Frontend** `hooks/useNextStepSuggestions.ts:62-126`

`setTimeout` with async callback calls `sendChatMessage`. No cleanup on unmount, no AbortController. `setSuggestions` and `setLoading` called on unmounted component.

### M14. Enterprise JSON config detection is fragile
**Backend** `main.rs:109-123`

String-contains check `content.contains("\"controllerUrl\":null")` breaks with whitespace variations. Should use `serde_json::from_str::<Value>` and check the parsed value.

---

## MODERATE - Should Address

### D1. AiProviderType defined identically in 4 files
`'anthropic' | 'openai' | 'ollama' | 'openrouter' | 'litellm' | 'custom'` in:
- `api/ai.ts:11`
- `hooks/useSettings.ts:4`
- `hooks/useAIAgent.ts:220`
- `contexts/TokenUsageContext.tsx:11`

### D2. AI provider initialization logic copy-pasted across 3 chat components
Nearly identical 40-line blocks in `AIInlineChat.tsx:62-99`, `AIFloatingChat.tsx:75-115`, `AIInlinePopup.tsx:77-107`. Extract to `useAIProviderInit()` hook.

### D3. `AvailableSession` interface defined in 3 files
Same `{ id: string; name: string; connected: boolean; cliFlavor?: string }` in all three AI chat components.

### D4. Escape-key + click-outside dismiss pattern repeated 3 times
`DeviceDetailsOverlay.tsx:157-186`, `ConnectionDetailsOverlay.tsx:77-107`, `InterfaceSnmpQuickLook.tsx:229-250`. Extract to `useOverlayDismiss()` hook.

### D5. Error message extraction repeated 309+ times
`err instanceof Error ? err.message : 'fallback'` everywhere. Create `getErrorMessage()` utility.

### D6. Duplicate `SessionConfigRow` struct in Rust
Identical struct + SQL in both `tasks/tools/ssh_command.rs:61-72` and `tasks/tools/write_helpers.rs:26-37`.

### D7. Duplicate `SshAuth`/`SftpAuth` enums
`sftp.rs:63-72` is a copy-paste of `ssh/mod.rs:62-69`. SFTP should reuse `SshAuth`.

### D8. `reqwest::Client::builder().danger_accept_invalid_certs(true)` repeated 10 times
All NetBox/LibreNMS proxy endpoints in `api.rs`. Extract to helper function.

### D9. Mixed error reporting: `showToast()` vs `alert()` vs `setError`
`alert()` used in 7+ locations (`App.tsx`, `IntegrationsTab.tsx`, `TopologyTabEditor.tsx`, etc.) — blocks UI, inconsistent with toast-based UX.

### D10. Mixed ID generation: `crypto.randomUUID()` vs `Date.now()-Math.random()`
Collision-prone `Date.now()-Math.random()` used in `topologyHistory.ts`, `Toast.tsx`, `TopologyTabEditor.tsx`, `useTroubleshootingSession.ts`, `useTopologyAICallbacks.ts`.

### D11. `useSettings` hook vs `getSettings()` singleton inconsistency
Non-reactive `getSettings()` used in `useAIAgent.ts` (6 calls), meaning AI settings changes (disabled tools, max messages) won't take effect until remount.

### D12. No shared date formatting utility
86 inline `toLocaleString` calls with varying format options. Two local `formatDate` helpers defined in `MyCredentialsTab.tsx` and `BackupHistoryTab.tsx`.

### D13. Path separator detection duplicated 6 times
`const sep = rootPath.includes('/') ? '/' : '\\'` in workspace files.

### D14. SFTP fake progress simulation duplicated
`Math.min(t.progress + Math.random() * 15, 95)` in both `SftpFileBrowser.tsx` and `SftpPanel.tsx`.

### D15. 10+ `eslint-disable-next-line react-hooks/exhaustive-deps` suppressions
Each potentially masks real stale closure bugs: `AISidePanel.tsx:214`, `Terminal.tsx:2654`, `DeviceDetailTab.tsx:921`, `SharedTerminal.tsx:176`, `SftpPanel.tsx:304`, `TopologyTabEditor.tsx:653`, `NetworkScene.tsx:114`, `LinkDetailTab.tsx:957`.

---

## MINOR - Cleanup When Convenient

### N1. ~103 potentially unused API client functions
Large number of exported functions in `src/api/` never imported outside the API layer. Notable: `getSessionTopology`, `importTopologyFromNetBox`, `exportAll`, `snmpInterfaceStats`, `stopAllTunnels`, `testAiConnection`, etc.

### N2. ~29 underscore-prefixed dead functions in Rust backend
Various `_new()`, `_close()`, `_has_session()`, etc. across models.rs, sftp.rs, cert_manager.rs, ssh/mod.rs, ws.rs, tasks/, discovery/, mcp/.

### N3. 16 `#[allow(dead_code)]` annotations in Rust
Including `tunnels/mod.rs:9` which annotates an entire `health` module as dead.

### N4. `src/api/config.ts` is a dead placeholder
Contains only a comment: "This file is kept as a placeholder and can be deleted in a future cleanup."

### N5. `src/api/agent.ts` has no API calls
Only defines types and pure utility functions — no HTTP calls despite being in the API layer.

### N6. Windows platform support incomplete
- `main.rs:197` — TODO: Windows process eviction is empty
- `main.rs:252` — TODO: Windows parent-death watcher is empty

### N7. `unsafe impl Send + Sync for TerminalManager`
`terminal.rs:538-539` — manual unsafe impl is fragile; if internal structure changes, compiler won't catch it.

### N8. Regex compiled on every call
`scripts.rs:348-349,1160` — `Regex::new(...)` called per invocation instead of using `OnceLock`/`LazyLock`.

### N9. Silently ignored SQL errors at startup
`main.rs:476-491` — `let _ = sqlx::query(...).execute(...)` silently drops MCP tool upsert errors.

### N10. `utf8_decoder.rs:61` — `is_some() + unwrap()` anti-pattern
Should use `if let Some(exp) = expected` instead.

### N11. Empty catch blocks in frontend (15+ locations)
Most concerning: `MyCredentialsTab.tsx` (6 empty catches for CRUD), `useWorkspace.ts` (5 empty catches including silent `writeFile` failure), `tunnelStore.ts:92` (poll errors silently ignored).

### N12. `ConnectionHistory` bytes_sent/bytes_received in DB but never surfaced
DB has `bytes_sent`, `bytes_received` columns. Neither Rust model nor TypeScript includes them.

### N13. Folder `scope` field — backend sends it, frontend ignores it
Rust `Folder` has `scope: String`, TypeScript `Folder` does not have `scope`.

### N14. Pact contract tests are stale
Only 2 pact tests exist (auth, capabilities) — both for enterprise controller, not local agent. Auth pact uses `email` but TypeScript type uses `username`. Response shapes don't match current types.

### N15. 20+ `as any` type assertions in frontend
Most problematic: `App.tsx:4791` `(session as any).profile_id`, `InstanceDetailTab.tsx` (4 casts on `deployment_procedure`), `MopDevicesTab.tsx:266-267` `(device as any).name`.

### N16. Hardcoded fallback org_id
`useResourceList.ts:21` — `'00000000-0000-0000-0000-000000000000'` as fallback. Could silently scope to wrong org.

---

## Summary Statistics

| Category | Count |
|---|---|
| Backend API endpoints | ~280 |
| Registered TODOs (backend) | 2 |
| Registered TODOs (frontend) | 2 |
| Dead/unused Rust functions | ~45 (29 underscore + 16 allow(dead_code)) |
| Potentially unused frontend API functions | ~103 |
| Type mismatches (Rust vs TypeScript) | 12 |
| DB schema vs model mismatches | 7 |
| Critical issues | 6 |
| Major issues | 14 |
| Moderate issues | 15 |
| Minor issues | 16 |
