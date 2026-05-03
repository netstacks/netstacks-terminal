# Testing Gaps & Program Status

## Program status (after Sub-projects 0, 1, 2, 4, 6)

After Sub-projects 0, 1, 2, 4, and 6 (Sub-project 5 — Frontend Vitest expansion — was
skipped as marginal-value given Playwright coverage), the netstacks-terminal test suite
has **490 tests across six suites, all green from cold start** (`teardown.sh` →
`setup-mocks.sh` → fresh test DB → run). The drift-detection mechanism (`coverage_drift.rs`
cross-referencing `/api/dev/routes`) enforces ongoing coverage: any new agent route added
in `agent/src/main.rs` without an `EXPECTED_COVERAGE` entry + a real test fails CI on the
next run. Outstanding gaps — all intentional deferrals or low-priority follow-ups, none
blocking — are documented below.

## Test program metrics

Cold-start re-run on 2026-05-02 with `feat/ai-mode-prompt-overrides` checked out:

| Suite | Runner | Tests | Status |
|---|---|---:|---|
| Backend phase tests          | `./run-tests.sh all` | 145 | green |
| Backend coverage sweep       | `./run-tests.sh cov` | 94  | green |
| Drift cross-check            | `./run-tests.sh cov` (coverage_drift) | 1   | green |
| AI integration               | `cargo test --test coverage_ai_integration -- --test-threads=1` | 26  | green (serial) |
| MCP integration              | `cargo test --test coverage_mcp_integration` | 3   | green |
| Frontend Vitest              | `npm run test`       | 40  | green |
| Playwright E2E               | `npx playwright test` (vite started externally) | 181 | green |
| **Grand total**              |                      | **490** | **all green from cold start** |

Frontend Vitest count moved from 36 → 40 since the Sub-project 1/2 era — the new file
`src/lib/__tests__/aiProviderResolver.test.ts` added 4 tests (provider/model resolution
for the AI side panel). All other counts match the per-sub-project final pass status
sections recorded below.

### How to run the tests

The unified runner at `tests/run-tests.sh` handles everything — infrastructure
setup, the per-suite quirks (`--test-threads=1` for AI integration, vite
management for E2E), log routing, and a color-coded summary. You don't need
to know Rust, Vitest, or Playwright internals to use it.

```bash
cd /Users/cwdavis/scripts/netstacks-terminal/tests

# Cold-start full run: teardown → setup → all 6 suites → teardown → summary
./run-tests.sh everything

# Same but stream test output to stdout instead of just to log files
./run-tests.sh -v everything

# Already have infra up? Skip setup/teardown:
./run-tests.sh quick

# Per-suite (for iteration):
./run-tests.sh setup            # bring up agent + mocks
./run-tests.sh phase 4          # one Rust phase
./run-tests.sh cov topologies   # one coverage area
./run-tests.sh ai-int           # AI integration suite
./run-tests.sh mcp-int          # MCP integration suite
./run-tests.sh frontend         # Vitest
./run-tests.sh e2e              # Playwright (auto-manages vite)
./run-tests.sh status           # what's running right now
./run-tests.sh logs e2e         # tail the log for a specific suite
./run-tests.sh teardown         # stop everything
./run-tests.sh help             # full command list

# Logs land in /tmp/netstacks-tests/<suite>.log for post-mortem.
```

Power-user fallback (each suite invoked directly):

```bash
./scripts/setup-mocks.sh
./run-tests.sh all                              # 145 phase tests
./run-tests.sh cov                              # 95 coverage + drift
TEST_AGENT_TOKEN=$(cat .agent-token) cargo test --manifest-path api/Cargo.toml \
    --test coverage_ai_integration -- --test-threads=1   # 26 AI integration
TEST_AGENT_TOKEN=$(cat .agent-token) cargo test --manifest-path api/Cargo.toml \
    --test coverage_mcp_integration              # 3 MCP integration
(cd ../frontend && npm run test)                # 40 Vitest
./run-tests.sh e2e                              # 181 Playwright (handles vite)
./scripts/teardown.sh
```

---

## Removed-feature tests (Sub-project 0 onward)

Endpoints / features that the standalone-agent test suite cannot exercise because
they are controller-only or have been removed in the standalone split. Tests that
asserted these endpoints existed have been deleted from the phase test files;
this section preserves the intent so the gap can be re-covered if the controller
is re-added or a standalone replacement ships.

### Phase 14 — Devices

#### `device_import_csv` (was: `POST /devices/import/csv`)

- **Removed from**: `tests/api/tests/phase14_devices.rs`
- **Reason**: No `/devices/*` top-level routes exist on the standalone agent.
  Bulk device import (CSV / NetBox sync etc.) is part of the controller's
  inventory-management surface.
- **Re-cover when**: A standalone bulk-import endpoint is added (e.g. a
  per-agent local-inventory CSV importer).

#### `credential_folders_list` (was: `GET /admin/credentials/folders`)
#### `credential_folder_access` (was: `GET /admin/credentials/folders/:id/access`)
#### `credential_personal_vaults` (was: `GET /admin/credentials/personal-vaults`)

- **Removed from**: `tests/api/tests/phase14_devices.rs`
- **Reason**: `/admin/credentials/*` is controller-only. The standalone agent
  exposes `/profiles/*` (per-session credential profiles) and `/vault/*`
  (single local vault) instead — there are no shared folders, no folder ACLs,
  and no per-user personal vaults.
- **Re-cover when**: Multi-user credential folder management ships in the
  standalone agent (currently not on the roadmap).

#### `agent_enable_disable` (was: `GET /agents`, `POST /agents/:id/{enable,disable}`)

- **Removed from**: `tests/api/tests/phase14_devices.rs`
- **Reason**: `/agents` was the controller's fleet-management endpoint (list
  registered agent processes and toggle them). The standalone agent has no
  notion of remote agents — it *is* the agent. The closest sibling endpoint,
  `/agent-definitions`, is for AI agent definitions and has no enable/disable.
- **Re-cover when**: A standalone deployment grows multi-agent topology
  awareness (e.g. peer agents in a mesh).

### Phase 15 — MOP steps

#### `token_analytics_by_feature` (was: `GET /admin/analytics/tokens/by-feature`)

- **Removed from**: `tests/api/tests/phase15_mop_steps.rs`
- **Reason**: `/admin/analytics/*` is controller-only — token usage analytics
  across users/teams/features is part of the multi-tenant admin surface. The
  standalone agent serves a single user and has no analytics aggregation.
- **Re-cover when**: A standalone usage-summary endpoint ships (e.g. a
  per-feature token counter visible in Settings → AI).

---

## Coverage gaps remaining (intentional deferrals)

Everything below is either explicitly deferred in a sub-project wave report or
flagged as `INTENTIONALLY_UNCOVERED` in `coverage_drift.rs`. Each entry has a
"re-cover when" trigger so the next operator can decide whether to invest.

### Sub-project 1 wave 4 — SFTP host-key TOFU re-prompt gap

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
- **Workaround**: Run `ssh-keygen -R "[127.0.0.1]:2222"` after a `setup-mocks.sh`
  rebuild; the next SFTP connect TOFU-stores the new key.
- **Fix later**: Either teach `setup-mocks.sh` to clear stale `:2222` entries
  before starting the agent, OR wire the host-key approval service into the
  SFTP handler so unknown/changed keys can be accepted programmatically in
  test mode (matches the WS SSH path).

### Sub-project 1 wave 7 — `/api/docs/` and `/api/scripts/` trailing-slash mismatch

- **Affected tests**: `coverage_docs.rs::document_full_round_trip_with_versions_and_render`,
  `coverage_scripts.rs::script_full_round_trip`
- **What's happening**: `agent/src/main.rs` registers two nested routers with
  `.route("/", ...)`. `TrackedRouter` reports the resulting route as
  `/api/scripts/` / `/api/docs/` (with the trailing slash from the inner `/`
  path), and the drift table records that string. But the *actual* HTTP route
  axum serves is `/api/scripts` / `/api/docs` — without the trailing slash —
  because axum collapses the empty-path nested route. Hitting the slash-suffixed
  URL returns 404/405. Wave 7 tests work around this by issuing requests
  against the no-slash path while leaving the COVERS comment pointing at the
  drift-table form.
- **Why this is mildly annoying**: It's a minor honesty problem in the drift
  table — the listed path is *not* what the agent answers on. It also breaks
  any consumer that follows the `/dev/routes` listing literally (though the
  frontend talks to the no-slash path so it isn't broken in practice).
- **Fix later**: Either change `scripts_routes` / `docs_routes` to attach
  list/create on the parent path explicitly (`api_routes.route("/scripts", ...)`),
  or teach `TrackedRouter::nest_tracked` to drop the trailing slash when the
  inner path is `/`.

### Sub-project 2 — Streaming mid-stream errors not covered

- **Affected tests**: `coverage_ai_integration.rs::ai_integration_streaming_*`
- **What's happening**: The SSE test reads the full stream and asserts on
  data-line count + presence of `content_delta` and `done` events. It does
  NOT exercise the case where the LLM disconnects mid-stream (e.g. after
  emitting one delta) or sends a structured error event partway through.
- **Re-cover when**: Production streaming bugs surface in the field. Adding
  a richer mock trigger that emits half a stream then closes (or a TCP
  proxy in front of the mock) would cover this. Lower priority than the
  happy-path round-trip that ships.

### Sub-project 2 — Knowledge-pack content equality (asserts substrings only)

- **Affected tests**: `coverage_ai_integration.rs::ai_integration_knowledge_pack_*`
- **What's happening**: The knowledge-pack injection test asserts on stable
  substrings (vendor name + IOS/show/interface keywords) and total prompt
  length > 3KB rather than full pack content equality. Pack contents
  (`agent/src/ai/knowledge_packs/*.rs`) are static `&str` constants that
  evolve — a length-and-keyword assertion is durable, a content snapshot
  would churn on every pack edit.
- **Re-cover when**: A regression slips through where a pack's content drops
  silently. At that point a snapshot test is worth the maintenance cost.

### Sub-project 2 — `generate-script` doesn't accept `session_id`

- **Affected tests**: N/A (the test was dropped from the wave brief)
- **What's happening**: The original Sub-project 2 task spec asked for a
  "generate script with target session_id — assert SSH context flows through"
  test, but `GenerateScriptRequest` (`agent/src/ai/chat.rs:228-236`) only has
  `prompt`, `provider`, `model`. There is no `session_id` parameter and no
  SSH context plumbed into script generation.
- **Re-cover when**: The agent's request schema grows a `session_id` field
  AND script generation actually uses it (current device session, current
  CWD, etc.) — at that point a "generate-script-with-session-context" test
  becomes meaningful.

### Sub-project 4 — SSE/streamable-HTTP MCP transport coverage

- **Affected tests**: N/A (only stdio is exercised end-to-end)
- **What's happening**: `coverage_mcp_integration.rs` covers the stdio
  transport against a Python mock (`tests/mocks/mcp-server/server.py`). The
  agent's other MCP transport — `transport_type: "sse"` using rmcp's
  `StreamableHttpClientTransport` with `auth_type` ∈ {none, bearer, api-key}
  — is NOT covered. Both transports share the same downstream pipeline
  (`connect()` → tool discovery → `tools/list` / `tools/call` → disconnect),
  so the stdio happy-path proves most wires.
- **Re-cover when**: Production MCP usage tilts toward HTTP-hosted servers,
  OR the SSE transport-selection branch in
  `agent/src/integrations/mcp/client.rs:79-129` grows complexity. Adding
  coverage requires a second container in `docker-compose.test.yml`
  (aiohttp/FastAPI server speaking the rmcp streamable-HTTP wire format).

### Sub-project 4 — MCP concurrent-connect race conditions

- **Affected tests**: N/A (test sequence is fully serial)
- **What's happening**: The MCP integration suite drives connect/disconnect
  one server at a time. Hammering connect in a loop or from multiple
  `tokio::spawn`s could surface lock-ordering bugs in `McpClientManager`'s
  `RwLock<HashMap>`, but no production code path exercises that pattern
  today (the agent connects servers one at a time at boot or from a single
  API call).
- **Re-cover when**: A fleet-wide MCP-pool feature lands that connects many
  servers concurrently.

### Sub-project 4 — MCP disconnect-during-tool-call edge case

- **Affected tests**: N/A
- **What's happening**: Not tested — what happens when a tool was enabled,
  the server got disconnected behind its back, and execute is attempted.
  The SQL `WHERE id=? AND enabled=1` clause matches, but `call_tool` will
  return `ServerNotConnected`. The current `execute_mcp_tool` handler at
  `agent/src/api.rs:8204-8251` would map that to `TOOL_EXECUTION_FAILED`
  5xx — same code path as any other call_tool error. Could be added as a
  one-liner test (enable, then disconnect, then execute).
- **Re-cover when**: MCP usage grows OR a production incident surfaces an
  unhandled disconnect race.

### Sub-project 6 — `AISidePanel.tsx` idle send button missing `data-testid`

- **Affected**: `tests/e2e/tests/ai-mock-roundtrip.spec.ts` and any future
  E2E that needs to click "Send" before a request is in flight.
- **What's happening**: `AISidePanel.tsx:1481-1497` — the `<button type="submit"
  className="ai-send-btn">` for the idle (non-busy) state has no
  `data-testid`, while the `ai-stop-btn` variant (rendered only when
  `isAgentBusy`) does have `data-testid="ai-send"`. As a result,
  `page.locator('[data-testid="ai-send"]')` only matches when a request is
  in flight, which is the opposite of what tests want. The new spec works
  around this by submitting via `Enter` instead.
- **Fix**: Add `data-testid="ai-send"` to *both* button variants in
  `AISidePanel.tsx`. Trivial frontend change, ~1 line. Not done in
  Sub-project 6 because the work was severable from the test pass.

### Sub-project 6 — Playwright managed-`webServer` flake

- **Affected**: `tests/e2e/playwright.config.ts` `webServer` block
- **What's happening**: With Playwright managing the vite dev server
  lifecycle, the first cold-start invocation reported 16 failures (all
  `ERR_CONNECTION_REFUSED at http://localhost:5173`) clustered in the *last*
  spec files alphabetically. Re-running just those files in isolation greens
  them. Re-running with vite started **externally** (so `reuseExistingServer`
  reuses it instead of managing its lifecycle) greens all 181. Root cause
  most likely: Playwright reaping the `webServer` process or its stdout
  pipe stalling under load.
- **Workaround (current)**: `tests/run-tests.sh e2e` and the `e2e` step
  inside `everything` start vite externally and pass
  `--workers=1 --max-failures=20 --retries=0` to Playwright. `--workers=1`
  reduces the concurrent navigation load that triggered the flake; the
  failure cap bails fast if vite genuinely dies (avoids ~5 minutes of
  "did not run" cascade) instead of attempting all 181.
- **Fix later**: Investigate Playwright `webServer` lifecycle management
  (timeout, stdout buffering, signal handling) in deep enough detail to
  let the managed path go green reliably under the default workers count.

### Test runner — vite v7 IPv6-only listener (fixed in `run-tests.sh`)

- **Affected**: `tests/run-tests.sh start_vite()` health probe + `cmd_status`
- **What was happening**: Vite v7 binds IPv6-only by default (`::1` listener,
  no IPv4). The runner's health probe used `http://127.0.0.1:5173` which
  returned `ECONNREFUSED` even though vite was up and serving on
  `localhost`/`::1`. Symptom: `./run-tests.sh e2e` aborted with
  "vite failed to start within 30s — see /tmp/netstacks-tests/vite.log",
  but the log showed vite ready in 500ms.
- **Fix (applied)**: Switched all 5173 health probes in `run-tests.sh` from
  `http://127.0.0.1:5173` to `http://localhost:5173`. `localhost` resolves to
  both families, so it works regardless of which vite version is in use.
- **Fix later (upstream)**: Either pin a vite config that binds dual-stack
  (`server.host: '0.0.0.0'` or similar) or accept localhost-only as the
  permanent norm. The current fix is robust enough that no upstream change
  is required.

### Sub-project 5 — Frontend Vitest expansion (entirely deferred)

- **Affected**: Frontend test surface broadly
- **What's happening**: A planned expansion of frontend Vitest coverage was
  skipped in favor of the Playwright E2E pass (Sub-project 6). The existing
  40 Vitest tests cover `aiModes` (22), `aiProviderResolver` (4),
  `modePrompts` (8), Pact contracts (4), and a smoke `App` render (2).
  Rationale for skipping: Playwright drives the user-facing behaviour
  end-to-end across 181 specs, which subsumes the marginal Vitest cases.
- **Re-cover when**: A bug class emerges that's hard to reproduce through
  Playwright (e.g. a state-management race in a hook, a memoization-correctness
  bug in a context provider) — those are the natural Vitest territory.

### Sub-project 2 — AI integration test parallel-execution flake

- **Affected**: `coverage_ai_integration.rs` (26 tests)
- **What's happening**: Two tests
  (`ai_integration_knowledge_pack_injected_via_profile_weights` and
  `ai_integration_sanitize_optional_ip_when_enabled`) intermittently fail
  when the suite runs with cargo's default parallelism. Both pass when run
  individually or with `--test-threads=1`. Root cause: shared agent state
  (sanitization config, profile state) is global to the agent process, so
  one test's `PUT /api/settings/ai.sanitization_config` can race another
  test's `POST /api/ai/agent-chat` if they overlap.
- **Workaround**: The cold-start command block above runs this suite with
  `--test-threads=1`. With that flag all 26 tests are green from cold
  start.
- **Fix later**: Either make the affected tests serializable via a
  per-test setup-restore sequence (snapshot config, mutate, run, restore)
  or mark the suite `#[serial]` (requires the `serial_test` crate). Lower
  priority than other gaps because the workaround is one CLI flag.

---

## Drift-detection mechanism

Three pieces, all committed, that together prevent silent route-coverage
drift:

1. **`agent/src/tracked_router.rs`** — `TrackedRouter<S>` wrapper around
   `axum::Router<S>`. Captures `(path, methods)` on every `.route()` call.
   `nest_tracked()` merges nested sub-routers with the prefix prepended so
   the aggregated list reflects the full URL surface. Method detection uses
   the `MethodRouter` Debug repr (axum 0.7 doesn't expose a public accessor);
   covered by `agent/tests/tracked_router_test.rs`.
2. **`agent/src/dev.rs`** — `GET /api/dev/routes` returns the live
   `Vec<RouteInfo>` from the global `OnceLock` populated by `main.rs` at
   startup. Cfg-gated `#[cfg(any(debug_assertions, feature = "dev-routes"))]`
   — absent from release builds (verified via
   `strings target/release/netstacks-agent | grep '/dev/routes'` returning 0).
3. **`tests/api/tests/coverage_drift.rs`** — hits `/api/dev/routes`,
   cross-references the response against the hand-maintained
   `EXPECTED_COVERAGE` constant (~227 entries) and `INTENTIONALLY_UNCOVERED`
   constant (currently empty), and panics with a precise diff if anything
   drifts.

**The contract**: adding a route in `main.rs` without adding a test +
`EXPECTED_COVERAGE` entry now fails the suite. Removing a covered route
without removing its `EXPECTED_COVERAGE` row also fails. The drift test is
the single authoritative source for "what's the agent's HTTP surface and
who proves it works."

Tracked router commits: `9110e76` (wrapper), `4dfc95b` (wire into main.rs),
`db2bba7` (`/dev/routes` endpoint).

---

## Recommendations for ongoing maintenance

Practical advice for the next operator who touches this suite:

1. **Adding a new agent route**: the drift test will fail until you add a
   row to `EXPECTED_COVERAGE` in `coverage_drift.rs` AND a real test with a
   `// COVERS: METHOD /path` marker pointing at that row. If the route is
   intentionally uncovered (e.g. an experimental endpoint), add it to
   `INTENTIONALLY_UNCOVERED` instead — but document why in the same edit.

2. **Before merging backend changes**: run
   `./run-tests.sh all && ./run-tests.sh cov` from `tests/`. Cold-start
   isn't required for incremental edits, but if you've touched
   `main.rs` route registration, re-run from a `teardown.sh` →
   `setup-mocks.sh` cycle to confirm the agent boots clean.

3. **Before merging frontend changes**: run `npm run test` in `frontend/`
   AND the Playwright suite in `tests/e2e/` (start vite externally first —
   see cold-start command block). The Vitest pass is fast (~7s); Playwright
   is ~14 minutes for the full 181 specs.

4. **When AI/MCP behaviour changes**: re-run the integration suites with
   `--test-threads=1` (AI) or default parallelism (MCP). The mock LLM
   (`tests/mocks/llm-server/server.py`) and mock MCP
   (`tests/mocks/mcp-server/server.py`) are designed as extension points —
   add new triggers (e.g. `test:new_scenario` in user content) when new
   test scenarios emerge, rather than spawning new mock containers. Both
   mocks are gitignored along with the rest of `tests/`.

5. **When something flakes**: the SFTP host-key TOFU and the Playwright
   managed-`webServer` flake are the two known infrastructure annoyances.
   If you see an unrelated flake on first hit, retry once before treating
   it as a real regression — many tests touch shared agent state, and
   parallelism races (see Sub-project 2 entry above) can produce
   intermittent failures even on a clean tree.

6. **Don't commit tests/**: the entire `tests/` directory is gitignored
   except for `docs/superpowers/` and the agent-side `agent/` /
   `frontend/` source. Test files, mock servers, and the `.agent-token`
   live locally only. Commits in this program (drift router, `/dev/routes`,
   TESTING-GAPS.md updates) all touched committed code paths.

7. **When the program's grand total drifts**: 490 is the expected
   green-from-cold-start count as of 2026-05-02. If a suite count rises,
   add the tests' purpose to the per-sub-project final-pass-status section
   (or open a new sub-project section for non-trivial expansions). If a
   suite count falls, investigate before merging — silent test deletion
   is what this program existed to prevent.

---

## Per-sub-project final pass status (historical record)

The remaining sections preserve each sub-project's final-pass-status
record exactly as filed when the sub-project shipped, for future
debugging context.

### Sub-project 0 — Foundation cleanup

Cold-start re-run of `./run-tests.sh all`:

| Phase | Tests | Status |
|---|---|---|
| 1  Foundation         | 9  | green |
| 2  Sessions           | 12 | green |
| 3  AI + Sanitization  | 41 | green (mock LLM round-trips now exercised, gap fixed 2026-05-02) |
| 4  Terminal/WebSocket | 13 | green |
| 5  Features           | 16 | green |
| 6  SNMP/Discovery     | 13 | green |
| 8  Edge Cases         | 16 | green |
| 14 Devices            | 14 | green (was 19; 5 removed-feature deletions) |
| 15 MOP Steps          | 11 | green (was 12; 1 removed-feature deletion) |
| **Total**             | **145** | **all green** |

Frontend Vitest at sub-project 0 close: 36/36 green
(App + aiModes + modePrompts + 2 Pact contracts).

#### Mock LLM fix (commit 988c433, 2026-05-02)

The `configure_mock_llm()` helper had two shape bugs that compounded to
produce a silent 503:

1. The JSON used field name `api_url`, but the agent's `AiSettingsConfig`
   expects `base_url` (see `agent/src/ai/chat.rs:390`). `api_url` was
   silently ignored by serde, so the agent fell back to its default
   `https://api.anthropic.com` and never reached the mock.
2. The JSON included `api_key`, but the agent reads the API key from the
   **vault** (`get_api_key("ai.<provider>")`, see `chat.rs:494-502`), not
   from the settings JSON. The vault was never unlocked nor populated, so
   the agent returned 503 with `"Vault is locked"` — which the test
   misread as a generic "provider config wrong" 503 and silently skipped.

Fix: rewrote `configure_mock_llm()` in `tests/api/tests/phase3_ai.rs`
(gitignored) to (a) call `ensure_vault_unlocked()`, (b) PUT the mock key
to `/vault/api-keys/ai.anthropic`, (c) PUT the provider config with
`base_url` instead of `api_url`. Also removed the silent-skip 503 branch
and tightened each test to assert the mock-LLM signature ("Mock LLM
response to:", profile name "MockTestEngineer", `system_prompt_length`
delta vs baseline) so future regressions fail loud.

Verified: all 4 `ai_mock_llm_*` tests pass with real round-trips
(parallel + serial). Full phase3_ai suite: 41/41 green.

### Sub-project 1 — Backend API coverage

Completed 2026-05-02. See
`docs/superpowers/specs/2026-05-02-backend-api-coverage-design.md` and
`docs/superpowers/plans/2026-05-02-backend-api-coverage.md`.

**Purpose:** add a happy-path round-trip test for every uncovered HTTP route on
the standalone agent, plus a drift-detection mechanism that fails the suite
when a route is added without a covering test.

**Outcome:** 94 net-new tests across 30 categories, 1 drift test, all green
from cold start. Combined with the 145 retained phase tests this gives 240
tests in the sweep at sub-project 1 close.

#### Routes newly covered

30 per-category test files, all under `tests/api/tests/coverage_*.rs`
(gitignored). Counts below are tests / `// COVERS:` route markers — many
tests cover multiple routes via consolidated lifecycle tests.

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

`terminals` was not given a `coverage_*.rs` file — Phase 4 already exercises
the WebSocket terminal route end-to-end, so `EXPECTED_COVERAGE` marks those
entries `EXISTING_PHASE_TEST`.

### Sub-project 2 — AI integration tests

Completed 2026-05-02. Builds on Sub-project 0's mock-LLM round-trip fix to
convert the four `phase3_ai::ai_mock_llm_*` smoke probes into a comprehensive
end-to-end suite that proves the wires between `/api/ai/*` endpoints and a
Claude-compatible provider actually carry sanitization, profile injection,
mode-prompt overrides, AI memories, knowledge-pack content, tool definitions,
and SSE stream events.

**Artifact:** `tests/api/tests/coverage_ai_integration.rs` (gitignored — 26
net-new tests, all green from cold start with `--test-threads=1`).

#### Coverage added (9 areas, 26 tests)

| Area | Tests | What's now proven |
|---|---:|---|
| 1. Sanitization round-trip                 | 8 | `SanitizingProvider` actually scrubs user messages AND `system_prompt` BEFORE the LLM sees them. Covers Cisco enable-secret hashes, generic `password=`, SNMP communities, RSA private keys, AWS access keys, optional IP redaction (when toggled in `ai.sanitization_config`), system-prompt scrubbing on `/agent-chat`, and a "safe text passes through unaltered" sentinel. |
| 2. Profile injection edge cases            | 2 | (a) Profile with rich fields (multi-vendor weights, multiple safety rules) flows through to the system prompt verbatim. (b) `DELETE /api/ai/profile` actually removes personality from the next chat's system prompt — tested with a unique sentinel name. |
| 3. Mode-prompt overrides                   | 3 | The `feat/ai-mode-prompt-overrides` branch is **frontend-only** — see below. Tests prove the agent-side guarantees the feature depends on. |
| 4. Tool use                                | 3 | `tools` array forwarded to the LLM verbatim; multi-turn `tool_result → final assistant text` cycle works. |
| 5. Streaming                               | 2 | `/api/ai/agent-chat-stream` actually emits SSE events. |
| 6. AI memories injection                   | 2 | Memories created via `POST /api/ai/memory` appear in the next agent-chat's system prompt under a `NETWORK MEMORY` header. |
| 7. Knowledge-pack injection                | 1 | A profile with vendor + domain weights pulls in the matching packs. |
| 8. Generate-script constraints             | 3 | Default and non-python fences parsed; provider error → 5xx with structured JSON. |
| 9. Mode-aware analyze-highlights           | 2 | Round-trip works through the mock LLM with a small highlights array. |

#### Mock LLM extensions

Three additive triggers in `tests/mocks/llm-server/server.py` —
`test:echo_messages`, `test:echo_system`, `test:tool_use`, `test:script_cisco`,
`test:script_error`, plus full SSE support on `stream: true`. Existing scenarios
unchanged. Multi-turn tool branch added to handle `tool_result` follow-ups.

### Sub-project 4 — MCP integration tests

Completed 2026-05-02. Closes the gap left by Sub-project 1 wave 5, which only
exercised the `/api/mcp/*` error paths against a non-existent stdio command.
This wave adds an end-to-end happy-path round-trip against a real MCP server
(a self-contained Python stdio mock).

**Artifacts (gitignored):**
- `tests/mocks/mcp-server/server.py` — stdio JSON-RPC mock MCP server
  (echo / add / get_time tools, MCP protocol version 2025-03-26 to match
  `rmcp 0.14`'s `ProtocolVersion::LATEST`).
- `tests/api/tests/coverage_mcp_integration.rs` — 3 new integration tests,
  all green from cold start.

**Committed:**
- `tests/api/tests/coverage_drift.rs` — `EXPECTED_COVERAGE` entries for 5 of
  the 6 MCP routes now point at `coverage_mcp_integration.rs::mcp_full_lifecycle_with_mock_server`.

#### Coverage added (3 tests)

| Test | What's now proven |
|---|---|
| `mcp_full_lifecycle_with_mock_server` | The canonical happy-path probe: create stdio server → connect → assert `connected=true` and 3 tools discovered → `GET /mcp/servers` shows the same 3 tools with stable IDs → `input_schema` flows through verbatim → tools default to disabled (execute returns 404) → enable echo + add → `tools/call echo {text}` returns `echo:<text>` → `tools/call add {a,b}` returns the sum as a string → bad-args call surfaces as `is_error=true` (HTTP 200, MCP-spec compliant) → disable echo, execute returns 404 → disconnect → `connected=false` in list → DELETE 204 |
| `mcp_reconnect_idempotent` | Connect-disconnect-reconnect cycle proves: tool count stays exactly 3 across reconnects (no duplicate inserts in the `mcp_tools` table — the `ON CONFLICT(server_id, name) DO UPDATE` upsert is doing its job); tool IDs are deterministic and stable across reconnects, so per-tool enabled flags survive a disconnect (verified by ID-set equality across two connect calls). |
| `mcp_connect_to_non_mcp_command_fails_cleanly` | Complements `coverage_mcp::mcp_server_lifecycle_round_trip`'s "non-existent path" case by pointing at `/usr/bin/true`. Asserts the agent surfaces a structured `{error, code}` response (4xx/5xx) instead of panicking or hanging. |

### Sub-project 6 — Playwright E2E pass

Completed 2026-05-02. The standalone Playwright suite under `tests/e2e/tests/`
had never been run since Sub-project 0's config fix
(`../../terminal/frontend` → `../../frontend`). This sub-project ran it cold,
verified all 19 spec files green, and added one new spec for the
previously-shallow AI mock-LLM round-trip.

#### Final pass status

| Suite | Tests | Status |
|---|---:|---|
| Existing 19 specs (`tests/e2e/tests/*.spec.ts`) | 179 | green |
| `ai-mock-roundtrip.spec.ts` (NEW) | 2 | green |
| **Total** | **181** | **green from cold start (with vite started externally)** |

Coverage that already existed: app-loads, navigation, panels, responsive,
tab-management, status-bar, sessions, session-workflows, dialogs,
keyboard-shortcuts, command-palette, settings, settings-tabs, settings-deep,
ai-panel, ai-chat, scripts-docs, topology, terminal-features.

New `ai-mock-roundtrip.spec.ts` wires the agent's `ai.provider_config` to
the mock LLM container in `beforeAll`, then drives the AI panel from the
UI: fills input, submits via Enter (no stable testid on the idle send
button — see gaps section above), and asserts the assistant response from
the mock LLM lands in `[data-testid="ai-messages"]` within 20s. Also
round-trips a second user message in the same session.
