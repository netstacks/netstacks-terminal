# Backend API Coverage — Sub-Project 1 Design

**Date:** 2026-05-02
**Status:** Approved
**Parent program:** Comprehensive test coverage for netstacks-terminal (8 sub-projects)
**Predecessor:** Sub-project 0 (Test suite foundation cleanup) — `docs/superpowers/specs/2026-05-02-test-suite-foundation-design.md`
**Scope:** Add a happy-path round-trip test for every HTTP route on the standalone agent that isn't already covered by an existing phase test, plus drift-detection infrastructure that makes future coverage gaps a CI failure rather than a discovered surprise.

## Problem

The agent (`agent/src/main.rs`) registers **226 `.route()` definitions** producing approximately **223 method-handler endpoints** (72 GET — including 3 WebSocket upgrades, 113 POST, 19 PUT, 19 DELETE). Sub-project 0 left us with 145 phase tests passing green, but those tests cover only 80–100 endpoints conceptually. ~120–140 endpoints have no automated test today; among those covered, depth varies (some round-trip, some status-only).

There's also no mechanism to *detect* when new routes are added without coverage. A developer can add `/widgets/:id` to the agent today and the test suite stays green — the gap simply grows.

## Goals

- Every endpoint registered on the agent's `/api` router (including the `/ws/*` upgrade routes mounted under it) has at least one test that exercises it round-trip — status + schema + data round-trip where applicable; status + error-shape for proxy/external endpoints; smoke connect for WebSockets.
- A drift-detection test fails CI if a developer adds a route without a covering test (or removes a route without removing its test).
- The new tests integrate with the existing test runner (`run-tests.sh`, `run-phase.sh`) without disrupting the existing 145 phase tests.
- "Done" means **every retained test plus every new coverage test produces green output from a cold-started infrastructure**, and `coverage_drift.rs` passes — no uncovered routes, no stale entries.

## Non-Goals

- Re-covering routes that existing phase tests already cover round-trip (delta-only scope).
- Building mock servers for NetBox / LibreNMS / Netdisco (use stub-at-config instead — point the agent at unreachable URLs and assert the error shape).
- Negative testing (auth failures, malformed bodies, race conditions) beyond what the existing Phase 8 (edge cases) already covers — that's later sub-project work.
- Performance / load testing — out of scope.
- Migrating existing phase tests into the new `coverage_*.rs` structure — they stay where they are.
- Streaming-protocol verification on WebSocket endpoints beyond a smoke connect/close (full WS protocol round-trip is Sub-project 6 / E2E territory).
- Building or maintaining an OpenAPI spec — explicitly considered and rejected as out-of-scope for this sub-project.

## Architecture

Four sequential phases:

1. **Phase A — Audit & extract.** Two scripts run once at the start to characterize the route surface and the coverage delta. Output is the work queue for Phase C.

2. **Phase B — Drift-detection infrastructure.** Add a `TrackedRouter` wrapper to the agent that captures every route as it's registered; expose the captured list via a dev-only `GET /api/dev/routes` endpoint; add `coverage_drift.rs` that diffs the live list against an `EXPECTED_COVERAGE` constant. This phase produces the enforcement mechanism that all subsequent work feeds.

3. **Phase C — Per-category test files.** ~13 new files in `tests/api/tests/`, each named `coverage_<area>.rs`. Tests are self-contained (create their own fixtures, tear them down). Each test annotated with a `// COVERS: METHOD /path` marker comment so future audits can re-derive coverage from source. Categories worked in difficulty order (cheapest, highest-confidence first → riskiest last).

4. **Phase D — Reproducibility & integration.** Cold-start re-run of the full suite (existing 145 + new ~85 = ~230 tests). Update `run-tests.sh` to add a `cov` aggregate target. Document final pass status in `TESTING-GAPS.md`.

## Components

### Files added in `agent/` (committed)

| Path | Purpose |
|---|---|
| `agent/src/tracked_router.rs` | Thin wrapper around `axum::Router`. Records `(path, methods)` on every `.route()` call and exposes the captured list via a `OnceCell<Vec<RouteInfo>>`. ~50 lines. |
| `agent/src/main.rs` (modified) | Replace `Router::new()` with `TrackedRouter::new()` for the `/api` router. Add `GET /api/dev/routes` handler gated by `#[cfg(any(debug_assertions, feature = "dev-routes"))]`. |
| `agent/Cargo.toml` (modified) | Add `dev-routes` feature flag (default-off). |

### Files added in `tests/` (local — `tests/` is gitignored)

| Path | Purpose |
|---|---|
| `tests/scripts/extract-routes.sh` | awk over `agent/src/main.rs` → emits `(method, path)` pairs to `tests/coverage/agent-routes.txt`. |
| `tests/scripts/audit-existing-coverage.sh` | Greps phase tests + new coverage tests for path literals AND `// COVERS:` markers; normalizes parameterized paths (e.g. `/sessions/{uuid}` → `/sessions/:id`); emits `tests/coverage/already-covered.txt`. |
| `tests/coverage/agent-routes.txt` | Generated. Source-of-truth route list (regenerable). |
| `tests/coverage/already-covered.txt` | Generated. Routes already touched by existing tests. |
| `tests/coverage/delta.txt` | Generated. Diff = work queue for Phase C. |
| `tests/api/tests/coverage_lookups.rs` | `/lookup/{oui,dns,whois,asn}` (~4 routes; OUI is real round-trip, DNS/WHOIS/ASN stubbed at config level). |
| `tests/api/tests/coverage_vault.rs` | Vault delta — biometric + api-key endpoints not yet covered (~6 routes). |
| `tests/api/tests/coverage_recordings.rs` | `/recordings/:id/{data,append,save-to-docs}` (~3 routes; create→append→save round-trip). |
| `tests/api/tests/coverage_changes.rs` | `/changes/*`, MOP import/export, snapshots, highlight rules (~6 routes; round-trip). |
| `tests/api/tests/coverage_topologies.rs` | `/topologies/*` CRUD + device CRUD + connection CRUD (~12 routes; nested round-trip). |
| `tests/api/tests/coverage_imports.rs` | `bulk-command`, `sessions/{import,export,bulk-delete}`, `folders/:id/export`, `logs/append` (~6 routes; involves file/binary payloads). |
| `tests/api/tests/coverage_netbox.rs` | NetBox proxy + source mgmt (~12 routes; stubbed upstream → assert error shape). |
| `tests/api/tests/coverage_librenms.rs` | LibreNMS proxy + source mgmt (~6 routes; same pattern). |
| `tests/api/tests/coverage_netdisco.rs` | Netdisco proxy + source mgmt (~7 routes; same pattern). |
| `tests/api/tests/coverage_ai_files.rs` | `/ai/{write-file,edit-file,patch-file,ssh-execute}` + `/ai/profile/*` + `/ai/memory/*` + `/ai/config-mode/*` + `/ai/{sanitization/test,analyze-highlights,knowledge-pack-sizes}` (~15 routes; mix). |
| `tests/api/tests/coverage_sftp.rs` | `/sftp/:id/{ls,download,upload,mkdir,rm,rename,stat,disconnect,connect}` (~9 routes; real SFTP via mock SSH). |
| `tests/api/tests/coverage_websockets.rs` | `/ws/{topology-live,tasks}` smoke (~2 routes; `/ws/terminal` already covered by Phase 4). |
| `tests/api/tests/coverage_drift.rs` | Single test: hits `/api/dev/routes`, cross-checks `EXPECTED_COVERAGE` constant. |

**Approximate net-new test count:** ~85 (many "delta" routes cluster into single round-trip tests — e.g. one topology test creates topology + device + connection covering 6 routes).

### Files updated in `tests/` (local)

| Path | Change |
|---|---|
| `tests/scripts/run-phase.sh` | Add `coverage <area>` and `coverage-all` modes. |
| `tests/run-tests.sh` | Add `cov` command + "Coverage Sweep" section in the menu. |
| `tests/README.md` | Section explaining coverage tests + how to regenerate the manifest. |

### Files updated (committed)

| Path | Change |
|---|---|
| `docs/superpowers/TESTING-GAPS.md` | Append Sub-project 1 results section (delta routes now covered, deferred routes with reasons, agent bugs fixed). |

## Data Flow & Test Patterns

### Pattern 1: CRUD round-trip (canonical)

For endpoint groups that form a CRUD set (topologies, recordings, changes, AI memories, etc.) — one test exercises the full lifecycle:

```rust
#[tokio::test]
async fn topology_full_round_trip() {
    let client = TestClient::new().await.expect("client");

    // CREATE — COVERS: POST /topologies
    let create = client.post("/topologies", &topology_body("test-topo")).await.unwrap();
    TestClient::assert_ok(&create, "create topology");
    let body: Value = create.json().await.unwrap();
    let id = body["id"].as_str().expect("id field").to_string();
    assert_eq!(body["name"], "test-topo");

    // READ — COVERS: GET /topologies/:id
    let get = client.get(&format!("/topologies/{}", id)).await.unwrap();
    TestClient::assert_ok(&get, "get topology");
    let got: Value = get.json().await.unwrap();
    assert_eq!(got["id"], id);
    assert_eq!(got["name"], "test-topo");

    // UPDATE — COVERS: PUT /topologies/:id
    let upd = client.put(&format!("/topologies/{}", id), &json!({"name": "renamed"})).await.unwrap();
    TestClient::assert_ok(&upd, "update topology");

    // LIST — COVERS: GET /topologies
    let list = client.get("/topologies").await.unwrap();
    TestClient::assert_ok(&list, "list topologies");
    let arr: Vec<Value> = list.json().await.unwrap();
    assert!(arr.iter().any(|t| t["id"] == id), "created topology in list");

    // DELETE — COVERS: DELETE /topologies/:id
    let del = client.delete(&format!("/topologies/{}", id)).await.unwrap();
    TestClient::assert_ok(&del, "delete topology");

    // VERIFY GONE — confirm delete actually deleted
    let after = client.get(&format!("/topologies/{}", id)).await.unwrap();
    TestClient::assert_status(&after, StatusCode::NOT_FOUND, "topology gone after delete");
}
```

One test, five route coverage markers, real data round-trip including delete/404 verification.

### Pattern 2: Stub-and-assert for proxy / external endpoints

For endpoints that depend on an external service (NetBox / LibreNMS / Netdisco proxies; DNS / WHOIS / ASN lookups) — point the agent at an unreachable upstream and assert the error response is well-formed:

```rust
#[tokio::test]
async fn netbox_sites_proxy_returns_upstream_error() {
    let client = TestClient::new().await.expect("client");

    // Source pointing at unreachable upstream
    let src = client.post("/netbox-sources",
        &json!({"name": "test-nb", "url": "http://127.0.0.1:1", "token": "fake"}))
        .await.unwrap();
    TestClient::assert_ok(&src, "create netbox source");
    let src_id = src.json::<Value>().await.unwrap()["id"].as_str().unwrap().to_string();

    // COVERS: GET /netbox/proxy/sites
    let resp = client.get(&format!("/netbox/proxy/sites?source_id={}", src_id)).await.unwrap();
    let status = resp.status();
    let body: Value = resp.json().await.unwrap();
    assert!(
        status == StatusCode::BAD_GATEWAY || status == StatusCode::SERVICE_UNAVAILABLE,
        "expected 502/503 for unreachable upstream, got {}", status
    );
    assert!(body.get("error").is_some(), "error response must include `error` field");
}
```

Tests prove: route is registered, handler runs, handler reaches out, failure is classified correctly, error shape is consistent. We don't test what NetBox returns — we test what the agent does when it can't talk to NetBox.

### Pattern 3: WebSocket smoke

For `/ws/topology-live` and `/ws/tasks` — connect, receive at least one message OR confirm clean acceptance, close cleanly:

```rust
#[tokio::test]
async fn topology_live_ws_smoke() {
    let url = format!("{}?token={}", ws_url("/topology-live"), env::var("TEST_AGENT_TOKEN").unwrap());
    let (ws, _) = connect_async(&url).await.expect("connect");
    // COVERS: WS /ws/topology-live
    let mut ws = ws;
    // Wait for first frame OR allow clean close after timeout
    let _ = tokio::time::timeout(Duration::from_secs(2), ws.next()).await;
    ws.close(None).await.expect("clean close");
}
```

Full protocol round-trip (live edits propagating across clients) is deferred to Sub-project 6.

### Pattern 4: Drift detection

`EXPECTED_COVERAGE` is a hand-maintained constant in `coverage_drift.rs`:

```rust
const EXPECTED_COVERAGE: &[(&str, &[&str], &str)] = &[
    ("/health", &["GET"], "phase1_health.rs::health_endpoint"),
    ("/sessions", &["GET", "POST"], "phase2_sessions.rs::session_crud"),
    ("/topologies", &["GET", "POST"], "coverage_topologies.rs::topology_full_round_trip"),
    // ... ~150 entries, one per agent route ...
];

const INTENTIONALLY_UNCOVERED: &[(&str, &str, &str)] = &[
    // (path, method, reason)
    // Example: ("/some/route", "POST", "Requires real LDAP server; mock TBD in Sub-project 6"),
];

#[tokio::test]
async fn no_uncovered_routes() {
    let client = TestClient::new().await.expect("client");
    let resp = client.get("/dev/routes").await.expect("dev/routes endpoint");
    TestClient::assert_ok(&resp, "GET /api/dev/routes");
    let live: Vec<RouteInfo> = resp.json().await.unwrap();

    let expected: HashSet<(&str, &str)> = EXPECTED_COVERAGE
        .iter()
        .flat_map(|(p, ms, _)| ms.iter().map(move |m| (*p, *m)))
        .chain(INTENTIONALLY_UNCOVERED.iter().map(|(p, m, _)| (*p, *m)))
        .collect();
    let actual: HashSet<(String, String)> = live
        .iter()
        .flat_map(|r| r.methods.iter().map(|m| (r.path.clone(), m.clone())))
        .collect();

    let uncovered: Vec<_> = actual.iter()
        .filter(|(p, m)| !expected.contains(&(p.as_str(), m.as_str())))
        .collect();
    let stale: Vec<_> = expected.iter()
        .filter(|(p, m)| !actual.iter().any(|(ap, am)| ap == p && am == m))
        .collect();

    assert!(
        uncovered.is_empty() && stale.is_empty(),
        "Coverage drift detected.\nUncovered routes (in agent, not in EXPECTED_COVERAGE): {:#?}\nStale entries (in EXPECTED_COVERAGE, not in agent): {:#?}",
        uncovered, stale
    );
}
```

When a developer adds `/widgets/:id` to the agent and forgets coverage, this test fails with `Uncovered routes: [("/widgets/:id", "GET")]`. They must either add a real test (and the entry to `EXPECTED_COVERAGE`) or add an `INTENTIONALLY_UNCOVERED` entry with a stated reason.

## Verification Flow

```bash
# Phase A: Audit & extract (one-time setup)
cd /Users/cwdavis/scripts/netstacks-terminal/tests
./scripts/extract-routes.sh           # → coverage/agent-routes.txt
./scripts/audit-existing-coverage.sh  # → coverage/already-covered.txt
diff <(sort coverage/agent-routes.txt) <(sort coverage/already-covered.txt) > coverage/delta.txt

# Phase B: Drift infrastructure
# - Add agent/src/tracked_router.rs
# - Wire TrackedRouter into agent/src/main.rs
# - Add /api/dev/routes handler (cfg-gated)
# - cargo build && cargo test --manifest-path agent/Cargo.toml
# - Build initial EXPECTED_COVERAGE table from agent-routes.txt
# - Add coverage_drift.rs; assert it passes (table = source-of-truth)

# Phase C: Per-category test files (in difficulty order)
for AREA in lookups vault recordings changes topologies imports \
            netbox librenms netdisco ai_files sftp websockets; do
    ./scripts/run-phase.sh coverage $AREA
    # Don't move on until green
done

# Phase D: Reproducibility & integration
./scripts/teardown.sh && ./scripts/setup-mocks.sh
./run-tests.sh all                  # full suite, cold start: 145 + ~85 = ~230 tests
./run-tests.sh cov                  # coverage-only aggregate
```

### Difficulty ordering for Phase C

Cheapest, highest-confidence first; highest-coupling-risk last:

1. **`lookups`** — 4 routes; mostly trivial.
2. **`vault`** — 6 delta routes; mostly status assertions.
3. **`recordings`** — 3 routes; simple round-trip.
4. **`changes`** — 6 routes; round-trip.
5. **`topologies`** — 12 routes; nested CRUD, biggest pure-CRUD case.
6. **`imports`** — 6 routes; involves file/binary payloads.
7. **`netbox`, `librenms`, `netdisco`** — proxy stubs, ~25 routes total.
8. **`ai_files`** — 15 routes; depends on AI provider configured/stubbed; filesystem write permissions.
9. **`sftp`** — 9 routes; depends on mock SSH SFTP subsystem (highest mock-coupling risk).
10. **`websockets`** — 2 routes; smoke-only but easy to leak connections.

## Per-Category Failure Decision Tree

Same as Sub-project 0:

```
test fails in coverage_<area>
  │
  ├── Does the test assert on a JSON shape / status code that the live agent disagrees with?
  │     │
  │     ├── Is the live agent's behavior correct for the current product?
  │     │     ├── YES → STALE TEST. Update assertion. Commit (n/a — tests/ gitignored).
  │     │     └── NO  → REAL BUG. Fix agent. Commit: fix(<area>): <what>.
  │     │
  │     └── (re-run category)
  │
  └── Does the test exercise a feature that no longer exists?
        ├── YES → REMOVED FEATURE. Delete test. Log in TESTING-GAPS.md.
        │        ALSO remove the entry from EXPECTED_COVERAGE so coverage_drift stays green.
        └── (re-run category)
```

## Error Handling

- **Agent build failure when wiring `TrackedRouter`** → block; `Router::new()` → `TrackedRouter::new()` is a non-trivial change because of axum's type machinery. If the wrapper can't be made type-compatible, fall back to a `static ROUTES: &[(&str, &[Method])]` constant maintained alongside the router with a unit test that asserts both lists agree.
- **`/api/dev/routes` accessible in release builds** → block; verify with `cargo build --release && grep -c "dev/routes"` on the binary symbols, or attempt the endpoint and assert 404.
- **Mock SSH SFTP subsystem incomplete** → likely root cause of `coverage_sftp` failures. Diagnose mock vs. agent before declaring an agent bug. If mock needs fixing, that's in scope (mock servers are tests/ infrastructure, local-only).
- **Test resource leakage** → mitigated by `test_name(prefix)` UUID suffixes; `setup-mocks.sh` wipes the test DB between full runs. Per-test runs may leave artifacts (acceptable).
- **`/dev/routes` security** → endpoint requires the agent token even in dev; returns route metadata only (paths + methods, no handler internals). Information leak is bounded.
- **Long-running endpoint timeouts** → `TestClient` 30s timeout is preserved. If a coverage test hits 30s, that's a real performance issue worth surfacing — don't bump the timeout to mask it.
- **Reproducibility failure in Phase D** → fix the root cause (test ordering, leftover state, race). Don't accept flakes.

## Deliverables

### Committed (in main repo)

- `agent/src/tracked_router.rs` (router wrapper, ~50 lines)
- `agent/src/main.rs` modified (wire wrapper + `/api/dev/routes` handler, ~30 line delta)
- `agent/Cargo.toml` modified (add `dev-routes` feature)
- `docs/superpowers/specs/2026-05-02-backend-api-coverage-design.md` (this design)
- `docs/superpowers/plans/2026-05-02-backend-api-coverage.md` (implementation plan, written next)
- `docs/superpowers/TESTING-GAPS.md` (appended Sub-project 1 section)
- Any agent bug fixes surfaced during Phase C, each with `fix(<area>):` commit

### Local-only (in `tests/`)

- `tests/scripts/extract-routes.sh`
- `tests/scripts/audit-existing-coverage.sh`
- `tests/coverage/` directory with `agent-routes.txt`, `already-covered.txt`, `delta.txt`
- `tests/api/tests/coverage_*.rs` (~13 files)
- `tests/api/tests/coverage_drift.rs`
- `tests/scripts/run-phase.sh` extended with `coverage` subcommand
- `tests/run-tests.sh` extended with `cov` command + Coverage Sweep menu section
- `tests/README.md` updated

## Done Criteria

Sub-project 1 is done when ALL of the following are true:

1. `agent/src/tracked_router.rs` exists; `Router::new()` replaced with `TrackedRouter::new()` for the `/api` router.
2. `GET /api/dev/routes` returns the live route list in dev/test builds; absent from release builds (verified by attempting the endpoint against a `--release` binary and getting 404).
3. `EXPECTED_COVERAGE` constant in `coverage_drift.rs` matches the live route list 1:1 — every entry points to either a real test or an `INTENTIONALLY_UNCOVERED` entry with a stated reason.
4. Every new `coverage_*.rs` file passes green from cold start.
5. `./run-tests.sh all` passes ~230 tests (145 existing + ~85 new) green from cold start.
6. `coverage_drift.rs` passes — no uncovered routes, no stale table entries.
7. `docs/superpowers/TESTING-GAPS.md` Sub-project 1 section lists: routes deferred to later sub-projects, agent bugs fixed, mock infrastructure changes.
8. Any agent bugs fixed during verification have their own `fix(<area>):` commits.

## Open Questions

- **`tests/coverage/` location.** Recommend keeping inside the gitignored `tests/` directory (regenerable from `agent/src/main.rs` anyway). Hoisting to a committed location adds maintenance burden without benefit.
- **Path normalization in `audit-existing-coverage.sh`.** Should recognize parameterized paths (`/sessions/{any-uuid}` in test code maps to `/sessions/:id` in the route table). The script must normalize before diffing or the audit will spuriously report duplicates as gaps.
- **`TrackedRouter` implementation strategy.** Leading approach: wrapper that captures `(path, method)` on every `.route()` chain. Fallback: parallel `static ROUTES` constant with a unit test that asserts both agree. Decided at implementation time when axum's type signatures are concrete.
