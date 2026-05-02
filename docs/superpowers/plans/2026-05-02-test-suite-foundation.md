# Test Suite Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Strip controller-only test code, fix repo-extraction path bugs, and verify every retained phase test (1, 2, 3, 4, 5, 6, 8, 14, 15) passes green against the current standalone netstacks-terminal application.

**Architecture:** Three sequential phases — (A) mechanical strip & simplify (delete controller-only files + collapse TestMode + fix path bugs), (B) per-phase verification loop in risk order (Phase 1 cheapest first → Phase 4 WebSocket riskiest last), (C) reproducibility check from cold start.

**Tech Stack:** Rust (cargo + reqwest + tokio + tokio-tungstenite for the API tests), Bash (test-runner scripts), Docker Compose (mock SSH + LLM containers), Playwright TypeScript (e2e config only — full e2e green is Sub-project 6).

**Spec:** `docs/superpowers/specs/2026-05-02-test-suite-foundation-design.md`

---

## Important: `tests/` is gitignored

The user added `tests/` to `.gitignore` (commit `db3a49f`). Test infrastructure stays local; only `docs/`, `agent/`, and `frontend/` changes are committed. This affects every task below — **do not run `git add tests/...`**. The verification gate is "phase passes green in the local working tree," not "diffs in commits."

Tracked files this plan will commit:
- `frontend/src/App.test.tsx` (fix for 2 pre-existing failures)
- `agent/src/...` (any real bugs surfaced by phase verification)
- `docs/superpowers/TESTING-GAPS.md` (running log of removed-feature tests)

Untracked but modified locally:
- Everything under `tests/`

---

## File Structure

**Delete (local only — `tests/` is gitignored):**
- `tests/api/tests/phase7_parity.rs`
- `tests/api/tests/phase9_controller_comparable.rs`
- `tests/api/tests/phase10_controller_admin.rs`
- `tests/api/tests/phase11_controller_high.rs`
- `tests/api/tests/phase12_controller_medium.rs`
- `tests/api/tests/phase13_controller_low.rs`
- `tests/api/src/modes.rs`
- `tests/e2e/tests/enterprise-terminal.spec.ts`
- `tests/e2e/tests/admin/` (10 files)

**Modify (local only — `tests/` is gitignored):**
- `tests/api/src/lib.rs` — drop `pub mod modes;`
- `tests/api/src/client.rs` — drop TestMode/login/JWT
- `tests/api/src/fixtures.rs` — drop mode-aware branches
- `tests/api/tests/phase{1,2,3,4,5,6,8,14,15}_*.rs` — strip `for_each_mode` and Enterprise arms
- `tests/scripts/setup-mocks.sh` — fix `terminal/agent` → `agent`
- `tests/scripts/run-phase.sh` — drop enterprise/both targets, drop phases 7/9-13
- `tests/run-tests.sh` — drop enterprise commands and phases 7/9-13
- `tests/e2e/playwright.config.ts` — drop enterprise + admin-ui projects, fix `terminal/frontend` → `frontend`
- `tests/README.md` — drop enterprise references
- `tests/TEST-COVERAGE-PLAN.md` — drop controller references

**Modify (committed):**
- `frontend/src/App.test.tsx` — fix the 2 pre-existing `getClient()` failures

**Create (committed):**
- `docs/superpowers/TESTING-GAPS.md` — running log of removed-feature tests, fed into Sub-projects 1–7

---

## Task 1: Delete controller-only API test files

**Files:**
- Delete: `tests/api/tests/phase7_parity.rs`
- Delete: `tests/api/tests/phase9_controller_comparable.rs`
- Delete: `tests/api/tests/phase10_controller_admin.rs`
- Delete: `tests/api/tests/phase11_controller_high.rs`
- Delete: `tests/api/tests/phase12_controller_medium.rs`
- Delete: `tests/api/tests/phase13_controller_low.rs`

These six files target the enterprise controller (not present in this repo) or run the same test against both backends (parity testing). All deletable wholesale.

- [ ] **Step 1: Confirm no in-tree references**

Run:
```bash
cd /Users/cwdavis/scripts/netstacks-terminal
grep -rn "phase7_parity\|phase9_controller\|phase10_controller\|phase11_controller\|phase12_controller\|phase13_controller" tests/ 2>/dev/null
```
Expected: matches only inside `tests/scripts/run-phase.sh` and `tests/run-tests.sh` (we update those in Task 5).

- [ ] **Step 2: Delete the six files**

```bash
cd /Users/cwdavis/scripts/netstacks-terminal/tests/api/tests
rm phase7_parity.rs phase9_controller_comparable.rs phase10_controller_admin.rs phase11_controller_high.rs phase12_controller_medium.rs phase13_controller_low.rs
```

- [ ] **Step 3: Verify the workspace still compiles (with broken references)**

Run:
```bash
cd /Users/cwdavis/scripts/netstacks-terminal/tests/api
cargo build --tests 2>&1 | tail -50
```
Expected: compile errors are OK at this point — the retained phase files still import `modes::TestMode` which we don't strip until Task 4. The point of this step is to confirm the deletion didn't break anything else (e.g., a missing module declaration).

If you see errors mentioning `mod phase7_parity` or `mod phase9_controller` etc. in any file, find and remove those `mod` declarations. Cargo's integration test discovery doesn't normally need explicit `mod` lines — each `tests/*.rs` is its own crate root — but check anyway.

No commit this task (`tests/` is gitignored).

---

## Task 2: Delete enterprise/admin E2E specs

**Files:**
- Delete: `tests/e2e/tests/enterprise-terminal.spec.ts`
- Delete: `tests/e2e/tests/admin/` (entire directory, 10 files)

- [ ] **Step 1: Confirm no in-tree references**

Run:
```bash
cd /Users/cwdavis/scripts/netstacks-terminal
grep -rn "enterprise-terminal\|admin/auth-navigation\|admin/users-roles\|admin/devices" tests/ 2>/dev/null
```
Expected: matches only in `tests/e2e/playwright.config.ts` (we update in Task 5) and possibly `tests/README.md` (Task 6).

- [ ] **Step 2: Delete the spec and the admin directory**

```bash
cd /Users/cwdavis/scripts/netstacks-terminal/tests/e2e/tests
rm enterprise-terminal.spec.ts
rm -rf admin
```

- [ ] **Step 3: Verify**

Run:
```bash
cd /Users/cwdavis/scripts/netstacks-terminal/tests/e2e
ls tests/
```
Expected: no `admin/` directory; no `enterprise-terminal.spec.ts`. The remaining specs (`ai-chat.spec.ts`, `app-loads.spec.ts`, etc.) are listed.

No commit this task.

---

## Task 3: Simplify TestMode infrastructure

**Files:**
- Delete: `tests/api/src/modes.rs`
- Modify: `tests/api/src/lib.rs`
- Rewrite: `tests/api/src/client.rs`
- Rewrite: `tests/api/src/fixtures.rs`

`TestMode`, `for_each_mode`, mode-aware path helpers, JWT login, and OnceLock JWT caching all exist only because the suite originally targeted two backends. Standalone-only kills all of it.

- [ ] **Step 1: Delete `modes.rs`**

```bash
cd /Users/cwdavis/scripts/netstacks-terminal/tests/api/src
rm modes.rs
```

- [ ] **Step 2: Update `tests/api/src/lib.rs`**

Replace the contents of `/Users/cwdavis/scripts/netstacks-terminal/tests/api/src/lib.rs` with:

```rust
pub mod client;
pub mod fixtures;

use std::env;

/// Base URL of the standalone agent under test. Reads `TEST_AGENT_URL` env var,
/// defaults to localhost:8080 (the default agent port).
pub fn agent_base_url() -> String {
    env::var("TEST_AGENT_URL").unwrap_or_else(|_| "http://localhost:8080".to_string())
}

/// Build an HTTP API URL for a given path (path should start with `/`).
pub fn api_url(path: &str) -> String {
    format!("{}/api{}", agent_base_url(), path)
}

/// Build a WebSocket URL for a given `/ws*` path.
pub fn ws_url(path: &str) -> String {
    let base = agent_base_url()
        .replace("http://", "ws://")
        .replace("https://", "wss://");
    format!("{}/ws{}", base, path)
}
```

- [ ] **Step 3: Rewrite `tests/api/src/client.rs`**

Replace the contents with:

```rust
//! HTTP test client for the standalone agent.
//!
//! Auth: the agent prints `NETSTACKS_AUTH_TOKEN=<hex>` to stdout at startup.
//! `setup-mocks.sh` captures it into `tests/.agent-token` and exports
//! `TEST_AGENT_TOKEN` before invoking the test runner.

use anyhow::Result;
use reqwest::{Client, Response, StatusCode};
use serde_json::Value;
use std::env;

use crate::api_url;

pub struct TestClient {
    pub http: Client,
    pub token: String,
}

impl TestClient {
    pub async fn new() -> Result<Self> {
        let http = Client::builder()
            .danger_accept_invalid_certs(true)
            .timeout(std::time::Duration::from_secs(30))
            .build()?;

        let token = env::var("TEST_AGENT_TOKEN").map_err(|_| {
            anyhow::anyhow!(
                "TEST_AGENT_TOKEN is required. Run `tests/scripts/setup-mocks.sh` to start \
                 the agent and capture the token, then re-run."
            )
        })?;

        Ok(Self { http, token })
    }

    /// GET request with auth
    pub async fn get(&self, path: &str) -> Result<Response> {
        Ok(self.http.get(api_url(path)).bearer_auth(&self.token).send().await?)
    }

    /// POST request with JSON body and auth
    pub async fn post(&self, path: &str, body: &Value) -> Result<Response> {
        Ok(self.http.post(api_url(path)).json(body).bearer_auth(&self.token).send().await?)
    }

    /// PUT request with JSON body and auth
    pub async fn put(&self, path: &str, body: &Value) -> Result<Response> {
        Ok(self.http.put(api_url(path)).json(body).bearer_auth(&self.token).send().await?)
    }

    /// DELETE request with auth
    pub async fn delete(&self, path: &str) -> Result<Response> {
        Ok(self.http.delete(api_url(path)).bearer_auth(&self.token).send().await?)
    }

    /// Assert response is success (2xx)
    pub fn assert_ok(resp: &Response, context: &str) {
        assert!(
            resp.status().is_success(),
            "[{}] Expected 2xx, got {} for {}",
            context,
            resp.status(),
            resp.url()
        );
    }

    /// Check if a status code indicates AI is not configured.
    pub fn is_ai_unavailable_status(status: StatusCode) -> bool {
        status == StatusCode::SERVICE_UNAVAILABLE || status == StatusCode::INTERNAL_SERVER_ERROR
    }

    /// Assert response is a specific status
    pub fn assert_status(resp: &Response, expected: StatusCode, context: &str) {
        assert_eq!(
            resp.status(),
            expected,
            "[{}] Expected {}, got {} for {}",
            context,
            expected,
            resp.status(),
            resp.url()
        );
    }
}
```

- [ ] **Step 4: Rewrite `tests/api/src/fixtures.rs`**

Replace the contents with:

```rust
//! Test data factories for creating test resources (standalone agent).

use serde_json::{json, Value};
use uuid::Uuid;

/// Generate a unique test name
pub fn test_name(prefix: &str) -> String {
    format!("{}-{}", prefix, &Uuid::new_v4().to_string()[..8])
}

/// Create a session request body.
/// Requires a valid `profile_id` — create one with `credential_profile_body()` first.
pub fn session_body(name: &str, host: &str, profile_id: &str) -> Value {
    json!({
        "name": name,
        "host": host,
        "port": 22,
        "protocol": "ssh",
        "profile_id": profile_id,
    })
}

/// Create a credential profile body.
pub fn credential_profile_body(name: &str) -> Value {
    json!({
        "name": name,
        "username": "testuser",
        "password": "testpass123",
    })
}

/// Create a script request body
pub fn script_body(name: &str) -> Value {
    json!({
        "name": name,
        "content": "#!/usr/bin/env python3\nprint('hello')\n",
        "language": "python",
    })
}

/// Create a document request body
pub fn document_body(name: &str, content: &str) -> Value {
    json!({
        "name": name,
        "content": content,
        "category": "notes",
        "content_type": "text",
    })
}

/// Create a topology request body
pub fn topology_body(name: &str) -> Value {
    json!({
        "name": name,
        "description": "Test topology",
    })
}

/// Create a topology device body
pub fn topology_device_body(name: &str) -> Value {
    json!({
        "name": name,
        "device_type": "router",
        "x": 100.0,
        "y": 200.0,
    })
}

/// Create a snippet body
pub fn snippet_body(name: &str, command: &str) -> Value {
    json!({
        "name": name,
        "command": command,
    })
}

/// Create a quick prompt body
pub fn quick_prompt_body(name: &str, prompt: &str) -> Value {
    json!({
        "name": name,
        "prompt": prompt,
    })
}

/// AI chat messages
pub fn chat_messages(user_msg: &str) -> Value {
    json!({
        "messages": [
            { "role": "user", "content": user_msg }
        ]
    })
}

/// AI agent chat messages (with optional system prompt and tools)
pub fn agent_chat_body(user_msg: &str, system_prompt: Option<&str>, with_tools: bool) -> Value {
    let mut body = json!({
        "messages": [
            { "role": "user", "content": user_msg }
        ]
    });

    if let Some(sp) = system_prompt {
        body["system_prompt"] = json!(sp);
    }

    if with_tools {
        body["tools"] = json!([{
            "name": "test_tool",
            "description": "A test tool",
            "input_schema": {
                "type": "object",
                "properties": {
                    "input": { "type": "string" }
                }
            }
        }]);
    }

    body
}

/// Settings value
pub fn setting_body(value: &str) -> Value {
    json!({ "value": value })
}

/// MOP template body (standalone shape)
pub fn mop_template_body(name: &str) -> Value {
    json!({
        "name": name,
        "description": "Test MOP template",
        "mop_steps": [],
        "created_by": "test",
    })
}

/// Agent definition body (standalone shape)
pub fn agent_definition_body(name: &str) -> Value {
    json!({
        "name": name,
        "description": "Test agent",
        "system_prompt": "You are a test agent",
        "tools": [],
    })
}

/// Session move body (standalone shape)
pub fn session_move_body(folder_id: &str) -> Value {
    json!({
        "folder_id": folder_id,
        "sort_order": 0.0,
    })
}

/// AI SSH execute body (standalone shape)
pub fn ai_ssh_execute_body(session_id: &str, command: &str) -> Value {
    json!({
        "session_id": session_id,
        "command": command,
    })
}
```

- [ ] **Step 5: Verify the helpers compile**

Run:
```bash
cd /Users/cwdavis/scripts/netstacks-terminal/tests/api
cargo build --lib 2>&1 | tail -20
```
Expected: PASS — the library crate now compiles cleanly. Test crates (which still import `modes`) will fail; that's expected and gets fixed in Task 4.

No commit this task.

---

## Task 4: Strip enterprise branches from retained phase tests

**Files:** modify each retained phase test in `tests/api/tests/`:
- `phase1_health.rs`
- `phase2_sessions.rs`
- `phase3_ai.rs`
- `phase4_terminal.rs`
- `phase5_features.rs`
- `phase6_snmp.rs`
- `phase8_edge.rs`
- `phase14_devices.rs`
- `phase15_mop_steps.rs`

This is the most invasive task in the strip phase. Each file needs the same set of edits.

### Per-file edit recipe

For each phase file:

1. **Update imports.** Remove `use netstacks_api_tests::modes::{all_modes, TestMode};` (or the equivalent). Replace with:
   ```rust
   use netstacks_api_tests::{api_url, ws_url};
   ```
   Adjust the imports based on what the file uses (most tests will need `api_url`; only Phase 4 uses `ws_url`).

2. **Remove `for_each_mode` helper if defined locally.** Each phase file historically defined a small helper:
   ```rust
   async fn for_each_mode<F, Fut>(test_fn: F) where ... {
       for mode in all_modes() {
           let client = TestClient::new(mode).await...
           test_fn(client).await;
       }
   }
   ```
   Delete this helper.

3. **Rewrite test bodies.** Every test body that uses `for_each_mode(|client| async move { ... }).await;` becomes:
   ```rust
   let client = TestClient::new().await.expect("Failed to create client");
   // ... existing body, but referencing `client` directly ...
   ```

4. **Remove `TestMode::Enterprise` match arms.** Search for `TestMode::Enterprise` in the file and:
   - If it's an `if mode == TestMode::Enterprise { ... continue; }` early-return guard, just delete the block.
   - If it's a `match mode { Standalone => A, Enterprise => B }`, keep `A`, drop `B`, and replace the match with the bare expression.
   - If it's used to call `mode.sessions_path()` etc., replace with the standalone literal: `/sessions`, `/folders`, `/mop-templates`, `/agent-definitions`, `/terminal`. (See `tests/api/src/modes.rs` (now deleted) for the original mapping if you need to look it up — git will still have it on `feat/ai-mode-prompt-overrides`.)

5. **Drop the mode arg from fixture calls.** Calls like `mop_template_body(name, &mode)` become `mop_template_body(name)`. Same for `agent_definition_body`, `session_move_body`, `ai_ssh_execute_body`. The fixtures were rewritten in Task 3 to drop the mode arg.

6. **Drop assertion preambles that reference mode name.** Strings like `format!("[{}] expected ...", mode.name())` become plain context strings. Change `assert_ok(&resp, &format!("[{}] create_session", mode.name()))` to `assert_ok(&resp, "create_session")`.

### Phase 4 specifics (terminal/WebSocket)

Phase 4's `for_each_mode` and `ws_url` helper are different. Look at `tests/api/tests/phase4_terminal.rs`:

```rust
fn ws_url(mode: &TestMode, params: &str) -> String {
    let base = mode.base_url()
        .replace("http://", "ws://")
        .replace("https://", "wss://");
    let path = mode.ws_terminal_path();
    format!("{}/ws{}?{}", base, path, params)
}
```

Replace with:

```rust
fn ws_terminal_url(params: &str) -> String {
    format!("{}?{}", netstacks_api_tests::ws_url("/terminal"), params)
}
```

The standalone WebSocket terminal path is `/terminal` (per the audit; not `/ssh` which was the controller path).

### Steps

- [ ] **Step 1: Update each phase file**

Work through `phase1_health.rs`, `phase2_sessions.rs`, `phase3_ai.rs`, `phase4_terminal.rs`, `phase5_features.rs`, `phase6_snmp.rs`, `phase8_edge.rs`, `phase14_devices.rs`, `phase15_mop_steps.rs` in turn, applying the recipe above.

After each file, run:
```bash
cd /Users/cwdavis/scripts/netstacks-terminal/tests/api
cargo build --tests 2>&1 | grep -E "error\[|^error|warning" | head -30
```

Fix compile errors before moving to the next file. Some errors will surface schema drift (e.g., a fixture method that no longer exists on `TestClient`); those are real bugs to flag for Phase B verification, not Task 4 work — note them but keep the test compiling (e.g., comment out the failing call temporarily and add a `// TODO Phase B: verify <X>` marker).

- [ ] **Step 2: Confirm full compile**

Run:
```bash
cd /Users/cwdavis/scripts/netstacks-terminal/tests/api
cargo build --tests 2>&1 | tail -10
```
Expected: PASS — all 9 retained phase tests compile.

- [ ] **Step 3: Confirm `TestMode` is fully purged**

Run:
```bash
grep -rn "TestMode\|for_each_mode\|all_modes" /Users/cwdavis/scripts/netstacks-terminal/tests/api/
```
Expected: ZERO matches. If anything appears, it's a residual reference — clean it up.

No commit this task.

---

## Task 5: Fix path bugs and update test runner scripts

**Files:**
- Modify: `tests/scripts/setup-mocks.sh`
- Modify: `tests/scripts/run-phase.sh`
- Modify: `tests/run-tests.sh`
- Modify: `tests/e2e/playwright.config.ts`

### setup-mocks.sh

The script references `terminal/agent/Cargo.toml` (old path before repo extraction). Current path is `agent/Cargo.toml`.

- [ ] **Step 1: Fix the agent path**

Edit `tests/scripts/setup-mocks.sh`. Find:

```bash
AGENT_BIN="$REPO_DIR/terminal/agent/target/debug/netstacks-agent"

if [ ! -f "$AGENT_BIN" ]; then
    echo "Building agent sidecar..."
    cargo build --manifest-path "$REPO_DIR/terminal/agent/Cargo.toml"
fi
```

Replace with:

```bash
AGENT_BIN="$REPO_DIR/agent/target/debug/netstacks-agent"

if [ ! -f "$AGENT_BIN" ]; then
    echo "Building agent sidecar..."
    cargo build --manifest-path "$REPO_DIR/agent/Cargo.toml"
fi
```

### run-phase.sh

Drop `enterprise`/`both` targets, drop the JWT pre-login block, drop case arms 7+9-13.

- [ ] **Step 2: Rewrite `tests/scripts/run-phase.sh`**

Replace the entire file with:

```bash
#!/bin/bash
# Run a specific test phase against the standalone agent.
# Usage: ./run-phase.sh <phase_number>
set -e

PHASE="${1:?Usage: $0 <phase_number>}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TESTS_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== Running Phase $PHASE tests (standalone) ==="

# Auto-load agent token from setup-mocks.sh output
TOKEN_FILE="$TESTS_DIR/.agent-token"
if [ -z "${TEST_AGENT_TOKEN:-}" ] && [ -f "$TOKEN_FILE" ]; then
    export TEST_AGENT_TOKEN=$(cat "$TOKEN_FILE")
    echo "Loaded agent token from $TOKEN_FILE"
fi

if [ -z "${TEST_AGENT_TOKEN:-}" ]; then
    echo "ERROR: TEST_AGENT_TOKEN not set and $TOKEN_FILE not found."
    echo "Run ./scripts/setup-mocks.sh first."
    exit 1
fi

cd "$TESTS_DIR/api"

case "$PHASE" in
    1)  TEST_FILE="phase1_health" ;;
    2)  TEST_FILE="phase2_sessions" ;;
    3)  TEST_FILE="phase3_ai" ;;
    4)  TEST_FILE="phase4_terminal" ;;
    5)  TEST_FILE="phase5_features" ;;
    6)  TEST_FILE="phase6_snmp" ;;
    8)  TEST_FILE="phase8_edge" ;;
    14) TEST_FILE="phase14_devices" ;;
    15) TEST_FILE="phase15_mop_steps" ;;
    *)  echo "Unknown phase: $PHASE (valid: 1, 2, 3, 4, 5, 6, 8, 14, 15)"; exit 1 ;;
esac

cargo test --test "$TEST_FILE" -- --nocapture

echo "=== Phase $PHASE complete ==="
```

The `[standalone|enterprise|both]` second arg is gone. Phase 7 (parity) and 9–13 (controller) are gone from the case statement.

### run-tests.sh

This is a 570-line interactive menu. The minimum change is: drop the controller status row, the `e1-e13`/`b1-b13`/`ea`/`ba` commands, the controller-related menu items, and any references to the controller container.

- [ ] **Step 3: Surgical edits to `tests/run-tests.sh`**

Make these edits in order. Each preserves a working script.

a. Remove the controller status row. Find:
```bash
echo -e " $(status_icon $CONTROLLER_RUNNING) Controller (enterprise) localhost:3000"
```
Delete the line.

b. Remove `CONTROLLER_RUNNING=false` from the State section near the top.

c. In `check_status()`, remove the entire block that checks Docker for controller (the block starting `# Controller — check Docker container...`).

d. In `print_phases()`, remove the entire `─── API Tests (Enterprise Only) ───` section block and the 5 lines of phases 9-13. Also remove phase 7 (parity) since it's deleted. The "API Tests (Cross-Mode)" header can be renamed to just "API Tests".

e. In the Commands section help text, remove `e1-e13`, `b1-b13`, `ea`, `ba` lines.

f. In the command parser (the case statement that maps user input to actions), remove the cases for `e<N>`, `b<N>`, `ea`, `ba`. Also remove cases for phase 7, 9, 10, 11, 12, 13.

g. In any function that takes a target argument (`standalone`/`enterprise`/`both`), remove the enterprise/both branches.

h. Change any prompts that ask "which target?" to just default to standalone.

After editing, run:
```bash
bash -n /Users/cwdavis/scripts/netstacks-terminal/tests/run-tests.sh
```
Expected: no syntax errors.

### playwright.config.ts

- [ ] **Step 4: Fix playwright config**

Replace the contents of `tests/e2e/playwright.config.ts` with:

```typescript
import { defineConfig } from '@playwright/test';

/**
 * NetStacks Terminal E2E Test Configuration (Standalone)
 *
 * Tests the React frontend served by Vite dev server (localhost:5173)
 * against the agent backend (localhost:8080). Tauri only adds window
 * chrome, file dialogs, and sidecar management (not tested here).
 *
 * Prerequisites:
 *   Agent on :8080 (run tests/scripts/setup-mocks.sh)
 *   Vite dev server on :5173 (started automatically via webServer below)
 */
export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  retries: 1,
  workers: 1,

  use: {
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
    viewport: { width: 1400, height: 900 },
  },

  projects: [
    {
      name: 'standalone',
      use: {
        baseURL: 'http://localhost:5173',
      },
    },
  ],

  // Start Vite dev server for tests
  // VITE_DEV_TIER=professional bypasses license check so tests exercise the full UI
  webServer: {
    command: 'cd ../../frontend && VITE_DEV_TIER=professional npm run dev',
    port: 5173,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
```

Notes:
- Dropped the `enterprise` and `admin-ui` projects.
- Removed `testIgnore` from the standalone project (no enterprise/admin tests left to ignore).
- Fixed `../../terminal/frontend` → `../../frontend`.

- [ ] **Step 5: Verify the e2e tsc passes**

Run:
```bash
cd /Users/cwdavis/scripts/netstacks-terminal/tests/e2e
npx tsc --noEmit
```
Expected: PASS — no compile errors. (We're not yet running playwright tests; that's Sub-project 6.)

No commit this task.

---

## Task 6: Update test docs

**Files:**
- Modify: `tests/README.md`
- Modify: `tests/TEST-COVERAGE-PLAN.md`

- [ ] **Step 1: Rewrite `tests/README.md` (standalone-only)**

Replace the contents of `tests/README.md` with a standalone-only version. Keep the structure (Test Runner, Manual Setup, Test Phases, Test Database Isolation, Mock Services, Environment Variables, Directory Structure) but drop:
- Every reference to controller / enterprise / both backends.
- The "Cross-Mode" vs "Enterprise-Only" table split — collapse to one table with phases 1, 2, 3, 4, 5, 6, 8, 14, 15.
- Phase 7 (parity) — feature gone.
- The `e<N>`, `b<N>`, `ea`, `ba`, `bN` commands.
- The controller startup instructions (`./controller-dev.sh --clean`).
- The `TEST_ENTERPRISE`, `TEST_ENTERPRISE_TOKEN`, `TEST_ADMIN_USER`, `TEST_ADMIN_PASS`, `TEST_CONTROLLER_URL` env-var rows.

The phase counts should reflect actual current test counts after Task 4 (use `cargo test --test phase1_health -- --list` etc. to count). If you don't have time to verify counts, write "N tests" and note "counts TBD pending green run."

- [ ] **Step 2: Update `tests/TEST-COVERAGE-PLAN.md`**

If this file references the controller or enterprise modes, drop those references. If it references phases 7+9-13, drop them. If the file is mostly historical / not accurate to current state, prepend a one-line note: `> Historical document. See docs/superpowers/specs/2026-05-02-test-suite-foundation-design.md for current scope.`

- [ ] **Step 3: Verify**

Run:
```bash
grep -ni "enterprise\|controller\|TEST_ENTERPRISE\|both backends" /Users/cwdavis/scripts/netstacks-terminal/tests/README.md /Users/cwdavis/scripts/netstacks-terminal/tests/TEST-COVERAGE-PLAN.md
```
Expected: zero matches (or only matches in the historical-document banner).

No commit this task.

---

## Task 7: Fix App.test.tsx pre-existing failures

**Files:**
- Modify: `frontend/src/App.test.tsx`

`App.test.tsx` has two failing tests because `getClient()` is not initialized in the test setup. The actual behavior the tests assert is "renders without crashing" — they don't need a working API client; they need the API client mocked or short-circuited so render doesn't blow up.

- [ ] **Step 1: Read the current file**

Read `/Users/cwdavis/scripts/netstacks-terminal/frontend/src/App.test.tsx` and `/Users/cwdavis/scripts/netstacks-terminal/frontend/src/setupTests.ts`. Identify the API client module being called (likely `frontend/src/api/client.ts` exporting `getClient()`).

- [ ] **Step 2: Run the failing tests to capture the exact error**

Run:
```bash
cd /Users/cwdavis/scripts/netstacks-terminal/frontend
npm run test -- App.test.tsx --run 2>&1 | tail -40
```
Capture the exact error message — it determines the right fix. Common possibilities:
- `getClient is not initialized` → add a `vi.mock('./api/client', ...)` block at the top of `App.test.tsx` that returns a stub client.
- `Cannot read properties of undefined (reading 'http')` → same fix.
- `Failed to fetch` (real HTTP attempt during render) → mock the offending fetch path.

- [ ] **Step 3: Apply the minimal mock**

Add a `vi.mock` block at the top of `App.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import App from './App'

// Stub the API client so render doesn't attempt real HTTP at mount.
vi.mock('./api/client', () => ({
  getClient: () => ({
    http: {
      get: vi.fn().mockResolvedValue({ data: null }),
      post: vi.fn().mockResolvedValue({ data: null }),
      put: vi.fn().mockResolvedValue({ data: null }),
      delete: vi.fn().mockResolvedValue({ data: null }),
    },
  }),
  getCurrentMode: () => 'standalone',
}))

describe('App', () => {
  it('renders without crashing', () => {
    const { container } = render(<App />)
    expect(container).toBeInTheDocument()
  })

  it('renders a non-empty component', () => {
    const { container } = render(<App />)
    expect(container.firstChild).toBeTruthy()
  })
})
```

Adjust the mock shape to match what `getClient()` actually returns (look at `frontend/src/api/client.ts` for the real shape).

If the mock shape is significantly different, mock additional methods/exports as needed. The principle: minimal stub that lets render complete.

- [ ] **Step 4: Verify the tests pass**

Run:
```bash
cd /Users/cwdavis/scripts/netstacks-terminal/frontend
npm run test -- App.test.tsx --run 2>&1 | tail -10
```
Expected: 2/2 pass.

- [ ] **Step 5: Verify the rest of the frontend test suite still passes**

Run:
```bash
cd /Users/cwdavis/scripts/netstacks-terminal/frontend
npm run test 2>&1 | tail -10
```
Expected: all tests pass (App.test.tsx + aiModes.test.ts + modePrompts.test.ts + Pact tests, ~36 tests).

- [ ] **Step 6: Commit (this file IS tracked)**

```bash
cd /Users/cwdavis/scripts/netstacks-terminal
git add frontend/src/App.test.tsx
git commit -m "$(cat <<'EOF'
test(App): mock API client so smoke tests render cleanly

The two App.test.tsx smoke tests were failing because render()
exercised modules that called getClient() at mount time without
the API client being initialized in the test environment. Mock
the client at the module boundary so render completes.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Bring up test infrastructure

**Files:** none (script execution only)

- [ ] **Step 1: Build the agent if needed**

```bash
cd /Users/cwdavis/scripts/netstacks-terminal/agent
cargo build 2>&1 | tail -5
```
Expected: PASS.

- [ ] **Step 2: Run setup-mocks.sh**

```bash
cd /Users/cwdavis/scripts/netstacks-terminal/tests
./scripts/setup-mocks.sh
```
Expected output ending with:
```
Test infrastructure ready!
  Agent:    http://localhost:8080 (PID <N>)
  Test DB:  /Users/cwdavis/scripts/netstacks-terminal/tests/.test-data/netstacks-test.db
  Token:    <16 hex chars>...
  Mock SSH: localhost:2222
  Mock LLM: localhost:8090
```

If this fails:
- Docker not running → start Docker Desktop and retry.
- Port conflict on :8080 → `lsof -ti :8080 | xargs kill -9`, retry.
- Mock SSH container fails healthcheck → `docker compose -f tests/docker-compose.test.yml logs ssh-server` to diagnose.

- [ ] **Step 3: Verify the agent is responsive**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8080/health
```
Expected: `200`.

- [ ] **Step 4: Verify the auth token works**

```bash
TOKEN=$(cat /Users/cwdavis/scripts/netstacks-terminal/tests/.agent-token)
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:8080/api/sessions | head -c 200
```
Expected: a JSON response (likely `[]` or a list of sessions).

If 401: the token in `.agent-token` doesn't match what the agent expects. Re-run setup-mocks.sh.

No commit this task.

---

## Tasks 9–17: Per-phase verification (in risk order)

Each task follows the same algorithm. Risk order is:

1. **Task 9: Phase 1** — health/settings/vault/auth (sanity check)
2. **Task 10: Phase 8** — edge cases
3. **Task 11: Phase 14** — devices
4. **Task 12: Phase 15** — MOP steps
5. **Task 13: Phase 5** — features
6. **Task 14: Phase 2** — sessions/folders/snippets
7. **Task 15: Phase 6** — SNMP
8. **Task 16: Phase 3** — AI + sanitization (largest, depends on mock LLM)
9. **Task 17: Phase 4** — WebSocket/SSH/SFTP (highest risk, user's explicit ask)

### Per-phase algorithm

For each phase task:

- [ ] **Step 1: Run the phase**

```bash
cd /Users/cwdavis/scripts/netstacks-terminal/tests
./scripts/run-phase.sh <PHASE>
```

Capture the output. Look at the summary line: `test result: ok. N passed; M failed; ...`.

- [ ] **Step 2: For each failing test, diagnose**

For each failing test:

a. **Re-read the failure message**: assertion text, status code, JSON shape mismatch, panic, timeout.

b. **Hit the live agent endpoint with curl** to see what it actually returns now:
   ```bash
   TOKEN=$(cat /Users/cwdavis/scripts/netstacks-terminal/tests/.agent-token)
   curl -s -H "Authorization: Bearer $TOKEN" -X <METHOD> http://localhost:8080/api<PATH> -H 'Content-Type: application/json' -d '<BODY>' | jq .
   ```

c. **Decide using this tree**:
   - If the live agent returns the right thing for the current product, but the test asserts an old shape → **STALE TEST**. Update the test to match the new shape.
   - If the live agent returns wrong/regressed behavior → **REAL APP BUG**. Fix the agent code (`agent/src/...`); commit with `fix(<area>): <what>`. Note in the per-phase report.
   - If the test exercises a feature that no longer exists in the agent (handler missing, route 404 with no replacement) → **REMOVED FEATURE**. Delete the test; log it in `docs/superpowers/TESTING-GAPS.md` (create if needed) with phase + test name + feature description.

d. **Apply the fix**.

- [ ] **Step 3: Re-run the phase**

```bash
./scripts/run-phase.sh <PHASE>
```

If still failing tests (different ones), repeat Step 2.
If failures are flakes (timing-dependent, intermittent), fix the root cause — don't add `#[ignore]`.

- [ ] **Step 4: Confirm phase is fully green**

The phase output must read `test result: ok. N passed; 0 failed`. Anything less is not done.

- [ ] **Step 5: Write a short per-phase report**

Append to `docs/superpowers/TESTING-PHASE-REPORTS.md` (create if needed):

```markdown
## Phase N (<short name>) — verified <date>

**Tests passing:** N/M (after fixes)

**Stale tests updated:**
- `phaseN_<file>::test_xyz` — endpoint now returns `<shape>`, was asserting `<old shape>`.

**App bugs fixed:**
- `agent/src/<module>` — <what was wrong, what fix was applied, commit SHA>.

**Removed-feature tests deleted:**
- `phaseN_<file>::test_old_feature` — feature removed in <version/commit>; logged in TESTING-GAPS.md.

**Notes:** <any quirks worth knowing>
```

- [ ] **Step 6: If app code was modified, commit**

If you fixed agent bugs:
```bash
cd /Users/cwdavis/scripts/netstacks-terminal
git add agent/src/...
git commit -m "fix(<area>): <what>

Surfaced by Phase N test verification (Sub-project 0).
"
```

If you only updated tests, no commit (tests/ is gitignored).

---

## Task 9: Phase 1 — Health / Settings / Vault / Auth

Phase 1 is the smallest and the cheapest. If it fails, infrastructure is broken — don't proceed to other phases until it's green.

Apply the per-phase algorithm above with `<PHASE>=1`.

**Phase 1 covers:**
- `GET /health`
- Settings CRUD (`GET/PUT /settings/:key`)
- Vault status / unlock / lock
- API key vault CRUD
- Auth token validation

**Likely failure modes:**
- Auth token mismatch → infrastructure issue, not a test bug.
- Settings endpoint shape changed → stale test (update assertion).
- Vault biometric on Linux test machine → may need to skip or mock; note in report.

---

## Task 10: Phase 8 — Edge cases

`<PHASE>=8`. Mostly status-code assertions: 404 on missing resources, 400 on malformed bodies, unicode handling, concurrency.

**Likely failure modes:**
- Status code drift (e.g., `400 → 422` for validation errors) → stale test.
- Unicode handling changes → could be either, investigate.

---

## Task 11: Phase 14 — Devices

`<PHASE>=14`. Newer phase — likely closer to current state.

**Likely failure modes:**
- Device schema additions (new fields) → stale test (additive, just update).
- Device removed/renamed handlers → check git log.

---

## Task 12: Phase 15 — MOP steps

`<PHASE>=15`. Newer phase.

**Likely failure modes:**
- MOP execution route reshuffles (the audit showed extensive MOP execution surface) → likely needs path updates.
- Step execution shape changes → stale test.

---

## Task 13: Phase 5 — Features

`<PHASE>=5`. Broad surface: scripts, docs, topologies, MOPs, agents, lookups.

**Likely failure modes:**
- Topology v2 schema (devices/connections fields) → stale test.
- Document categories may have changed → stale test.
- Lookup endpoints (`/lookup/oui/:mac` etc.) likely stable.

---

## Task 14: Phase 2 — Sessions / Folders / Snippets

`<PHASE>=2`. Schema may have drifted significantly.

**Likely failure modes:**
- Session move shape changed → stale test (covered by Task 3 fixture rewrite).
- Folder hierarchy changes → investigate.
- Snippet body changes → stale test.

---

## Task 15: Phase 6 — SNMP

`<PHASE>=6`. Depends on mock SSH server's SNMP responder behavior.

**Likely failure modes:**
- Mock SNMP responder returns different OIDs than tests expect → fix the mock, not the agent.
- SNMP discovery batch shape changes → stale test.

---

## Task 16: Phase 3 — AI + Sanitization (41 tests)

`<PHASE>=3`. Largest phase. Depends on mock LLM server. The 19 sanitization patterns are heavily tested here.

**Likely failure modes:**
- Mock LLM response shape changed (e.g., switched to streaming) → check `tests/mocks/llm-server/`.
- AI provider config schema changed (e.g., added `auth_mode` field) → stale test.
- Sanitization pattern count drifted (the audit showed 19 mandatory + 5 optional + custom) → stale test if the test was written for an older count.
- Onboarding gating: agent-chat routes may now hit onboarding first if profile not set → tests need to set profile first or set a "onboarded" marker.

---

## Task 17: Phase 4 — WebSocket / SSH / SFTP (highest risk, user's explicit ask)

`<PHASE>=4`. The most likely to surface real app bugs.

**Likely failure modes:**
- WebSocket protocol drift (frame shape changed) → real bug or stale test, depending on intent.
- SSH connection timing → flake; investigate root cause.
- SFTP route shape (the audit showed `/api/sftp/:id/<op>` paths) — verify test paths match.
- Mock SSH server behavior (canned `show version` output, etc.) → fix mock if drift.
- The `ws_terminal_url` helper rewrite from Task 4 — verify it produces the right URL by adding a printout in the first failing test.

This task may take significantly longer than the others. **Do not declare green until every test in phase 4 passes.** If a single test is unfixable in this sub-project's scope, escalate to user — don't paper over with `#[ignore]`.

---

## Task 18: Frontend Vitest sweep

**Files:** none (verification only)

- [ ] **Step 1: Run the full frontend test suite**

```bash
cd /Users/cwdavis/scripts/netstacks-terminal/frontend
npm run test 2>&1 | tail -15
```

Expected: all tests pass. This includes:
- `App.test.tsx` (2 tests, fixed in Task 7)
- `aiModes.test.ts` (22 tests, from earlier feature work)
- `modePrompts.test.ts` (8 tests, from earlier feature work)
- Pact contract tests

If failures emerge, follow the same diagnose-fix-rerun loop from the per-phase tasks. Frontend test failures may be:
- Stale test → update.
- Real frontend bug → fix.
- Removed feature → delete + log in TESTING-GAPS.md.

- [ ] **Step 2: Run typecheck and lint as a final sanity check**

```bash
cd /Users/cwdavis/scripts/netstacks-terminal/frontend
npx tsc --noEmit && npm run lint 2>&1 | grep -E "error" | head -5
```

Expected: tsc clean. Lint may have pre-existing baseline noise — only NEW errors introduced by Task 7 are blocking.

If you committed agent or frontend fixes during phases 9-17, the commit messages already exist; nothing more to commit here.

---

## Task 19: Reproducibility check (cold restart)

**Files:** none (verification only)

The pass criterion isn't "tests passed once when I ran them" — it's "tests pass green from a cold start of the test infrastructure."

- [ ] **Step 1: Tear down**

```bash
cd /Users/cwdavis/scripts/netstacks-terminal/tests
./scripts/teardown.sh
```
Expected: agent killed, mock containers down, `.agent-pid` and `.agent-token` removed, `.test-data/` removed.

- [ ] **Step 2: Cold start**

```bash
cd /Users/cwdavis/scripts/netstacks-terminal/tests
./scripts/setup-mocks.sh
```
Expected: same successful output as Task 8.

- [ ] **Step 3: Re-run all retained phases**

Run each phase in order:

```bash
cd /Users/cwdavis/scripts/netstacks-terminal/tests
for PHASE in 1 2 3 4 5 6 8 14 15; do
    echo "=== Phase $PHASE ==="
    ./scripts/run-phase.sh $PHASE
    if [ $? -ne 0 ]; then
        echo "FAIL: phase $PHASE did not pass on cold start"
        exit 1
    fi
done
echo ""
echo "All retained phases green from cold start."
```

Expected: every phase passes; final line `All retained phases green from cold start.`

If a phase that previously passed now fails on cold start, that's a flake (test ordering, leftover state, race). Fix the root cause; don't accept flakes.

- [ ] **Step 4: Final teardown**

```bash
cd /Users/cwdavis/scripts/netstacks-terminal/tests
./scripts/teardown.sh
```

No commit this task.

---

## Task 20: Finalize TESTING-GAPS.md

**Files:**
- Create or finalize: `docs/superpowers/TESTING-GAPS.md`

This document feeds into Sub-projects 1–7. Every test deleted because the feature is gone, every test ignored because it's flaky and unfixable in this scope, every coverage area we know is now untested — capture it here.

- [ ] **Step 1: Aggregate notes from per-phase reports**

Read `docs/superpowers/TESTING-PHASE-REPORTS.md` (built up across Tasks 9–17). Pull every "Removed-feature tests deleted" line into a structured `TESTING-GAPS.md`:

```markdown
# Testing Gaps

Tests removed during Sub-project 0 (Foundation cleanup) because their feature is gone, plus known coverage gaps.
Each entry feeds into a future sub-project for replacement coverage where applicable.

## Removed-feature tests deleted

| Phase | Test | Feature | Replacement coverage planned |
|---|---|---|---|
| 2 | `test_session_share_url` | Session sharing | Sub-project 6 (E2E) if feature is brought back |
| ... | ... | ... | ... |

## Coverage gaps (always-untested areas surfaced during cleanup)

| Area | Why not covered today | Sub-project that will address |
|---|---|---|
| MCP SSE transport | No mock SSE server in tests/mocks/ | Sub-project 4 (MCP) |
| ... | ... | ... |

## Phase pass status (after Sub-project 0)

| Phase | Tests | Status | Notes |
|---|---|---|---|
| 1 | <N> | ✅ green | |
| 2 | <N> | ✅ green | |
| ... | ... | ... | ... |
```

- [ ] **Step 2: Commit**

```bash
cd /Users/cwdavis/scripts/netstacks-terminal
git add docs/superpowers/TESTING-GAPS.md docs/superpowers/TESTING-PHASE-REPORTS.md
git commit -m "$(cat <<'EOF'
docs: testing gaps and phase reports from Sub-project 0

Captures every test deleted because the feature it covered no
longer exists, plus known coverage gaps surfaced during the
foundation cleanup. Feeds Sub-projects 1-7 planning.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Done criteria

Sub-project 0 is done when ALL of the following are true:

1. The 6 controller-only API phase files are deleted.
2. The 11 enterprise/admin E2E specs are deleted.
3. `TestMode` is fully purged (zero `grep` matches across `tests/`).
4. `tests/scripts/setup-mocks.sh` finds the agent at `agent/Cargo.toml` (not `terminal/agent/`).
5. `tests/e2e/playwright.config.ts` has only the `standalone` project; webServer points to `../../frontend`.
6. `tests/run-tests.sh` and `tests/scripts/run-phase.sh` reject enterprise/both targets and don't list controller phases.
7. `frontend/src/App.test.tsx` passes 2/2 (committed fix).
8. **All 9 retained phases pass green** on `./run-tests.sh all standalone` from a cold-started infrastructure.
9. `docs/superpowers/TESTING-PHASE-REPORTS.md` documents per-phase results.
10. `docs/superpowers/TESTING-GAPS.md` documents removed-feature tests + coverage gaps for Sub-projects 1–7.
11. Any agent or frontend bugs fixed during verification have their own commits with `fix(<area>):` messages.

If condition 8 isn't true, **the sub-project isn't done.** No assumptions. Re-run from cold start until it's green.
