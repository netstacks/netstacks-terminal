# AI Mode Prompt Overrides — Design

**Date:** 2026-05-02
**Status:** Approved (pending implementation plan)
**Scope:** Frontend-only

## Problem

The Settings → Prompts UI exposes 5 system-prompt overrides today:

1. AI Troubleshooting (Side Panel)
2. AI Discovery (Topology Enrichment)
3. Topology Canvas AI
4. Script Generation
5. Agent Tasks (Background)

Two issues:

1. **Asymmetry.** The AI assistant runs in 4 modes (Chat, Operator, Troubleshoot, Copilot — see `frontend/src/lib/aiModes.ts`). Only "Troubleshoot" appears to have an override, and the other 3 modes' base prompts (`MODE_PROMPTS`) are hardcoded with no UI to customize them.
2. **Existing "Troubleshoot" override is mostly dead code.** The override is stored at `ai.provider_config.systemPrompt` and consumed only on the Rust side as a fallback (`agent/src/ai/chat.rs:843-845`):

   ```rust
   let base_prompt = req_system_prompt
       .or(custom_prompt)
       .unwrap_or_else(|| AGENT_SYSTEM_PROMPT.to_string());
   ```

   But the frontend always sends a `system_prompt` derived from `getModeSystemPrompt(mode, isEnterprise)` (`frontend/src/hooks/useAIAgent.ts:2228-2230` and ~L2336), so `req_system_prompt` is always `Some(...)` and `custom_prompt` is never reached in practice. Users editing the existing field see no effect on the model.

## Goals

- Surface all 4 AI mode prompts as user-editable overrides in Settings → Prompts.
- Fix the broken Troubleshoot override by routing it through the same path as the other 3 modes.
- Preserve any value the user has already saved in the legacy field via one-shot migration.
- Frontend-only change. No Rust backend changes.

## Non-Goals

- Surfacing other hardcoded prompt categories (MOP cluster, Highlight Analysis, Onboarding, Session Summarization, MOP Real-Time Pilot). Tracked separately as Tiers 2–4.
- Editing `NETSTACKS_IDENTITY` (shared platform-knowledge prefix) or the enterprise/standalone addenda.
- Per-mode model, temperature, or token-budget overrides.

## Architecture

### Storage

One settings key per mode, mirroring the existing `ai.discovery_prompt` / `ai.topology_prompt` / `ai.script_prompt` pattern:

- `ai.mode_prompt.chat`
- `ai.mode_prompt.operator`
- `ai.mode_prompt.troubleshoot` (migrated from `ai.provider_config.systemPrompt`)
- `ai.mode_prompt.copilot`

Each value is a string. Empty / null / absent means "use the built-in default" — same convention as the existing 3 prompt settings.

### Override target

The override replaces only the per-mode block (`MODE_PROMPTS[mode]`, the `## Mode: X` section). The composer in `aiModes.ts` continues to assemble:

```
NETSTACKS_IDENTITY + <override-or-default> + <enterprise-or-standalone-addendum>
```

Rationale:
- Smallest, most focused edit surface for the user.
- Avoids duplicating ~1KB of `NETSTACKS_IDENTITY` in 4 places.
- Tier-specific addendum stays automatic — the user doesn't have to remember to keep the enterprise/standalone footer in sync.

### Wiring change

`getModeSystemPrompt(mode, isEnterprise)` gains an optional 3rd parameter `overrides?: Partial<Record<AIMode, string>>`. When the override for the requested mode is a non-empty string, it substitutes for `MODE_PROMPTS[mode]`. Otherwise the default is used. `NETSTACKS_IDENTITY` and addendum logic are unchanged.

The Rust backend (`agent/src/ai/chat.rs`) needs no changes — the frontend already sends the composed prompt as `system_prompt` and the backend treats it as `req_system_prompt` (priority 1).

### Migration

One-shot, idempotent, runs on first read of mode prompts after upgrade:

1. Read `ai.mode_prompt.troubleshoot` and `ai.provider_config.systemPrompt`.
2. If troubleshoot is empty/null AND `provider_config.systemPrompt` is non-empty:
   - Write `provider_config.systemPrompt` → `ai.mode_prompt.troubleshoot`.
   - Clear `systemPrompt` from the `provider_config` object (write back without the field).
3. Subsequent reads find `ai.mode_prompt.troubleshoot` populated and skip the migration.

This mirrors the existing localStorage → backend migration for `aiDiscoveryPrompt` in `PromptsSettingsTab.tsx:101-109`.

### UI

The "SYSTEM PROMPTS" section in `PromptsSettingsTab` splits into two visually-grouped subsections:

- **AI Modes** (4): Chat, Operator, Troubleshoot, Copilot
- **Specialized Tasks** (4): AI Discovery, Topology Canvas, Script Generation, Agent Tasks

The existing "AI Troubleshooting (Side Panel)" entry becomes "Troubleshoot Mode" and moves into the AI Modes group.

## Components

### New

| Component | Where | Purpose |
|---|---|---|
| `MODE_PROMPTS` exported | `frontend/src/lib/aiModes.ts` | Make per-mode default strings consumable as defaults in the settings UI (currently `const`-private). |
| `getModePrompt(mode)` / `setModePrompt(mode, value\|null)` | `frontend/src/api/ai.ts` | CRUD against `ai.mode_prompt.<mode>`. Mirrors `getTopologyPrompt` / `setTopologyPrompt`. |
| `getAllModePrompts()` | `frontend/src/api/ai.ts` | Single batched fetch returning `Record<AIMode, string \| null>` to avoid 4 round-trips. Includes the migration step. |
| `modeOverridesRef` in `useAIAgent` | `frontend/src/hooks/useAIAgent.ts` | Cached `Record<AIMode, string \| null>`, refreshed on mount and on settings save events. Mirrors the existing `topologyPromptRef` pattern. |
| `DEFAULT_MODE_PROMPTS` re-export | `frontend/src/api/ai.ts` | Re-export `MODE_PROMPTS` from `aiModes.ts` so the settings UI's editor has a "default" for the reset/diff button without importing from `lib/`. (Optional convenience; can also import directly.) |

### Modified

| Component | Change |
|---|---|
| `getModeSystemPrompt(mode, isEnterprise, overrides?)` in `aiModes.ts` | Add optional `overrides` arg. When set and non-empty for the requested mode, substitute for `MODE_PROMPTS[mode]`. |
| `useAIAgent.ts` ~L2228 and ~L2336 | Pass `modeOverridesRef.current` as the 3rd arg to `getModeSystemPromptFn`. |
| `PromptsSettingsTab.tsx` | Add `'chat' \| 'operator' \| 'copilot'` to `SystemKey`; add 3 entries to `SYSTEM_PROMPT_META`; rename `'troubleshooting'` → `'troubleshoot'` with label "Troubleshoot Mode"; replace `getAiConfig`/`setAiConfig` calls for the troubleshoot key with `getModePrompt`/`setModePrompt`; split SYSTEM PROMPTS UI into two subsection headers. |
| `PromptsSettingsTab.css` | Add subsection-header styles if needed. |

## Data Flow

### Chat request after change

```
User sends a message in mode=operator
  → useAIAgent.callAgentApi (or callAgentApiStream)
  → getModeSystemPrompt('operator', isEnterprise, modeOverridesRef.current)
      → if modeOverrides.operator is non-empty:
          NETSTACKS_IDENTITY + <override> + addendum
        else:
          NETSTACKS_IDENTITY + MODE_PROMPTS.operator + addendum
  → POST /ai/agent-chat { system_prompt: <composed> }
  → agent/src/ai/chat.rs: req_system_prompt.or(custom_prompt).unwrap_or(AGENT_SYSTEM_PROMPT)
      → req_system_prompt is always present (frontend always passes it),
        so the backend's AGENT_SYSTEM_PROMPT and the legacy
        ai.provider_config.systemPrompt are bypassed.
```

### Migration on first load after upgrade

```
PromptsSettingsTab mount
  → getAllModePrompts()
     → reads ai.mode_prompt.{chat, operator, troubleshoot, copilot}
     → if troubleshoot is empty/null AND ai.provider_config.systemPrompt is non-empty:
         copy systemPrompt → ai.mode_prompt.troubleshoot
         clear systemPrompt from ai.provider_config (PUT updated config without the field)
     → returns the resolved Record<AIMode, string|null>
```

Idempotent: after the copy, `systemPrompt` is gone from `provider_config`, so subsequent loads skip the migration.

## Error Handling

- **Settings read failure** — log and treat as unset (default applies). Same convention as existing `getTopologyPrompt` / `getScriptPrompt` callers.
- **Settings write failure** — surface in the existing editor toast/error UI. `PromptsSettingsTab` already handles this for the other 3 prompts.
- **Migration failure** — log only; never block the settings page from rendering. The user can still see the legacy value in the existing field's display state if needed and re-paste it manually.

## Testing

### Unit

- `getModeSystemPrompt(mode, isEnterprise, overrides)` — 4 modes × {override set, override empty, override absent} × {enterprise, standalone}. Verify:
  - Correct mode section appears (override or default).
  - `NETSTACKS_IDENTITY` is always present.
  - Correct addendum (enterprise vs. standalone, except chat which has no addendum).
- Migration helper — three states:
  - No legacy value, no new value → no writes.
  - Legacy value present, new value empty → copy + clear.
  - Both present → no writes (new value wins, legacy is left alone for safety).

### Manual smoke

For each of the 4 modes:
1. Open Settings → Prompts → AI Modes → \<mode\>.
2. Save an override that includes a sentinel sentence (e.g., "Always end every reply with the word BANANA.").
3. Switch the assistant into that mode and send a message.
4. Confirm the model output reflects the sentinel.

This is the only way to verify the full wire end-to-end.

### Migration smoke

1. Before upgrade: save a value in the legacy "AI Troubleshooting (Side Panel)" field.
2. Upgrade.
3. Open Settings → Prompts. Confirm the value now appears under "Troubleshoot Mode".
4. Confirm the legacy field is gone (no longer rendered) or empty in `ai.provider_config`.
5. Reload. Confirm no further migration writes occur.

## Open Questions

None at design time. Implementation plan should pick up:
- Exact subsection header markup / CSS (small detail).
- Whether `getAllModePrompts` lives in `api/ai.ts` alongside the per-key getters or in a new helper module.
- Whether to debounce the `modeOverridesRef` refresh on settings-save events or rely on a manual refresh trigger.
