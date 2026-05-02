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
