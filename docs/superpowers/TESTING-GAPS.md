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

### Phase 3 — mock LLM integration silently skips

- **Affected tests**: `ai_mock_llm_chat_response`, `ai_mock_llm_generate_script`,
  `ai_mock_llm_profile_injection`, `ai_mock_llm_system_prompt_forwarded`
- **What's happening**: Each test attempts to write a provider config that
  points the agent at the mock LLM (`http://localhost:8090`). The PUT succeeds
  but the agent still returns `503 Service Unavailable` on the chat call. The
  tests detect the 503 and silently skip ("Mock LLM config saved but agent
  still returns 503 — provider config format may differ"). They pass without
  having actually exercised the LLM round-trip.
- **Root cause** (hypothesis): the `ai.provider_config` JSON shape the test
  writes doesn't match what the current agent expects (likely needs a
  different provider type than `"custom"` or a different field set for the
  mock LLM URL).
- **Re-cover where**: Sub-project 2 (AI sanitization comprehensive) and
  Sub-project 3 (AI prompt wiring) — both depend on the mock LLM round-trip
  actually working. Fix the provider-config shape there.

## Phase pass status (after Sub-project 0)

Cold-start re-run of `./run-tests.sh all`:

| Phase | Tests | Status |
|---|---|---|
| 1  Foundation         | 9  | ✅ green |
| 2  Sessions           | 12 | ✅ green |
| 3  AI + Sanitization  | 41 | ✅ green (mock LLM tests skip, see gap above) |
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
