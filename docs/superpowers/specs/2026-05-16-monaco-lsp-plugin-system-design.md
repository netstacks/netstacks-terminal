# Monaco LSP & Language Features — Plugin-Shaped System

**Status:** Design approved, ready for implementation planning
**Date:** 2026-05-16
**Owner:** Casey Davis

## Summary

Add language-feature support to the NetStacks Monaco editors via a plugin-shaped architecture. v1 ships:

- **Python:** full LSP (Pyrefly) via on-demand download, hosted by the local agent, proxied to Monaco over WebSocket.
- **YANG:** real syntax highlighting (Monarch grammar) + indent-based format provider, all client-side.
- **XML:** existing highlighting + format provider using `xml-formatter`, all client-side.
- **JSON:** no changes — Monaco's bundled `json.worker` already covers it.

The architecture is generic: nothing in the codebase outside one descriptor file is Pyrefly- or Python-specific. Adding another LSP later (built-in or user-defined) is a config change, not a refactor. The Settings UI is full-CRUD so a user can register their own language server (e.g. gopls, pyright) right now without waiting on a release.

Pyrefly is **not** bundled in the installer. It's downloaded (~13 MB) only when a user opens a `.py` file and clicks Install. Users who never edit Python pay nothing.

## Scope

### In scope (v1)

| Language | Behavior | Where it runs |
|---|---|---|
| Python | Full LSP: diagnostics, completion, hover, go-to-def, format | Pyrefly binary, downloaded on demand, hosted by local agent, proxied to Monaco over WebSocket |
| YANG | Syntax highlighting (Monarch grammar) + format-document (indent pretty-printer) | 100% client-side, in frontend bundle |
| XML | Existing Monaco highlighting + format-document (`xml-formatter` npm package) | 100% client-side, in frontend bundle |
| JSON | No work — Monaco's bundled `json.worker` already covers it | Already shipped |

Editors targeted: `WorkspaceCodeEditor.tsx` (any extension) and `ScriptEditor.tsx` (Python-only). Wired via a single `useLspClient()` hook in each.

### Out of scope (deferred to later versions)

- UI for installing **third-party** plugins from a marketplace (v1 lets users add custom plugins pointing at binaries they already have on their machine — see Section "Settings UI"; the marketplace UI for browsing/downloading new plugins is v2+).
- Sandboxing or signing of third-party plugins.
- Hot reload of plugin descriptors at runtime.
- Per-workspace LSP overrides (v1 has one config per plugin per user).
- Auto-update of bundled LSP binaries (v1: user explicitly clicks "Update" when a new version is pinned by a NetStacks release).
- YANG LSP (full semantic features like cross-module import resolution). Highlighting + format is enough for v1; the plugin system makes upgrading to a real YANG LSP later trivial.
- LSP in Enterprise mode (no local agent exists there). YANG/XML/JSON features still work in Enterprise; Python LSP shows as "Unavailable in Enterprise Mode" in Settings.

### Mode coverage

- **Standalone (Personal Mode):** Python LSP works (via local agent). YANG/XML/JSON features work (all client-side).
- **Enterprise:** YANG/XML/JSON features work (client-side, no backend needed). Python LSP shows in Settings as **"Unavailable in Enterprise Mode"** with explanation text. Monaco's built-in Python tokenizer keeps the editor functional, just not "smart." Future hook: the plugin descriptor's `runtime` field can be pointed at a Controller-side LSP service when one exists, without changes to the Monaco/editor side.

## Architecture

### Plugin descriptor (single source of truth)

The shape that every LSP plugin conforms to. Mirrored in TypeScript (frontend) and Rust (agent).

```typescript
interface LspPlugin {
  id: string;                    // 'pyrefly'
  displayName: string;           // 'Pyrefly'
  language: string;              // Monaco language id, e.g. 'python'
  fileExtensions: string[];      // ['.py', '.pyi']
  defaultEnabled: boolean;       // true once installed
  unavailableInEnterprise: boolean;
  source: 'built-in' | 'user-added';

  installation:
    | { kind: 'on-demand-download',
        version: string,
        sources: {
          [platform: string]: { url: string, sha256: string, binaryPath: string }
        } }
    | { kind: 'bundled', binary: string, args: string[] }       // future-proofing
    | { kind: 'system-path', defaultCommand: string };          // BYO LSP

  runtime: { command: string, args: string[] };                 // e.g. 'pyrefly' + ['lsp']
}
```

v1 ships one built-in descriptor (Pyrefly). User-added descriptors always use `installation: { kind: 'system-path' }` and are persisted in the existing SQLite database.

### Agent — generic LSP host (`agent/src/lsp/`)

- **`mod.rs`** — `LspHost` struct. Owns the merged plugin registry (built-ins + user-added from SQLite) and installed-binary state.
- **`session.rs`** — `LspSession` per `(plugin_id, workspace_path)`. Owns a child process plus the set of connected WebSocket clients (multiple Monaco tabs in the same workspace share one Pyrefly process).
- **`install.rs`** — generic on-demand installer: download, SHA-256 verify, extract, set permissions, smoke test.
- **`routes.rs`** — Axum routes mounted under `/lsp`:
  - `GET /lsp/plugins` — returns the merged plugin list with install status.
  - `POST /lsp/plugins/{id}/install` — kicks off on-demand download (only valid for `on-demand-download` plugins).
  - `DELETE /lsp/plugins/{id}` — uninstall (deletes binary for built-in plugins; deletes descriptor for user-added).
  - `POST /lsp/plugins` — create a user-added plugin (used by the Add form's "Save").
  - `PUT /lsp/plugins/{id}` — update a plugin's configuration (override command for built-in; any field for user-added).
  - `POST /lsp/plugins/test` — spawn a candidate command, send LSP `initialize`, report success or stderr. Used by the "Test connection" button in the Add form.
  - `WS /lsp/{plugin_id}?workspace={path}` — bidirectional LSP JSON-RPC stream (this is the hot path).
- Authentication: reuses the existing agent bearer-token scheme on all routes.

### Frontend — generic client (`frontend/src/lsp/`)

- **`plugins.ts`** — the built-in plugin registry array. v1: `[pyreflyPlugin]`.
- **`useLspClient.ts`** — hook called from any Monaco editor. Looks up the plugin descriptor for the editor's language, queries the agent for install status, opens the WebSocket if available, wires `monaco-languageclient` to Monaco.
- **`installationApi.ts`** — thin axios wrapper over the agent's `/lsp/plugins` REST endpoints. Returns typed responses; emits progress events for downloads via the existing event system.

### Settings UI (`Settings → Workspaces → Language Features`)

Full-CRUD management surface for LSPs, auto-generated from plugin descriptors. No language-specific code anywhere in the Settings UI.

- **List view:** single table, built-in plugins at top with a "Built-in" badge, user-added below with a "Custom" badge. Each row shows: name, language, file extensions, status (Not installed / Installing / Installed v1.0.0 / Disabled / Unavailable in Enterprise), and actions.
- **Add (`+ Add Language Server` button):** opens a form with:
  - Display name
  - Monaco language id (autocomplete from Monaco's registered language list)
  - File extensions (comma-separated)
  - Command (e.g. `gopls`, full path)
  - Args (e.g. `serve`, `--stdio`)
  - Environment variables (optional key/value list)
  - **Test connection** button — calls `POST /lsp/plugins/test`, shows success or stderr inline before save
- **Update:** click any row to edit. For built-ins, only override fields are editable (custom command, enable toggle). For user-added, everything is editable.
- **Delete:** for built-ins, "Uninstall" removes the downloaded binary but keeps the descriptor (so the user can reinstall later). For user-added, full removal.

This makes the system useful for far more users on day one — anyone with a language server already installed can wire it in via Settings without waiting on a NetStacks release. The marketplace UI for browsing/downloading new built-in plugins is v2+.

## Pyrefly first-run UX & installation lifecycle

### First-run trigger

When `WorkspaceCodeEditor` or `ScriptEditor` mounts a `.py` file, `useLspClient('python', workspace)` checks the agent for plugin status. If Pyrefly is not installed and the user hasn't dismissed the prompt before, a non-blocking banner appears at the top of the editor:

> 🐍 **Get rich Python language features?**
> Install Pyrefly (~13 MB) for diagnostics, autocomplete, hover docs, and go-to-definition.
> [**Install**]  [Skip]  [Don't ask again]

- **Install** → triggers `POST /lsp/plugins/pyrefly/install`. Banner becomes a progress bar (download bytes + verify + extract). On success: LSP connects automatically, banner dismisses, file gets diagnostics. Typical time: 5–15 seconds on broadband.
- **Skip** → banner dismisses for this session. Reappears next time a `.py` file opens.
- **Don't ask again** → persisted flag in app config; banner suppressed until the user explicitly hits "Install" from Settings.

### Settings-driven install path (alternative entry point)

`Settings → Workspaces → Language Features → Pyrefly (Python) → [Install]` triggers the same flow. Status field cycles: `Not installed → Installing (37%) → Installed v1.0.0`.

### Installation mechanics (`agent/src/lsp/install.rs`)

1. Resolve current platform (`aarch64-apple-darwin`, `x86_64-pc-windows-msvc`, etc.).
2. Look up `installation.sources[platform]` from the descriptor → `{ url, sha256, binaryPath }`.
3. Download to a temp file with a streaming progress reporter (Server-Sent Events back to frontend).
4. Verify SHA-256 against the pinned value in the descriptor. **Mismatch = abort, error to user, no partial install.**
5. Extract `binaryPath` from the tarball/wheel into `{dataDir}/lsp/pyrefly/v1.0.0/pyrefly`.
6. Set executable permissions (`chmod +x` on Unix).
7. Run `pyrefly --version` once to confirm it executes (catches Gatekeeper / SmartScreen issues early).
8. Update plugin state to `Installed`. Emit `lsp-plugin-installed` event so editors with the banner reconnect.

### Pyrefly binary sources (per platform)

Pyrefly binaries are extracted from the Pyrefly PyPI wheels (which contain platform-native binaries despite the `py3-none` wheel tag). GitHub releases also host tarballs but only for Linux + macOS, not Windows — so PyPI wheels are the consistent cross-platform source.

| Platform | Wheel filename (PyPI) | Binary inside |
|---|---|---|
| macOS arm64 | `pyrefly-1.0.0-py3-none-macosx_11_0_arm64.whl` | `pyrefly/bin/pyrefly` |
| macOS x86_64 | `pyrefly-1.0.0-py3-none-macosx_10_12_x86_64.whl` | `pyrefly/bin/pyrefly` |
| Linux x86_64 | `pyrefly-1.0.0-py3-none-manylinux_2_17_x86_64.manylinux2014_x86_64.whl` | `pyrefly/bin/pyrefly` |
| Linux arm64 | `pyrefly-1.0.0-py3-none-manylinux_2_17_aarch64.manylinux2014_aarch64.whl` | `pyrefly/bin/pyrefly` |
| Windows x86_64 | `pyrefly-1.0.0-py3-none-win_amd64.whl` | `pyrefly/bin/pyrefly.exe` |
| Windows arm64 | `pyrefly-1.0.0-py3-none-win_arm64.whl` | `pyrefly/bin/pyrefly.exe` |

(Exact `binaryPath` inside the wheel to be confirmed during implementation; treat the values above as expected shape.)

### Version pinning

Each NetStacks agent release pins one Pyrefly version in its descriptor (e.g. v1.0.0). When the user updates NetStacks, the bundled descriptor may bump the pinned version → on next launch the agent notices the version mismatch and offers an in-Settings "Update Pyrefly v1.0.0 → v1.1.0" button. **No silent auto-update** — the user controls when binaries change.

### Uninstall

`Settings → Pyrefly → [Uninstall]` shuts down any running session, deletes `{dataDir}/lsp/pyrefly/`, marks descriptor as `Not installed`. Disk space reclaimed; user can install again later.

### Custom command override

If the user sets a custom command (e.g. `pyright-langserver --stdio`), the on-demand install path is skipped entirely. The agent just uses the custom command. The downloaded Pyrefly binary (if any) is left alone and can be re-activated by clearing the override.

### Air-gapped / blocked-network escape hatch

If the download fails (network error, corporate proxy, blocked github.com / PyPI), the install dialog shows the expected destination path and instructs the user to manually place the binary there. The agent re-checks on next startup. This is documented in Settings but isn't a separate UI flow — it just works the moment a valid binary appears at the expected path.

## Non-LSP language features

### YANG syntax highlighting (`frontend/src/languages/yang.ts`)

A Monarch grammar for YANG, ported from the VS Code YANG extension's TextMate grammar. Roughly 150 lines covering:

- **Keywords:** `module`, `submodule`, `import`, `include`, `revision`, `container`, `leaf`, `leaf-list`, `list`, `choice`, `case`, `grouping`, `uses`, `typedef`, `type`, `rpc`, `notification`, `augment`, `deviation`, `feature`, `identity`, `extension`, `if-feature`, `when`, `must`, `presence`, `config`, `mandatory`, `key`, `unique`, `min-elements`, `max-elements`, `ordered-by`, `description`, `reference`, `status`, `units`, `default`, `namespace`, `prefix`, `organization`, `contact`, `yang-version`.
- **Built-in types:** `string`, `int8/16/32/64`, `uint8/16/32/64`, `boolean`, `enumeration`, `bits`, `binary`, `decimal64`, `leafref`, `identityref`, `instance-identifier`, `union`, `empty`.
- **String literals** (single + double quote, with proper escape handling).
- **Single-line `//` and multi-line `/* */` comments.**
- **Numeric literals** (integer + decimal).
- **Operators** for `when` / `must` XPath-ish expressions.

Wired up in `main.tsx` next to the existing Monaco language registrations:

```typescript
monaco.languages.register({ id: 'yang', extensions: ['.yang'], aliases: ['YANG'] });
monaco.languages.setMonarchTokensProvider('yang', yangMonarch);
monaco.languages.setLanguageConfiguration('yang', yangConfig); // comments, brackets, auto-closing
```

In `WorkspaceCodeEditor.tsx` (line 35), change `yang: 'plaintext'` → `yang: 'yang'`.

### YANG format provider (`frontend/src/languages/yangFormat.ts`)

A simple indent-based pretty-printer:

- Each `{` increases indent depth by one tab.
- Each `}` decreases.
- Statements ending with `;` get no indent change.
- Strings (quoted) are passed through unchanged.
- Comments preserved verbatim.

~80 lines of TS. Registered via `monaco.languages.registerDocumentFormattingEditProvider('yang', ...)` so Monaco's "Format Document" command (Shift+Alt+F) and format-on-save both work. Not a full YANG canonicalizer; the plugin system leaves room to upgrade to a real YANG LSP later.

### XML format provider (`frontend/src/languages/xmlFormat.ts`)

Thin wrapper around the `xml-formatter` npm package (~15 KB, no dependencies):

```typescript
monaco.languages.registerDocumentFormattingEditProvider('xml', {
  provideDocumentFormattingEdits: (model) => {
    const formatted = xmlFormatter(model.getValue(), {
      indentation: '  ',
      collapseContent: true
    });
    return [{ range: model.getFullModelRange(), text: formatted }];
  }
});
```

Handles NETCONF-XML config templates (the `netconf-xml` format in `TemplateDetailTab.tsx`) too, since they're valid XML.

### JSON

No changes. Monaco's built-in `json.worker` (already bundled, configured in `frontend/src/main.tsx:24-29`) provides syntax highlighting + structural validation, schema-based completion + diagnostics when `$schema` is referenced, and a Format Document command. If specific NetStacks schemas need to be wired in later (e.g. session config JSON), that's a one-line `monaco.languages.json.jsonDefaults.setDiagnosticsOptions(...)` change — separate work.

## Error handling & edge cases

### Error matrix

| Failure | What the user sees | What the system does |
|---|---|---|
| Download fails (no network / proxy / DNS) | Banner shows error + retry button + path-to-place-manually instructions | Agent stays at `Not installed`, no partial files left |
| SHA-256 mismatch | "Verification failed. Skipping install for safety." with a "Report" link | Downloaded file deleted, no install attempted |
| Binary doesn't execute (Gatekeeper / SmartScreen / wrong arch) | "Pyrefly couldn't run on this system. Try reinstalling, or set a custom command." | Plugin state goes to `Installed but unusable`, with a [Reinstall] button |
| LSP child crashes mid-session | Inline editor message: "Python language features stopped. [Restart]" | Agent kills session, frees the WebSocket, attempts a single auto-restart with backoff |
| WebSocket disconnects | Silent reconnect within 1s; diagnostics briefly disappear and return | Frontend `useLspClient` auto-reconnects; LSP `didOpen` replayed for active documents |
| User opens a `.py` file in Enterprise mode | Inline banner: "Python LSP isn't available in Enterprise Mode yet." (one-time, dismissable) | No download, no agent calls; Monaco's built-in tokenizer keeps the editor functional |
| Workspace path contains spaces / unicode | Just works | Agent passes the path with proper quoting; YANG/XML format providers operate on Monaco models, path-independent |
| Two `.py` files in two workspaces opened simultaneously | Both get LSP | Two `LspSession` instances, one per workspace, each with its own Pyrefly child |
| Same workspace, multiple `.py` files | Both share one Pyrefly session | `LspSession` keyed by `(plugin_id, workspace_path)`; multiple WS clients per session |
| User uninstalls Pyrefly while a session is active | Session shuts down cleanly, banner reappears in editors | Agent SIGTERMs the child, deletes the binary, emits `lsp-plugin-uninstalled` |
| User adds a custom plugin with an invalid command | "Test connection" button in the Add form catches this before save | Form shows stderr, blocks save until fixed |

### Edge cases

- **First-launch race:** if a user opens a `.py` file before the agent's TLS-ready event fires, the banner waits silently until the agent is reachable (existing `sidecar-tls-ready` event handles this).
- **Workspace = subdirectory of another workspace:** Pyrefly session is keyed by workspace root, not file path, so opening `repo/subdir/file.py` from a `repo`-rooted workspace reuses the `repo` session.
- **Pyrefly version skew across NetStacks updates:** descriptor pinning ensures the agent never auto-runs a binary it didn't pin. When a NetStacks release pins a newer Pyrefly version, the install dir keeps the old binary until the user clicks "Update."
- **Concurrent installs:** install endpoint is mutex-protected per plugin; second concurrent call returns `409 Already in progress` and joins the existing progress stream.

## Testing approach

### Unit tests (Vitest, frontend)

- YANG Monarch grammar — table of input/expected-tokens pairs.
- YANG format provider — input/output snapshot tests for indent rules, comment preservation, string passthrough.
- XML format provider — sanity check on a few NETCONF XML samples.
- Plugin registry merging (built-in + user-added) — pure logic, no I/O.

### Integration tests (cargo test, Rust agent)

- `LspSession` lifecycle: spawn, send `initialize`, receive `initialized`, send `didOpen`, receive diagnostics, shutdown cleanly. Uses a tiny fake stdio-LSP child binary so tests don't depend on Pyrefly being installed in CI.
- Install endpoint: mock HTTP server serves a fake "Pyrefly" binary; verify SHA flow, extraction, permissions.
- SHA mismatch case: feed a wrong-hash payload, assert install aborts and no files remain.
- Concurrent install: two parallel requests, second gets 409.
- Custom-plugin CRUD via REST endpoints, persisted to a test SQLite database.

### E2E tests (Playwright, `tests/e2e/`)

- Open `.py` file in a workspace, see banner, click Skip → banner dismisses.
- Open `.py` file, click Install (mock the download endpoint with a fixture binary), see status transition, see banner disappear.
- Open `.yang` file, assert syntax highlighting present (token classes on keywords).
- Format `.xml` document via Shift+Alt+F, assert content is reformatted.
- Settings → Workspaces → Language Features: add a custom plugin, save, verify it appears in the list and the agent picks it up.

### Manual smoke test (v1 cut)

Three platforms (macOS arm64, Linux x86_64, Windows x86_64):

- Install Pyrefly, open a Python file, confirm diagnostics on a bad import, confirm hover docs on `len()`, confirm Cmd+I AI editing still coexists with LSP suggestions.
- Open a YANG file (e.g. one of the IETF YANG modules), confirm keywords highlight, confirm Format Document fixes a mis-indented block.
- Switch to Enterprise mode config, open a `.py` file, confirm the "unavailable" banner shows and no agent install endpoint is called.

## Bundle size impact

| Component | Cost in every installer | Notes |
|---|---|---|
| Plugin descriptor for Pyrefly | ~1 KB | Pure data |
| Generic LspHost in Rust agent | ~0 MB | ~200–300 lines, statically compiled into existing agent binary |
| `monaco-languageclient` + `vscode-languageserver-protocol` in frontend | ~300–500 KB compressed | One-time add to JS bundle, shared across all LSPs |
| YANG Monarch grammar | ~10 KB | Tiny tokenizer config |
| `xml-formatter` npm package | ~15 KB | Tiny client-side formatter |
| **Pyrefly binary** | **0 bytes** in installer; **~13 MB** on disk for users who install it | On-demand download; never touches users who don't edit Python |

Total cost to a fresh install: well under 1 MB. Users who never edit Python pay nothing more.

## File layout (proposed)

```
agent/src/lsp/
  mod.rs              # LspHost
  session.rs          # LspSession (one per plugin+workspace)
  install.rs          # On-demand download, SHA verify, extraction
  routes.rs           # Axum routes mounted under /lsp
  plugins.rs          # Built-in plugin registry (mirrors frontend/src/lsp/plugins.ts)

frontend/src/lsp/
  plugins.ts          # Built-in plugin registry (Pyrefly descriptor)
  useLspClient.ts     # Hook called from Monaco editors
  installationApi.ts  # axios wrapper over /lsp/plugins REST endpoints
  types.ts            # LspPlugin, InstallStatus, etc.

frontend/src/languages/
  yang.ts             # Monarch grammar + language config
  yangFormat.ts       # Indent-based format provider
  xmlFormat.ts        # xml-formatter wrapper

frontend/src/components/settings/
  LanguageFeaturesTab.tsx     # New tab inside Workspaces settings
  LspPluginRow.tsx            # One row per plugin (built-in or custom)
  AddCustomPluginDialog.tsx   # The +Add Language Server form
```

## Adding LSP #2 later (proof the abstraction works)

To add e.g. ruff-lsp as a built-in:

1. Add a descriptor to `frontend/src/lsp/plugins.ts` and `agent/src/lsp/plugins.rs`.
2. Add the ruff-lsp binary URLs + SHAs to the descriptor (or mark it `system-path` if it's user-installed).
3. Done. Zero changes to `LspHost`, `useLspClient`, Settings UI, or `WorkspaceCodeEditor`.

To add gopls as a user-added plugin (no NetStacks release required):

1. Open Settings → Workspaces → Language Features.
2. Click **+ Add Language Server**, fill in name/language/extensions/command.
3. Click **Test connection**, then **Save**.
4. Open a `.go` file. LSP connects.

## Open questions for implementation

These are small details that should be confirmed during planning but don't affect the design:

- Exact `binaryPath` inside Pyrefly wheels (likely `pyrefly/bin/pyrefly` or `pyrefly-1.0.0.data/scripts/pyrefly`) — confirm by inspecting an actual wheel.
- Choice of `monaco-languageclient` version compatible with `monaco-editor@0.55.1`.
- Whether the agent's `dataDir` already has a convention for binary caches, or if `{dataDir}/lsp/` is a new top-level concept.
- Whether the Settings UI's "Test connection" button should also try a `textDocument/didOpen` with a sample file to catch misconfigured but live LSPs, or stop at `initialize`.

## Memory & process model

- One Pyrefly process per `(plugin_id, workspace_path)`. Idle session = idle Pyrefly process (~30–80 MB RSS depending on workspace size).
- Sessions are torn down after the last WebSocket disconnects + a grace period (60 seconds default, configurable).
- On agent shutdown, all sessions receive `shutdown` + `exit` LSP requests, then SIGTERM after a 5s timeout, then SIGKILL after another 5s.
- WebSocket → stdio bridging uses async Rust (tokio); no thread-per-session.
