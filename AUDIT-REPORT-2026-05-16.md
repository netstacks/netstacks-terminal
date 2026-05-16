# NetStacks Terminal — Full Vibe-Code Audit
**Date:** 2026-05-16
**Scope:** Frontend HTTP calls vs backend Axum routes, Rust↔TypeScript type contracts, frontend & backend vibe-coded bug hunt, status check on 2025-05-15 audit findings
**Method:** 5 parallel read-only audit agents over 413 .ts/.tsx and 91 .rs files; 208 commits since prior audit

---

## CRITICAL — Fix Immediately

### C1. `RemoteGitOps.run()` is permanently 404 — every remote git op broken
**Frontend** `frontend/src/lib/gitOps.ts:178`

Posts to `'/api/ai-ssh-execute'`. The axios baseURL already ends in `/api`, so this resolves to `/api/api/ai-ssh-execute`. The correct route is `POST /api/ai/ssh-execute` (`agent/src/main.rs:1118`). Path is also missing the `/` between `ai` and `ssh-execute`. `RemoteGitOps` is constructed from `frontend/src/hooks/useWorkspace.ts:214` whenever a remote workspace opens — status, diff, log, blame, commit all 404.

Fix: `'/ai/ssh-execute'`.

### C2. `local_dir_list` and `local_file_exists` skip path validator
**Backend** `agent/src/api.rs:9440-9478` and `9540-9545`

Every sibling local-fs handler (`local_file_read`, `local_file_write`, `local_file_mkdir`, etc.) calls `validate_local_path(&req.path)?` before touching disk. These two forgot. With the bearer token, an attacker can `POST /api/local/list-dir {"path":"/etc"}` to enumerate any directory, or `POST /api/local/file-exists` as a sensitive-file oracle against `~/.ssh/id_rsa`, `/etc/shadow`, etc. This defeats the entire deny-list put in place last audit (C1 in 2025-05).

### C3. `validate_local_path` is TOCTOU-vulnerable — callers discard the canonical PathBuf
**Backend** `agent/src/api.rs:9410, 9427, 9488, 9505, 9526-9527, 9556`

Every consumer is `validate_local_path(&req.path)?; tokio::fs::write(&req.path, ...)`. The validator returns the canonicalised `PathBuf` (line 9399) but callers throw it away and re-use the raw user-supplied string. Symlink swap between validate and write bypasses the deny list. Use the returned `PathBuf`.

### C4. SNMP-via-jump-host silently broken across all SNMP endpoints
**Backend** `agent/src/api.rs:7133-7181, 7444-7467` — `SnmpJumpRef` declared `#[serde(rename_all = "camelCase")]`, flattened into request bodies; expects `jumpHostId` / `jumpSessionId`.
**Frontend** `frontend/src/api/snmp.ts:160,189,216,253,282` — sends `jump_host_id` / `jump_session_id` (snake_case).

Serde silently deserializes both as `None`. Backend runs the SNMP query *without* the bastion hop — fails to reach the device, or worse hits a colliding host on the local network. Sibling fields (`profileId`, `rootOid`) are correctly camelCased, so this is a partial-migration vibe bug. Affects 5 endpoints.

### C5. AI AbortControllers are decorative — fetches keep running after abort
**Frontend** `frontend/src/hooks/useAITabComplete.ts:73`, `useAiPilot.ts:213,279,382`, `components/AITabInput.tsx:77`

Five AI features create `AbortController`s, store them in refs, and check `signal.aborted` after the await — but never pass `signal` to `sendChatMessage`. `frontend/src/api/ai.ts:458` doesn't accept a signal at all. Fast typing / tab-switching stacks N concurrent provider calls (tokens billed, rate limits hit). The "cancel" only suppresses the handler.

This is the unfixed remainder of M10 from the 2025-05 audit, now broader than just `useAiPilot`.

### C6. `window.confirm` / `alert` used despite acknowledged Tauri incompatibility
**Frontend** `frontend/src/App.tsx:2442`

Line 2447 has the comment *"Skipping unsaved changes warning since confirm dialogs don't work in Tauri"* — but `window.confirm` runs five lines above (2442). Plus 24 more `alert`/`confirm` calls throughout `App.tsx`, `PluginPanel.tsx`, `SftpEditorTab.tsx`, `VaultSettings.tsx`, `AIEngineerSettingsTab.tsx`, `IntegrationsTab.tsx`, `SettingsTunnels.tsx`. In Tauri WebView these block the renderer thread or silently no-op.

### C7. SFTP progress intervals leak on every failed transfer
**Frontend** `frontend/src/components/SftpFileBrowser.tsx:258,347` and `SftpPanel.tsx:329,412`

`progressInterval = setInterval(...)` opens inside `try`; `clearInterval()` lives only on the happy path. Any thrown error leaves the interval running forever doing `setTransfers(...)` 5×/sec. Two files, four leak sites. Same files (lines 274, 340) also read `transfers.find(...)` from a stale closure, so the cancel button never actually cancels in-flight transfers.

### C8. `updateConnection()` PUT — backend only registered DELETE
**Frontend** `frontend/src/api/topology.ts:260` — `PUT /topologies/:id/connections/:conn_id`
**Backend** `agent/src/main.rs:899` — `delete(api::delete_topology_connection)` only

Called by the AI topology tool `updateConnection` (`frontend/src/hooks/useTopologyAICallbacks.ts:419`). Every time the assistant tries to change a connection's waypoints, label, color, or line style in a saved topology, it 405s. AI-driven edits silently fail.

### C9. Vault `std::sync::Mutex` panics permanently brick credential unlock
**Backend** `agent/src/providers/local.rs:54,1148,1159,1175-1187,1869,1931,1977,1987-1997`

Vault unlock counter, master vault RwLock, master salt RwLock — all `std::sync::Mutex/RwLock` with `.lock().unwrap()` / `.read().unwrap()` / `.write().unwrap()`. A panic anywhere holding these poisons them; subsequent vault operations panic the request thread. Combined with the AUDIT-FIX cooldown logic that *also* lives behind these locks, one panic permanently kills the vault until restart.

Use `parking_lot::Mutex` (no poison) or `tokio::sync::Mutex`.

### C10. SSE Python child processes never killed on client disconnect — fork-bomb on `while True: pass`
**Backend** `agent/src/scripts.rs:1317-1431`, `agent/src/api.rs:9566-9648`

`tokio::spawn` reads from `child.stdout` and `tx.send(...).await`. When the SSE client disconnects, `tx.send` returns `Err(_)` (channel closed); the `let _ =` swallows it. The reader task keeps reading, the child keeps running until it self-terminates. A user who clicks "run script" and closes the browser tab leaves the `uv`-spawned Python running indefinitely. Pathological scripts run forever per disconnect.

Fix: wrap the read loop in `select!` against a cancel token that calls `child.kill()`.

---

## MAJOR — Should Fix

### M1. Hardcoded `danger_accept_invalid_certs(true)` — still 17 sites (carried from 2025-05 M1)
**Backend** `agent/src/api.rs:1443,1494,1706,1748,1790,1832,1874,1916,2060,2157`, `main.rs:146`, `discovery/integration_lookup.rs:54`, `ai/oauth2.rs:100`, `ai/providers.rs:432,1198,1232,1256`

Every NetBox proxy handler, both AI provider clients (Anthropic and OpenAI-compat), the OAuth2 token endpoint, and integration lookups all unconditionally bypass TLS. `quick_actions.rs:117` is the only call that honors a per-resource `verify_ssl` flag. Worse: in `api.rs`, when `.build()` fails, the fallback `reqwest::Client::new()` **flips TLS verification back on silently** — a security toggle that flips on the error path.

### M2. NetBox `/netbox-sources/:id/devices*` endpoints don't exist
**Frontend** `frontend/src/components/CollectionDialog.tsx:519` — `GET /netbox-sources/${source.id}/devices`
**Frontend** `frontend/src/App.tsx:5023` — `GET /netbox-sources/${sourceId}/devices/${deviceId}/neighbors` (Phase 22 AI discovery)

Neither route is registered. NetBox device fetches are exposed only as `POST /api/netbox/proxy/devices`. Both paths are reachable in Personal Mode. Will 404.

### M3. WS auth uses non-constant-time `==`
**Backend** `agent/src/ws.rs:90, 1164, 1600`

HTTP `auth_middleware` (`api.rs:135`) was specifically migrated to `subtle::ConstantTimeEq` (the AUDIT-FIX comment is right there). The three WebSocket handlers — `terminal_ws`, `topology_live_ws`, `task_progress_ws` — compare the same token with plain `==`. 256-bit token makes timing-attack impractical, but inconsistency is a vibe-pattern tell.

### M4. NetBox proxy pagination has no max-page cap
**Backend** `agent/src/api.rs:2122-2126`

Pagination loop accumulates pages into `Vec<NetBoxDevice>` with no bound. A misconfigured or malicious NetBox returning a huge `count` and a working `next` chain will eat memory until OOM. Add a max-pages cap.

### M5. `evict_existing_agent_if_present` fingerprints by `/api/health` 200 — can SIGKILL the wrong process
**Backend** `agent/src/main.rs:175-192, 207-219`

Shells out to `lsof`, parses PIDs, probes `https://127.0.0.1:8080/api/health`, and SIGKILLs whatever responded 200. Any other local service whose `/api/health` returns 200 — a debug server, another axum app — would be killed. Use a netstacks-specific handshake.

### M6. UpdateMopExecution silently drops 5 fields the UI sets
**Frontend** `frontend/src/types/mop.ts:173-189` exposes `on_failure`, `ai_autonomy_level`, `pause_after_pre_checks`, `pause_after_changes`, `pause_after_post_checks`
**Backend** `agent/src/models.rs:2729-2741` — these five fields are missing from `UpdateMopExecution`

Every PATCH from the UI to toggle pause-after-phase or AI autonomy mode is silently discarded by serde. No error to the user.

### M7. Tasks `failure_policy` is never read — Rust field has leading underscore
**Backend** `agent/src/tasks/models.rs:90-94` — `pub _failure_policy: Option<serde_json::Value>`
**Frontend** `frontend/src/types/tasks.ts:36-40` sends `failure_policy`

Serde uses the Rust field name verbatim, so the wire key the backend expects is literally `_failure_policy`. Frontend sends `failure_policy`. Per-task failure policy is silently dropped on every create.

### M8. `MopExecutionDevice.device_name`/`device_host` optional in Rust, required in TS
**Backend** `agent/src/models.rs:2807-2832` — both `Option<String>` with `skip_serializing_if = "Option::is_none"`
**Frontend** `frontend/src/types/mop.ts:208-209` — both required `string`

`device.device_name.toLowerCase()` throws `TypeError` whenever a row exists without a denormalized name (e.g. enterprise device-only rows where `session_id` is null).

### M9. `MopExecution.devices`/`steps` joined fields never produced by backend
**Frontend** `frontend/src/types/mop.ts:151, 223` — declared with comment "Joined data (when fetched with devices)"
**Backend** `agent/src/models.rs:2672-2697, 2807-2832` — no such fields exist

Any code doing `execution.devices?.length` always reads 0, masking real data.

### M10. Hardcoded all-zero org_id fallback fires API calls against garbage
**Frontend** `frontend/src/hooks/useResourceList.ts:21`

```ts
const orgId = user?.org_id || '00000000-0000-0000-0000-000000000000';
```

Hook fires `fetchFn(orgId)` from `useEffect` before auth hydrates. Every consumer of `useResourceList` sends a request with the all-zero UUID — either 404s or returns wrong-org data depending on backend semantics.

### M11. Sensitive auth material logged to console
**Frontend** `frontend/src/hooks/useEnterpriseSSH.ts:315` — `console.log('[useEnterpriseSSH] Reconnect token received:', token)` prints the full token
**Frontend** `frontend/src/main.tsx:71,89` — sidecar auth token logged on retrieval
**Frontend** `frontend/src/main.tsx:209` — bootstrap error handler injects `error.message` into `innerHTML` unescaped (minor XSS if Tauri/backend ever returns HTML in an error)

### M12. Async `useEffect` with no cancellation — race conditions on rapid dep changes
**Frontend** `components/ProfilingAgentChat.tsx:43`, `components/AISettingsTab.tsx:379,540`, `components/AboutModal.tsx:22`, `components/workspace/WorkspaceHistoryEditor.tsx:28`, `components/mop/DeviceSelector.tsx:60`, `components/UpdateChecker.tsx:36`, `components/SftpFileBrowser.tsx:127`

Pattern: `useEffect(() => { const load = async () => {...}; load(); }, [...])` with `setState` after await and no mount/abort guard. Rapid dep changes let older fetches resolve after newer ones, clobbering correct state.

### M13. `useEffect` exhaustive-deps suppressions hide stale closures (15 sites)
**Frontend** `components/EnterpriseSessionPanel.tsx:180` (refresh ignores `fetchData` changes), `AISidePanel.tsx:214` (overlay-size resize bug latent), `SharedTerminal.tsx:176`, `SftpPanel.tsx:304`, `TopologyTabEditor.tsx:653`, `hooks/useEnterpriseSSH.ts:408`, `hooks/useWorkspace.ts:242,334`, `Terminal.tsx:2654`

At least 7 of the 15 suppressions hide real stale-dep bugs.

### M14. Sync `std::sync::Mutex` in async OAuth2 + scattered call sites
**Backend** `agent/src/ai/oauth2.rs:126` — `.expect("OAuth2 registry mutex poisoned")` is honest but still tears down the request on panic. Same poison concern as C9 above.

### M15. `eprintln!("[DEBUG] ...")` left in production HTTP handlers
**Backend** `agent/src/api.rs:2096, 2128, 2137, 2167, 5711, 5771, 5777, 318`

Bypasses tracing, ignores `RUST_LOG`, leaks NetBox URLs / resource IDs to stderr regardless of log level. Eight sites, all in HTTP handlers. Should be `tracing::debug!`/`warn!`.

### M16. Header injection / panic in SFTP download response
**Backend** `agent/src/api.rs:3604-3617`

```rust
format!("attachment; filename=\"{}\"", filename).parse().unwrap()
```

`filename` is user-controlled (SFTP path basename). A `"`, `\r`, or `\n` in the filename either panics the request thread (DoS) or, if the parse accepts it, gets header injection. Use a `ContentDisposition` builder or percent-encode.

### M17. Polling without backoff or signal propagation
**Frontend** `hooks/useWorkspace.ts:252` (1 s `.netstacks/open-request.json` poll, no backoff on ENOENT), `api/scripts.ts:297` (script execution poll for 120 s, ignores unmount), `components/EnterpriseSessionPanel.tsx:189` (15 s poll, no 401 suppression), `hooks/useAIAgent.ts:2011` (3 s background-task poll, no AbortSignal)

User-impact: spinners hang for 2 minutes after navigation; persistent 401 loops on token expiry.

### M18. Unsafe `JSON.parse` of AI output without shape validation
**Frontend** `hooks/useAIAgent.ts:1786-1790` (4 strings, one shared catch — can't tell which failed), `hooks/useNextStepSuggestions.ts:127`, `components/mop/MopWorkspace.tsx:1367,1533,1603,1668,1782` (5 parses of AI JSON, none validate parsed shape)

Malformed AI output silently disappears with no telemetry. Suggestion UI just shows nothing.

### M19. `Promise.all` where partial failure should not lose siblings
**Frontend** `components/AISettingsTab.tsx:543` (one anthropic-vault error wipes openai/openrouter/custom display), `SessionPanel.tsx:351`, `EnterpriseSessionPanel.tsx:158`, `AISidePanel.tsx:552`, `QuickActionsPanel.tsx:91`

Single-leg failure shows generic "Failed to load X" even when N-1 requests succeeded. Use `Promise.allSettled`.

### M20. `key={index}` on editable / reorderable lists (10+ sites)
**Frontend** `components/NetBoxSourceDialog.tsx:750,813,888,960` (user-editable mapping rows), `SessionSettingsDialog.tsx:917`, `ProfileEditorDialog.tsx:678,749`, `AIEngineerSettingsTab.tsx:493` (auto-command & SNMP-community lists), `AISettingsTab.tsx:1998,2038,2095`, `SplitPaneContainer.tsx:146` (terminals!)

State tears on reorder/insert. `SplitPaneContainer` in particular: terminals re-mount when panes are re-keyed.

### M21. `as any` masking real type drift (21 sites)
Worst: `App.tsx:4842` `(session as any).profile_id` — property is sometimes absent on enterprise sessions, downstream silently gets `undefined`. Plus `components/config/InstanceDetailTab.tsx:627,628,1106-1108` (`deployment_procedure`), `mop/MopDevicesTab.tsx:266-267`, `mop/MopPlanTab.tsx:1153`, `mop/MopWorkspace.tsx:1948`, `lib/highlightEngine.ts:502-508` (mutating Monaco decoration options that don't exist on the type).

---

## MODERATE — Should Address

### D1. Sessions schema drift carried from 2025-05 (M7 still unfixed)
`agent/src/db/schema.sql:16-58` `sessions` CREATE TABLE still omits `legacy_ssh` and `protocol`. They're added only via runtime migrations in `agent/src/db/mod.rs:310-322`. A fresh install + concurrent older client = column-not-found errors.

### D2. NetBox `default_headers` / quick-action `headers` typed `Record<string,string>` but stored as `serde_json::Value`
**Backend** `agent/src/models.rs:2188, 2246`
**Frontend** `frontend/src/types/quickAction.ts:24, 67`

If anyone stores a numeric/boolean header value (which the backend won't reject), `Object.entries(headers).map(([k,v]) => v.toLowerCase())` blows up.

### D3. ExecutionStatus phantom `'completed'` value in TS
**Frontend** `frontend/src/types/mop.ts:19` lists `'complete' | 'completed'` — Rust (`agent/src/models.rs:2489-2497`) only produces `'complete'`. Code branching on `'completed'` is dead.

### D4. Backend silently drops 6 fields the frontend assumes round-trip
Catalog: `deploy_metadata` / `device_scope` / `device_ids` on MopStep (`frontend/src/types/change.ts:17-57`); `execution_defaults` / `linked_stack` on MopPackage (`frontend/src/types/mopPackage.ts:85-94`); `device_overrides` on MopPackageProcedure; `jump_password` / `jump_key_passphrase` on ProfileCredential.

### D5. 5 DB columns no longer represented in any Rust model
`sessions.username`, `sessions.auth_type`, `sessions.key_path`, `sessions.profile_overrides`, `mop_executions.ai_autonomy_level`, `connection_history.bytes_sent`/`bytes_received`. Inserts must still satisfy NOT NULL / CHECK constraints on the legacy columns; nobody reads them.

### D6. Mode-confusion latent: 8+ API clients call Controller-only endpoints without runtime guard
`api/incidents.ts`, `api/alerts.ts`, `api/profilingAgents.ts`, `api/enterpriseCredentials.ts`, `api/enterpriseDevices.ts`, `api/enterpriseSessions.ts`, `api/controllerMop.ts`, `api/sharing.ts`, `api/mopTestTerminal.ts`, `api/auth.ts`, `api/taskHistory.ts`, `api/configManagement.ts`, `api/aiEngineerProfile.ts` (lines 128/133/138).

All rely on UI gating in Terminal.tsx / page mounts. If gating ever breaks (or a new caller appears), they 404 against the local agent. Compare to `api/tasks.ts` and `api/agentDefinitions.ts` — the correct pattern.

### D7. Module-level `toolNameMap` collision risk (carryover from M11)
**Frontend** `frontend/src/hooks/useAIAgent.ts:328-350`

Now bounded to 1000 entries with `.clear()` when exceeded, but two hook instances registering MCP tools whose 64-char-truncated names collide will overwrite each other silently within the same 1000-entry window.

### D8. `tunnels` numeric fields use `u64` server-side, `number` in TS — bytes counters lose precision >2^53
**Backend** `agent/src/models.rs:1283-1291` — `bytes_tx: u64, bytes_rx: u64`
**Frontend** `frontend/src/api/tunnels.ts:31-39` — `number`

Theoretical for `uptime_secs` (285M years), realistic for `bytes_tx/rx` on a long-lived high-throughput tunnel (>9 PB cumulative).

### D9. `Tunnel.created_at` / `updated_at` are raw String (not `DateTime<Utc>`)
**Backend** `agent/src/models.rs:1206-1233`

Wire format leaks the SQLite default `"%Y-%m-%d %H:%M:%S"` (no timezone) instead of RFC3339. `new Date(s)` fails in Safari.

### D10. 11 collision-prone IDs using `Date.now()+Math.random()`
**Frontend** `api/agent.ts:108,115` (msg_/toolu_ IDs feed Anthropic — duplicate `tool_use_id` returns 400), `types/topologyHistory.ts:102`, `components/TopologyTabEditor.tsx:939`, `components/Toast.tsx:72`, `hooks/useTroubleshootingSession.ts:104`, `hooks/useTopologyAICallbacks.ts:87,298,460`, `lib/tracerouteParser.ts:13`. Use `crypto.randomUUID()`.

### D11. Empty / comment-only catch blocks swallow real errors
12 strict-empty (11 are intentional SNMP probes in `DeviceDetailTab.tsx`; one in `components/workspace/WorkspaceOutputPanel.tsx:119` silently drops AI workspace output parse errors). ~45 `/* ignore */`-style catches — including `useEnterpriseSSH.ts:287` (WS reconnect redirect parse), `Terminal.tsx:2822,2905` (session lookup), `useAIAgent.ts:2480,2887` (AI message JSON).

### D12. `localStorage` unsafe casts crash UI on corrupt storage
**Frontend** `components/SessionPanel.tsx:291`, `components/TopologyPanel.tsx:186`

`localStorage.getItem('session-panel-sort-order') as 'default' | 'reverse'` — corrupt value passes through and `setSortOrder` with an invalid value breaks the toggle.

### D13. `key={index}` mis-keying on `SplitPaneContainer`
**Frontend** `components/SplitPaneContainer.tsx:146`

Re-keying terminals by index re-mounts them on reorder. PTY connection drops, session state lost.

### D14. Async clipboard ops never catch rejection
**Frontend** `frontend/src/App.tsx:5265, 5278, 5290`

In Tauri WebView, permission denial throws — paste/copy silently fails with no UI feedback.

### D15. WebSocket onmessage handlers parse with bare `try` — no telemetry on bad frames
**Frontend** `components/Terminal.tsx:550,1003`, `components/SharedTerminal.tsx:129`, `hooks/useAgentTasks.ts:195`, `hooks/useTopologyLive.ts:396`, `hooks/useEnterpriseSSH.ts:247`

Malformed frames silently dropped; user sees a stuck stream with no indication.

### D16. Broken template literal in sessionState
**Frontend** `frontend/src/utils/sessionState.ts:59` — single-quoted, prints `${age}` literally. Debug-log only, but signals AI didn't read the line it wrote.

### D17. `unsafe impl Send + Sync for TerminalManager` may be unnecessary
**Backend** `agent/src/terminal.rs:538-539`

Wrapping a non-`Sync` type in a `Mutex` already makes the outer `Mutex` `Sync`. `cargo check` should tell us whether the `unsafe impl` does anything; if not, it's dead unsafe; if so, the SAFETY comment's reasoning is wrong.

### D18. Dead frontend endpoints (would 404 if anyone calls them)
**Frontend** `frontend/src/api/topology.ts:320,325` (`/topology` singular — no backend route), `topology.ts:413` (`shareTopology` — no backend route, no enterprise guard), `topology.ts:313` (`updateConnectionStyle` — no backend route).

---

## MINOR — Cleanup When Convenient

### N1. Dead backend endpoints (no frontend caller)
`GET /api/recordings`, `DELETE /api/recordings/:id`, `POST /api/cert/renew`, `DELETE /api/credentials/:session_id`, `GET /api/folders/:id`, `GET /api/topologies/folders/:id`, `PUT /api/topologies/:id/devices/:device_id/type`, `POST /api/terminals/:id/log/write`.

### N2. `api.rs` is 9,662 lines — kitchen-sink module
Strongly correlates with the deny-list-skip bugs (C2, C3). Split into `api/netbox.rs`, `api/lookup.rs`, `api/local_fs.rs`, `api/mcp.rs`.

### N3. Regex compiled per call
`agent/src/scripts.rs:348-349` (`extract_imports`), `agent/src/scripts.rs:1160` (`detect_main_params`). Other regex sites correctly use `OnceLock` / `LazyLock`.

### N4. No database transactions anywhere in `agent/src`
`grep -rn 'begin()|begin_transaction|\.commit()|\.rollback()' agent/src` returns zero hits. Multi-row mutations (e.g., bulk delete sessions in `api.rs:308`) execute as independent `sqlx::query(...).execute(pool)` calls; mid-loop failure leaves the DB torn.

### N5. Dead-code stubs `_prefixed_fn()` + `#[allow(dead_code)]`
Representative: `agent/src/models.rs:1552,1574,1636,1978`; `sftp.rs:463,473`; `cert_manager.rs:67,105,205`; `providers/local.rs:1297,1717,2008,6247,6465`; `discovery/integration_lookup.rs:395`; `tasks/store.rs:209`; `tasks/tools/registry.rs:70,75,80`. Standard vibe artifact — function written, never wired, renamed with `_` to silence the lint.

### N6. Frontend dead/unreferenced API helpers
Topology singular routes (see D18); `getSessionTopology`, `updateSessionDevicePosition`, `updateConnectionStyle`, `shareTopology` have no callers and point at nonexistent routes.

### N7. `ServeDir::new("../frontend/dist")` resolves against agent's pwd
**Backend** `agent/src/main.rs:1161-1162`. Tauri sidecar pwd is not guaranteed across platforms / install layouts. Use absolute path from `std::env::current_exe()`.

### N8. Windows TODOs in security-relevant paths
`agent/src/main.rs:198, 253` — Windows equivalents of agent-eviction and parent-death watcher still empty. Orphan-process protections are Unix-only.

### N9. `let _ = stop_tunnel(...).await` discards stop errors before mutation
**Backend** `agent/src/api.rs:9228, 9237, 9265`. Failed stop races against update/delete of the still-running forwarder. At least log on error.

### N10. WS token in query string
**Backend** `agent/src/ws.rs:35, 1042, 1586` — auth token as `?token=...`. URLs end up in browser history, server logs. Mitigated only by `tower_http=info` log level (`main.rs:329`); anyone re-enables debug and the token leaks.

### N11. 155 `console.log` calls in frontend
Includes the token-bearing logs in M11. Worth a pass to gate debug logs behind a flag or strip in production builds.

### N12. `unwrap_or_else(|_| reqwest::Client::new())` after builder failure
**Backend** `agent/src/api.rs:1445,1495,1707,1749,1791,1833,1875,1917,2062,2158` — when `.danger_accept_invalid_certs(true).build()` fails, fallback Client enforces TLS. The caller wanted the bypass; the fallback flips a security setting silently rather than failing.

---

## Status of 2025-05 Audit Findings

20 of 20 Critical+Major items checked:
- **Fixed: 16** — all 6 Critical (C1-C6) plus M2, M3, M4, M5, M6, M8, M9, M12, M13, M14
- **Partial fix: 2** — M10 (AbortControllers wired but signal still not passed → expanded scope, now C5 above); M11 (`toolNameMap` size-capped but collision risk remains within window → now D7)
- **Still present: 2** — M1 (TLS verification → now M1 above), M7 (sessions schema drift → now D1)

Notable wins since last audit: RCE risk closed (the original C1 file handlers all validate paths now — though C2 and C3 above show that two handlers were missed and the validator design has a TOCTOU hole). CORS locked to localhost/Tauri origins. Tauri v1/v2 detection unified. MopExecution/Device structs aligned with DB schema. Listener no longer panics on port collision.

---

## Summary Statistics

| Category | Count |
|---|---|
| Backend Axum routes | 271 |
| Frontend HTTP call sites | ~460 |
| Total .ts/.tsx files | 413 |
| Total .rs files | 91 |
| `.unwrap()` in Rust (incl. tests) | 304 |
| `let _ = ...` (silent error drops) | 113 |
| Hardcoded `danger_accept_invalid_certs(true)` | 17 |
| `as any` casts in TS | 21 |
| `// eslint-disable react-hooks/exhaustive-deps` | 15 |
| `Date.now()+Math.random()` IDs | 11 |
| `confirm`/`alert` calls in Tauri | ~25 |
| `key={index}` on lists | 55 |
| `console.log` in production | 155 |
| **Critical issues (new)** | **10** |
| **Major issues** | **21** |
| **Moderate issues** | **18** |
| **Minor issues** | **12** |

---

## Suggested Triage Order

1. **C1** — one-line fix, every remote git op currently 404 (`gitOps.ts:178`)
2. **C2** — 15-line fix, two unauthenticated-by-deny-list handlers (`api.rs:9440,9540`)
3. **C3** — refactor `validate_local_path` to return the canonical `PathBuf` callers must use
4. **C4** — frontend snake→camel migration on 5 SNMP endpoints (`api/snmp.ts:160,189,216,253,282`)
5. **C5** — add `signal` param to `sendChatMessage` and thread through 5 AI features
6. **C6** — replace 25 `confirm`/`alert` calls with the existing toast/modal pattern
7. **C7** — move `clearInterval` to a `finally` block in SFTP transfers (4 sites)
8. **C8** — register `PUT /topologies/:id/connections/:conn_id` handler
9. **C9** — swap `std::sync::Mutex`/`RwLock` for `parking_lot` in vault path
10. **C10** — add cancel-token-aware `child.kill()` to SSE Python handlers
11. **M1** — gate AI/integration HTTPS clients on per-resource `verify_ssl` config
12. **M3** — switch WS token comparison to `subtle::ConstantTimeEq`
