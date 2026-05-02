# AI Mode Prompt Overrides Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface all 4 AI mode prompts (Chat / Operator / Troubleshoot / Copilot) as user-editable overrides in Settings → Prompts, and route the existing Troubleshoot setting through the active path so saved values actually reach the model.

**Architecture:** Frontend-only. Each mode prompt gets its own settings key (`ai.mode_prompt.<mode>`) following the existing `ai.topology_prompt` / `ai.script_prompt` pattern. The composer in `aiModes.ts` (`getModeSystemPrompt`) gains an `overrides` parameter that substitutes the per-mode `## Mode: X` block while preserving `NETSTACKS_IDENTITY` and the enterprise/standalone addendum. A one-shot migration moves any saved `ai.provider_config.systemPrompt` value into `ai.mode_prompt.troubleshoot`.

**Tech Stack:** TypeScript, React, Vitest, Vite, Axios.

**Spec:** `docs/superpowers/specs/2026-05-02-ai-mode-prompt-overrides-design.md`

---

## File Structure

**Create:**
- `frontend/src/lib/__tests__/aiModes.test.ts` — unit tests for `getModeSystemPrompt(mode, isEnterprise, overrides?)`
- `frontend/src/api/__tests__/modePrompts.test.ts` — unit tests for the migration helper

**Modify:**
- `frontend/src/lib/aiModes.ts` — export `MODE_PROMPTS`; add `overrides?` parameter to `getModeSystemPrompt`
- `frontend/src/api/ai.ts` — add `getModePrompt`, `setModePrompt`, `getAllModePrompts` (incl. migration)
- `frontend/src/hooks/useAIAgent.ts` — add `modeOverridesRef`, load on mount, pass to `getModeSystemPromptFn`
- `frontend/src/components/PromptsSettingsTab.tsx` — replace single `troubleshooting` entry with 4 mode entries; split UI into "AI Modes" + "Specialized Tasks" subsections
- `frontend/src/components/PromptsSettingsTab.css` — subsection-header style

---

## Task 1: Add `overrides` parameter to `getModeSystemPrompt`

**Files:**
- Modify: `frontend/src/lib/aiModes.ts`
- Create: `frontend/src/lib/__tests__/aiModes.test.ts`

The composer needs to accept a per-mode overrides map and substitute the override (when non-empty) for the default `MODE_PROMPTS[mode]` block. `MODE_PROMPTS` also needs to be exported so the settings UI can use the defaults as fallbacks.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/lib/__tests__/aiModes.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { getModeSystemPrompt, MODE_PROMPTS, type AIMode } from '../aiModes'

const MODES: AIMode[] = ['chat', 'operator', 'troubleshoot', 'copilot']
const SENTINEL = '## Mode: SENTINEL\n\nThis is a test override.'

describe('getModeSystemPrompt', () => {
  for (const mode of MODES) {
    it(`uses default ${mode} prompt when no overrides passed`, () => {
      const out = getModeSystemPrompt(mode, true)
      expect(out).toContain(MODE_PROMPTS[mode])
    })

    it(`uses default ${mode} prompt when overrides for that mode is empty/absent`, () => {
      const out = getModeSystemPrompt(mode, true, {})
      expect(out).toContain(MODE_PROMPTS[mode])
    })

    it(`uses default ${mode} prompt when override value is empty string`, () => {
      const out = getModeSystemPrompt(mode, true, { [mode]: '' })
      expect(out).toContain(MODE_PROMPTS[mode])
    })

    it(`substitutes override for ${mode} when override is non-empty`, () => {
      const out = getModeSystemPrompt(mode, true, { [mode]: SENTINEL })
      expect(out).toContain(SENTINEL)
      expect(out).not.toContain(MODE_PROMPTS[mode])
    })
  }

  it('always includes NETSTACKS_IDENTITY (with or without override)', () => {
    const withDefault = getModeSystemPrompt('operator', false)
    const withOverride = getModeSystemPrompt('operator', false, { operator: SENTINEL })
    expect(withDefault).toContain('NetStacks Platform Knowledge')
    expect(withOverride).toContain('NetStacks Platform Knowledge')
  })

  it('appends enterprise addendum when isEnterprise=true (non-chat modes)', () => {
    const out = getModeSystemPrompt('operator', true)
    expect(out).toContain('Enterprise Features Available')
  })

  it('appends standalone addendum when isEnterprise=false (non-chat modes)', () => {
    const out = getModeSystemPrompt('operator', false)
    expect(out).toContain('enterprise-only features')
  })

  it('chat mode never gets an addendum', () => {
    const ent = getModeSystemPrompt('chat', true)
    const std = getModeSystemPrompt('chat', false)
    expect(ent).not.toContain('Enterprise Features Available')
    expect(std).not.toContain('enterprise-only features')
  })

  it('override for one mode does not affect another mode', () => {
    const out = getModeSystemPrompt('chat', true, { operator: SENTINEL })
    expect(out).not.toContain(SENTINEL)
    expect(out).toContain(MODE_PROMPTS.chat)
  })
})

describe('MODE_PROMPTS export', () => {
  it('exports all four modes', () => {
    for (const mode of MODES) {
      expect(MODE_PROMPTS[mode]).toBeDefined()
      expect(typeof MODE_PROMPTS[mode]).toBe('string')
      expect(MODE_PROMPTS[mode].length).toBeGreaterThan(0)
    }
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npm run test -- aiModes.test`
Expected: FAIL — `MODE_PROMPTS` is not exported, `getModeSystemPrompt` doesn't accept third arg.

- [ ] **Step 3: Modify `frontend/src/lib/aiModes.ts`**

Change the `MODE_PROMPTS` declaration from `const MODE_PROMPTS` to `export const MODE_PROMPTS` (line 99).

Update `getModeSystemPrompt` (lines 240-247) to accept and use the overrides map:

```ts
/**
 * Get the system prompt for a given AI mode.
 * Composes: NETSTACKS_IDENTITY + (override-or-default mode block) + tier addendum.
 * User AI Engineer Profiles are appended on top by the caller.
 *
 * @param mode - The active AI mode
 * @param isEnterprise - Whether the user is on the Enterprise tier
 * @param overrides - Optional per-mode prompt overrides from Settings → Prompts.
 *                   When the override for `mode` is a non-empty string, it
 *                   replaces the built-in `MODE_PROMPTS[mode]` block.
 *                   `NETSTACKS_IDENTITY` and the addendum are not affected.
 */
export function getModeSystemPrompt(
  mode: AIMode,
  isEnterprise: boolean,
  overrides?: Partial<Record<AIMode, string | null>>,
): string {
  const override = overrides?.[mode]
  const modePrompt = (override && override.trim()) ? override : MODE_PROMPTS[mode]
  const addendum = mode === 'chat' ? ''
    : isEnterprise ? ENTERPRISE_ADDENDUM
    : STANDALONE_ADDENDUM

  return `${NETSTACKS_IDENTITY}\n\n${modePrompt}${addendum}`
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npm run test -- aiModes.test`
Expected: PASS — all `getModeSystemPrompt` and `MODE_PROMPTS` tests green.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/aiModes.ts frontend/src/lib/__tests__/aiModes.test.ts
git commit -m "$(cat <<'EOF'
feat(ai-modes): add overrides param to getModeSystemPrompt

Composer now accepts a per-mode overrides map and substitutes the
override block when non-empty, leaving NETSTACKS_IDENTITY and the
enterprise/standalone addendum intact. MODE_PROMPTS is exported so
the settings UI can use built-ins as defaults.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Add per-mode prompt API helpers

**Files:**
- Modify: `frontend/src/api/ai.ts`

Add three exports following the existing `getTopologyPrompt` / `setTopologyPrompt` shape (api/ai.ts:1156-1184). Settings keys: `ai.mode_prompt.chat`, `ai.mode_prompt.operator`, `ai.mode_prompt.troubleshoot`, `ai.mode_prompt.copilot`.

- [ ] **Step 1: Add the `AIMode` import to the top-of-file imports**

Add this line to the top imports of `frontend/src/api/ai.ts` (alongside the existing `import type` lines, around line 4-7):

```ts
import type { AIMode } from '../lib/aiModes';
```

Verify no circular import: `frontend/src/lib/aiModes.ts` currently has no imports — confirm with `head -15 frontend/src/lib/aiModes.ts`. Safe to import from `lib/aiModes` here.

- [ ] **Step 2: Add `getModePrompt` and `setModePrompt` at the end of `frontend/src/api/ai.ts`**

Append after `setScriptPrompt` (around line 1216):

```ts
// --- Per-mode AI prompts (ai.mode_prompt.<mode>) ---
// One settings key per mode: chat, operator, troubleshoot, copilot.
// Empty / null / 404 = "use built-in default" (see MODE_PROMPTS in lib/aiModes.ts).

export async function getModePrompt(mode: AIMode): Promise<string | null> {
  try {
    const prefix = settingsPrefix();
    const res = await getClient().http.get(`${prefix}/ai.mode_prompt.${mode}`);
    const data = res.data;
    if (data === null) return null;
    if (getCurrentMode() === 'enterprise') {
      return typeof data === 'string' && data.trim() ? data : null;
    }
    const val = data.value ?? null;
    return val && val.trim() ? val : null;
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 404) return null;
    return null;
  }
}

export async function setModePrompt(mode: AIMode, prompt: string | null): Promise<void> {
  const prefix = settingsPrefix();
  if (!prompt || !prompt.trim()) {
    try { await getClient().http.delete(`${prefix}/ai.mode_prompt.${mode}`); } catch { /* ok */ }
  } else {
    if (getCurrentMode() === 'enterprise') {
      await getClient().http.put(`${prefix}/ai.mode_prompt.${mode}`, prompt);
    } else {
      await getClient().http.put(`${prefix}/ai.mode_prompt.${mode}`, { value: prompt });
    }
  }
}
```

- [ ] **Step 3: Run typecheck to verify**

Run: `cd frontend && npx tsc --noEmit`
Expected: PASS — no new type errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/api/ai.ts
git commit -m "$(cat <<'EOF'
feat(api): add per-mode prompt helpers (ai.mode_prompt.<mode>)

Mirrors the existing getTopologyPrompt/setTopologyPrompt shape, one
settings key per AI mode (chat/operator/troubleshoot/copilot).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Add `getAllModePrompts` with one-shot migration

**Files:**
- Modify: `frontend/src/api/ai.ts`
- Create: `frontend/src/api/__tests__/modePrompts.test.ts`

`getAllModePrompts()` batches the four `getModePrompt` reads and runs the legacy migration: if `ai.mode_prompt.troubleshoot` is empty AND `ai.provider_config.systemPrompt` is non-empty, copy the value into the new key and clear `systemPrompt` from the provider config.

> **Implementation pivot (post-hoc note):** The `vi.mock('../ai', ...)` test pattern shown in Step 1 below collides with Vitest's ESM constraint — mocked namespace exports do not intercept in-module bindings, so `getAllModePrompts` (spread from `actual` via `vi.importActual`) ends up calling the real `getAiConfig` etc. The shipped implementation extracted a pure helper `decideModePromptMigration` (returning a discriminated `{ migrate: false } | { migrate: true; value; clearedConfig }` union) and tested that directly with no mocks. The IO wrapper `getAllModePrompts` retains the contract described here. See commit `eaf2012`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/api/__tests__/modePrompts.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

// We mock the per-mode getter/setter and the AI config getter/setter,
// then verify the migration helper performs (or skips) the right writes.

vi.mock('../ai', async () => {
  const actual = await vi.importActual<typeof import('../ai')>('../ai')
  return {
    ...actual,
    getModePrompt: vi.fn(),
    setModePrompt: vi.fn(),
    getAiConfig: vi.fn(),
    setAiConfig: vi.fn(),
  }
})

import * as ai from '../ai'

const mocks = ai as unknown as {
  getModePrompt: ReturnType<typeof vi.fn>
  setModePrompt: ReturnType<typeof vi.fn>
  getAiConfig: ReturnType<typeof vi.fn>
  setAiConfig: ReturnType<typeof vi.fn>
  getAllModePrompts: typeof ai.getAllModePrompts
}

describe('getAllModePrompts', () => {
  beforeEach(() => {
    mocks.getModePrompt.mockReset()
    mocks.setModePrompt.mockReset()
    mocks.getAiConfig.mockReset()
    mocks.setAiConfig.mockReset()
  })

  it('returns all four modes (no migration needed)', async () => {
    mocks.getModePrompt.mockResolvedValue(null)
    mocks.getAiConfig.mockResolvedValue(null)

    const out = await mocks.getAllModePrompts()

    expect(out).toEqual({
      chat: null,
      operator: null,
      troubleshoot: null,
      copilot: null,
    })
    expect(mocks.setModePrompt).not.toHaveBeenCalled()
    expect(mocks.setAiConfig).not.toHaveBeenCalled()
  })

  it('migrates legacy systemPrompt into troubleshoot when troubleshoot is empty', async () => {
    const LEGACY = 'Always answer as a haiku.'
    mocks.getModePrompt.mockResolvedValue(null)
    mocks.getAiConfig.mockResolvedValue({
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      systemPrompt: LEGACY,
    })

    const out = await mocks.getAllModePrompts()

    expect(out.troubleshoot).toBe(LEGACY)
    expect(mocks.setModePrompt).toHaveBeenCalledWith('troubleshoot', LEGACY)
    expect(mocks.setAiConfig).toHaveBeenCalledWith({
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      systemPrompt: undefined,
    })
  })

  it('does NOT migrate when troubleshoot already has a value', async () => {
    const NEW = 'Be terse.'
    const LEGACY = 'Be verbose.'
    mocks.getModePrompt.mockImplementation(async (mode: string) =>
      mode === 'troubleshoot' ? NEW : null
    )
    mocks.getAiConfig.mockResolvedValue({
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      systemPrompt: LEGACY,
    })

    const out = await mocks.getAllModePrompts()

    expect(out.troubleshoot).toBe(NEW)
    expect(mocks.setModePrompt).not.toHaveBeenCalled()
    expect(mocks.setAiConfig).not.toHaveBeenCalled()
  })

  it('does NOT migrate when legacy value is missing or whitespace', async () => {
    mocks.getModePrompt.mockResolvedValue(null)
    mocks.getAiConfig.mockResolvedValue({
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      systemPrompt: '   ',
    })

    const out = await mocks.getAllModePrompts()

    expect(out.troubleshoot).toBe(null)
    expect(mocks.setModePrompt).not.toHaveBeenCalled()
    expect(mocks.setAiConfig).not.toHaveBeenCalled()
  })

  it('does NOT migrate when there is no AI config at all', async () => {
    mocks.getModePrompt.mockResolvedValue(null)
    mocks.getAiConfig.mockResolvedValue(null)

    const out = await mocks.getAllModePrompts()

    expect(out.troubleshoot).toBe(null)
    expect(mocks.setModePrompt).not.toHaveBeenCalled()
    expect(mocks.setAiConfig).not.toHaveBeenCalled()
  })

  it('returns the migrated value for the same call (does not require reload)', async () => {
    const LEGACY = 'Hello.'
    mocks.getModePrompt.mockResolvedValue(null)
    mocks.getAiConfig.mockResolvedValue({
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      systemPrompt: LEGACY,
    })

    const out = await mocks.getAllModePrompts()

    // chat/operator/copilot stay null; troubleshoot reflects the migrated value
    expect(out).toEqual({
      chat: null,
      operator: null,
      troubleshoot: LEGACY,
      copilot: null,
    })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npm run test -- modePrompts.test`
Expected: FAIL — `getAllModePrompts` is not defined.

- [ ] **Step 3: Add `getAllModePrompts` to `frontend/src/api/ai.ts`**

Append after `setModePrompt` (the function added in Task 2):

```ts
/**
 * Batch-load all four mode prompt overrides AND run the one-shot migration
 * from the legacy ai.provider_config.systemPrompt field into ai.mode_prompt.troubleshoot.
 *
 * Migration rules:
 * - Runs only if ai.mode_prompt.troubleshoot is empty/null AND
 *   ai.provider_config.systemPrompt is non-empty.
 * - Copies systemPrompt → ai.mode_prompt.troubleshoot, then clears systemPrompt
 *   from the provider_config blob (set to undefined; JSON.stringify drops it).
 * - Idempotent: subsequent calls find troubleshoot populated and skip.
 *
 * Failures inside the migration are logged but never thrown — callers always
 * get a Record<AIMode, string|null>.
 */
export async function getAllModePrompts(): Promise<Record<AIMode, string | null>> {
  const modes: AIMode[] = ['chat', 'operator', 'troubleshoot', 'copilot'];
  const values = await Promise.all(modes.map(m => getModePrompt(m)));
  const result: Record<AIMode, string | null> = {
    chat: values[0],
    operator: values[1],
    troubleshoot: values[2],
    copilot: values[3],
  };

  // One-shot migration: legacy ai.provider_config.systemPrompt -> ai.mode_prompt.troubleshoot
  if (!result.troubleshoot) {
    try {
      const cfg = await getAiConfig();
      const legacy = cfg?.systemPrompt;
      if (cfg && legacy && legacy.trim()) {
        await setModePrompt('troubleshoot', legacy);
        await setAiConfig({ ...cfg, systemPrompt: undefined });
        result.troubleshoot = legacy;
      }
    } catch (err) {
      console.warn('Mode-prompt migration skipped:', err);
    }
  }

  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npm run test -- modePrompts.test`
Expected: PASS — all six migration test cases green.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/ai.ts frontend/src/api/__tests__/modePrompts.test.ts
git commit -m "$(cat <<'EOF'
feat(api): batch loader + legacy migration for mode prompts

getAllModePrompts() reads all four ai.mode_prompt.<mode> values in
parallel and performs a one-shot, idempotent migration of any legacy
ai.provider_config.systemPrompt value into ai.mode_prompt.troubleshoot,
then clears it from the provider_config blob.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Wire mode overrides into `useAIAgent`

**Files:**
- Modify: `frontend/src/hooks/useAIAgent.ts`

Add a `modeOverridesRef`, load it on mount via `getAllModePrompts()`, and pass it as the third argument to `getModeSystemPromptFn` at both call sites (~L2230 and ~L2336).

- [ ] **Step 1: Add the import**

In the existing import block (around line 48 where `getTopologyPrompt` is imported), add `getAllModePrompts`:

```ts
// Before
import { getTopologyPrompt, DEFAULT_TOPOLOGY_PROMPT } from '../api/ai';

// After
import { getTopologyPrompt, DEFAULT_TOPOLOGY_PROMPT, getAllModePrompts } from '../api/ai';
```

Also add `AIMode` to the existing aiModes import (find the line that imports `getModeSystemPrompt` and add `AIMode`):

```ts
// Locate the existing import — likely something like:
// import { getModeSystemPrompt as getModeSystemPromptFn } from '../lib/aiModes'
// Update to:
import { getModeSystemPrompt as getModeSystemPromptFn, type AIMode } from '../lib/aiModes'
```

If the existing import line uses a different name or path, keep it intact and only add `type AIMode` to its named imports.

- [ ] **Step 2: Add the ref and loader**

Locate the `topologyPromptRef` block (around line 528-529) and add a parallel ref immediately after:

```ts
// Custom topology prompt loaded from backend settings
const topologyPromptRef = useRef<string | null>(null);

// Per-mode prompt overrides loaded from backend settings (Settings → Prompts → AI Modes).
// null/empty for a given mode = "use built-in default from MODE_PROMPTS".
const modeOverridesRef = useRef<Partial<Record<AIMode, string | null>>>({});
```

Locate the `useEffect` that loads `topologyPromptRef` (around line 570-577) and add a parallel `useEffect` immediately after:

```ts
// Load custom topology prompt from backend when topology tools are active
useEffect(() => {
  if (topologyCallbacks) {
    getTopologyPrompt()
      .then(val => { topologyPromptRef.current = val; })
      .catch(() => { topologyPromptRef.current = null; });
  }
}, [topologyCallbacks]);

// Load per-mode prompt overrides on mount. Mirrors the topology prompt
// pattern — refresh is implicit on hook remount.
useEffect(() => {
  getAllModePrompts()
    .then(overrides => { modeOverridesRef.current = overrides; })
    .catch(() => { modeOverridesRef.current = {}; });
}, []);
```

- [ ] **Step 3: Pass overrides at both call sites**

At ~L2230 (inside `callAgentApi`):

```ts
// Before
if (aiModeRef.current) {
  const isEnterprise = useCapabilitiesStore.getState().isEnterprise?.() ?? false;
  requestBody.system_prompt = getModeSystemPromptFn(aiModeRef.current, isEnterprise);
}

// After
if (aiModeRef.current) {
  const isEnterprise = useCapabilitiesStore.getState().isEnterprise?.() ?? false;
  requestBody.system_prompt = getModeSystemPromptFn(
    aiModeRef.current,
    isEnterprise,
    modeOverridesRef.current,
  );
}
```

At ~L2336 (inside `callAgentApiStream`), make the identical change. The two blocks are textually similar — search for `getModeSystemPromptFn(aiModeRef.current, isEnterprise)` and replace both occurrences.

- [ ] **Step 4: Verify typecheck**

Run: `cd frontend && npx tsc --noEmit`
Expected: PASS — no type errors.

- [ ] **Step 5: Verify tests still pass**

Run: `cd frontend && npm run test`
Expected: PASS — Task 1 and Task 3 tests still green; nothing else broken.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/hooks/useAIAgent.ts
git commit -m "$(cat <<'EOF'
feat(useAIAgent): wire per-mode prompt overrides into chat requests

Loads ai.mode_prompt.<mode> overrides on hook mount via
getAllModePrompts() and passes them as the third arg to
getModeSystemPrompt at both call sites (callAgentApi and
callAgentApiStream). Default behavior unchanged when no override
is set.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Replace troubleshooting state with mode-overrides state in PromptsSettingsTab

**Files:**
- Modify: `frontend/src/components/PromptsSettingsTab.tsx`

Replace the single `troubleshootingPrompt` state and its `getAiConfig`/`setAiConfig` plumbing with a unified `modePrompts: Record<AIMode, string>` state backed by `getAllModePrompts` / `setModePrompt`. Add the 3 new mode entries (chat, operator, copilot) to `SYSTEM_PROMPT_META`. UI grouping is deferred to Task 6 — for this task the entries go into the existing flat list.

This is a larger task because the `SystemKey` rename ripples through the file. Rename `'troubleshooting'` → `'troubleshoot'` everywhere to match `AIMode`.

- [ ] **Step 1: Update imports**

Replace lines 9-25 (the import block from `'../api/ai'`) so the unused legacy helpers are removed and the new ones added:

```ts
import {
  DEFAULT_AI_DISCOVERY_PROMPT,
  DEFAULT_TOPOLOGY_PROMPT,
  DEFAULT_SCRIPT_PROMPT,
  DEFAULT_AGENT_PROMPT,
  getDiscoveryPrompt as apiGetDiscoveryPrompt,
  setDiscoveryPrompt as apiSetDiscoveryPrompt,
  getTopologyPrompt as apiGetTopologyPrompt,
  setTopologyPrompt as apiSetTopologyPrompt,
  getScriptPrompt as apiGetScriptPrompt,
  setScriptPrompt as apiSetScriptPrompt,
  getAiAgentConfig,
  setAiAgentConfig,
  getAllModePrompts,
  setModePrompt,
} from '../api/ai';
import { MODE_PROMPTS, type AIMode } from '../lib/aiModes';
```

(`DEFAULT_SYSTEM_PROMPT`, `getAiConfig`, `setAiConfig` are removed from the import — they're no longer used by this file once Step 4 below is complete. If `DEFAULT_SYSTEM_PROMPT` is exported from `../api/ai` and used elsewhere, leave the export intact in `api/ai.ts`; only stop importing it here.)

- [ ] **Step 2: Update `SystemKey` type and `SYSTEM_PROMPT_META`**

Replace lines 30-65 (the `SystemKey` type, `EditorState` interface, and `SYSTEM_PROMPT_META`):

```ts
type SystemKey =
  | 'chat'
  | 'operator'
  | 'troubleshoot'
  | 'copilot'
  | 'discovery'
  | 'topology'
  | 'script'
  | 'agent';

const MODE_KEYS: SystemKey[] = ['chat', 'operator', 'troubleshoot', 'copilot'];
const TASK_KEYS: SystemKey[] = ['discovery', 'topology', 'script', 'agent'];

interface EditorState {
  isOpen: boolean;
  mode: 'create' | 'edit' | 'system';
  prompt?: QuickPrompt;
  systemKey?: SystemKey;
}

const SYSTEM_PROMPT_META: Record<SystemKey, { label: string; editorTitle: string; default: string }> = {
  chat: {
    label: 'Chat Mode',
    editorTitle: 'Edit Chat Mode Prompt',
    default: MODE_PROMPTS.chat,
  },
  operator: {
    label: 'Operator Mode',
    editorTitle: 'Edit Operator Mode Prompt',
    default: MODE_PROMPTS.operator,
  },
  troubleshoot: {
    label: 'Troubleshoot Mode',
    editorTitle: 'Edit Troubleshoot Mode Prompt',
    default: MODE_PROMPTS.troubleshoot,
  },
  copilot: {
    label: 'Copilot Mode',
    editorTitle: 'Edit Copilot Mode Prompt',
    default: MODE_PROMPTS.copilot,
  },
  discovery: {
    label: 'AI Discovery (Topology Enrichment)',
    editorTitle: 'Edit AI Discovery Prompt',
    default: DEFAULT_AI_DISCOVERY_PROMPT,
  },
  topology: {
    label: 'Topology Canvas AI',
    editorTitle: 'Edit Topology Canvas AI Prompt',
    default: DEFAULT_TOPOLOGY_PROMPT,
  },
  script: {
    label: 'Script Generation',
    editorTitle: 'Edit Script Generation Prompt',
    default: DEFAULT_SCRIPT_PROMPT,
  },
  agent: {
    label: 'Agent Tasks (Background)',
    editorTitle: 'Edit Agent Tasks Prompt',
    default: DEFAULT_AGENT_PROMPT,
  },
};
```

- [ ] **Step 3: Replace `troubleshootingPrompt` state with `modePrompts` record**

Replace lines 72-77 (the per-prompt `useState` block):

```ts
// Per-mode prompt overrides (empty string = using default)
const [modePrompts, setModePrompts] = useState<Record<AIMode, string>>({
  chat: '',
  operator: '',
  troubleshoot: '',
  copilot: '',
});

// Specialized-task prompt overrides (empty string = using default)
const [discoveryPrompt, setDiscoveryPrompt] = useState('');
const [topologyPrompt, setTopologyPrompt] = useState('');
const [scriptPrompt, setScriptPrompt] = useState('');
const [agentPrompt, setAgentPrompt] = useState('');
```

- [ ] **Step 4: Replace the load effect**

Replace lines 79-132 (the entire `useEffect` that loads prompts):

```ts
useEffect(() => {
  listQuickPrompts()
    .then(setPrompts)
    .catch(console.error)
    .finally(() => setLoading(false));

  // Load all four mode-prompt overrides (also runs the one-shot legacy migration)
  getAllModePrompts()
    .then(overrides => {
      setModePrompts({
        chat: overrides.chat ?? '',
        operator: overrides.operator ?? '',
        troubleshoot: overrides.troubleshoot ?? '',
        copilot: overrides.copilot ?? '',
      });
    })
    .catch(err => console.debug('Could not load mode prompts:', err));

  // Load discovery prompt from backend, with one-time localStorage migration
  apiGetDiscoveryPrompt()
    .then(val => {
      if (val) {
        setDiscoveryPrompt(val);
      } else {
        const legacy = localStorage.getItem('netstacks:aiDiscoveryPrompt');
        if (legacy) {
          setDiscoveryPrompt(legacy);
          apiSetDiscoveryPrompt(legacy)
            .then(() => localStorage.removeItem('netstacks:aiDiscoveryPrompt'))
            .catch(console.error);
        }
      }
    })
    .catch(console.error);

  apiGetTopologyPrompt()
    .then(val => { if (val) setTopologyPrompt(val); })
    .catch(console.error);

  apiGetScriptPrompt()
    .then(val => { if (val) setScriptPrompt(val); })
    .catch(console.error);

  getAiAgentConfig()
    .then(config => {
      if (config?.system_prompt && config.system_prompt !== DEFAULT_AGENT_PROMPT) {
        setAgentPrompt(config.system_prompt);
      }
    })
    .catch(console.error);
}, []);
```

- [ ] **Step 5: Update `getPromptValue`**

Replace lines 134-142:

```ts
const getPromptValue = (key: SystemKey): string => {
  switch (key) {
    case 'chat':
    case 'operator':
    case 'troubleshoot':
    case 'copilot':
      return modePrompts[key];
    case 'discovery': return discoveryPrompt;
    case 'topology': return topologyPrompt;
    case 'script': return scriptPrompt;
    case 'agent': return agentPrompt;
  }
};
```

- [ ] **Step 6: Update `handleResetSystem`**

Replace the `case 'troubleshooting':` block in `handleResetSystem` (lines 159-166) with mode-key cases:

```ts
const handleResetSystem = useCallback(async (key: SystemKey) => {
  try {
    switch (key) {
      case 'chat':
      case 'operator':
      case 'troubleshoot':
      case 'copilot': {
        setModePrompts(prev => ({ ...prev, [key]: '' }));
        await setModePrompt(key, null);
        break;
      }
      case 'discovery':
        setDiscoveryPrompt('');
        await apiSetDiscoveryPrompt(null);
        break;
      case 'topology':
        setTopologyPrompt('');
        await apiSetTopologyPrompt(null);
        break;
      case 'script':
        setScriptPrompt('');
        await apiSetScriptPrompt(null);
        break;
      case 'agent': {
        setAgentPrompt('');
        const agentConfig = await getAiAgentConfig();
        if (agentConfig) {
          await setAiAgentConfig({ ...agentConfig, system_prompt: DEFAULT_AGENT_PROMPT });
        }
        const settings = getSettings();
        const stored = localStorage.getItem('netstacks-settings');
        const parsed = stored ? JSON.parse(stored) : {};
        parsed['ai.agent.systemPrompt'] = settings['ai.agent.systemPrompt'];
        localStorage.setItem('netstacks-settings', JSON.stringify(parsed));
        break;
      }
    }
  } catch (err) {
    console.error('Failed to reset system prompt:', err);
  }
}, []);
```

- [ ] **Step 7: Update `handleSaveEditor`**

Replace the `case 'troubleshooting':` block (lines 237-254) with mode-key cases:

```ts
} else if (editor.mode === 'system' && editor.systemKey) {
  const key = editor.systemKey;
  switch (key) {
    case 'chat':
    case 'operator':
    case 'troubleshoot':
    case 'copilot': {
      setModePrompts(prev => ({ ...prev, [key]: prompt }));
      await setModePrompt(key, prompt || null);
      break;
    }
    case 'discovery':
      setDiscoveryPrompt(prompt);
      await apiSetDiscoveryPrompt(prompt || null);
      break;
    case 'topology':
      setTopologyPrompt(prompt);
      await apiSetTopologyPrompt(prompt || null);
      break;
    case 'script':
      setScriptPrompt(prompt);
      await apiSetScriptPrompt(prompt || null);
      break;
    case 'agent': {
      setAgentPrompt(prompt);
      const agentConfig = await getAiAgentConfig();
      const effectivePrompt = prompt || DEFAULT_AGENT_PROMPT;
      if (agentConfig) {
        await setAiAgentConfig({ ...agentConfig, system_prompt: effectivePrompt });
      } else {
        await setAiAgentConfig({
          provider: null,
          model: null,
          temperature: 0.7,
          max_tokens: 4096,
          max_iterations: 15,
          system_prompt: effectivePrompt,
        });
      }
      const stored = localStorage.getItem('netstacks-settings');
      const parsed = stored ? JSON.parse(stored) : {};
      parsed['ai.agent.systemPrompt'] = effectivePrompt;
      localStorage.setItem('netstacks-settings', JSON.stringify(parsed));
      break;
    }
  }
}
```

- [ ] **Step 8: Update `systemKeys` constant (UI rendering)**

Find line 303 (`const systemKeys: SystemKey[] = ['troubleshooting', 'discovery', 'topology', 'script', 'agent'];`) and replace with:

```ts
// Render order: 4 mode prompts first, then 4 specialized tasks. UI grouping
// (subsection headers) is added in the next task.
const systemKeys: SystemKey[] = [...MODE_KEYS, ...TASK_KEYS];
```

- [ ] **Step 9: Verify typecheck and lint**

Run: `cd frontend && npx tsc --noEmit && npm run lint`
Expected: PASS — no type errors, no new lint errors.

- [ ] **Step 10: Verify tests still pass**

Run: `cd frontend && npm run test`
Expected: PASS — all tests from prior tasks still green.

- [ ] **Step 11: Commit**

```bash
git add frontend/src/components/PromptsSettingsTab.tsx
git commit -m "$(cat <<'EOF'
feat(settings): expose all four AI mode prompts in Settings → Prompts

Replaces the single 'AI Troubleshooting (Side Panel)' entry — which
wrote to ai.provider_config.systemPrompt and was never read at runtime
once mode-based prompts shipped — with four entries (Chat, Operator,
Troubleshoot, Copilot) that route through ai.mode_prompt.<mode>.

Any existing legacy systemPrompt value is migrated automatically into
ai.mode_prompt.troubleshoot on first load (see getAllModePrompts).

UI grouping (subsection headers) is in the next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Group prompts into "AI Modes" and "Specialized Tasks" subsections

**Files:**
- Modify: `frontend/src/components/PromptsSettingsTab.tsx`
- Modify: `frontend/src/components/PromptsSettingsTab.css`

After Task 5 the SYSTEM PROMPTS section has 8 entries in a flat list. Split it into two visually-grouped subsections so it's scannable.

- [ ] **Step 1: Refactor the System Prompts render block**

Locate the `{/* System Prompts Section */}` block in `PromptsSettingsTab.tsx` (around line 307-344). Replace it with:

```tsx
{/* System Prompts Section */}
<div className="prompts-section">
  <div className="prompts-section-header">
    <span className="prompts-section-title">System Prompts</span>
  </div>
  <p className="prompts-section-description">
    These control how the AI behaves in different contexts.
  </p>

  <div className="prompts-subsection-title">AI Modes</div>
  <div className="prompts-list">
    {MODE_KEYS.map(key => renderSystemPromptItem(key))}
  </div>

  <div className="prompts-subsection-title prompts-subsection-title--spaced">
    Specialized Tasks
  </div>
  <div className="prompts-list">
    {TASK_KEYS.map(key => renderSystemPromptItem(key))}
  </div>
</div>
```

Extract the per-item render into a helper above the `return` (so it isn't duplicated):

```tsx
const renderSystemPromptItem = (key: SystemKey) => {
  const meta = SYSTEM_PROMPT_META[key];
  const value = getPromptValue(key);
  return (
    <div key={key} className="prompt-item">
      <div className="prompt-item-header">
        <span className="prompt-item-icon">{'\u{1F916}'}</span>
        <span className="prompt-item-name">{meta.label}</span>
        <div className="prompt-item-actions">
          <button onClick={() => handleEditSystem(key)} title="Edit">{'✎'}</button>
          <button
            onClick={() => handleResetSystem(key)}
            title="Reset to default"
            disabled={!value}
          >
            {'↺'}
          </button>
        </div>
      </div>
      <div className="prompt-item-preview">
        {value ? value.substring(0, 60) + '...' : 'Using default prompt'}
      </div>
    </div>
  );
};
```

The `systemKeys` constant added in Task 5 step 8 is no longer used — delete it.

- [ ] **Step 2: Add subsection-header styles**

Append to `frontend/src/components/PromptsSettingsTab.css`:

```css
.prompts-subsection-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--text-secondary, #808080);
  letter-spacing: 0.4px;
  margin: 0 0 8px 0;
  opacity: 0.85;
}

.prompts-subsection-title--spaced {
  margin-top: 16px;
}
```

- [ ] **Step 3: Verify typecheck and lint**

Run: `cd frontend && npx tsc --noEmit && npm run lint`
Expected: PASS.

- [ ] **Step 4: Verify tests still pass**

Run: `cd frontend && npm run test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/PromptsSettingsTab.tsx frontend/src/components/PromptsSettingsTab.css
git commit -m "$(cat <<'EOF'
feat(settings): group prompts into AI Modes / Specialized Tasks

Splits the 8-entry SYSTEM PROMPTS list into two visually-grouped
subsections so it stays scannable. Extracts the per-item render
into a small helper to avoid duplicating the markup across groups.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: End-to-end smoke verification

**Files:**
- None (manual verification + final build/lint/test sweep)

This is the verification gate before declaring the feature done. The unit tests cover composition and migration; this task confirms the full wire reaches the model.

- [ ] **Step 1: Full build + test sweep**

Run from the repo root:

```bash
cd frontend && npm run lint && npx tsc --noEmit && npm run test && npm run build
```

Expected: all four commands exit 0.

- [ ] **Step 2: Start the dev server**

Run: `cd frontend && npm run dev`

Open the app in a browser as you normally would for local dev.

- [ ] **Step 3: Smoke-test each mode override (golden path)**

For each of the 4 modes (`chat`, `operator`, `troubleshoot`, `copilot`):

  a. Open Settings → Prompts. Confirm the new layout: "AI Modes" subsection contains 4 entries, "Specialized Tasks" contains 4.
  b. Click the pencil on the mode entry. Save an override that adds a sentinel sentence at the end:
     ```
     ## Mode: Sentinel
     Always end every reply with the exact word "BANANA-<mode>".
     ```
     (substitute the real mode name).
  c. Switch the AI assistant into that mode in the side panel.
  d. Send any message ("hello"). Confirm the model's reply ends with the sentinel string.
  e. Click the reset button on that mode entry. Confirm the editor preview returns to "Using default prompt".
  f. Send another message. Confirm the model no longer ends with the sentinel.

- [ ] **Step 4: Verify the legacy migration**

  a. Stop the dev server. In the dev tools / settings DB / however local settings are inspected, manually plant a value at `ai.provider_config.systemPrompt` (e.g., paste a value into the legacy field on a build *without* this change, then check out this branch — or use the settings API directly).
  b. Restart the dev server. Open Settings → Prompts.
  c. Confirm the value now appears under "Troubleshoot Mode" and that `ai.provider_config.systemPrompt` is no longer set (check via settings API or DB).
  d. Reload the page. Confirm no further migration writes (you can check the network tab — there should be no PUT to either key on this load).

- [ ] **Step 5: Edge cases**

  a. Save an override that is whitespace only ("   "). Confirm the entry shows "Using default prompt" and the saved value is cleared (treated as empty by the helpers).
  b. Save an empty override on a mode that already has one. Confirm it deletes the setting (not just an empty PUT).

- [ ] **Step 6: Final commit if any tweaks were needed**

If smoke testing surfaced any small fixes, commit them. Otherwise no commit needed. Do not claim the feature is complete unless steps 1-5 all pass.

---

## Out of Scope (Tracked Separately)

Per the design doc, these are deferred:
- MOP cluster prompts (6 in `MopWorkspace.tsx`)
- Highlight Analysis prompt (`agent/src/ai/highlight.rs`)
- Onboarding interview prompt (`agent/src/ai/onboarding.rs`)
- Session Summarization prompt (`frontend/src/services/troubleshootingAI.ts`)
- MOP Real-Time Pilot prompt (`frontend/src/hooks/useAiPilot.ts`)
- Editing `NETSTACKS_IDENTITY` or the enterprise/standalone addenda
- Per-mode model / temperature / token-budget overrides
