# Test Suite Foundation — Sub-Project 0 Design

**Date:** 2026-05-02
**Status:** Approved
**Parent program:** Comprehensive test coverage for netstacks-terminal (8 sub-projects)
**Scope:** Foundation only — strip controller-only test code, fix repo-extraction path bugs, get every retained phase test passing green against the current standalone application.

## Problem

The `tests/` directory was authored when this codebase shared a repo with a separate enterprise controller product. After extraction, the suite still:

1. Contains 5 controller-only API phase files (~104 tests) that target a backend not present in this repo.
2. Contains a `phase7_parity.rs` whose only purpose is to run the same test against both backends.
3. Contains 11 enterprise/admin Playwright specs targeting a controller-served UI.
4. Has a `TestMode` enum threaded through `client.rs`, `fixtures.rs`, and every retained phase file as dead-weight dual-mode infrastructure.
5. Has two path bugs from the repo extraction:
   - `tests/scripts/setup-mocks.sh:30,34` references `terminal/agent/Cargo.toml`; current path is `agent/Cargo.toml`.
   - `tests/e2e/playwright.config.ts` webServer command references `../../terminal/frontend`; current path is `../../frontend`.
6. Has unverifiable test status — phases haven't been run against the current standalone application since extraction. Many tests likely assert against API shapes that have since drifted.

## Goals

- Every retained phase test (1, 2, 3, 4, 5, 6, 8, 14, 15) passes green in a fresh `setup-mocks → run-phase → teardown` cycle.
- The standalone test runner (`./run-tests.sh`, `./scripts/run-phase.sh`, `./scripts/setup-mocks.sh`) is consistent and works without enterprise-mode flags.
- A `TESTING-GAPS.md` documents every test deleted because the feature it covered no longer exists, feeding planning for Sub-projects 1–7.
- "Done" means **every retained test produces green output**, not "tests are present."

## Non-Goals

- Adding new test coverage (Sub-projects 1–7).
- Running the full Playwright E2E suite green (Sub-project 6 — fix the config here, full E2E pass later).
- Touching the frontend Pact contract tests other than verifying they still compile.
- Restructuring the test runner UI beyond removing dead enterprise commands.
- Refactoring the agent code beyond fixing bugs surfaced by tests.

## Architecture

The work is three sequential phases:

1. **Strip & simplify** — mechanical deletion + helper collapse + path-bug fixes. One commit per logical concern (delete controller phases, simplify TestMode, fix paths, etc.). Must compile cleanly before Phase B.

2. **Verify each phase green** — the real work. Run phases in risk order: Phase 1 first (cheapest, sanity-check), Phase 4 last (highest-risk, terminal/WebSocket). For each failing test:
   - Diagnose: stale assertion vs. real app bug vs. removed feature.
   - **Stale test** → update test to match current behavior; commit `test(phaseN): update <X>`.
   - **Real bug** → fix agent code; commit `fix(<area>): <what>`; surface in end-of-phase report.
   - **Removed feature** → delete test; log in `TESTING-GAPS.md`.
   Re-run the phase. Don't move on until it's fully green.

3. **Document gaps & reproducibility** — finalize `TESTING-GAPS.md`; tear down + cold-restart and re-run all phases to confirm reproducibility.

## Components

### Files deleted

- `tests/api/tests/phase7_parity.rs`
- `tests/api/tests/phase9_controller_comparable.rs`
- `tests/api/tests/phase10_controller_admin.rs`
- `tests/api/tests/phase11_controller_high.rs`
- `tests/api/tests/phase12_controller_medium.rs`
- `tests/api/tests/phase13_controller_low.rs`
- `tests/api/src/modes.rs`
- `tests/e2e/tests/enterprise-terminal.spec.ts`
- `tests/e2e/tests/admin/` (10 files)

### Files rewritten / edited

| Path | Change |
|---|---|
| `tests/api/src/lib.rs` | Drop `pub mod modes;` |
| `tests/api/src/client.rs` | Drop `TestMode`/login/JWT/OnceLock; constructor reads `TEST_AGENT_TOKEN`; methods take plain paths and prepend `/api`. |
| `tests/api/src/fixtures.rs` | Drop `session_definition_body`; collapse mode-aware factories to standalone shapes; drop the `mode: &TestMode` parameter. |
| `tests/api/tests/phase{1,2,3,4,5,6,8,14,15}_*.rs` | Remove `for_each_mode`; remove `TestMode::Enterprise` arms; clients via `TestClient::new()` (no mode arg); WebSocket helpers use a single `agent_url()` helper. |
| `tests/scripts/setup-mocks.sh` | `$REPO_DIR/terminal/agent/Cargo.toml` → `$REPO_DIR/agent/Cargo.toml`. |
| `tests/scripts/run-phase.sh` | Drop `enterprise`/`both` targets; drop JWT pre-login; drop case arms 7, 9–13. |
| `tests/run-tests.sh` | Drop controller status row; drop `e1-e13`/`b1-b13`/`ea`/`ba` commands; drop phases 7+9–13 from menu. |
| `tests/e2e/playwright.config.ts` | Drop `enterprise` and `admin-ui` projects; fix `../../terminal/frontend` → `../../frontend`. |
| `tests/README.md` | Drop enterprise table and env-var rows; update phase count. |
| `tests/TEST-COVERAGE-PLAN.md` | Drop controller references. |
| `frontend/src/App.test.tsx` | Fix the 2 pre-existing `getClient()` failures. |

### Files created

- `tests/TESTING-GAPS.md` — running log of tests deleted because their feature no longer exists.

## Verification Flow

```bash
# Phase A: Compile
cargo build --manifest-path tests/api/Cargo.toml --tests
cd tests/e2e && npx tsc --noEmit

# Phase B: Bring up infrastructure
cd tests && ./scripts/setup-mocks.sh
# (writes .agent-token, starts mock SSH:2222, mock LLM:8090, agent:8080)

# Phase C: Per-phase verification (in risk order — cheapest first, riskiest last)
# 1 → 8 → 14 → 15 → 5 → 2 → 6 → 3 → 4
for PHASE in 1 8 14 15 5 2 6 3 4; do
    ./scripts/run-phase.sh $PHASE standalone
    # If FAIL: diagnose stale-test vs app-bug, fix, re-run; do not advance until green
done

# Phase D: Frontend Vitest
cd frontend && npm run test  # incl. App.test.tsx fixes

# Phase E: Reproducibility
cd tests && ./scripts/teardown.sh && ./scripts/setup-mocks.sh
./run-tests.sh all standalone  # full re-run from cold start; must be green
```

## Per-Phase Failure Decision Tree

```
test fails in phase N
  │
  ├── Does the test assert on a JSON shape / status code that the live agent disagrees with?
  │     │
  │     ├── Is the live agent's behavior correct for the current product?
  │     │     ├── YES → STALE TEST. Update assertion. Commit: test(phaseN): update <X>.
  │     │     └── NO  → REAL BUG. Fix agent. Commit: fix(<area>): <what>.
  │     │
  │     └── (re-run phase)
  │
  └── Does the test exercise a feature that no longer exists?
        ├── YES → REMOVED FEATURE. Delete test. Log in TESTING-GAPS.md.
        └── (re-run phase)
```

## Risk Ordering for Phase C

Cheapest, most-likely-passing first; highest-risk last:

1. **Phase 1** (health/settings/vault/auth) — small, sanity check
2. **Phase 8** (edge cases) — mostly status-code assertions
3. **Phase 14** (devices) — newer phase
4. **Phase 15** (MOP steps) — newer phase
5. **Phase 5** (features: scripts/docs/topologies/MOPs/agents/lookups) — broad
6. **Phase 2** (sessions/folders/snippets) — schema may have drifted
7. **Phase 6** (SNMP) — depends on mock SSH SNMP responder
8. **Phase 3** (AI + 41 tests including 19 sanitization patterns) — depends on mock LLM
9. **Phase 4** (WebSocket terminal/SSH/SFTP) — highest-risk, user's explicit ask

## Error Handling

- **Compile failure in Phase A** → block; cannot proceed to verification.
- **Infrastructure failure in Phase B** (mocks/agent won't start) → block; investigate (likely path bug, container issue, or port conflict). Don't proceed to per-phase loop.
- **Repeated unfixable test failure** → escalate to user; do not paper over with `#[ignore]`. If the test reflects a real product gap that can't be fixed in this sub-project's scope, log it in `TESTING-GAPS.md` and surface it for Sub-project planning.
- **Reproducibility failure in Phase E** (tests pass once but flake on cold restart) → fix the root cause (likely test ordering, leftover state, or a race). Do not declare "done" with flakes.

## Deliverables

- Branch `feat/test-foundation-cleanup` with all changes.
- Every retained phase passes green: documented terminal output of `./run-tests.sh all standalone` showing all phases passed.
- `tests/TESTING-GAPS.md` listing every deleted test and the feature it covered.
- A short report listing every app bug fixed and every test rewritten, surfaced before merge.

## Open Questions

None at design time. Implementation will surface answers about specific test failures.
