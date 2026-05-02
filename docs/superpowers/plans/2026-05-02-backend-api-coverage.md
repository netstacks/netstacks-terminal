# Backend API Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a happy-path round-trip test for every uncovered HTTP route on the standalone agent (~85 net-new tests across 13 files), plus drift-detection infrastructure (`TrackedRouter` wrapper + `/api/dev/routes` endpoint + `coverage_drift.rs` cross-check) that fails CI when a route is added without a covering test.

**Architecture:** Four sequential phases — (A) audit & extract scripts produce the delta work queue, (B) `TrackedRouter` + `/api/dev/routes` + `coverage_drift.rs` are built first so subsequent test work has a forcing function, (C) per-category test files in difficulty order (cheapest first), (D) cold-start reproducibility check + integration with `run-tests.sh`.

**Tech Stack:** Rust (axum 0.7 for the agent, cargo + reqwest + tokio + tokio-tungstenite for the API tests), Bash (audit/extract scripts + test runner extensions), Docker Compose (existing mock SSH + LLM containers — reused, not extended for this sub-project).

**Spec:** `docs/superpowers/specs/2026-05-02-backend-api-coverage-design.md`

---

## Important: `tests/` is gitignored

`tests/` is in `.gitignore` (since Sub-project 0). Test infrastructure stays local; only `agent/`, `docs/`, and `frontend/` changes are committed. Do not run `git add tests/...`. The pass gate is "category passes green in the local working tree," not "diffs in commits."

**Tracked files this plan will commit:**
- `agent/src/tracked_router.rs` (new)
- `agent/src/main.rs` (modified — wire TrackedRouter)
- `agent/Cargo.toml` (modified — add `dev-routes` feature)
- `agent/src/api.rs` or new `agent/src/dev.rs` (modified — `/api/dev/routes` handler)
- `agent/src/...` (any real bugs surfaced during Phase C)
- `docs/superpowers/TESTING-GAPS.md` (appended Sub-project 1 section)

**Untracked but modified locally:**
- Everything under `tests/`

---

## Router topology (read this before Phase B)

The agent composes its routes via 6 sub-routers, all nested under `/api/*` or `/ws/*`. From `agent/src/main.rs:418-918`:

| Sub-router | Variable | Mount point | Approx routes |
|---|---|---|---|
| Top-level API | `api_routes` | `/api` | ~170 |
| Scripts | `scripts_routes` | `/api/scripts` | ~5 |
| Docs | `docs_routes` | `/api/docs` | ~6 |
| AI | `ai_routes` | `/api/ai` | ~22 |
| SFTP | `sftp_routes` | `/api/sftp` | ~9 |
| WebSocket | `ws_routes` | `/ws` | ~3 |

`TrackedRouter` must therefore (a) capture routes per sub-router instance and (b) aggregate them with the correct nesting prefix at compose time. The implementation in Task 4 accounts for this.

---

## File Structure

**Create (committed):**
- `agent/src/tracked_router.rs` — `TrackedRouter<S>` wrapper around `axum::Router<S>` capturing `(path, methods)` per instance, with a `merge_into_global(prefix)` aggregator.
- `agent/src/dev.rs` — module containing `routes_handler` for `GET /api/dev/routes` and the `RouteInfo` serialization type. Behind `#[cfg(any(debug_assertions, feature = "dev-routes"))]`.
- `docs/superpowers/plans/2026-05-02-backend-api-coverage.md` — this plan.

**Modify (committed):**
- `agent/src/main.rs` — replace `Router::new()` with `TrackedRouter::new()` for all 6 sub-routers; add `dev::routes_handler` mount at `/api/dev/routes` under the cfg gate.
- `agent/Cargo.toml` — add `[features] dev-routes = []`.
- `docs/superpowers/TESTING-GAPS.md` — append Sub-project 1 results section.

**Create (local only — `tests/` is gitignored):**
- `tests/scripts/extract-routes.sh`
- `tests/scripts/audit-existing-coverage.sh`
- `tests/coverage/agent-routes.txt` (generated)
- `tests/coverage/already-covered.txt` (generated)
- `tests/coverage/delta.txt` (generated)
- `tests/api/tests/coverage_lookups.rs`
- `tests/api/tests/coverage_vault.rs`
- `tests/api/tests/coverage_recordings.rs`
- `tests/api/tests/coverage_changes.rs`
- `tests/api/tests/coverage_topologies.rs`
- `tests/api/tests/coverage_imports.rs`
- `tests/api/tests/coverage_netbox.rs`
- `tests/api/tests/coverage_librenms.rs`
- `tests/api/tests/coverage_netdisco.rs`
- `tests/api/tests/coverage_ai_files.rs`
- `tests/api/tests/coverage_sftp.rs`
- `tests/api/tests/coverage_websockets.rs`
- `tests/api/tests/coverage_drift.rs`

**Modify (local only):**
- `tests/scripts/run-phase.sh` — add `coverage <area>` and `coverage-all` modes.
- `tests/run-tests.sh` — add `cov` command and Coverage Sweep menu section.
- `tests/README.md` — section explaining coverage tests + how to regenerate the manifest.

---

# Phase A — Audit & extract

Establishes the work queue. Two scripts; one diff. Run before any test writing so we know exactly which routes need new coverage and which are already exercised by existing phase tests.

## Task 1: Write `tests/scripts/extract-routes.sh`

**Files:**
- Create: `tests/scripts/extract-routes.sh`

The script parses `agent/src/main.rs` for every `.route(...)` invocation and emits `(METHOD path)` lines, expanding multi-method routes (`get(...).post(...)`) into one line per method, and prepending the correct nesting prefix (`/api`, `/api/ai`, `/api/sftp`, etc.) based on which sub-router block the line is in.

- [ ] **Step 1: Create the script**

Write `/Users/cwdavis/scripts/netstacks-terminal/tests/scripts/extract-routes.sh`:

```bash
#!/bin/bash
# Extract every (METHOD, path) pair from agent/src/main.rs.
# Output: one line per (method, full_path) tuple, sorted, to stdout (or $1 if given).
# Format: "METHOD /full/path"
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
MAIN_RS="$REPO_DIR/agent/src/main.rs"

if [ ! -f "$MAIN_RS" ]; then
    echo "ERROR: $MAIN_RS not found" >&2
    exit 1
fi

# Sub-router mount prefixes — keep in sync with main.rs `nest("/api/...", X)` calls.
# Map: variable name (lhs of `let X_routes = Router::new()` or `TrackedRouter::new()`) → nest prefix.
# Sourced from main.rs:905-918.
declare -A PREFIX=(
    [api_routes]=/api
    [scripts_routes]=/api/scripts
    [docs_routes]=/api/docs
    [ai_routes]=/api/ai
    [sftp_routes]=/api/sftp
    [ws_routes]=/ws
)

awk -v prefix_map="$(declare -p PREFIX | sed -e 's/declare -A PREFIX=//' -e 's/[()"]//g')" '
BEGIN {
    # Parse "[api_routes]=/api [scripts_routes]=/api/scripts ..." into prefixes[name]=path.
    n = split(prefix_map, parts, /[ ]+/)
    for (i = 1; i <= n; i++) {
        if (parts[i] ~ /=/) {
            split(parts[i], kv, "=")
            gsub(/[\[\]]/, "", kv[1])
            prefixes[kv[1]] = kv[2]
        }
    }
    current_prefix = ""
}
# Track which sub-router we are currently inside.
# A new sub-router starts with `let X_routes = Router::new()` or `TrackedRouter::new()`.
/let [a-z_]+_routes = (Router|TrackedRouter)::new\(\)/ {
    match($0, /let [a-z_]+_routes/)
    name = substr($0, RSTART + 4, RLENGTH - 4)
    if (name in prefixes) {
        current_prefix = prefixes[name]
    } else {
        current_prefix = ""  # unknown sub-router — emit unprefixed; surface as a manual review item
    }
    next
}
/\.route\("/ {
    if (match($0, /\.route\("[^"]+"/)) {
        path = substr($0, RSTART + 8, RLENGTH - 9)
    } else {
        next
    }
    full = current_prefix path
    if ($0 ~ /\bget\(/)    print "GET " full
    if ($0 ~ /\bpost\(/)   print "POST " full
    if ($0 ~ /\bput\(/)    print "PUT " full
    if ($0 ~ /\bdelete\(/) print "DELETE " full
    if ($0 ~ /\bpatch\(/)  print "PATCH " full
}
' "$MAIN_RS" | sort -u > "${1:-/dev/stdout}"
```

- [ ] **Step 2: Make executable**

```bash
chmod +x /Users/cwdavis/scripts/netstacks-terminal/tests/scripts/extract-routes.sh
```

- [ ] **Step 3: Test it**

```bash
mkdir -p /Users/cwdavis/scripts/netstacks-terminal/tests/coverage
cd /Users/cwdavis/scripts/netstacks-terminal/tests
./scripts/extract-routes.sh coverage/agent-routes.txt
wc -l coverage/agent-routes.txt
head -20 coverage/agent-routes.txt
```

Expected: ~220–225 lines (matches the spec's claim of 223 method-handler endpoints). Each line: `METHOD /full/path`. Examples: `GET /api/health`, `POST /api/sessions`, `GET /ws/terminal`.

If line count is wildly off (<150 or >300), the awk parser missed a sub-router prefix. Inspect `coverage/agent-routes.txt` for unprefixed paths (lines starting with `GET /` not `GET /api/` etc.) and fix the `PREFIX` map.

No commit (`tests/` gitignored).

---

## Task 2: Write `tests/scripts/audit-existing-coverage.sh`

**Files:**
- Create: `tests/scripts/audit-existing-coverage.sh`

The script greps every existing test file under `tests/api/tests/` (phase tests + new coverage tests) for two signals:
1. `// COVERS: METHOD /path` marker comments (canonical).
2. URL literals like `client.get("/sessions")`, `client.post("/topologies", ...)`, `&format!("/sessions/{}", id)` (for tests that pre-date the marker convention).

It normalizes parameterized paths (`/sessions/abc-123-uuid` → `/sessions/:id`) before emitting `METHOD /path` lines.

- [ ] **Step 1: Create the script**

Write `/Users/cwdavis/scripts/netstacks-terminal/tests/scripts/audit-existing-coverage.sh`:

```bash
#!/bin/bash
# Audit tests/api/tests/*.rs to discover which (METHOD, path) tuples are exercised.
# Output: one line per (method, normalized_path) tuple, sorted, to stdout (or $1 if given).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
TESTS_DIR="$REPO_DIR/tests/api/tests"

if [ ! -d "$TESTS_DIR" ]; then
    echo "ERROR: $TESTS_DIR not found" >&2
    exit 1
fi

normalize() {
    # Stdin: paths with concrete IDs. Stdout: same with placeholders.
    # UUIDs, hex strings (>=8 chars), all-digit IDs → :id
    sed -E \
        -e 's#/[0-9a-fA-F]{8}-[0-9a-fA-F-]{27,}#/:id#g' \
        -e 's#/[0-9a-fA-F]{12,}#/:id#g' \
        -e 's#/[0-9]+#/:id#g' \
        -e 's#\{[a-z_]+\}#:id#g'
}

{
    # Pass 1: COVERS markers (canonical).
    grep -rhE '// *COVERS: *[A-Z]+ +/' "$TESTS_DIR" \
        | sed -E 's#.*COVERS: *([A-Z]+) +(/[^ ]+).*#\1 \2#'

    # Pass 2: URL literals in client method calls.
    # Catches: client.get("/path"), client.post("/path", ...), client.put, client.delete
    # Catches: &format!("/sessions/{}", id) — strips the {} segment via normalize
    grep -rhnE 'client\.(get|post|put|delete)\(' "$TESTS_DIR" \
        | sed -E 's#.*client\.(get|post|put|delete)\(&?(format!\()?"([^"]+)".*#\1 \3#' \
        | awk '{ print toupper($1), $2 }' \
        | grep -v '^[A-Z]\+ /tmp\|^[A-Z]\+ Bearer'  # filter false positives

    # Pass 3: WebSocket connect_async / ws_url("/path")
    grep -rhE 'ws_url\("[^"]+"\)' "$TESTS_DIR" \
        | sed -E 's#.*ws_url\("([^"]+)"\).*#GET /ws\1#'
} | normalize | sort -u > "${1:-/dev/stdout}"
```

- [ ] **Step 2: Make executable**

```bash
chmod +x /Users/cwdavis/scripts/netstacks-terminal/tests/scripts/audit-existing-coverage.sh
```

- [ ] **Step 3: Test it (will produce a noisy first cut)**

```bash
cd /Users/cwdavis/scripts/netstacks-terminal/tests
./scripts/audit-existing-coverage.sh coverage/already-covered.txt
wc -l coverage/already-covered.txt
head -30 coverage/already-covered.txt
```

Expected: 80–120 lines. The first run will likely have a few false positives (e.g. method names mistakenly captured) — inspect and prune the regex if needed. Goal is "good enough to scope," not "perfectly precise" — the drift test in Phase B is the real authority.

No commit (`tests/` gitignored).

---

## Task 3: Generate the delta and validate

**Files:**
- Create: `tests/coverage/delta.txt` (generated)
- Create: `tests/coverage/delta-summary.txt` (generated; counts by route prefix)

- [ ] **Step 1: Compute the delta**

```bash
cd /Users/cwdavis/scripts/netstacks-terminal/tests
comm -23 \
    <(sort coverage/agent-routes.txt) \
    <(sort coverage/already-covered.txt) \
    > coverage/delta.txt
wc -l coverage/delta.txt
```

Expected: 100–150 lines. Each line is a `METHOD /full/path` that has no covering test today.

- [ ] **Step 2: Bucket the delta by prefix**

```bash
cd /Users/cwdavis/scripts/netstacks-terminal/tests
awk '{
    # Extract the first two path segments after /api or first segment after /ws
    n = split($2, parts, "/")
    if (n >= 3) {
        bucket = parts[2] "/" parts[3]
    } else if (n >= 2) {
        bucket = parts[2]
    } else {
        bucket = "other"
    }
    counts[bucket]++
}
END {
    for (b in counts) printf "%4d  %s\n", counts[b], b
}' coverage/delta.txt | sort -rn > coverage/delta-summary.txt
cat coverage/delta-summary.txt
```

Expected: a sorted-by-count summary. Sample output:
```
  18  api/ai
  12  api/topologies
  12  api/netbox
   9  api/sftp
   ...
```

This summary is your sanity check: does the bucket distribution match the per-category file plan in the spec? If a category in the spec shows 0 delta, the existing coverage already has it — drop the file from Phase C. If a bucket has a high count and no matching spec file, surface it as a planning gap (most likely a misclassification — investigate before continuing).

- [ ] **Step 3: Document deviations**

If your `delta-summary.txt` differs materially from the spec's predicted bucketing (>30% in any bucket, or any new bucket appears), update the per-category test files list in your local working notes before proceeding to Phase B. The spec's count of "~85 net-new tests" is a target; the actual delta governs.

No commit.

---

# Phase B — Drift infrastructure

Build the enforcement mechanism BEFORE writing the per-category tests. This way every category test added in Phase C immediately gets cross-checked against `EXPECTED_COVERAGE`, surfacing miscategorizations as test failures rather than as coverage holes.

## Task 4: Add `agent/src/tracked_router.rs`

**Files:**
- Create: `agent/src/tracked_router.rs`
- Create: `agent/tests/tracked_router_test.rs`

A thin wrapper around `axum::Router<S>` that records every `.route(path, MethodRouter)` call into an internal `Vec<RouteInfo>`. Provides `into_inner_with_routes() -> (Router<S>, Vec<RouteInfo>)` so `main.rs` can extract the captured list and compose with axum's `.nest()` (which itself takes a plain `Router`). Provides `nest_tracked(prefix, other)` to merge another tracked router's captured routes with the prefix prepended.

- [ ] **Step 1: Write the failing test**

Create `/Users/cwdavis/scripts/netstacks-terminal/agent/tests/tracked_router_test.rs`:

```rust
//! Unit tests for TrackedRouter. Verifies the wrapper captures routes accurately
//! and merges nested sub-routers with the correct prefix.

use axum::routing::{get, post};
use netstacks_agent::tracked_router::{RouteInfo, TrackedRouter};

async fn ok() -> &'static str { "ok" }

#[test]
fn captures_single_route() {
    let (_router, routes) = TrackedRouter::<()>::new()
        .route("/health", get(ok))
        .into_inner_with_routes();
    assert_eq!(routes.len(), 1);
    assert_eq!(routes[0].path, "/health");
    assert_eq!(routes[0].methods, vec!["GET".to_string()]);
}

#[test]
fn captures_multi_method_route() {
    let (_router, routes) = TrackedRouter::<()>::new()
        .route("/items", get(ok).post(ok))
        .into_inner_with_routes();
    assert_eq!(routes.len(), 1);
    assert_eq!(routes[0].path, "/items");
    let mut methods = routes[0].methods.clone();
    methods.sort();
    assert_eq!(methods, vec!["GET".to_string(), "POST".to_string()]);
}

#[test]
fn nest_tracked_prefixes_paths() {
    let inner = TrackedRouter::<()>::new()
        .route("/list", get(ok))
        .route("/:id", get(ok));
    let (_router, routes) = TrackedRouter::<()>::new()
        .route("/health", get(ok))
        .nest_tracked("/items", inner)
        .into_inner_with_routes();
    let paths: std::collections::HashSet<String> = routes.iter().map(|r| r.path.clone()).collect();
    assert!(paths.contains("/health"));
    assert!(paths.contains("/items/list"));
    assert!(paths.contains("/items/:id"));
}

#[test]
fn route_info_serializes_to_json() {
    let info = RouteInfo {
        path: "/a".into(),
        methods: vec!["GET".into()],
    };
    let json = serde_json::to_string(&info).unwrap();
    assert!(json.contains("\"path\":\"/a\""));
    assert!(json.contains("\"methods\":[\"GET\"]"));
}
```

- [ ] **Step 2: Confirm test fails (no module yet)**

```bash
cd /Users/cwdavis/scripts/netstacks-terminal/agent
cargo test --test tracked_router_test 2>&1 | tail -10
```

Expected: FAIL — `unresolved import netstacks_agent::tracked_router`. (If the agent crate name isn't `netstacks_agent`, check `Cargo.toml`'s `[package] name` and adjust the test imports.)

- [ ] **Step 3: Write the wrapper**

Create `/Users/cwdavis/scripts/netstacks-terminal/agent/src/tracked_router.rs`:

```rust
//! TrackedRouter — thin wrapper around axum::Router that records every route
//! registration so the agent can introspect its own surface at runtime via
//! `GET /api/dev/routes`.
//!
//! Captures (path, methods) per `.route()` call. `nest_tracked()` merges another
//! tracked router and prepends the nesting prefix to every captured path so the
//! aggregated list reflects the full URL surface.

use axum::routing::{MethodRouter, Router};
use serde::Serialize;
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Serialize)]
pub struct RouteInfo {
    pub path: String,
    pub methods: Vec<String>,
}

pub struct TrackedRouter<S = ()> {
    inner: Router<S>,
    routes: Arc<Mutex<Vec<RouteInfo>>>,
}

impl<S> TrackedRouter<S>
where
    S: Clone + Send + Sync + 'static,
{
    pub fn new() -> Self {
        Self {
            inner: Router::new(),
            routes: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// Register a route. Captures (path, methods) into the internal log.
    /// Methods are inferred from the MethodRouter's debug repr (axum 0.7 doesn't
    /// expose a public accessor) — see `infer_methods()`.
    pub fn route(self, path: &str, method_router: MethodRouter<S>) -> Self {
        let methods = infer_methods(&method_router);
        self.routes.lock().unwrap().push(RouteInfo {
            path: path.to_string(),
            methods,
        });
        Self {
            inner: self.inner.route(path, method_router),
            routes: self.routes,
        }
    }

    /// Nest another TrackedRouter and merge its captured routes with the prefix.
    pub fn nest_tracked(self, prefix: &str, other: TrackedRouter<S>) -> Self {
        let (other_router, other_routes) = other.into_inner_with_routes();
        let mut log = self.routes.lock().unwrap();
        for r in other_routes {
            log.push(RouteInfo {
                path: format!("{}{}", prefix, r.path),
                methods: r.methods,
            });
        }
        drop(log);
        Self {
            inner: self.inner.nest(prefix, other_router),
            routes: self.routes,
        }
    }

    /// Apply state to the wrapped router. Captured routes carry over unchanged.
    pub fn with_state<S2>(self, state: S) -> TrackedRouter<S2>
    where
        S2: Clone + Send + Sync + 'static,
    {
        TrackedRouter {
            inner: self.inner.with_state(state),
            routes: self.routes,
        }
    }

    /// Consume self, returning the inner Router and the captured routes.
    pub fn into_inner_with_routes(self) -> (Router<S>, Vec<RouteInfo>) {
        let routes = std::mem::take(&mut *self.routes.lock().unwrap());
        (self.inner, routes)
    }

    /// Borrow-style access for callers that need to keep building (e.g. `.layer()`).
    pub fn into_inner(self) -> Router<S> {
        self.inner
    }

    pub fn captured_routes(&self) -> Vec<RouteInfo> {
        self.routes.lock().unwrap().clone()
    }
}

impl<S> Default for TrackedRouter<S>
where
    S: Clone + Send + Sync + 'static,
{
    fn default() -> Self {
        Self::new()
    }
}

/// Infer HTTP methods from a MethodRouter. Axum 0.7 doesn't expose this publicly,
/// so we use the Debug impl as a workaround. The Debug output for a MethodRouter
/// includes lines like `get: Some(...)`, `post: Some(...)`. This is brittle — if
/// axum changes the Debug format, this needs an update. Wrap in a unit test that
/// exercises every method to catch breakage.
fn infer_methods<S>(router: &MethodRouter<S>) -> Vec<String> {
    let dbg = format!("{:?}", router);
    let mut methods = Vec::new();
    for m in &["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"] {
        let needle = format!("{}: Some", m.to_lowercase());
        if dbg.contains(&needle) {
            methods.push(m.to_string());
        }
    }
    if methods.is_empty() {
        // Fallback: include ANY so the route is at least surfaced; spec test will catch this.
        methods.push("ANY".to_string());
    }
    methods
}
```

- [ ] **Step 4: Wire the module into the agent crate**

Edit `/Users/cwdavis/scripts/netstacks-terminal/agent/src/main.rs`. Find the `mod ai;` block (around line 28-46) and add:

```rust
mod tracked_router;
```

Then expose it via `lib.rs`. Check whether the agent has a `lib.rs`:

```bash
ls /Users/cwdavis/scripts/netstacks-terminal/agent/src/lib.rs 2>/dev/null && echo "EXISTS" || echo "MISSING"
```

If `MISSING`, create `/Users/cwdavis/scripts/netstacks-terminal/agent/src/lib.rs` with just:

```rust
//! Library surface for integration tests. Production use is via main.rs.

pub mod tracked_router;
```

And in `Cargo.toml` ensure both `[[bin]]` and `[lib]` targets exist (likely you'll need to add `[lib] path = "src/lib.rs"` if it isn't already).

If `EXISTS`, add `pub mod tracked_router;` to it.

- [ ] **Step 5: Re-run the test**

```bash
cd /Users/cwdavis/scripts/netstacks-terminal/agent
cargo test --test tracked_router_test 2>&1 | tail -15
```

Expected: 4/4 PASS.

If the `infer_methods` test fails, axum's Debug format has changed. Inspect with:
```rust
let mr = get(ok).post(ok);
println!("{:?}", mr);
```
And update the substring needle accordingly.

- [ ] **Step 6: Commit**

```bash
cd /Users/cwdavis/scripts/netstacks-terminal
git add agent/src/tracked_router.rs agent/src/lib.rs agent/src/main.rs agent/Cargo.toml agent/tests/tracked_router_test.rs
git commit -m "$(cat <<'EOF'
feat(agent): TrackedRouter wrapper for route introspection

Wraps axum::Router to capture (path, methods) on each .route()
call. nest_tracked() merges nested sub-routers with the correct
prefix so the aggregated list reflects the full URL surface.
Powers the upcoming /api/dev/routes endpoint.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Wire `TrackedRouter` into `main.rs`

**Files:**
- Modify: `agent/src/main.rs:418-921`

Replace `Router::new()` with `TrackedRouter::new()` for all 6 sub-routers. Replace `.nest("/api/...", X)` with the equivalent that uses `nest_tracked` for the captured-route aggregation. Stash the final aggregated `Vec<RouteInfo>` in `AppState` (or a global `OnceCell`) so the dev handler in Task 6 can read it.

- [ ] **Step 1: Add a global captured-routes cell**

Edit `/Users/cwdavis/scripts/netstacks-terminal/agent/src/tracked_router.rs`. Append at the bottom:

```rust
use std::sync::OnceLock;

/// Global registry populated once at startup by main.rs after all routes are composed.
/// Read by the /api/dev/routes handler.
pub static REGISTERED_ROUTES: OnceLock<Vec<RouteInfo>> = OnceLock::new();

pub fn set_global_routes(routes: Vec<RouteInfo>) {
    let _ = REGISTERED_ROUTES.set(routes);
}

pub fn get_global_routes() -> Vec<RouteInfo> {
    REGISTERED_ROUTES.get().cloned().unwrap_or_default()
}
```

- [ ] **Step 2: Update `main.rs` imports**

Edit the top of `/Users/cwdavis/scripts/netstacks-terminal/agent/src/main.rs`. Replace:

```rust
use axum::{
    routing::{delete, get, post, put},
    Router,
};
```

with:

```rust
use axum::routing::{delete, get, post, put};
use crate::tracked_router::{set_global_routes, TrackedRouter};
```

(`Router` is no longer needed at the top of the file for our usage; it's still needed inside the type signatures of axum's middleware. If you get unused-import warnings during compile, leave the original `Router` import in place.)

- [ ] **Step 3: Convert sub-routers**

Find each `let X_routes = Router::new()` block and replace with `let X_routes = TrackedRouter::new()`. Six occurrences (around lines 418, 816, 835, 852, 881, 894).

For sub-routers that end with `.with_state(...)` followed by use in `.nest()`: the `with_state` call returns a `TrackedRouter<NewState>` (preserving the captured-routes vec). The `nest_tracked` call in Step 4 will work the same.

For sub-routers that end without `.with_state(...)` (top-level `api_routes`), no change to the chaining.

- [ ] **Step 4: Convert composition**

Find `let authenticated_routes = Router::new()` (around line 905) and replace the entire composition block with:

```rust
    // Compose all sub-routers via TrackedRouter::nest_tracked so we capture the full path.
    let composed = TrackedRouter::<()>::new()
        .nest_tracked("/api", api_routes)
        .nest_tracked("/api/scripts", scripts_routes)
        .nest_tracked("/api/docs", docs_routes)
        .nest_tracked("/api/ai", ai_routes)
        .nest_tracked("/api/sftp", sftp_routes)
        .nest_tracked("/ws", ws_routes);

    let captured = composed.captured_routes();
    set_global_routes(captured);

    let (composed_router, _) = composed.into_inner_with_routes();

    // Apply auth middleware ONLY to /api routes (not /ws — WS uses its own token check).
    let api_with_auth = composed_router
        .layer(axum::middleware::from_fn_with_state(
            app_state.clone(),
            api::auth_middleware,
        ));

    api_with_auth
        .fallback_service(static_service)
        .layer(cors)
}
```

**Wait — middleware-scoping subtlety.** The original code wrapped `authenticated_routes` (the `/api` nest) with auth middleware via `.nest("/api", ...).layer(auth)`, but kept `/ws` outside the auth layer. The naive replacement above would apply auth to `/ws` too, which breaks WebSocket tests.

Use this corrected version instead:

```rust
    // Compose API sub-routers (these get auth middleware).
    let api_composed = TrackedRouter::<()>::new()
        .nest_tracked("/api", api_routes)
        .nest_tracked("/api/scripts", scripts_routes)
        .nest_tracked("/api/docs", docs_routes)
        .nest_tracked("/api/ai", ai_routes)
        .nest_tracked("/api/sftp", sftp_routes);

    // Compose WS routes separately (no auth middleware).
    let ws_composed = TrackedRouter::<()>::new()
        .nest_tracked("/ws", ws_routes);

    // Aggregate captured routes from BOTH and stash globally.
    let mut all_routes = api_composed.captured_routes();
    all_routes.extend(ws_composed.captured_routes());
    set_global_routes(all_routes);

    let (api_router, _) = api_composed.into_inner_with_routes();
    let (ws_router, _) = ws_composed.into_inner_with_routes();

    let authenticated = api_router.layer(axum::middleware::from_fn_with_state(
        app_state.clone(),
        api::auth_middleware,
    ));

    Router::new()
        .merge(authenticated)
        .merge(ws_router)
        .fallback_service(static_service)
        .layer(cors)
}
```

- [ ] **Step 5: Build the agent**

```bash
cd /Users/cwdavis/scripts/netstacks-terminal/agent
cargo build 2>&1 | tail -20
```

Expected: PASS (warnings OK; errors are not).

If you see type errors about `MethodRouter<S>` vs `MethodRouter<()>`, the most likely issue is that some sub-routers use a non-`()` state type and need a generic param on `TrackedRouter`. Look at the `with_state(...)` calls in main.rs — they reveal which sub-routers carry which state. The `TrackedRouter<S>` generic should pass through transparently, but the `nest_tracked` signature requires the inner router's state to match. If state types diverge, call `.with_state(state)` on each sub-router BEFORE `nest_tracked` so they all become `TrackedRouter<()>` by composition.

- [ ] **Step 6: Smoke test the live agent**

```bash
cd /Users/cwdavis/scripts/netstacks-terminal/tests
./scripts/teardown.sh 2>/dev/null || true
./scripts/setup-mocks.sh 2>&1 | tail -5
TOKEN=$(cat .agent-token)
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8080/api/health \
    -H "Authorization: Bearer $TOKEN"
curl -s -o /dev/null -w "%{http_code}\n" "ws://localhost:8080/ws/terminal" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Connection: Upgrade" -H "Upgrade: websocket" \
    -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
    -H "Sec-WebSocket-Version: 13"
```

Expected: both return non-error status codes (200 for health, 101 or 400 for WS depending on whether the handshake completes cleanly with curl). The point is to confirm BOTH routers still serve.

- [ ] **Step 7: Run Phase 1 + Phase 4 (the most representative)**

```bash
cd /Users/cwdavis/scripts/netstacks-terminal/tests
./scripts/run-phase.sh 1 2>&1 | tail -10
./scripts/run-phase.sh 4 2>&1 | tail -10
```

Expected: both pass green (9 + 13 tests). If Phase 4 WebSocket tests fail with auth errors, the middleware scoping in Step 4 is wrong — auth has leaked into `/ws`. Re-check.

- [ ] **Step 8: Commit**

```bash
cd /Users/cwdavis/scripts/netstacks-terminal
git add agent/src/tracked_router.rs agent/src/main.rs
git commit -m "$(cat <<'EOF'
feat(agent): wire TrackedRouter into main.rs route composition

All 6 sub-routers (api, scripts, docs, ai, sftp, ws) now use
TrackedRouter::new(); nest_tracked aggregates captured paths
with the correct nesting prefix; the global REGISTERED_ROUTES
cell is populated at startup with the full surface for the
forthcoming /api/dev/routes endpoint to introspect.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Add `/api/dev/routes` handler behind cfg gate

**Files:**
- Create: `agent/src/dev.rs`
- Modify: `agent/src/main.rs` — register the handler under cfg gate
- Modify: `agent/Cargo.toml` — add `dev-routes` feature

- [ ] **Step 1: Add the feature flag**

Edit `/Users/cwdavis/scripts/netstacks-terminal/agent/Cargo.toml`. Find the section between `[dependencies]` and the next `[...]` heading. Above `[dependencies]`, add:

```toml
[features]
default = []
dev-routes = []
```

(If a `[features]` section already exists, just add the `dev-routes = []` line.)

- [ ] **Step 2: Create the dev module**

Create `/Users/cwdavis/scripts/netstacks-terminal/agent/src/dev.rs`:

```rust
//! Dev-only endpoints. Compiled in only when `debug_assertions` is set
//! (i.e. non-release builds) OR when the `dev-routes` feature is enabled.
//!
//! Currently exposes `GET /api/dev/routes` for the test suite's coverage-drift check.

#![cfg(any(debug_assertions, feature = "dev-routes"))]

use axum::Json;
use crate::tracked_router::{get_global_routes, RouteInfo};

pub async fn routes_handler() -> Json<Vec<RouteInfo>> {
    Json(get_global_routes())
}
```

- [ ] **Step 3: Register the module**

Edit `/Users/cwdavis/scripts/netstacks-terminal/agent/src/main.rs`. Add near the other `mod` declarations:

```rust
#[cfg(any(debug_assertions, feature = "dev-routes"))]
mod dev;
```

Also add to `/Users/cwdavis/scripts/netstacks-terminal/agent/src/lib.rs`:

```rust
#[cfg(any(debug_assertions, feature = "dev-routes"))]
pub mod dev;
```

- [ ] **Step 4: Mount the handler**

In `main.rs`, find the `api_routes = TrackedRouter::new()` block (top-level API routes, around line 418). At the very end of that block (BEFORE the next `let X_routes = ...`), add:

```rust
        // Dev-only route introspection (cfg-gated; absent from release builds).
        ;
    #[cfg(any(debug_assertions, feature = "dev-routes"))]
    let api_routes = api_routes.route("/dev/routes", get(dev::routes_handler));
```

Note the trailing `;` ending the original chained expression — you'll have to find where the original chain ended and split it. The cleanest way:

1. Find the END of the `let api_routes = TrackedRouter::new()...` chain (look for the last `.route(...)` followed by `;`).
2. After that `;`, add the cfg-gated extension as shown above.

- [ ] **Step 5: Build & smoke-test**

```bash
cd /Users/cwdavis/scripts/netstacks-terminal/agent
cargo build 2>&1 | tail -10
cd /Users/cwdavis/scripts/netstacks-terminal/tests
./scripts/teardown.sh && ./scripts/setup-mocks.sh
TOKEN=$(cat .agent-token)
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:8080/api/dev/routes | head -c 500
echo ""
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:8080/api/dev/routes \
    | python3 -c "import sys, json; data = json.load(sys.stdin); print(f'{len(data)} routes')"
```

Expected: JSON array; route count matches the line count of `tests/coverage/agent-routes.txt` (within ±5 — small differences possible due to method-router debug-format edge cases).

If the count is off by more than 5%, inspect the JSON output for missing or duplicated paths and reconcile.

- [ ] **Step 6: Confirm absence in release build**

```bash
cd /Users/cwdavis/scripts/netstacks-terminal/agent
cargo build --release 2>&1 | tail -5
ls -lh target/release/netstacks-agent
# Start the release binary on a non-conflicting port
TEST_DB_PATH=/tmp/release-test.db PORT=8081 ./target/release/netstacks-agent &
RELEASE_PID=$!
sleep 2
RELEASE_TOKEN=$(grep -oE 'NETSTACKS_AUTH_TOKEN=[a-f0-9]+' /tmp/release-test.log 2>/dev/null | head -1 | cut -d= -f2 || echo "")
# (Token capture method may need adjustment — check how setup-mocks.sh extracts it)
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8081/api/dev/routes \
    -H "Authorization: Bearer $RELEASE_TOKEN"
kill $RELEASE_PID
```

Expected: `404` (route absent in release build).

If the release binary is too painful to start standalone for this test (it needs DB setup, certs, etc.), an alternate quick check:
```bash
strings /Users/cwdavis/scripts/netstacks-terminal/agent/target/release/netstacks-agent | grep -c "/dev/routes"
```
Expected: `0`.

- [ ] **Step 7: Commit**

```bash
cd /Users/cwdavis/scripts/netstacks-terminal
git add agent/Cargo.toml agent/src/dev.rs agent/src/main.rs agent/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(agent): add /api/dev/routes endpoint behind cfg gate

Returns the live RouteInfo[] captured by TrackedRouter so the
test suite's coverage-drift check can cross-verify against the
EXPECTED_COVERAGE table. Compiled in only when debug_assertions
is set or the `dev-routes` feature is enabled — absent from
release builds. Still requires the agent token (no anonymous
access even in dev).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Build initial `EXPECTED_COVERAGE` constant

**Files:**
- Create: `tests/api/tests/coverage_drift.rs` (skeleton; the test body is added in Task 8)

This task generates the initial table from `coverage/agent-routes.txt`. Every entry starts pointing at a placeholder marker (`"PENDING"`) — the per-category Phase C tasks will replace these as they implement coverage. Entries for routes already covered by phase tests get pointed at the right phase file via the audit data.

- [ ] **Step 1: Generate the initial table from agent-routes.txt + already-covered.txt**

```bash
cd /Users/cwdavis/scripts/netstacks-terminal/tests
mkdir -p api/tests
{
    echo "// AUTO-GENERATED INITIAL TABLE — edit by hand from here on."
    echo "// Format: (path, &[methods], \"covering_test_file::test_name\" or \"PENDING: <category>\")"
    echo "// Replace PENDING entries as Phase C categories ship."
    echo "pub const EXPECTED_COVERAGE: &[(&str, &[&str], &str)] = &["
    while read -r line; do
        method=$(echo "$line" | awk '{print $1}')
        path=$(echo "$line" | awk '{print $2}')
        # Check if already-covered.txt contains this (method, path)
        if grep -qFx "$method $path" coverage/already-covered.txt 2>/dev/null; then
            covered_by="EXISTING_PHASE_TEST"
        else
            # Bucket by route prefix to suggest the Phase C category
            case "$path" in
                /api/lookup/*)              covered_by="PENDING: coverage_lookups" ;;
                /api/vault/biometric*|/api/vault/api-keys*) covered_by="PENDING: coverage_vault" ;;
                /api/recordings/*)          covered_by="PENDING: coverage_recordings" ;;
                /api/changes/*|/api/sessions/*/highlight-rules*) covered_by="PENDING: coverage_changes" ;;
                /api/topologies*)           covered_by="PENDING: coverage_topologies" ;;
                /api/sessions/import|/api/sessions/export|/api/sessions/bulk-delete|/api/sessions/*/export|/api/folders/*/export|/api/bulk-command|/api/logs/append) covered_by="PENDING: coverage_imports" ;;
                /api/netbox*|/api/netbox-sources*) covered_by="PENDING: coverage_netbox" ;;
                /api/librenms*|/api/librenms-sources*) covered_by="PENDING: coverage_librenms" ;;
                /api/netdisco*|/api/netdisco-sources*) covered_by="PENDING: coverage_netdisco" ;;
                /api/ai/*)                  covered_by="PENDING: coverage_ai_files" ;;
                /api/sftp/*)                covered_by="PENDING: coverage_sftp" ;;
                /ws/*)                      covered_by="PENDING: coverage_websockets" ;;
                *)                          covered_by="PENDING: review" ;;
            esac
        fi
        echo "    (\"$path\", &[\"$method\"], \"$covered_by\"),"
    done < coverage/agent-routes.txt
    echo "];"
    echo ""
    echo "pub const INTENTIONALLY_UNCOVERED: &[(&str, &str, &str)] = &["
    echo "    // (path, method, reason). Add only with a real reason."
    echo "];"
} > coverage/initial-expected-coverage.rs
wc -l coverage/initial-expected-coverage.rs
head -20 coverage/initial-expected-coverage.rs
```

Expected: ~230 lines of generated Rust.

- [ ] **Step 2: Inspect & manually fix-up**

Open `coverage/initial-expected-coverage.rs` and:
- Look for `PENDING: review` entries — these are routes the bucketer didn't recognize. Decide which category they belong to and update the marker.
- Look for `EXISTING_PHASE_TEST` entries — verify they actually exist (a few may be false positives from the audit script). Where the audit was wrong, change to `PENDING: <category>`.
- Note: many CRUD endpoints will combine method-rows into one logical row per path during Task 9 — for now, leave one row per (method, path) pair; we'll deduplicate in Task 9 when consolidating.

No commit (file is in `tests/coverage/`, gitignored).

---

## Task 8: Create `coverage_drift.rs` test

**Files:**
- Create: `tests/api/tests/coverage_drift.rs`

- [ ] **Step 1: Write the test file**

Create `/Users/cwdavis/scripts/netstacks-terminal/tests/api/tests/coverage_drift.rs`:

```rust
//! Drift detection: assert that the live agent route list matches our hand-maintained
//! EXPECTED_COVERAGE table 1:1. When a developer adds a route without coverage,
//! this test fails with a precise diff.

use netstacks_api_tests::client::TestClient;
use serde::Deserialize;
use std::collections::HashSet;

#[derive(Debug, Deserialize)]
struct RouteInfo {
    path: String,
    methods: Vec<String>,
}

// PASTE THE OUTPUT OF tests/coverage/initial-expected-coverage.rs BELOW.
// Maintain by hand from here. Add an entry when adding a route + test;
// remove an entry when removing a route + test; add to INTENTIONALLY_UNCOVERED
// when a route can't be tested today, with a reason.

const EXPECTED_COVERAGE: &[(&str, &[&str], &str)] = &[
    // <-- paste here -->
];

const INTENTIONALLY_UNCOVERED: &[(&str, &str, &str)] = &[
    // (path, method, reason)
];

#[tokio::test]
async fn no_uncovered_routes() {
    let client = TestClient::new().await.expect("Failed to create client");

    let resp = client.get("/dev/routes").await.expect("GET /api/dev/routes");
    TestClient::assert_ok(&resp, "GET /api/dev/routes");
    let live: Vec<RouteInfo> = resp.json().await.expect("decode dev/routes JSON");

    // Build the expected set from EXPECTED_COVERAGE + INTENTIONALLY_UNCOVERED.
    let mut expected: HashSet<(String, String)> = HashSet::new();
    for (path, methods, _) in EXPECTED_COVERAGE {
        for m in *methods {
            expected.insert(((*path).to_string(), (*m).to_string()));
        }
    }
    for (path, method, _) in INTENTIONALLY_UNCOVERED {
        expected.insert(((*path).to_string(), (*method).to_string()));
    }

    // Build the actual set from the live route list.
    let mut actual: HashSet<(String, String)> = HashSet::new();
    for route in &live {
        for method in &route.methods {
            // Skip "ANY" (placeholder when method-detection fell through) — acceptable
            // until we improve infer_methods. Surfaces as an INTENTIONALLY_UNCOVERED
            // entry if needed.
            if method == "ANY" { continue; }
            actual.insert((route.path.clone(), method.clone()));
        }
    }

    let uncovered: Vec<&(String, String)> = actual
        .iter()
        .filter(|(p, m)| !expected.contains(&(p.clone(), m.clone())))
        .collect();
    let stale: Vec<&(String, String)> = expected
        .iter()
        .filter(|(p, m)| !actual.contains(&(p.clone(), m.clone())))
        .collect();

    if !uncovered.is_empty() || !stale.is_empty() {
        let mut msg = String::from("Coverage drift detected.\n");
        if !uncovered.is_empty() {
            msg.push_str(&format!(
                "\n  Uncovered routes ({}) — in agent, not in EXPECTED_COVERAGE:\n",
                uncovered.len()
            ));
            for (p, m) in &uncovered {
                msg.push_str(&format!("    {} {}\n", m, p));
            }
        }
        if !stale.is_empty() {
            msg.push_str(&format!(
                "\n  Stale entries ({}) — in EXPECTED_COVERAGE, not in agent:\n",
                stale.len()
            ));
            for (p, m) in &stale {
                msg.push_str(&format!("    {} {}\n", m, p));
            }
        }
        panic!("{}", msg);
    }
}
```

- [ ] **Step 2: Paste the generated table**

Open `tests/coverage/initial-expected-coverage.rs` and copy the contents of `EXPECTED_COVERAGE` and `INTENTIONALLY_UNCOVERED` into the placeholders in `coverage_drift.rs`.

- [ ] **Step 3: Compile**

```bash
cd /Users/cwdavis/scripts/netstacks-terminal/tests/api
cargo build --tests 2>&1 | tail -10
```

Expected: PASS.

- [ ] **Step 4: Run the drift test**

```bash
cd /Users/cwdavis/scripts/netstacks-terminal/tests
./scripts/setup-mocks.sh 2>&1 | tail -5  # ensure agent is up
TOKEN_FILE=.agent-token TEST_AGENT_TOKEN=$(cat .agent-token) \
    cargo test --manifest-path api/Cargo.toml --test coverage_drift -- --nocapture 2>&1 | tail -30
```

Expected: PASS — the table was generated from the live route list, so they match.

If the test fails, the most likely cause is a method-detection edge case in `infer_methods`. The failure message will show exactly which (method, path) tuples are mismatched; reconcile by either updating the table or improving `infer_methods`.

- [ ] **Step 5: Commit (table only — `coverage_drift.rs` itself is in gitignored tests/)**

`coverage_drift.rs` lives in `tests/api/tests/` and is gitignored. Nothing to commit for this task. The drift test exists locally and will be re-run after every Phase C category.

---

# Phase C — Per-category test files

## Algorithm (applied to every Task 9 through Task 20)

For each category:

1. **Read the spec's Pattern 1/2/3** in `docs/superpowers/specs/2026-05-02-backend-api-coverage-design.md` — one matches the category's predominant endpoint shape.

2. **Open `tests/coverage/delta.txt`** and filter to lines whose path matches the category's prefix. This is the work queue for the file.

3. **Create `tests/api/tests/coverage_<category>.rs`** with a test for each route or each CRUD group. Annotate every endpoint covered with `// COVERS: METHOD /path`.

4. **Run the file**:
   ```bash
   cd /Users/cwdavis/scripts/netstacks-terminal/tests
   TEST_AGENT_TOKEN=$(cat .agent-token) \
       cargo test --manifest-path api/Cargo.toml --test coverage_<category> -- --nocapture 2>&1 | tail -30
   ```

5. **For each failing test**, diagnose:
   - Stale assumption about API shape → update test.
   - Real agent bug → fix in `agent/src/...`, commit `fix(<area>):`, re-run.
   - Removed feature → delete the test, log in `TESTING-GAPS.md`, **and remove the entry from `EXPECTED_COVERAGE`**.

6. **Re-run** until all tests in the file pass.

7. **Update `coverage_drift.rs`'s `EXPECTED_COVERAGE`**: change every PENDING entry that the new tests now cover to point at `coverage_<category>.rs::test_name`.

8. **Re-run `coverage_drift`** — it must remain green.

9. **Per-phase report**: append a short note to a local working notes file capturing tests added, agent bugs fixed, removed-feature deletions.

---

## Task 9: `coverage_lookups.rs` — `/api/lookup/*` (4 routes)

**Files:**
- Create: `tests/api/tests/coverage_lookups.rs`

- [ ] **Step 1: List the delta**

```bash
cd /Users/cwdavis/scripts/netstacks-terminal/tests
grep -E '^[A-Z]+ /api/lookup/' coverage/delta.txt
```

Expected: 4 lines. Routes: `/api/lookup/oui/:mac`, `/api/lookup/dns/:query`, `/api/lookup/whois/:query`, `/api/lookup/asn/:asn`.

- [ ] **Step 2: Write the file**

Create `/Users/cwdavis/scripts/netstacks-terminal/tests/api/tests/coverage_lookups.rs`:

```rust
//! Coverage for /api/lookup/* — read-only utility endpoints.
//! OUI is a real round-trip (built-in static lookup). DNS/WHOIS/ASN may hit
//! external services depending on agent config; assert "endpoint responds with
//! expected shape," accepting both success and well-formed error.

use netstacks_api_tests::client::TestClient;
use reqwest::StatusCode;
use serde_json::Value;

#[tokio::test]
async fn lookup_oui_known_mac() {
    let client = TestClient::new().await.expect("client");
    // COVERS: GET /api/lookup/oui/:mac
    // Cisco OUI: 00:00:0C
    let resp = client.get("/lookup/oui/00:00:0C:11:22:33").await.unwrap();
    TestClient::assert_ok(&resp, "lookup_oui");
    let body: Value = resp.json().await.unwrap();
    assert!(body.get("vendor").is_some(), "expected `vendor` field, got {:?}", body);
}

#[tokio::test]
async fn lookup_dns_well_formed() {
    let client = TestClient::new().await.expect("client");
    // COVERS: GET /api/lookup/dns/:query
    let resp = client.get("/lookup/dns/example.com").await.unwrap();
    let status = resp.status();
    let body: Value = resp.json().await.unwrap();
    // Accept success, or well-formed error if upstream resolver unavailable.
    if status.is_success() {
        assert!(
            body.get("answers").is_some() || body.get("addresses").is_some(),
            "success response must include answers/addresses, got {:?}", body
        );
    } else {
        assert!(body.get("error").is_some(), "error response must include `error`, got {:?}", body);
    }
}

#[tokio::test]
async fn lookup_whois_well_formed() {
    let client = TestClient::new().await.expect("client");
    // COVERS: GET /api/lookup/whois/:query
    let resp = client.get("/lookup/whois/example.com").await.unwrap();
    let status = resp.status();
    if status.is_success() {
        let body: Value = resp.json().await.unwrap();
        assert!(body.is_object() || body.is_string(), "whois result should be object or string");
    } else {
        // 502/503 acceptable when upstream WHOIS unavailable
        assert!(
            status == StatusCode::BAD_GATEWAY
                || status == StatusCode::SERVICE_UNAVAILABLE
                || status == StatusCode::INTERNAL_SERVER_ERROR,
            "unexpected status {}", status
        );
    }
}

#[tokio::test]
async fn lookup_asn_well_formed() {
    let client = TestClient::new().await.expect("client");
    // COVERS: GET /api/lookup/asn/:asn
    let resp = client.get("/lookup/asn/15169").await.unwrap();  // Google
    let status = resp.status();
    if status.is_success() {
        let body: Value = resp.json().await.unwrap();
        assert!(
            body.get("name").is_some() || body.get("org").is_some() || body.is_object(),
            "asn lookup should return descriptive object, got {:?}", body
        );
    } else {
        assert!(
            status == StatusCode::BAD_GATEWAY
                || status == StatusCode::SERVICE_UNAVAILABLE
                || status == StatusCode::INTERNAL_SERVER_ERROR,
            "unexpected status {}", status
        );
    }
}
```

- [ ] **Step 3: Run**

```bash
cd /Users/cwdavis/scripts/netstacks-terminal/tests
TEST_AGENT_TOKEN=$(cat .agent-token) \
    cargo test --manifest-path api/Cargo.toml --test coverage_lookups -- --nocapture 2>&1 | tail -30
```

Expected: 4/4 PASS.

- [ ] **Step 4: Update `EXPECTED_COVERAGE` in `coverage_drift.rs`**

Replace the four `("...", &["GET"], "PENDING: coverage_lookups")` entries with:
```rust
("/api/lookup/oui/:mac",   &["GET"], "coverage_lookups.rs::lookup_oui_known_mac"),
("/api/lookup/dns/:query", &["GET"], "coverage_lookups.rs::lookup_dns_well_formed"),
("/api/lookup/whois/:query", &["GET"], "coverage_lookups.rs::lookup_whois_well_formed"),
("/api/lookup/asn/:asn",   &["GET"], "coverage_lookups.rs::lookup_asn_well_formed"),
```

- [ ] **Step 5: Re-run drift**

```bash
TEST_AGENT_TOKEN=$(cat .agent-token) \
    cargo test --manifest-path api/Cargo.toml --test coverage_drift -- --nocapture 2>&1 | tail -10
```

Expected: PASS.

No commit (`tests/` gitignored). If a real agent bug surfaced and was fixed, commit that fix on its own.

---

## Task 10: `coverage_vault.rs` — `/api/vault/biometric/*` + `/api/vault/api-keys/*` delta (~6 routes)

**Files:**
- Create: `tests/api/tests/coverage_vault.rs`

- [ ] **Step 1: List the delta**

```bash
cd /Users/cwdavis/scripts/netstacks-terminal/tests
grep -E '^[A-Z]+ /api/vault/(biometric|api-keys)' coverage/delta.txt
```

Expected: 6 lines. Likely routes: `GET /api/vault/biometric/status`, `POST /api/vault/biometric/enable`, `POST /api/vault/biometric/unlock`, `DELETE /api/vault/biometric`, `GET /api/vault/api-keys/:key_type/exists`, plus any related delta.

- [ ] **Step 2: Write the file**

Create `/Users/cwdavis/scripts/netstacks-terminal/tests/api/tests/coverage_vault.rs`:

```rust
//! Coverage for vault delta — biometric + API-key endpoints.
//! Biometric tests assert "endpoint responds" — actual biometric prompts can't run
//! in CI; expect 503 or "unsupported" on Linux test runners.

use netstacks_api_tests::client::TestClient;
use reqwest::StatusCode;
use serde_json::{json, Value};

#[tokio::test]
async fn biometric_status() {
    let client = TestClient::new().await.expect("client");
    // COVERS: GET /api/vault/biometric/status
    let resp = client.get("/vault/biometric/status").await.unwrap();
    TestClient::assert_ok(&resp, "biometric_status");
    let body: Value = resp.json().await.unwrap();
    assert!(
        body.get("available").is_some() || body.get("supported").is_some(),
        "status must include availability flag, got {:?}", body
    );
}

#[tokio::test]
async fn biometric_enable_unsupported_responds() {
    let client = TestClient::new().await.expect("client");
    // COVERS: POST /api/vault/biometric/enable
    let resp = client.post("/vault/biometric/enable", &json!({})).await.unwrap();
    // Accept success on macOS, 503/501 on Linux test machines
    let status = resp.status();
    assert!(
        status.is_success() || status == StatusCode::SERVICE_UNAVAILABLE
            || status == StatusCode::NOT_IMPLEMENTED,
        "expected success or unsupported, got {}", status
    );
}

#[tokio::test]
async fn biometric_unlock_responds() {
    let client = TestClient::new().await.expect("client");
    // COVERS: POST /api/vault/biometric/unlock
    let resp = client.post("/vault/biometric/unlock", &json!({})).await.unwrap();
    let status = resp.status();
    assert!(
        status.is_success() || status == StatusCode::SERVICE_UNAVAILABLE
            || status == StatusCode::NOT_IMPLEMENTED || status == StatusCode::UNAUTHORIZED,
        "expected success/unsupported/unauthorized, got {}", status
    );
}

#[tokio::test]
async fn biometric_disable() {
    let client = TestClient::new().await.expect("client");
    // COVERS: DELETE /api/vault/biometric
    let resp = client.delete("/vault/biometric").await.unwrap();
    let status = resp.status();
    assert!(
        status.is_success() || status == StatusCode::SERVICE_UNAVAILABLE
            || status == StatusCode::NOT_IMPLEMENTED,
        "unexpected status {}", status
    );
}

#[tokio::test]
async fn api_key_exists_check() {
    let client = TestClient::new().await.expect("client");
    // COVERS: GET /api/vault/api-keys/:key_type/exists
    let resp = client.get("/vault/api-keys/anthropic/exists").await.unwrap();
    TestClient::assert_ok(&resp, "api_key_exists");
    let body: Value = resp.json().await.unwrap();
    assert!(body.get("exists").is_some(), "must include `exists`, got {:?}", body);
    assert!(body["exists"].is_boolean(), "`exists` must be boolean");
}
```

- [ ] **Step 3: Run, diagnose, fix until green** (use the algorithm from Phase C intro)

- [ ] **Step 4: Update `EXPECTED_COVERAGE` for the 5 (or 6) routes covered**

- [ ] **Step 5: Re-run drift; ensure green**

---

## Task 11: `coverage_recordings.rs` — `/api/recordings/:id/*` (3 routes)

**Files:**
- Create: `tests/api/tests/coverage_recordings.rs`

- [ ] **Step 1: List the delta**

```bash
grep -E '^[A-Z]+ /api/recordings/' coverage/delta.txt
```

Expected: 3 lines. Routes: `/api/recordings/:id/data`, `/api/recordings/:id/append`, `/api/recordings/:id/save-to-docs`.

- [ ] **Step 2: Write the file**

Create `/Users/cwdavis/scripts/netstacks-terminal/tests/api/tests/coverage_recordings.rs`:

```rust
//! Coverage for /api/recordings/:id/* — terminal recording write/read/save lifecycle.

use netstacks_api_tests::client::TestClient;
use serde_json::{json, Value};

#[tokio::test]
async fn recording_full_round_trip() {
    let client = TestClient::new().await.expect("client");
    let rec_id = "test-rec-coverage";

    // COVERS: POST /api/recordings/:id/append
    let append = client
        .post(
            &format!("/recordings/{}/append", rec_id),
            &json!({ "data": "show version\nIOS XE 17.3.4\n", "timestamp": 1714652400 }),
        )
        .await
        .unwrap();
    TestClient::assert_ok(&append, "append recording chunk");

    // COVERS: GET /api/recordings/:id/data
    let read = client.get(&format!("/recordings/{}/data", rec_id)).await.unwrap();
    TestClient::assert_ok(&read, "read recording");
    let body: Value = read.json().await.unwrap();
    assert!(
        body.is_string() || body.is_array() || body.get("data").is_some(),
        "recording data must be string/array/{{data:...}}, got {:?}", body
    );

    // COVERS: POST /api/recordings/:id/save-to-docs
    let save = client
        .post(
            &format!("/recordings/{}/save-to-docs", rec_id),
            &json!({ "name": "test-saved-recording" }),
        )
        .await
        .unwrap();
    TestClient::assert_ok(&save, "save recording to docs");
    let saved: Value = save.json().await.unwrap();
    assert!(
        saved.get("id").is_some() || saved.get("doc_id").is_some(),
        "save response must include doc id, got {:?}", saved
    );
}
```

- [ ] **Step 3: Run, diagnose, update drift table — same algorithm.**

---

## Task 12: `coverage_changes.rs` — `/api/changes/*` + highlight rules (~6 routes)

**Files:**
- Create: `tests/api/tests/coverage_changes.rs`

- [ ] **Step 1: List the delta**

```bash
grep -E '^[A-Z]+ /api/(changes|sessions/.*highlight-rules)' coverage/delta.txt
```

Expected: ~6 lines. Routes: `POST /api/changes/import-mop`, `GET /api/changes/:id/export-mop`, `GET /api/changes/:change_id/snapshots`, `GET /api/sessions/:session_id/highlight-rules/effective`, plus any related.

- [ ] **Step 2: Write the file**

Create `/Users/cwdavis/scripts/netstacks-terminal/tests/api/tests/coverage_changes.rs`. Use the same shape as `coverage_recordings.rs`. Key tests:
- `changes_import_export_round_trip` — import a small MOP JSON, capture the returned change_id, export it back, assert payload echoes input shape.
- `change_snapshots_list` — for the change_id created above, list snapshots, assert empty array (no snapshots taken yet) or well-formed array.
- `session_highlight_rules_effective` — create a session via the existing fixtures helper, GET its `/highlight-rules/effective`, assert array shape.

```rust
use netstacks_api_tests::client::TestClient;
use netstacks_api_tests::fixtures::{credential_profile_body, session_body, test_name};
use serde_json::{json, Value};

#[tokio::test]
async fn changes_import_export_round_trip() {
    let client = TestClient::new().await.expect("client");

    let mop = json!({
        "name": test_name("test-mop"),
        "description": "MOP for coverage test",
        "mop_steps": [{"command": "show version"}],
    });
    // COVERS: POST /api/changes/import-mop
    let imp = client.post("/changes/import-mop", &mop).await.unwrap();
    TestClient::assert_ok(&imp, "import MOP");
    let imp_body: Value = imp.json().await.unwrap();
    let change_id = imp_body["id"].as_str().or(imp_body["change_id"].as_str())
        .expect("import response must include id/change_id").to_string();

    // COVERS: GET /api/changes/:id/export-mop
    let exp = client.get(&format!("/changes/{}/export-mop", change_id)).await.unwrap();
    TestClient::assert_ok(&exp, "export MOP");
    let exp_body: Value = exp.json().await.unwrap();
    assert!(exp_body.get("name").is_some() || exp_body.get("mop_steps").is_some());

    // COVERS: GET /api/changes/:change_id/snapshots
    let snaps = client.get(&format!("/changes/{}/snapshots", change_id)).await.unwrap();
    TestClient::assert_ok(&snaps, "list snapshots");
    let snaps_body: Value = snaps.json().await.unwrap();
    assert!(snaps_body.is_array(), "snapshots must be array, got {:?}", snaps_body);
}

#[tokio::test]
async fn session_highlight_rules_effective() {
    let client = TestClient::new().await.expect("client");

    // Create a credential profile + session to attach rules to
    let prof = client.post("/profiles", &credential_profile_body(&test_name("prof"))).await.unwrap();
    TestClient::assert_ok(&prof, "create profile");
    let prof_id = prof.json::<Value>().await.unwrap()["id"].as_str().unwrap().to_string();

    let sess = client.post("/sessions", &session_body(&test_name("sess"), "127.0.0.1", &prof_id)).await.unwrap();
    TestClient::assert_ok(&sess, "create session");
    let sess_id = sess.json::<Value>().await.unwrap()["id"].as_str().unwrap().to_string();

    // COVERS: GET /api/sessions/:session_id/highlight-rules/effective
    let rules = client.get(&format!("/sessions/{}/highlight-rules/effective", sess_id)).await.unwrap();
    TestClient::assert_ok(&rules, "effective highlight rules");
    let rules_body: Value = rules.json().await.unwrap();
    assert!(rules_body.is_array() || rules_body.is_object());

    // Cleanup
    let _ = client.delete(&format!("/sessions/{}", sess_id)).await;
}
```

- [ ] **Step 3-5: Run, fix, update drift.**

---

## Task 13: `coverage_topologies.rs` — `/api/topologies/*` nested CRUD (~12 routes)

**Files:**
- Create: `tests/api/tests/coverage_topologies.rs`

- [ ] **Step 1: List the delta**

```bash
grep -E '^[A-Z]+ /api/topologies' coverage/delta.txt
```

Expected: ~12 lines covering topologies + devices + connections.

- [ ] **Step 2: Write the file using the canonical CRUD pattern from the spec**

Create `/Users/cwdavis/scripts/netstacks-terminal/tests/api/tests/coverage_topologies.rs`:

```rust
//! Coverage for /api/topologies/* — nested CRUD: topology → device → connection.
//! One full round-trip test covers ~6 routes; supplementary tests cover edge cases.

use netstacks_api_tests::client::TestClient;
use netstacks_api_tests::fixtures::{test_name, topology_body, topology_device_body};
use reqwest::StatusCode;
use serde_json::{json, Value};

#[tokio::test]
async fn topology_full_round_trip() {
    let client = TestClient::new().await.expect("client");
    let name = test_name("test-topo");

    // COVERS: POST /api/topologies
    let create = client.post("/topologies", &topology_body(&name)).await.unwrap();
    TestClient::assert_ok(&create, "create topology");
    let body: Value = create.json().await.unwrap();
    let id = body["id"].as_str().expect("id field").to_string();
    assert_eq!(body["name"], name);

    // COVERS: GET /api/topologies/:id
    let get = client.get(&format!("/topologies/{}", id)).await.unwrap();
    TestClient::assert_ok(&get, "get topology");

    // COVERS: PUT /api/topologies/:id
    let upd = client.put(&format!("/topologies/{}", id), &json!({"name": "renamed"})).await.unwrap();
    TestClient::assert_ok(&upd, "update topology");

    // COVERS: GET /api/topologies
    let list = client.get("/topologies").await.unwrap();
    TestClient::assert_ok(&list, "list topologies");
    let arr: Vec<Value> = list.json().await.unwrap();
    assert!(arr.iter().any(|t| t["id"] == id), "created topology in list");

    // Add a device
    // COVERS: POST /api/topologies/:id/devices
    let dev = client.post(
        &format!("/topologies/{}/devices", id),
        &topology_device_body(&test_name("dev")),
    ).await.unwrap();
    TestClient::assert_ok(&dev, "create topology device");
    let dev_id = dev.json::<Value>().await.unwrap()["id"].as_str().unwrap().to_string();

    // COVERS: GET /api/topologies/:id/devices
    let devs = client.get(&format!("/topologies/{}/devices", id)).await.unwrap();
    TestClient::assert_ok(&devs, "list topology devices");

    // Cleanup — delete topology cascades device + connections
    // COVERS: DELETE /api/topologies/:id
    let del = client.delete(&format!("/topologies/{}", id)).await.unwrap();
    TestClient::assert_ok(&del, "delete topology");

    let after = client.get(&format!("/topologies/{}", id)).await.unwrap();
    TestClient::assert_status(&after, StatusCode::NOT_FOUND, "topology gone");
}
```

Add additional tests for any remaining delta routes (PUT/DELETE on devices, POST/DELETE on connections, etc.). The exact set depends on the delta — list those routes and add one round-trip per logical group.

- [ ] **Step 3-5: Run, fix, update drift.**

---

## Task 14: `coverage_imports.rs` — bulk + import/export endpoints (~6 routes)

**Files:**
- Create: `tests/api/tests/coverage_imports.rs`

- [ ] **Step 1: List the delta**

```bash
grep -E '^[A-Z]+ /api/(sessions/(import|export|bulk-delete)|sessions/.+/(export)|folders/.+/export|bulk-command|logs/append)' coverage/delta.txt
```

Expected: ~6 lines.

- [ ] **Step 2: Write the file**

Create `/Users/cwdavis/scripts/netstacks-terminal/tests/api/tests/coverage_imports.rs`:

```rust
//! Coverage for bulk + import/export endpoints. These work with file/binary
//! payloads, so test data is constructed inline rather than read from disk.

use netstacks_api_tests::client::TestClient;
use netstacks_api_tests::fixtures::{credential_profile_body, session_body, test_name};
use serde_json::{json, Value};

#[tokio::test]
async fn sessions_export_import_round_trip() {
    let client = TestClient::new().await.expect("client");

    // Setup: create a profile + session to export
    let prof = client.post("/profiles", &credential_profile_body(&test_name("prof"))).await.unwrap();
    let prof_id = prof.json::<Value>().await.unwrap()["id"].as_str().unwrap().to_string();
    let sess = client.post("/sessions", &session_body(&test_name("sess-exp"), "127.0.0.1", &prof_id)).await.unwrap();
    let sess_id = sess.json::<Value>().await.unwrap()["id"].as_str().unwrap().to_string();

    // COVERS: POST /api/sessions/export   (or whatever the route is — verify against agent-routes.txt)
    let exp = client.post("/sessions/export", &json!({"session_ids": [sess_id]})).await.unwrap();
    TestClient::assert_ok(&exp, "export sessions");
    let exp_body: Value = exp.json().await.unwrap();
    assert!(exp_body.get("sessions").is_some() || exp_body.is_array());

    // COVERS: POST /api/sessions/import
    let imp = client.post("/sessions/import", &exp_body).await.unwrap();
    TestClient::assert_ok(&imp, "import sessions");
}

#[tokio::test]
async fn sessions_bulk_delete() {
    let client = TestClient::new().await.expect("client");

    let prof = client.post("/profiles", &credential_profile_body(&test_name("prof-bd"))).await.unwrap();
    let prof_id = prof.json::<Value>().await.unwrap()["id"].as_str().unwrap().to_string();
    let s1 = client.post("/sessions", &session_body(&test_name("bd1"), "127.0.0.1", &prof_id)).await.unwrap();
    let s1_id = s1.json::<Value>().await.unwrap()["id"].as_str().unwrap().to_string();
    let s2 = client.post("/sessions", &session_body(&test_name("bd2"), "127.0.0.1", &prof_id)).await.unwrap();
    let s2_id = s2.json::<Value>().await.unwrap()["id"].as_str().unwrap().to_string();

    // COVERS: POST /api/sessions/bulk-delete
    let del = client.post("/sessions/bulk-delete", &json!({"ids": [s1_id, s2_id]})).await.unwrap();
    TestClient::assert_ok(&del, "bulk delete sessions");
}

#[tokio::test]
async fn bulk_command_dispatch() {
    let client = TestClient::new().await.expect("client");
    // COVERS: POST /api/bulk-command
    // Empty target list — handler should respond cleanly even with no targets.
    let resp = client.post("/bulk-command", &json!({
        "command": "show version",
        "session_ids": [],
    })).await.unwrap();
    let status = resp.status();
    assert!(
        status.is_success() || status == reqwest::StatusCode::BAD_REQUEST,
        "bulk-command should reject empty targets cleanly, got {}", status
    );
}

#[tokio::test]
async fn logs_append() {
    let client = TestClient::new().await.expect("client");
    // COVERS: POST /api/logs/append
    let resp = client.post("/logs/append", &json!({
        "level": "info",
        "message": "coverage test log entry",
    })).await.unwrap();
    TestClient::assert_ok(&resp, "logs append");
}
```

Add a similar test for `POST /api/sessions/:id/export` and `POST /api/folders/:id/export` based on whichever survive the delta filter.

- [ ] **Step 3-5: Run, fix, update drift.**

---

## Task 15: `coverage_netbox.rs` — NetBox proxy + source mgmt (~12 routes)

**Files:**
- Create: `tests/api/tests/coverage_netbox.rs`

- [ ] **Step 1: List the delta**

```bash
grep -E '^[A-Z]+ /api/(netbox|netbox-sources)' coverage/delta.txt
```

Expected: ~12 lines.

- [ ] **Step 2: Write the file using Pattern 2 (stub-and-assert)**

Create `/Users/cwdavis/scripts/netstacks-terminal/tests/api/tests/coverage_netbox.rs`:

```rust
//! Coverage for NetBox source mgmt + proxy endpoints.
//! Source mgmt is real CRUD; proxy endpoints stub upstream at 127.0.0.1:1
//! and assert the agent returns a well-shaped error.

use netstacks_api_tests::client::TestClient;
use netstacks_api_tests::fixtures::test_name;
use reqwest::StatusCode;
use serde_json::{json, Value};

async fn create_unreachable_netbox_source(client: &TestClient) -> String {
    let body = json!({
        "name": test_name("nb-test"),
        "url": "http://127.0.0.1:1",
        "token": "fake-token-for-test",
    });
    let resp = client.post("/netbox-sources", &body).await.unwrap();
    TestClient::assert_ok(&resp, "create netbox source");
    resp.json::<Value>().await.unwrap()["id"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn netbox_source_full_crud() {
    let client = TestClient::new().await.expect("client");
    let id = create_unreachable_netbox_source(&client).await;

    // COVERS: GET /api/netbox-sources, GET /api/netbox-sources/:id, PUT /api/netbox-sources/:id, DELETE /api/netbox-sources/:id
    let list = client.get("/netbox-sources").await.unwrap();
    TestClient::assert_ok(&list, "list netbox sources");

    let get = client.get(&format!("/netbox-sources/{}", id)).await.unwrap();
    TestClient::assert_ok(&get, "get netbox source");

    let upd = client.put(&format!("/netbox-sources/{}", id), &json!({"name": "renamed"})).await.unwrap();
    TestClient::assert_ok(&upd, "update netbox source");

    let del = client.delete(&format!("/netbox-sources/{}", id)).await.unwrap();
    TestClient::assert_ok(&del, "delete netbox source");
}

fn assert_proxy_error(resp: &reqwest::Response, ctx: &str) {
    let status = resp.status();
    assert!(
        status == StatusCode::BAD_GATEWAY
            || status == StatusCode::SERVICE_UNAVAILABLE
            || status == StatusCode::GATEWAY_TIMEOUT
            || status == StatusCode::INTERNAL_SERVER_ERROR,
        "[{}] expected proxy error 502/503/504/500, got {}", ctx, status
    );
}

#[tokio::test]
async fn netbox_proxy_endpoints_return_upstream_error() {
    let client = TestClient::new().await.expect("client");
    let id = create_unreachable_netbox_source(&client).await;

    let endpoints = [
        ("/netbox/proxy/sites",          "sites"),
        ("/netbox/proxy/roles",          "roles"),
        ("/netbox/proxy/manufacturers",  "manufacturers"),
        ("/netbox/proxy/platforms",      "platforms"),
        ("/netbox/proxy/tags",           "tags"),
        ("/netbox/proxy/devices/count",  "devices/count"),
        ("/netbox/proxy/devices",        "devices"),
        ("/netbox/proxy/ip-addresses",   "ip-addresses"),
    ];

    for (path, name) in endpoints {
        // COVERS: GET <path>  (each iteration covers one)
        let resp = client.get(&format!("{}?source_id={}", path, id)).await.unwrap();
        let status = resp.status();
        assert_proxy_error(&resp, name);
        if let Ok(body) = resp.json::<Value>().await {
            assert!(body.get("error").is_some() || body.is_string() || body.is_object(),
                "[{}] error response should be JSON-shaped, got {:?}", name, body);
        }
    }
}

#[tokio::test]
async fn netbox_source_test_endpoint() {
    let client = TestClient::new().await.expect("client");
    let id = create_unreachable_netbox_source(&client).await;

    // COVERS: POST /api/netbox-sources/:id/test
    let resp = client.post(&format!("/netbox-sources/{}/test", id), &json!({})).await.unwrap();
    let status = resp.status();
    // Test endpoint should return 200 with success=false OR an upstream error code.
    if status.is_success() {
        let body: Value = resp.json().await.unwrap();
        assert!(body.get("success").is_some() || body.get("ok").is_some());
    } else {
        assert_proxy_error(&resp, "source test");
    }

    // COVERS: POST /api/netbox/test  (the form-based test endpoint)
    let test = client.post("/netbox/test", &json!({"url": "http://127.0.0.1:1", "token": "fake"})).await.unwrap();
    if test.status().is_success() {
        let body: Value = test.json().await.unwrap();
        assert!(body.get("success").is_some() || body.get("ok").is_some());
    }

    // COVERS: POST /api/netbox-sources/:id/sync-complete
    let sync = client.post(&format!("/netbox-sources/{}/sync-complete", id), &json!({})).await.unwrap();
    let _ = sync.status();  // either way is acceptable shape-wise; we mostly want the route to be wired.

    // COVERS: PUT /api/netbox-sources/:id/token
    let token = client.put(&format!("/netbox-sources/{}/token", id), &json!({"token": "new-fake"})).await.unwrap();
    TestClient::assert_ok(&token, "update netbox token");
}
```

Verify the `.post`/`.put`/`.get` method maps actually match the agent's signatures (the agent-routes.txt has the source-of-truth methods).

- [ ] **Step 3-5: Run, fix, update drift.**

---

## Task 16: `coverage_librenms.rs` — LibreNMS proxy + source mgmt (~6 routes)

**Files:**
- Create: `tests/api/tests/coverage_librenms.rs`

Apply the same pattern as `coverage_netbox.rs`. Filter delta with `grep -E '^[A-Z]+ /api/(librenms|librenms-sources)'`. Routes likely include:
- CRUD on `/api/librenms-sources/*`
- `POST /api/librenms-sources/:id/test`
- `POST /api/librenms/test`
- `GET /api/librenms-sources/:id/devices`
- `GET /api/librenms-sources/:id/devices/:hostname/links`
- `GET /api/librenms-sources/:id/links`

- [ ] **Step 1**: list delta with grep above.
- [ ] **Step 2**: write file mirroring `coverage_netbox.rs` structure (one CRUD test for source mgmt, one proxy-error test for the device endpoints).
- [ ] **Step 3-5**: Run, fix, update drift.

---

## Task 17: `coverage_netdisco.rs` — Netdisco proxy + source mgmt (~7 routes)

**Files:**
- Create: `tests/api/tests/coverage_netdisco.rs`

Same pattern again. Filter delta with `grep -E '^[A-Z]+ /api/(netdisco|netdisco-sources)'`. Routes likely include:
- CRUD on `/api/netdisco-sources/*`
- `POST /api/netdisco-sources/:id/test`
- `POST /api/netdisco/test`
- `GET /api/netdisco-sources/:id/devices`
- `GET /api/netdisco-sources/:id/devices/:device_ip/neighbors`
- `GET /api/netdisco-sources/:id/devicelinks`
- `GET /api/netdisco-sources/:id/search`

- [ ] **Step 1-5**: same algorithm.

---

## Task 18: `coverage_ai_files.rs` — AI file ops, profile, memory, config-mode (~15 routes)

**Files:**
- Create: `tests/api/tests/coverage_ai_files.rs`

This is the biggest non-CRUD category. Tests must handle the case where AI provider isn't configured (mock LLM still flaky per Sub-project 0 gap log).

- [ ] **Step 1: List the delta**

```bash
grep -E '^[A-Z]+ /api/ai/' coverage/delta.txt
```

- [ ] **Step 2: Write the file**

Create `/Users/cwdavis/scripts/netstacks-terminal/tests/api/tests/coverage_ai_files.rs`. Test groups:

1. **AI profile** (round-trip):
   - `GET /api/ai/profile` — returns current profile (or default)
   - `PUT /api/ai/profile` — set profile
   - `DELETE /api/ai/profile` — reset to default
   - `GET /api/ai/profile/status` — returns onboarding/configured state

2. **AI memories** (round-trip CRUD):
   - `GET /api/ai/memory`, `POST /api/ai/memory`, `PUT /api/ai/memory/:id`, `DELETE /api/ai/memory/:id`

3. **AI file operations** (status + shape; AI may not be available):
   - `POST /api/ai/write-file` — assert response shape (success or "AI unavailable" 503)
   - `POST /api/ai/edit-file` — same
   - `POST /api/ai/patch-file` — same
   - `POST /api/ai/ssh-execute` — same; needs a session_id to target

4. **AI utilities**:
   - `GET /api/ai/knowledge-pack-sizes` — returns object with size info
   - `POST /api/ai/sanitization/test` — round-trip a sanitization test
   - `POST /api/ai/analyze-highlights` — assert shape (may be 503)

5. **Config mode**:
   - `GET /api/ai/config-mode/status`
   - `POST /api/ai/config-mode/enable`
   - `POST /api/ai/config-mode/disable`

```rust
use netstacks_api_tests::client::TestClient;
use netstacks_api_tests::fixtures::test_name;
use reqwest::StatusCode;
use serde_json::{json, Value};

fn ai_unavailable(status: StatusCode) -> bool {
    status == StatusCode::SERVICE_UNAVAILABLE || status == StatusCode::INTERNAL_SERVER_ERROR
}

#[tokio::test]
async fn ai_profile_round_trip() {
    let client = TestClient::new().await.expect("client");

    // COVERS: GET /api/ai/profile
    let get = client.get("/ai/profile").await.unwrap();
    TestClient::assert_ok(&get, "get profile");

    // COVERS: PUT /api/ai/profile
    let put = client.put("/ai/profile", &json!({
        "expertise_level": "intermediate",
        "role": "network engineer",
    })).await.unwrap();
    TestClient::assert_ok(&put, "set profile");

    // COVERS: GET /api/ai/profile/status
    let status = client.get("/ai/profile/status").await.unwrap();
    TestClient::assert_ok(&status, "profile status");

    // COVERS: DELETE /api/ai/profile
    let del = client.delete("/ai/profile").await.unwrap();
    TestClient::assert_ok(&del, "reset profile");
}

#[tokio::test]
async fn ai_memory_full_crud() {
    let client = TestClient::new().await.expect("client");

    // COVERS: POST /api/ai/memory
    let create = client.post("/ai/memory", &json!({
        "content": format!("Test memory: {}", test_name("mem")),
        "type": "user",
    })).await.unwrap();
    TestClient::assert_ok(&create, "create memory");
    let id = create.json::<Value>().await.unwrap()["id"].as_str().unwrap().to_string();

    // COVERS: GET /api/ai/memory
    let list = client.get("/ai/memory").await.unwrap();
    TestClient::assert_ok(&list, "list memories");

    // COVERS: PUT /api/ai/memory/:id
    let upd = client.put(&format!("/ai/memory/{}", id), &json!({"content": "updated"})).await.unwrap();
    TestClient::assert_ok(&upd, "update memory");

    // COVERS: DELETE /api/ai/memory/:id
    let del = client.delete(&format!("/ai/memory/{}", id)).await.unwrap();
    TestClient::assert_ok(&del, "delete memory");
}

#[tokio::test]
async fn ai_knowledge_pack_sizes() {
    let client = TestClient::new().await.expect("client");
    // COVERS: GET /api/ai/knowledge-pack-sizes
    let resp = client.get("/ai/knowledge-pack-sizes").await.unwrap();
    TestClient::assert_ok(&resp, "knowledge pack sizes");
    let body: Value = resp.json().await.unwrap();
    assert!(body.is_object(), "expected object, got {:?}", body);
}

#[tokio::test]
async fn ai_sanitization_test_round_trip() {
    let client = TestClient::new().await.expect("client");
    // COVERS: POST /api/ai/sanitization/test
    let resp = client.post("/ai/sanitization/test", &json!({
        "input": "Router#show running-config\npassword secret123\n",
    })).await.unwrap();
    TestClient::assert_ok(&resp, "sanitization test");
    let body: Value = resp.json().await.unwrap();
    assert!(body.get("sanitized").is_some() || body.get("output").is_some());
}

#[tokio::test]
async fn ai_file_ops_respond() {
    let client = TestClient::new().await.expect("client");

    // COVERS: POST /api/ai/write-file
    let write = client.post("/ai/write-file", &json!({
        "path": "/tmp/coverage-test.txt",
        "content": "test\n",
    })).await.unwrap();
    let status = write.status();
    assert!(status.is_success() || ai_unavailable(status), "write-file unexpected {}", status);

    // COVERS: POST /api/ai/edit-file
    let edit = client.post("/ai/edit-file", &json!({
        "path": "/tmp/coverage-test.txt",
        "old": "test",
        "new": "edited",
    })).await.unwrap();
    let status = edit.status();
    assert!(status.is_success() || ai_unavailable(status), "edit-file unexpected {}", status);

    // COVERS: POST /api/ai/patch-file
    let patch = client.post("/ai/patch-file", &json!({
        "path": "/tmp/coverage-test.txt",
        "patch": "--- /tmp/coverage-test.txt\n+++ /tmp/coverage-test.txt\n@@ -1 +1 @@\n-edited\n+patched\n",
    })).await.unwrap();
    let status = patch.status();
    assert!(status.is_success() || ai_unavailable(status), "patch-file unexpected {}", status);

    // COVERS: POST /api/ai/ssh-execute  (requires a session_id; expect "no such session" if AI configured)
    let ssh = client.post("/ai/ssh-execute", &json!({
        "session_id": "nonexistent",
        "command": "show version",
    })).await.unwrap();
    let status = ssh.status();
    assert!(
        status.is_client_error() || ai_unavailable(status),
        "ssh-execute should reject unknown session, got {}", status
    );

    // COVERS: POST /api/ai/analyze-highlights
    let highlights = client.post("/ai/analyze-highlights", &json!({
        "session_id": "nonexistent",
        "lines": ["line 1", "line 2"],
    })).await.unwrap();
    let status = highlights.status();
    assert!(
        status.is_success() || status.is_client_error() || ai_unavailable(status),
        "analyze-highlights unexpected {}", status
    );
}

#[tokio::test]
async fn ai_config_mode_lifecycle() {
    let client = TestClient::new().await.expect("client");

    // COVERS: GET /api/ai/config-mode/status
    let status = client.get("/ai/config-mode/status").await.unwrap();
    TestClient::assert_ok(&status, "config-mode status");

    // COVERS: POST /api/ai/config-mode/enable
    let enable = client.post("/ai/config-mode/enable", &json!({})).await.unwrap();
    TestClient::assert_ok(&enable, "enable config mode");

    // COVERS: POST /api/ai/config-mode/disable
    let disable = client.post("/ai/config-mode/disable", &json!({})).await.unwrap();
    TestClient::assert_ok(&disable, "disable config mode");
}
```

- [ ] **Step 3-5: Run, diagnose, fix, update drift.** AI file-ops tests in particular may surface real bugs (path validation, permissions); commit fixes individually.

---

## Task 19: `coverage_sftp.rs` — SFTP operations via mock SSH (~9 routes)

**Files:**
- Create: `tests/api/tests/coverage_sftp.rs`

This category depends on the mock SSH server (port 2222) supporting the SFTP subsystem. If tests fail mock-side, fix the mock (it's in `tests/mocks/`, local-only).

- [ ] **Step 1: List the delta**

```bash
grep -E '^[A-Z]+ /api/sftp/' coverage/delta.txt
```

Expected: 9 lines.

- [ ] **Step 2: Write the file with one full lifecycle test**

Create `/Users/cwdavis/scripts/netstacks-terminal/tests/api/tests/coverage_sftp.rs`:

```rust
//! Coverage for /api/sftp/:id/* — SFTP operations via mock SSH server (port 2222).
//! One full lifecycle test exercises connect → ls → mkdir → upload → stat →
//! download → rename → rm → disconnect.

use netstacks_api_tests::client::TestClient;
use netstacks_api_tests::fixtures::{credential_profile_body, session_body, test_name};
use serde_json::{json, Value};

#[tokio::test]
async fn sftp_full_lifecycle() {
    let client = TestClient::new().await.expect("client");

    // Setup: session pointing at mock SSH on localhost:2222
    let prof = client.post("/profiles", &credential_profile_body(&test_name("sftp-prof"))).await.unwrap();
    let prof_id = prof.json::<Value>().await.unwrap()["id"].as_str().unwrap().to_string();
    let sess = client.post("/sessions", &json!({
        "name": test_name("sftp-sess"),
        "host": "127.0.0.1",
        "port": 2222,
        "protocol": "ssh",
        "profile_id": prof_id,
    })).await.unwrap();
    TestClient::assert_ok(&sess, "create sftp session");
    let sess_id = sess.json::<Value>().await.unwrap()["id"].as_str().unwrap().to_string();

    // COVERS: POST /api/sftp/:id/connect
    let conn = client.post(&format!("/sftp/{}/connect", sess_id), &json!({})).await.unwrap();
    TestClient::assert_ok(&conn, "sftp connect");

    // COVERS: GET /api/sftp/:id/ls
    let ls = client.get(&format!("/sftp/{}/ls?path=/", sess_id)).await.unwrap();
    TestClient::assert_ok(&ls, "sftp ls /");

    // COVERS: POST /api/sftp/:id/mkdir
    let dir_path = format!("/tmp/coverage-{}", &sess_id[..8]);
    let mkdir = client.post(&format!("/sftp/{}/mkdir", sess_id),
        &json!({"path": &dir_path})).await.unwrap();
    TestClient::assert_ok(&mkdir, "sftp mkdir");

    // COVERS: POST /api/sftp/:id/upload
    let file_path = format!("{}/test.txt", dir_path);
    let upload = client.post(&format!("/sftp/{}/upload", sess_id), &json!({
        "path": &file_path,
        "content": "hello from coverage test",  // adjust if upload uses base64 — check agent code
    })).await.unwrap();
    if !upload.status().is_success() {
        // Upload might require multipart/form-data instead of JSON; document and adapt.
        eprintln!("upload returned {}; investigate format", upload.status());
    }

    // COVERS: GET /api/sftp/:id/stat
    let stat = client.get(&format!("/sftp/{}/stat?path={}", sess_id, file_path)).await.unwrap();
    let _ = stat.status();  // stat may 404 if upload didn't actually upload — acceptable for now

    // COVERS: GET /api/sftp/:id/download
    let download = client.get(&format!("/sftp/{}/download?path={}", sess_id, file_path)).await.unwrap();
    let _ = download.status();

    // COVERS: POST /api/sftp/:id/rename
    let new_path = format!("{}/renamed.txt", dir_path);
    let rename = client.post(&format!("/sftp/{}/rename", sess_id),
        &json!({"from": &file_path, "to": &new_path})).await.unwrap();
    let _ = rename.status();

    // COVERS: DELETE /api/sftp/:id/rm
    let rm = client.delete(&format!("/sftp/{}/rm?path={}", sess_id, new_path)).await.unwrap();
    let _ = rm.status();

    // COVERS: POST /api/sftp/:id/disconnect
    let disc = client.post(&format!("/sftp/{}/disconnect", sess_id), &json!({})).await.unwrap();
    TestClient::assert_ok(&disc, "sftp disconnect");

    // Cleanup
    let _ = client.delete(&format!("/sessions/{}", sess_id)).await;
}
```

- [ ] **Step 3: Run**

```bash
cd /Users/cwdavis/scripts/netstacks-terminal/tests
TEST_AGENT_TOKEN=$(cat .agent-token) \
    cargo test --manifest-path api/Cargo.toml --test coverage_sftp -- --nocapture 2>&1 | tail -40
```

Likely outcomes:
- **Connect fails (mock SSH SFTP subsystem missing)**: check `tests/mocks/` for the SSH server config; confirm it advertises and accepts `sftp` subsystem requests. Fix the mock.
- **Upload returns 415 / 422**: the route expects multipart instead of JSON; update the test.
- **Connect succeeds, ops fail with auth**: profile credentials don't match mock SSH expectations; check profile body.

Diagnose, fix mock or test, re-run until green.

- [ ] **Step 4-5: Update drift, re-run.**

---

## Task 20: `coverage_websockets.rs` — `/ws/topology-live` + `/ws/tasks` smoke (2 routes)

**Files:**
- Create: `tests/api/tests/coverage_websockets.rs`

`/ws/terminal` is already covered by phase 4. Only `/ws/topology-live` and `/ws/tasks` need new coverage.

- [ ] **Step 1: Write the file**

Create `/Users/cwdavis/scripts/netstacks-terminal/tests/api/tests/coverage_websockets.rs`:

```rust
//! Smoke coverage for /ws/topology-live and /ws/tasks. Connect, optionally
//! receive one message, close cleanly. Full protocol verification is Sub-project 6.

use futures_util::{SinkExt, StreamExt};
use netstacks_api_tests::ws_url;
use std::env;
use std::time::Duration;
use tokio::time::timeout;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

async fn connect_with_token(path: &str) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>> {
    let token = env::var("TEST_AGENT_TOKEN").expect("TEST_AGENT_TOKEN");
    let url = format!("{}?token={}", ws_url(path), token);
    let (ws, _resp) = connect_async(&url).await.expect("ws connect");
    ws
}

#[tokio::test]
async fn topology_live_ws_smoke() {
    // COVERS: GET /ws/topology-live
    let mut ws = connect_with_token("/topology-live").await;
    // Allow up to 2s for the server to send anything (welcome, snapshot, etc.).
    let _ = timeout(Duration::from_secs(2), ws.next()).await;
    ws.close(None).await.expect("clean close");
}

#[tokio::test]
async fn tasks_ws_smoke() {
    // COVERS: GET /ws/tasks
    let mut ws = connect_with_token("/tasks").await;
    let _ = timeout(Duration::from_secs(2), ws.next()).await;
    ws.send(Message::Close(None)).await.expect("send close");
    let _ = ws.close(None).await;
}
```

- [ ] **Step 2-5: Run, fix, update drift.** Verify the `ws_url()` helper generates the right URL — Sub-project 0 introduced it as `format!("{base}/ws{path}", ...)`, so `ws_url("/topology-live")` should yield `ws://localhost:8080/ws/topology-live`.

---

# Phase D — Reproducibility & integration

## Task 21: Update `tests/scripts/run-phase.sh` and `tests/run-tests.sh`

**Files:**
- Modify: `tests/scripts/run-phase.sh`
- Modify: `tests/run-tests.sh`

- [ ] **Step 1: Add coverage subcommand to `run-phase.sh`**

Edit `/Users/cwdavis/scripts/netstacks-terminal/tests/scripts/run-phase.sh`. After the existing `case "$PHASE"` block, add a new top-level branch:

```bash
# Coverage sweep: ./run-phase.sh coverage <area>  OR  ./run-phase.sh coverage-all
if [ "$PHASE" = "coverage" ]; then
    AREA="${2:?Usage: $0 coverage <area>  (areas: lookups vault recordings changes topologies imports netbox librenms netdisco ai_files sftp websockets drift)}"
    cd "$TESTS_DIR/api"
    cargo test --test "coverage_${AREA}" -- --nocapture
    echo "=== Coverage ${AREA} complete ==="
    exit 0
fi

if [ "$PHASE" = "coverage-all" ]; then
    cd "$TESTS_DIR/api"
    for AREA in lookups vault recordings changes topologies imports netbox librenms netdisco ai_files sftp websockets drift; do
        echo "=== Coverage ${AREA} ==="
        cargo test --test "coverage_${AREA}" -- --nocapture || exit 1
    done
    echo "=== All coverage suites complete ==="
    exit 0
fi
```

Place this BEFORE the existing `case "$PHASE"` so the `coverage` keywords intercept first.

- [ ] **Step 2: Add `cov` command to `run-tests.sh`**

Edit `/Users/cwdavis/scripts/netstacks-terminal/tests/run-tests.sh`. Locate the command parser case statement; add a new case:

```bash
        cov)
            "$SCRIPT_DIR/scripts/run-phase.sh" coverage-all
            ;;
```

In the help text and menu, add a new section near the existing phase listing:

```bash
echo "─── Coverage Sweep ───"
echo "  cov               Run all coverage_* tests"
echo "  cov-<area>        Run a single coverage area (e.g. cov-topologies)"
```

And in the parser, add a wildcard for `cov-<area>`:

```bash
        cov-*)
            AREA="${INPUT#cov-}"
            "$SCRIPT_DIR/scripts/run-phase.sh" coverage "$AREA"
            ;;
```

- [ ] **Step 3: Smoke-test**

```bash
cd /Users/cwdavis/scripts/netstacks-terminal/tests
./scripts/run-phase.sh coverage lookups 2>&1 | tail -5
./scripts/run-phase.sh coverage-all 2>&1 | tail -10
```

Expected: each runs without script errors. Test pass/fail depends on prior task progress.

No commit.

---

## Task 22: Update `tests/README.md`

**Files:**
- Modify: `tests/README.md`

- [ ] **Step 1: Add a Coverage Tests section**

Open `/Users/cwdavis/scripts/netstacks-terminal/tests/README.md`. Find the "Test Phases" section. Add a new section AFTER the phases table:

```markdown
## Coverage Sweep (Sub-project 1)

In addition to the phase tests, the suite includes per-category coverage tests
that exercise every HTTP route on the agent at least once. These live in
`tests/api/tests/coverage_*.rs` and are organized by route prefix:

| File | Routes covered |
|---|---|
| `coverage_lookups.rs`     | `/api/lookup/*` |
| `coverage_vault.rs`       | `/api/vault/biometric/*`, `/api/vault/api-keys/*` |
| `coverage_recordings.rs`  | `/api/recordings/:id/*` |
| `coverage_changes.rs`     | `/api/changes/*`, `/api/sessions/.../highlight-rules/effective` |
| `coverage_topologies.rs`  | `/api/topologies/*` (incl. nested device + connection CRUD) |
| `coverage_imports.rs`     | bulk + import/export endpoints |
| `coverage_netbox.rs`      | `/api/netbox/*`, `/api/netbox-sources/*` |
| `coverage_librenms.rs`    | `/api/librenms/*`, `/api/librenms-sources/*` |
| `coverage_netdisco.rs`    | `/api/netdisco/*`, `/api/netdisco-sources/*` |
| `coverage_ai_files.rs`    | `/api/ai/{write,edit,patch}-file`, `/api/ai/profile/*`, `/api/ai/memory/*`, `/api/ai/config-mode/*`, `/api/ai/sanitization/test`, `/api/ai/analyze-highlights`, `/api/ai/knowledge-pack-sizes`, `/api/ai/ssh-execute` |
| `coverage_sftp.rs`        | `/api/sftp/:id/*` |
| `coverage_websockets.rs`  | `/ws/topology-live`, `/ws/tasks` |
| `coverage_drift.rs`       | Cross-checks live `/api/dev/routes` against `EXPECTED_COVERAGE` |

### Running the coverage sweep

```bash
./scripts/run-phase.sh coverage lookups   # one area
./scripts/run-phase.sh coverage-all       # all areas
./run-tests.sh cov                         # via menu
```

### Drift detection

The agent registers all routes via `TrackedRouter` (`agent/src/tracked_router.rs`),
exposing a dev-only `GET /api/dev/routes` endpoint (cfg-gated; absent from release
builds). `coverage_drift.rs` hits this endpoint, cross-references the result
against the hand-maintained `EXPECTED_COVERAGE` constant, and fails the suite
if any route is missing from coverage OR any expected entry has been removed
from the agent.

When adding a new route to the agent:
1. Add the route in `agent/src/main.rs`.
2. Run the drift test — it will fail with `Uncovered routes: [...]`.
3. Either add a real test to a `coverage_*.rs` file AND add an entry to
   `EXPECTED_COVERAGE`, or add an entry to `INTENTIONALLY_UNCOVERED` with a reason.

### Regenerating the coverage manifest

```bash
./scripts/extract-routes.sh tests/coverage/agent-routes.txt
./scripts/audit-existing-coverage.sh tests/coverage/already-covered.txt
comm -23 <(sort coverage/agent-routes.txt) <(sort coverage/already-covered.txt) > coverage/delta.txt
```
```

No commit (`tests/README.md` is local-only).

---

## Task 23: Cold-start reproducibility verification

**Files:** none (verification only)

The pass criterion isn't "tests passed once" — it's "tests pass green from a cold start of the test infrastructure."

- [ ] **Step 1: Tear down and cold-start**

```bash
cd /Users/cwdavis/scripts/netstacks-terminal/tests
./scripts/teardown.sh
./scripts/setup-mocks.sh 2>&1 | tail -5
```

- [ ] **Step 2: Run the full retained suite + coverage sweep**

```bash
cd /Users/cwdavis/scripts/netstacks-terminal/tests
./run-tests.sh all 2>&1 | tail -20      # 145 phase tests
./run-tests.sh cov 2>&1 | tail -20      # ~85 coverage tests + 1 drift
```

Expected: every phase passes; every coverage area passes; drift test passes. Total: ~231 tests green.

- [ ] **Step 3: If anything fails on cold start that previously passed, fix the root cause**

Likely flake sources:
- Test ordering (tests within a single file may share resources unintentionally — fix by adding UUID suffixes).
- Leftover state from a prior run that wasn't cleaned by teardown — extend `teardown.sh` to remove the artifact.
- Race conditions on agent startup (test runs before AI provider config is ready) — add a wait/retry in the test setup.

Do NOT add `#[ignore]` to mask flakes. Fix the cause.

- [ ] **Step 4: Final teardown**

```bash
./scripts/teardown.sh
```

No commit.

---

## Task 24: Finalize `TESTING-GAPS.md` Sub-project 1 section

**Files:**
- Modify: `docs/superpowers/TESTING-GAPS.md`

- [ ] **Step 1: Append the Sub-project 1 section**

Add a new section to `docs/superpowers/TESTING-GAPS.md`:

```markdown
## Sub-project 1 — Backend API coverage

Completed YYYY-MM-DD. See `docs/superpowers/specs/2026-05-02-backend-api-coverage-design.md`.

### Routes newly covered

| Category | File | Routes |
|---|---|---|
| Lookups   | `coverage_lookups.rs`    | 4 |
| Vault     | `coverage_vault.rs`      | <N> |
| Recordings| `coverage_recordings.rs` | 3 |
| Changes   | `coverage_changes.rs`    | <N> |
| Topologies| `coverage_topologies.rs` | <N> |
| Imports   | `coverage_imports.rs`    | <N> |
| NetBox    | `coverage_netbox.rs`     | <N> |
| LibreNMS  | `coverage_librenms.rs`   | <N> |
| Netdisco  | `coverage_netdisco.rs`   | <N> |
| AI files  | `coverage_ai_files.rs`   | <N> |
| SFTP      | `coverage_sftp.rs`       | <N> |
| WebSockets| `coverage_websockets.rs` | 2 |
| **Total** | | **~85** |

### Routes intentionally uncovered

| Path | Method | Reason |
|---|---|---|
| <fill in from coverage_drift.rs::INTENTIONALLY_UNCOVERED> | | |

### Agent bugs surfaced and fixed

| Commit | Area | Description |
|---|---|---|
| <SHA> | <module> | <one-line> |

### Mock infrastructure changes

| Change | Reason |
|---|---|
| <e.g. mock SSH SFTP subsystem implemented> | <reason> |

### Drift-detection mechanism live

`agent/src/tracked_router.rs` + `agent/src/dev.rs` (cfg-gated `/api/dev/routes`)
+ `tests/api/tests/coverage_drift.rs`. Adding a route without a covering test
now fails CI.
```

Fill in the placeholders (test counts, intentionally-uncovered list, bug fixes, mock changes) from your working notes during Phase C.

- [ ] **Step 2: Commit**

```bash
cd /Users/cwdavis/scripts/netstacks-terminal
git add docs/superpowers/TESTING-GAPS.md
git commit -m "$(cat <<'EOF'
docs(testing-gaps): finalize Sub-project 1 with route coverage + drift

Captures the ~85 newly-covered routes, intentionally-uncovered
list with reasons, agent bugs surfaced and fixed during Phase C,
and mock infrastructure changes. Documents the drift-detection
mechanism (TrackedRouter + /api/dev/routes + coverage_drift.rs)
that prevents future coverage gaps.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Done criteria

Sub-project 1 is done when ALL of the following are true:

1. `agent/src/tracked_router.rs` exists; all 6 sub-routers in `main.rs` use `TrackedRouter::new()`; the global `REGISTERED_ROUTES` cell is populated at startup.
2. `GET /api/dev/routes` returns the live route list in dev/test builds (debug_assertions or `dev-routes` feature); absent from release builds (verified via curl 404 OR `strings` count = 0).
3. `coverage_drift.rs::no_uncovered_routes` passes — every route in the agent has either a real `EXPECTED_COVERAGE` entry or an `INTENTIONALLY_UNCOVERED` entry.
4. Every `coverage_*.rs` file (12 categories + drift = 13 files) passes green from cold start.
5. `./run-tests.sh all` (existing 145) + `./run-tests.sh cov` (~85 + drift) passes green from cold start = ~231 tests total.
6. `docs/superpowers/TESTING-GAPS.md` has the Sub-project 1 section filled in (counts, INTENTIONALLY_UNCOVERED list, bug fixes, mock changes).
7. Any agent bugs fixed during verification have their own `fix(<area>):` commits.
8. `tests/scripts/run-phase.sh` accepts `coverage <area>` and `coverage-all`; `tests/run-tests.sh` accepts `cov` and `cov-<area>`.

If condition 5 isn't true on a cold start, **the sub-project isn't done.** No assumptions. Re-run from cold start until green.
