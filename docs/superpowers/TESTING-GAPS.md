# Testing Gaps

Endpoints / features that the standalone-agent test suite cannot exercise because
they are controller-only or have been removed in the standalone split. Tests that
asserted these endpoints existed have been deleted from the phase test files;
this doc preserves the intent so the gap can be re-covered if the controller is
re-added or a standalone replacement ships.

## Phase 14 — Devices

### `device_import_csv` (was: `POST /devices/import/csv`)

- **Removed from**: `tests/api/tests/phase14_devices.rs`
- **Reason**: No `/devices/*` top-level routes exist on the standalone agent.
  Bulk device import (CSV / NetBox sync etc.) is part of the controller's
  inventory-management surface.
- **Re-cover when**: A standalone bulk-import endpoint is added (e.g. a
  per-agent local-inventory CSV importer).

### `credential_folders_list` (was: `GET /admin/credentials/folders`)
### `credential_folder_access` (was: `GET /admin/credentials/folders/:id/access`)
### `credential_personal_vaults` (was: `GET /admin/credentials/personal-vaults`)

- **Removed from**: `tests/api/tests/phase14_devices.rs`
- **Reason**: `/admin/credentials/*` is controller-only. The standalone agent
  exposes `/profiles/*` (per-session credential profiles) and `/vault/*`
  (single local vault) instead — there are no shared folders, no folder ACLs,
  and no per-user personal vaults.
- **Re-cover when**: Multi-user credential folder management ships in the
  standalone agent (currently not on the roadmap).

### `agent_enable_disable` (was: `GET /agents`, `POST /agents/:id/{enable,disable}`)

- **Removed from**: `tests/api/tests/phase14_devices.rs`
- **Reason**: `/agents` was the controller's fleet-management endpoint (list
  registered agent processes and toggle them). The standalone agent has no
  notion of remote agents — it *is* the agent. The closest sibling endpoint,
  `/agent-definitions`, is for AI agent definitions and has no enable/disable.
- **Re-cover when**: A standalone deployment grows multi-agent topology
  awareness (e.g. peer agents in a mesh).

## Phase 15 — MOP steps

### `token_analytics_by_feature` (was: `GET /admin/analytics/tokens/by-feature`)

- **Removed from**: `tests/api/tests/phase15_mop_steps.rs`
- **Reason**: `/admin/analytics/*` is controller-only — token usage analytics
  across users/teams/features is part of the multi-tenant admin surface. The
  standalone agent serves a single user and has no analytics aggregation.
- **Re-cover when**: A standalone usage-summary endpoint ships (e.g. a
  per-feature token counter visible in Settings → AI).

## Coverage gaps surfaced during Sub-project 0

These are areas where existing tests technically pass but don't actually
exercise the feature — flagged here so subsequent sub-projects close the gap.

### Sub-project 1 wave 4 — SFTP test depends on a clean known_hosts

- **Affected tests**: `coverage_sftp.rs::sftp_full_lifecycle`
- **What's happening**: The agent's SFTP `check_server_key` uses strict TOFU
  via `host_keys::HostKeyStore::verify_or_store(.., auto_accept_changed=false)`
  and reads `~/.ssh/known_hosts` (the user's real file, shared with system
  ssh). When the mock SSH container is rebuilt, the new ed25519 host key
  doesn't match the entry the previous container left behind, and SFTP
  connect fails with `russh::Error::UnknownKey` ("Unknown server key"). The
  WebSocket SSH handler (phase 4) is unaffected because it goes through
  `ssh::ClientHandler` with the host-key approval service, which auto-TOFUs
  unknown keys. SFTP's handler doesn't have an approval service wired.
- **Workaround**: Run `ssh-keygen -R "127.0.0.1:2222"` after a `setup-mocks.sh`
  rebuild; the next SFTP connect TOFU-stores the new key.
- **Fix later**: Either teach `setup-mocks.sh` to clear stale `:2222` entries
  before starting the agent, OR wire the host-key approval service into the
  SFTP handler so unknown/changed keys can be accepted programmatically in
  test mode (matches the WS SSH path).

### Sub-project 1 wave 4 — AI LLM endpoints all hit the 503 fallback

- **Affected tests**: `coverage_ai_files.rs::{ai_chat_responds, ai_agent_chat_responds, ai_generate_script_responds, ai_analyze_highlights_responds}`
- **What's happening**: Same root cause as the Phase 3 mock-LLM gap below —
  the test environment's `ai.provider_config` doesn't get accepted by the
  agent, so every LLM-dependent endpoint returns `503 NOT_CONFIGURED`. The
  wave-4 tests assert `is_success() || ai_unavailable(status)`; in practice
  4 of 5 LLM-dependent endpoints exercise the 503 branch. The fifth
  (`ai_agent_chat_stream_responds`) returns 200 because SSE upgrades before
  the LLM is invoked — the error event arrives in-stream.
- **Wired-and-tested without LLM**: profile CRUD, memory CRUD, knowledge-pack
  sizes, sanitization-test round-trip, ssh-execute / write-file / edit-file
  / patch-file (4xx for unknown session), config-mode lifecycle.
- **Re-cover when**: Sub-project 2 / 3 fixes the provider-config shape, the
  same `coverage_ai_files.rs` tests will start exercising the 2xx branch and
  surface latent LLM-round-trip bugs without any test rewrite.

### Sub-project 1 wave 7 — `/api/docs/` and `/api/scripts/` trailing-slash mismatch

- **Affected tests**: `coverage_docs.rs::document_full_round_trip_with_versions_and_render`,
  `coverage_scripts.rs::script_full_round_trip`
- **What's happening**: `agent/src/main.rs` registers two nested routers with
  `.route("/", ...)`:
  ```rust
  let scripts_routes = TrackedRouter::new()
      .route("/", get(scripts::list_scripts).post(scripts::create_script))
      ...;
  let docs_routes = TrackedRouter::new()
      .route("/", get(docs::list_documents).post(docs::create_document))
      ...;
  // ... mounted under `/api/scripts` and `/api/docs`
  ```
  `TrackedRouter` reports the resulting route as `/api/scripts/` /
  `/api/docs/` (with the trailing slash from the inner `/` path). The drift
  table records that string. But the *actual* HTTP route axum serves is
  `/api/scripts` / `/api/docs` — without the trailing slash — because axum
  collapses the empty-path nested route. Hitting the slash-suffixed URL
  returns 404/405. Wave 7 tests work around this by issuing requests against
  the no-slash path while leaving the COVERS comment pointing at the
  drift-table form.
- **Why this is mildly annoying**: It's a minor honesty problem in the drift
  table — the listed path is *not* what the agent answers on. It also breaks
  any consumer that follows the `/dev/routes` listing literally (though the
  frontend talks to the no-slash path so it isn't broken in practice).
- **Fix later**: Either change `scripts_routes` / `docs_routes` to attach
  list/create on the parent path explicitly (`api_routes.route("/scripts",
  ...)`), or teach `TrackedRouter::nest_tracked` to drop the trailing slash
  when the inner path is `/`.

### Phase 3 — mock LLM integration silently skips ✅ FIXED (2026-05-02)

- **Affected tests**: `ai_mock_llm_chat_response`, `ai_mock_llm_generate_script`,
  `ai_mock_llm_profile_injection`, `ai_mock_llm_system_prompt_forwarded`
- **Root cause** (confirmed): the test's `configure_mock_llm()` helper had
  TWO shape bugs that compounded to produce the 503:
  1. The JSON used field name `api_url`, but the agent's `AiSettingsConfig`
     expects `base_url` (see `agent/src/ai/chat.rs:390`). `api_url` was
     silently ignored by serde, so the agent fell back to its default
     `https://api.anthropic.com` and never reached the mock.
  2. The JSON included `api_key`, but the agent reads the API key from the
     **vault** (`get_api_key("ai.<provider>")`, see `chat.rs:494-502`), not
     from the settings JSON. The vault was never unlocked nor populated, so
     the agent returned 503 with `"Vault is locked"` — which the test
     misread as a generic "provider config wrong" 503 and silently skipped.
- **Fix**: rewrote `configure_mock_llm()` in `tests/api/tests/phase3_ai.rs`
  (gitignored) to (a) call `ensure_vault_unlocked()`, (b) PUT the mock key
  to `/vault/api-keys/ai.anthropic`, (c) PUT the provider config with
  `base_url` instead of `api_url`. Also removed the silent-skip 503 branch
  and tightened each test to assert the mock-LLM signature ("Mock LLM
  response to:", profile name "MockTestEngineer", `system_prompt_length`
  delta vs baseline) so future regressions fail loud.
- **Verified**: all 4 `ai_mock_llm_*` tests pass with real round-trips
  (parallel + serial). Full phase3_ai suite: 41/41 green.
- **Side effects**: none — the four tests previously passed by skipping;
  now they pass by exercising. No other tests touched.

## Phase pass status (after Sub-project 0)

Cold-start re-run of `./run-tests.sh all`:

| Phase | Tests | Status |
|---|---|---|
| 1  Foundation         | 9  | ✅ green |
| 2  Sessions           | 12 | ✅ green |
| 3  AI + Sanitization  | 41 | ✅ green (mock LLM round-trips now exercised, gap fixed 2026-05-02) |
| 4  Terminal/WebSocket | 13 | ✅ green |
| 5  Features           | 16 | ✅ green |
| 6  SNMP/Discovery     | 13 | ✅ green |
| 8  Edge Cases         | 16 | ✅ green |
| 14 Devices            | 14 | ✅ green (was 19; 5 removed-feature deletions) |
| 15 MOP Steps          | 11 | ✅ green (was 12; 1 removed-feature deletion) |
| **Total**             | **145** | **✅ all green** |

Frontend Vitest: 36/36 green (App + aiModes + modePrompts + 2 Pact contracts).

---

# Sub-project 1 — Backend API coverage

Completed 2026-05-02. See `docs/superpowers/specs/2026-05-02-backend-api-coverage-design.md` and `docs/superpowers/plans/2026-05-02-backend-api-coverage.md`.

**Purpose:** add a happy-path round-trip test for every uncovered HTTP route on the standalone agent, plus a drift-detection mechanism that fails the suite when a route is added without a covering test.

**Outcome:** 94 net-new tests across 30 categories, 1 drift test, all green from cold start. Combined with the 145 retained phase tests this gives 240 tests in the sweep.

## Drift-detection mechanism (live)

Three pieces, committed:

1. **`agent/src/tracked_router.rs`** — `TrackedRouter<S>` wrapper around `axum::Router<S>`. Captures `(path, methods)` on every `.route()` call. `nest_tracked()` merges nested sub-routers with the prefix prepended so the aggregated list reflects the full URL surface. Method detection uses the `MethodRouter` Debug repr (axum 0.7 doesn't expose a public accessor); covered by `agent/tests/tracked_router_test.rs`.
2. **`agent/src/dev.rs`** — `GET /api/dev/routes` returns the live `Vec<RouteInfo>` from the global `OnceLock` populated by `main.rs` at startup. Cfg-gated `#[cfg(any(debug_assertions, feature = "dev-routes"))]` — absent from release builds (verified via `strings target/release/netstacks-agent | grep '/dev/routes'` returning 0).
3. **`tests/api/tests/coverage_drift.rs`** — hits `/api/dev/routes`, cross-references the response against the hand-maintained `EXPECTED_COVERAGE` constant (227 entries) and `INTENTIONALLY_UNCOVERED` constant (currently empty), and panics with a precise diff if anything drifts. Adding a route in `main.rs` without adding a test + `EXPECTED_COVERAGE` entry now fails the suite.

Tracked router commits: `9110e76` (wrapper), `4dfc95b` (wire into main.rs), `db2bba7` (`/dev/routes` endpoint).

## Routes newly covered

30 per-category test files, all under `tests/api/tests/coverage_*.rs` (gitignored). Counts below are tests / `// COVERS:` route markers — many tests cover multiple routes via consolidated lifecycle tests (CRUD round-trips, source-mgmt + proxy-error pairs, etc.).

| # | Category | Test file | Tests | Routes covered |
|---|---|---|---:|---:|
| 1  | Lookups            | `coverage_lookups.rs`           | 4  | 4  |
| 2  | Vault              | `coverage_vault.rs`             | 6  | 9  |
| 3  | Recordings         | `coverage_recordings.rs`        | 1  | 8  |
| 4  | Changes            | `coverage_changes.rs`           | 3  | 9  |
| 5  | Topologies         | `coverage_topologies.rs`        | 2  | 17 |
| 6  | Imports            | `coverage_imports.rs`           | 5  | 7  |
| 7  | NetBox             | `coverage_netbox.rs`            | 4  | 17 |
| 8  | LibreNMS           | `coverage_librenms.rs`          | 4  | 9  |
| 9  | Netdisco           | `coverage_netdisco.rs`          | 4  | 11 |
| 10 | AI files           | `coverage_ai_files.rs`          | 14 | 22 |
| 11 | SFTP               | `coverage_sftp.rs`              | 1  | 9  |
| 12 | WebSockets         | `coverage_websockets.rs`        | 2  | 2  |
| 13 | MOP diff           | `coverage_mop_diff.rs`          | 2  | 1  |
| 14 | MOP executions     | `coverage_mop_executions.rs`    | 2  | 25 |
| 15 | Tunnels            | `coverage_tunnels.rs`           | 2  | 10 |
| 16 | MCP                | `coverage_mcp.rs`               | 2  | 7  |
| 17 | API resources      | `coverage_api_resources.rs`     | 2  | 7  |
| 18 | Jump hosts         | `coverage_jump_hosts.rs`        | 1  | 5  |
| 19 | Layouts            | `coverage_layouts.rs`           | 1  | 5  |
| 20 | Groups             | `coverage_groups.rs`            | 1  | 5  |
| 21 | Cert               | `coverage_cert.rs`              | 4  | 4  |
| 22 | SMTP               | `coverage_smtp.rs`              | 2  | 4  |
| 23 | Profiles (delta)   | `coverage_profiles.rs`          | 2  | 8  |
| 24 | Mapped keys        | `coverage_mapped_keys.rs`       | 1  | 4  |
| 25 | Agent definitions  | `coverage_agent_definitions.rs` | 1  | 1  |
| 26 | Context            | `coverage_context.rs`           | 1  | 5  |
| 27 | Credentials        | `coverage_credentials.rs`       | 1  | 2  |
| 28 | Custom commands    | `coverage_custom_commands.rs`   | 1  | 4  |
| 29 | Discovery          | `coverage_discovery.rs`         | 3  | 3  |
| 30 | Docs               | `coverage_docs.rs`              | 1  | 9  |
| 31 | Highlight rules    | `coverage_highlight_rules.rs`   | 1  | 5  |
| 32 | Host keys          | `coverage_host_keys.rs`         | 1  | 3  |
| 33 | Quick actions      | `coverage_quick_actions.rs`     | 2  | 11 |
| 34 | Scripts            | `coverage_scripts.rs`           | 1  | 9  |
| 35 | Snapshots          | `coverage_snapshots.rs`         | 1  | 3  |
| 36 | Task approvals     | `coverage_task_approvals.rs`    | 1  | 3  |
| 37 | Tasks              | `coverage_tasks.rs`             | 1  | 5  |
| 38 | Settings (delta)   | `coverage_settings.rs`          | 1  | 2  |
| 39 | Folders (delta)    | `coverage_folders.rs`           | 1  | 1  |
| 40 | History            | `coverage_history.rs`           | 1  | 3  |
| 41 | Snippets (delta)   | `coverage_snippets.rs`          | 2  | 6  |
| 42 | Sessions extras    | `coverage_sessions_extras.rs`   | 1  | 1  |
|    | **Coverage total** |                                 | **94** | **285** |
| 43 | Drift cross-check  | `coverage_drift.rs`             | 1  | (n/a) |
|    | **Grand total**    |                                 | **95** |  |

`terminals` was not given a `coverage_*.rs` file — Phase 4 already exercises the WebSocket terminal route end-to-end, so `EXPECTED_COVERAGE` marks those entries `EXISTING_PHASE_TEST`.

## Routes intentionally uncovered

None. `INTENTIONALLY_UNCOVERED` in `coverage_drift.rs` is empty. Every route surfaced by the agent at boot has either:
- a real test with a `// COVERS: METHOD /path` marker pointing at an `EXPECTED_COVERAGE` entry, or
- an `EXISTING_PHASE_TEST` marker (covered by `phase*.rs`).

## Agent bugs surfaced and fixed

None. Every test failure encountered during Phase C wave development was a stale assumption about API shape (request/response field names, status codes for absent resources, request body format e.g. multipart vs JSON), not a real agent bug. Tests were updated to match the agent's actual behavior.

The two real test-infra issues uncovered (and noted above):
- SFTP TOFU on stale `~/.ssh/known_hosts` — not an agent bug; it's the host-key store correctly refusing a changed key.
- `/api/docs/` and `/api/scripts/` trailing-slash mismatch — minor honesty problem in the drift table, not a runtime bug for any consumer.

## Mock infrastructure changes

None new in Sub-project 1. The mock SSH container (`tests/mocks/ssh-server`, alpine `linuxserver/openssh-server`) already advertises the SFTP subsystem, so `coverage_sftp.rs` works out of the box. The mock LLM container (`tests/mocks/llm-server`) is unchanged — coverage_ai_files tests accept either 2xx success or the 503 "AI not configured" branch (provider-config wiring is Sub-project 2/3 territory).

## Test infrastructure changes (committed via Phase D follow-up)

Vault-unlock helper added to `tests/api/src/fixtures.rs` (`ensure_vault_unlocked`) so coverage tests that store credentials/profiles/SMTP-config/source-mgmt API tokens can idempotently unlock the vault on cold start. Phase 1 standardized on the same canonical password (`test-vault-pass-coverage`) so every test agrees on what unlocks the vault. (`tests/` is gitignored — these helpers ship locally, not via commit.)

## Final pass status (cold-start re-run of `./run-tests.sh all && ./run-tests.sh cov`)

After cold-start (`teardown.sh` + `setup-mocks.sh` + clean test DB):

| Suite | Tests | Status |
|---|---:|---|
| **Phase tests** | | |
| 1 Foundation        | 9   | green |
| 2 Sessions          | 12  | green |
| 3 AI + Sanitization | 41  | green (mock LLM tests still skip; see Phase 3 gap above) |
| 4 Terminal/WebSocket| 13  | green |
| 5 Features          | 16  | green |
| 6 SNMP/Discovery    | 13  | green |
| 8 Edge Cases        | 16  | green |
| 14 Devices          | 14  | green |
| 15 MOP Steps        | 11  | green |
| **Phase total**     | **145** | **green** |
| **Coverage tests (94 across 30 categories)** | | |
| coverage_lookups, vault, recordings, changes, topologies, imports | 21 | green |
| coverage_netbox, librenms, netdisco | 12 | green |
| coverage_ai_files, sftp, websockets, mop_diff | 19 | green |
| coverage_mop_executions, tunnels, mcp, api_resources | 8 | green |
| coverage_jump_hosts, layouts, groups, cert, smtp, profiles, mapped_keys | 12 | green |
| coverage_agent_definitions, context, credentials, custom_commands, discovery, docs, highlight_rules, host_keys, quick_actions, scripts, snapshots, task_approvals, tasks | 16 | green |
| coverage_settings, folders, history, snippets, sessions_extras | 6 | green |
| **Coverage total**  | **94** | **green** |
| coverage_drift (cross-check) | 1 | green (0 PENDING entries, 0 stale entries, 0 uncovered routes) |
| **Grand total**     | **240** | **all green from cold start** |

Frontend Vitest unaffected: 36/36 still green.

---

# Sub-project 2 — AI integration tests (sanitization + prompt wiring + chat round-trips)

Completed 2026-05-02. Builds on Sub-project 0's mock-LLM round-trip fix to convert the four `phase3_ai::ai_mock_llm_*` smoke probes into a comprehensive end-to-end suite that proves the wires between `/api/ai/*` endpoints and a Claude-compatible provider actually carry sanitization, profile injection, mode-prompt overrides, AI memories, knowledge-pack content, tool definitions, and SSE stream events.

**Artifact:** `tests/api/tests/coverage_ai_integration.rs` (gitignored — 26 net-new tests, all green from cold start). Additive to `coverage_ai_files.rs` and `phase3_ai.rs` — no existing tests modified or replaced.

## Coverage added (9 areas, 26 tests)

| Area | Tests | What's now proven |
|---|---:|---|
| 1. Sanitization round-trip                 | 8 | `SanitizingProvider` actually scrubs user messages AND `system_prompt` BEFORE the LLM sees them. Covers Cisco enable-secret hashes, generic `password=`, SNMP communities, RSA private keys, AWS access keys, optional IP redaction (when toggled in `ai.sanitization_config`), system-prompt scrubbing on `/agent-chat`, and a "safe text passes through unaltered" sentinel. |
| 2. Profile injection edge cases            | 2 | (a) Profile with rich fields (multi-vendor weights, multiple safety rules) flows through to the system prompt verbatim. (b) `DELETE /api/ai/profile` actually removes personality from the next chat's system prompt — tested with a unique sentinel name. |
| 3. Mode-prompt overrides                   | 3 | The `feat/ai-mode-prompt-overrides` branch is **frontend-only** — see below. Tests prove the agent-side guarantees the feature depends on: (a) `ai.mode_prompt.{chat,operator,troubleshoot,copilot}` settings keys are persistable via the generic `/api/settings/:key` CRUD; (b) a sentinel-bearing system_prompt POSTed to `/agent-chat` flows through sanitization to the LLM; (c) `req.system_prompt` REPLACES `AGENT_SYSTEM_PROMPT` (verified by length-shrink: small override yields a much shorter prompt than baseline). |
| 4. Tool use                                | 3 | `tools` array forwarded to the LLM verbatim (mock returns matching tool name in `tool_use` block, agent surfaces it with `stop_reason: "tool_use"`). Synthetic `test:tool_use` trigger lets us probe the parsing path in isolation. Multi-turn `tool_result → final assistant text` cycle works (assistant's response after a tool_result is `end_turn`, not another tool call). |
| 5. Streaming                               | 2 | `/api/ai/agent-chat-stream` actually emits SSE events: `Content-Type: text/event-stream`, multiple `data: ...` lines, `content_delta` events, and a final `done` event. Also proves the unconfigured path returns 503 before opening the stream. (Required extending the mock LLM to honour `stream: true` on `/v1/messages` — see below.) |
| 6. AI memories injection                   | 2 | Memories created via `POST /api/ai/memory` appear in the next agent-chat's system prompt under a `NETWORK MEMORY` header; deleting a memory removes it from subsequent prompts; with zero memories, the `NETWORK MEMORY` section is absent. |
| 7. Knowledge-pack injection                | 1 | A profile with `vendor_weights.cisco=1.0` and `domain_focus.routing=1.0` pulls in the cisco vendor + routing domain packs, observable in the system prompt the LLM receives (system prompt grows past 3KB, contains "cisco" + IOS/show/interface tells). |
| 8. Generate-script constraints             | 3 | (a) Default `\`\`\`python` fence parsed into `script` + `explanation`. (b) Non-python fence (`\`\`\`cisco`) handled — body extracted into `script`. (c) Provider error → 5xx with structured `{error, code}` JSON, never a panic or silent OK. (Note: `GenerateScriptRequest` has no `target_session_id` field — that part of the original task was infeasible and dropped.) |
| 9. Mode-aware analyze-highlights           | 2 | Round-trip works through the mock LLM with a small highlights array; `model` override accepted on the request body. |

**Cold-start re-run:**
- `coverage_ai_integration` → 26/26 green
- `phase3_ai` → 41/41 green (mock-LLM extensions did not break existing tests)
- `coverage_ai_files` → 14/14 green
- `coverage_drift` → 1/1 green (no new routes, no entries needed in `EXPECTED_COVERAGE`)

## Mock LLM extensions

Three additive triggers in `tests/mocks/llm-server/server.py` — all are pure echoes that bypass tool/script flow, so existing scenarios (default text, `who are you`, `test:system_prompt`, `test:onboarding`, highlight analysis, script generation, tool_use-on-`tools`-presence) are unchanged.

| Trigger | Purpose |
|---|---|
| `test:echo_messages` in user content | Mock returns `ECHO_MESSAGES: {json}` whose `echoed_messages` field is the verbatim concatenation of all messages it received (including `tool_result` content). Lets sanitization tests assert `[REDACTED]` is present and the secret is absent in what the LLM was asked to read. |
| `test:echo_system` in user content | Mock returns `ECHO_SYSTEM: {json}` with the FULL system prompt (no length truncation). Lets profile/memory/knowledge-pack/mode-prompt tests grep for sentinels in the prompt the LLM received. |
| `test:tool_use` in user content | Mock emits a synthetic tool_use block even without a `tools` array, exercising the agent's tool_use-response parsing in isolation. |
| `test:script_cisco` in user content | Mock emits a `\`\`\`cisco`-fenced code block so generate-script's non-python-fence path can be exercised. |
| `test:script_error` in user content | Mock returns HTTP 500 with an Anthropic-style `{type: error, error: ...}` body so the agent's provider-error translation can be exercised. |
| `stream: true` on `/v1/messages` | Mock now emits a real Anthropic-style SSE event sequence (`message_start` → `content_block_start` → 2× `content_block_delta` → `content_block_stop` → `message_delta` → `message_stop`), letting `/api/ai/agent-chat-stream` round-trip be tested with real chunked decoding. |

A multi-turn tool branch was added too: when the most recent message contains a `tool_result` block, the mock returns a final `end_turn` text message that includes a preview of the messages text, instead of trying to call another tool. This was needed for the multi-turn tool flow test (#4c).

The mock LLM container needs a rebuild after these changes (`docker compose -f tests/docker-compose.test.yml up -d --build mock-llm`); `setup-mocks.sh` already does `--build` so a fresh `setup-mocks.sh` picks up the new server automatically.

## Mode-prompt overrides — what the branch actually does

The `feat/ai-mode-prompt-overrides` branch ships a **frontend-only** feature (see `docs/superpowers/specs/2026-05-02-ai-mode-prompt-overrides-design.md`). Per-mode system-prompt overrides live at four new generic settings keys (`ai.mode_prompt.chat`, `.operator`, `.troubleshoot`, `.copilot`). The frontend's `getModeSystemPrompt(mode, isEnterprise, overrides)` composer in `aiModes.ts` substitutes the override for the per-mode `## Mode: X` block, keeps `NETSTACKS_IDENTITY` and the enterprise/standalone addendum, and POSTs the composed result to `/api/ai/agent-chat` as `system_prompt`. A one-shot migration moves any saved `ai.provider_config.systemPrompt` into `ai.mode_prompt.troubleshoot`.

The agent makes no schema decisions about which keys exist — it just stores arbitrary settings and reads `req.system_prompt` from the chat request. So the agent-side test surface is small:

1. The four new `ai.mode_prompt.*` settings keys are addressable (PUT/GET/DELETE round-trip works on each).
2. A composed system_prompt with a sentinel sentence flows through sanitization to the LLM verbatim.
3. `req.system_prompt` REPLACES `AGENT_SYSTEM_PROMPT` (length-shrink check) so the override actually wins over the agent's hardcoded default.

All three are now covered. Frontend mode composition / migration / UI behaviour is covered by the existing Vitest suite (see `frontend/src/lib/aiModes.test.ts` and `frontend/src/lib/modePrompts.test.ts`, 36/36 green) and is out of scope here.

## Bugs surfaced

None. No agent code touched in Sub-project 2 — every test passes against the in-flight `feat/ai-mode-prompt-overrides` branch as-is. Sanitization, profile injection, memory injection, tool-use plumbing, SSE streaming, generate-script error mapping, and analyze-highlights round-tripping all work as designed.

## Infeasible / dropped

- **Generate-script with `target session_id`** — the task spec asked for a "generate script with target session_id — assert SSH context flows through" test, but `GenerateScriptRequest` (`agent/src/ai/chat.rs:228-236`) only has `prompt`, `provider`, `model`. There is no session_id parameter and no SSH context plumbed into script generation. This is a scope question for the agent, not a test gap — flagging here so it gets re-considered if/when the request shape grows.
- **Knowledge-pack injection — exact pack-content matching** — the test asserts on stable substrings (vendor name + IOS/show/interface keywords) and total prompt length > 3KB rather than full pack content equality. This is intentional: pack contents (`agent/src/ai/knowledge_packs/*.rs`) are static `&str` constants that will evolve. A length-and-keyword assertion is much more durable than a content snapshot.
- **Streaming — drop-mid-stream / error event mid-stream** — the SSE test reads the full stream and asserts on data-line count + presence of `content_delta` and `done` events. Testing mid-stream errors (e.g., the LLM disconnects after the first delta) would require either a richer mock trigger that emits half a stream + closes, or a proxy in front of the mock. Deferred — happy-path streaming round-trip is the higher-value coverage.

## Final pass status

| Suite | Tests | Status |
|---|---:|---|
| `coverage_ai_integration` (NEW)            | 26  | green from cold start |
| `phase3_ai` (regression check)             | 41  | green (mock-LLM extensions backwards-compatible) |
| `coverage_ai_files` (regression check)     | 14  | green |
| `coverage_drift` (regression check)        | 1   | green (no new routes — coverage is additive) |

No commits in this sub-project — `tests/` is gitignored, mock-LLM changes are gitignored, no agent fixes were needed. TESTING-GAPS.md updated (this section, committed).

---

# Sub-project 4 — MCP integration tests with a mock MCP server

Completed 2026-05-02. Closes the gap left by Sub-project 1 wave 5, which only exercised the `/api/mcp/*` error paths against a non-existent stdio command. This wave adds an end-to-end happy-path round-trip against a real MCP server (a self-contained Python stdio mock).

**Artifacts (gitignored):**
- `tests/mocks/mcp-server/server.py` — stdio JSON-RPC mock MCP server (echo / add / get_time tools, MCP protocol version 2025-03-26 to match `rmcp 0.14`'s `ProtocolVersion::LATEST`).
- `tests/api/tests/coverage_mcp_integration.rs` — 3 new integration tests, all green from cold start.

**Committed:**
- `tests/api/tests/coverage_drift.rs` — `EXPECTED_COVERAGE` entries for `/api/mcp/servers`, `/api/mcp/servers/:id/connect`, `/api/mcp/servers/:id/disconnect`, `/api/mcp/tools/:id/enabled`, and `/api/mcp/tools/:id/execute` now point at the strengthened `coverage_mcp_integration.rs::mcp_full_lifecycle_with_mock_server`. The `DELETE /api/mcp/servers/:id` row stays on `coverage_mcp.rs::mcp_server_lifecycle_round_trip` because that test is the canonical create-then-delete probe (no MCP runtime needed).

## Transports supported by the agent

`agent/src/integrations/mcp/client.rs` supports two `transport_type` values:

| `transport_type` | rmcp transport | Config keys used |
|---|---|---|
| `"stdio"` (default) | `TokioChildProcess` | `command`, `args` (the agent spawns `command args...` and speaks JSON-RPC over the child's stdin/stdout, newline-framed) |
| `"sse"` | `StreamableHttpClientTransport` | `url`, `auth_type` (`none`/`bearer`/`api-key`), `auth_token` |

Both are wrapped by the same `McpClientManager` and produce the same `McpServerConnection` after handshake — so testing one transport exercises everything downstream of `connect()` (tool discovery, `tools/list`, `tools/call`, disconnect cleanup).

We chose **stdio** for the mock because:

1. No port allocation, no docker container, no compose file changes — the agent spawns the script directly.
2. The mock is a single Python script with zero dependencies (only stdlib `json` + `sys`).
3. Stdio is the more commonly used transport in the wild (every npm-published MCP server like `@modelcontextprotocol/server-filesystem` ships as stdio).
4. SSE coverage is intentionally deferred — see the deferrals section below.

## Mock MCP server design

`tests/mocks/mcp-server/server.py` is a minimal JSON-RPC over stdio implementation:

| JSON-RPC method | Behaviour |
|---|---|
| `initialize` | Returns `protocolVersion: "2025-03-26"`, `capabilities: {tools: {listChanged: false}}`, `serverInfo: {name: "netstacks-mock-mcp", version: "0.0.1"}` |
| `notifications/initialized` | Silent ack (no response — it's a notification) |
| `ping` | Returns `{}` |
| `tools/list` | Returns three canned tools: `echo` (deterministic prefix round-trip), `add` (numeric round-trip), `get_time` (fixed-value sentinel for time-flakiness avoidance) |
| `tools/call` | Dispatches to one of three handlers; unknown tool name returns `{isError: true, content: [{text: "unknown tool: ..."}]}` (per MCP spec, tool-level failures aren't JSON-RPC errors) |
| anything else with `id` | JSON-RPC error `-32601` "Method not found" |
| anything else without `id` (notifications) | Silently ignored |

All diagnostics go to stderr (captured by the agent's tracing layer). Stdout stays a pure JSON-RPC stream.

## Coverage added (3 tests)

| Test | What's now proven |
|---|---|
| `mcp_full_lifecycle_with_mock_server` | The canonical happy-path probe: create stdio server → connect → assert `connected=true` and 3 tools discovered → `GET /mcp/servers` shows the same 3 tools with stable IDs (`<server_id>:<tool_name>`) → `input_schema` flows through verbatim → tools default to disabled (execute returns 404) → enable echo + add → `tools/call echo {text}` returns `echo:<text>` → `tools/call add {a,b}` returns the sum as a string → bad-args call surfaces as `is_error=true` (HTTP 200, MCP-spec compliant) → disable echo, execute returns 404 → disconnect → `connected=false` in list → DELETE 204 |
| `mcp_reconnect_idempotent` | Connect-disconnect-reconnect cycle proves: (a) tool count stays exactly 3 across reconnects (no duplicate inserts in the `mcp_tools` table — the `ON CONFLICT(server_id, name) DO UPDATE` upsert at `agent/src/api.rs:8073-8079` is doing its job); (b) tool IDs are deterministic and stable across reconnects, so per-tool enabled flags survive a disconnect (verified by ID-set equality across two connect calls). |
| `mcp_connect_to_non_mcp_command_fails_cleanly` | Complements `coverage_mcp::mcp_server_lifecycle_round_trip`'s "non-existent path" case by pointing at `/usr/bin/true` (a real executable that exits immediately and doesn't speak MCP). Asserts the agent surfaces a structured `{error, code}` response (4xx/5xx) instead of panicking or hanging. |

## Test gating + skip behaviour

`mcp_mock_available()` checks for `python3` on PATH and the script's existence. If either is missing, the test logs `[skip] ...` and returns `Ok(())` without failing — same convention as `phase3_ai::mock_llm_available`. CI without Python won't go red.

`mcp_connect_to_non_mcp_command_fails_cleanly` doesn't gate on python3 because it only needs `/usr/bin/true` (always present on Linux/macOS).

## Cold-start re-run

| Suite | Tests | Status |
|---|---:|---|
| `coverage_mcp_integration` (NEW) | 3 | green from cold start |
| `coverage_mcp` (regression check) | 2 | green (still covers the create + DELETE + 404-error paths) |
| `coverage_drift` (regression check) | 1 | green after pointing 5 of the 6 MCP rows at the new test |

## Bugs surfaced

None. The agent's MCP client (`McpClientManager`), connect/disconnect plumbing, tool upsert (`ON CONFLICT(server_id, name) DO UPDATE`), per-tool enabled flag, and `tools/call` round-trip all work correctly against a real MCP server. The error-translation path (`/usr/bin/true` connect failure) also returns a well-shaped `{error, code}` response.

## Deferrals / not in this wave

- **SSE/streamable-HTTP transport coverage** — both transports share the same downstream pipeline (`connect()` → tool discovery → `tools/list` / `tools/call` → disconnect cleanup), so the stdio happy-path proves the wires from the agent's perspective. SSE-specific behaviours (URL parsing, `auth_type=bearer/api-key` header injection, HTTP error → `ConnectionFailed`) are not covered. Adding an SSE mock would require a second container in `docker-compose.test.yml` (e.g. an aiohttp/FastAPI server with the rmcp streamable-HTTP wire format). Worth doing if MCP usage in production tilts toward HTTP-hosted servers, but lower-value than stdio because (a) authentic MCP server packaging is overwhelmingly stdio-first today, and (b) the agent's transport-selection branch (`agent/src/integrations/mcp/client.rs:79-129`) is short and easily code-reviewed.
- **Real `rmcp` server library mock** — instead of hand-rolling JSON-RPC in Python, we could spin up an `rmcp` server in Rust and link it as a dev-dependency / standalone binary. Trade-off: more bytes of dependency code to compile, but exact protocol fidelity. Deferred — the Python mock is 200 lines, has zero deps, and round-trips successfully through `rmcp 0.14`'s client at protocol version `2025-03-26`. If `rmcp` updates `LATEST` past what the Python mock advertises and the client refuses the older version, swap to the Rust-server approach.
- **Concurrent connect calls / race conditions** — the test sequence is fully serial. Hammering connect in a loop or from multiple `tokio::spawn`s could surface lock-ordering bugs in `McpClientManager`'s `RwLock<HashMap>`, but no production code path exercises that pattern (the agent connects servers one at a time at boot or from a single API call). Deferred unless a fleet-wide MCP-pool feature lands.
- **Tool authorization edge cases** — we test enable=true → execute works, enable=false → execute 404. Not tested: what happens when a tool was enabled, the server got disconnected, and execute is attempted (the SQL `WHERE id=? AND enabled=1` clause matches, but `call_tool` will return `ServerNotConnected`). The current `execute_mcp_tool` handler at `agent/src/api.rs:8204-8251` would map that to `TOOL_EXECUTION_FAILED` 5xx — same code path as any other call_tool error. Could be added as a one-liner test (enable, then disconnect, then execute) — flagged for follow-up if MCP usage grows.

## Final pass status

| Suite | Tests | Status |
|---|---:|---|
| `coverage_mcp_integration` (NEW) | 3 | green from cold start |
| `coverage_mcp` (regression check) | 2 | green |
| `coverage_drift` | 1 | green (5 MCP rows now point at the integration suite) |

Commits in this sub-project:
- `tests/api/tests/coverage_drift.rs` — point 5 of the 6 MCP `EXPECTED_COVERAGE` rows at `coverage_mcp_integration.rs::mcp_full_lifecycle_with_mock_server`.
- `docs/superpowers/TESTING-GAPS.md` — this section.

No agent code touched. `tests/api/tests/coverage_mcp_integration.rs` and `tests/mocks/mcp-server/server.py` are gitignored along with the rest of `tests/`.

## Sub-project 6 — Playwright E2E pass

The standalone Playwright suite under `tests/e2e/tests/` had never been run since Sub-project 0's config fix (`../../terminal/frontend` → `../../frontend`). This sub-project ran it cold, verified all 19 spec files green, and added one new spec for the previously-shallow AI mock-LLM round-trip.

### Final pass status

| Suite | Tests | Status |
|---|---:|---|
| Existing 19 specs (`tests/e2e/tests/*.spec.ts`) | 179 | green |
| `ai-mock-roundtrip.spec.ts` (NEW) | 2 | green |
| **Total** | **181** | **green from cold start** |

### Coverage that already existed

The 19 pre-existing specs cover the user-facing golden paths in depth:
- `app-loads`, `navigation`, `panels`, `responsive`, `tab-management`, `status-bar`
- `sessions`, `session-workflows`, `dialogs`, `keyboard-shortcuts`, `command-palette`
- `settings`, `settings-tabs`, `settings-deep`
- `ai-panel`, `ai-chat` (input/send-button/clear/quick-actions, but no response assertion)
- `scripts-docs`, `topology`, `terminal-features`

### New coverage added (`tests/e2e/tests/ai-mock-roundtrip.spec.ts`)

The existing `ai-chat.spec.ts` validates that user messages render and tolerates AI errors when no provider is configured — it never asserts on the *response*. The new spec wires the agent's `ai.provider_config` to the mock LLM container (`localhost:8090`) via the HTTP API in `beforeAll`, then drives the AI panel from the UI:

1. **`send a message and receive a mock LLM response in the messages area`** — fills the input with `who are you`, submits via Enter (no stable testid on the idle send button — see "Frontend gap" below), and asserts the assistant response from the mock LLM lands in `[data-testid="ai-messages"]` within 20s.
2. **`round-trip a second user message in the same session`** — second-message round-trip with a generic prompt, asserts non-trivial assistant content renders.

This closes the "AI chat completes a round-trip end-to-end through the UI" gap that API-tier tests already cover (`coverage_ai_integration.rs`) but the E2E tier did not.

### Frontend gap surfaced (not fixed in this sub-project)

`AISidePanel.tsx:1481-1497` — the `<button type="submit" className="ai-send-btn">` for the idle (non-busy) state has **no `data-testid`**, while the `ai-stop-btn` variant (rendered only when `isAgentBusy`) does have `data-testid="ai-send"`. As a result, `page.locator('[data-testid="ai-send"]')` only matches when a request is in flight, which is the opposite of what tests want. The new spec works around this by submitting via `Enter` instead.

- **Affected tests**: any future E2E that needs to click "Send" before a request is in flight.
- **Re-cover when**: the team is comfortable adding `data-testid="ai-send"` to *both* button variants. Trivial frontend change, ~1 line.

### Infrastructure friction encountered

- **Playwright-managed `webServer` died mid-run on the first cold-start invocation.** With `webServer.command: 'cd ../../frontend && VITE_DEV_TIER=professional npm run dev'` and the default `reuseExistingServer: true`, the first cold run reported 16 failures (all `ERR_CONNECTION_REFUSED at http://localhost:5173`) clustered in the *last* spec files alphabetically (topology, terminal-features). Re-running just those files in isolation green'd them. Re-running the full suite with vite started **externally** (so `reuseExistingServer` reused it instead of managing its lifecycle) green'd all 179. Root cause is most likely Playwright reaping the `webServer` process or its stdout pipe stalling — unclear without deeper instrumentation.
- **Workaround (recommended for CI)**: start vite externally before running Playwright, e.g. `cd frontend && VITE_DEV_TIER=professional npm run dev > /tmp/vite-e2e.log 2>&1 &` then `cd tests/e2e && npx playwright test`. This is what produced the 181/181 green run.
- **Mock LLM auth handoff**: the agent's `?token=` query-param flow already works (frontend `main.tsx:82-86`), so no frontend changes were needed for E2E auth. Existing `fixtures/auth.ts` reads `tests/.agent-token` and appends it to the URL — golden.

### Deferrals

- **Theme toggle E2E** — listed in the Phase 2 wishlist, but `App.tsx` `terminalTheme` is a *per-session* terminal-color preference, not a global UI light/dark toggle. No global theme toggle exists in the standalone shell — this is intentional, not a gap.
- **Real terminal/SSH session E2E** — covered shallowly by the existing `session-workflows.spec.ts` (right-click menu, double-click triggers connect) but a true mock-SSH end-to-end session would require terminal-specific assertions and the mock SSH container's command-dispatch quirks. The API tier already covers this in `coverage_sftp.rs` and `coverage_sessions_*`; deferred.
- **WebGL 3D topology** — explicitly excluded by the sub-project brief.

### Bugs surfaced

- The send-button missing-testid issue above (frontend gap, not a bug per se).
- No JS errors emerged across all 181 tests on the green run.

### Commits in this sub-project

- `docs/superpowers/TESTING-GAPS.md` — this section.

No agent or frontend code was modified — the suite is green as-is, and the missing send-button testid was severable enough to work around in the test rather than touch the frontend. `tests/e2e/tests/ai-mock-roundtrip.spec.ts` is gitignored along with the rest of `tests/`.
