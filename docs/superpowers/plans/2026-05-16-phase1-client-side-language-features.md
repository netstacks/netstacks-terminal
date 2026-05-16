# Phase 1: Client-Side Language Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Light up YANG syntax highlighting + format-document support across every Monaco editor in the app, and add format-document support for XML — all client-side, no backend involvement. JSON is already covered by Monaco's bundled `json.worker`.

**Architecture:** A new `frontend/src/languages/` module owns all language registrations. A single `registerNetstacksLanguages(monaco)` entry point is called from `main.tsx` after the existing MonacoEnvironment configuration. YANG gets a Monarch tokenizer + language config + indent-based format provider. XML reuses Monaco's built-in highlighting and gets a new format provider wrapping the `xml-formatter` npm package.

**Tech Stack:** TypeScript, Monaco Editor 0.55.1, `xml-formatter` (new dependency), Vitest.

---

## Phase Map (for context — this plan is Phase 1 only)

- **Phase 1: Client-Side Language Features** ← you are here
- Phase 2: Agent LSP Foundation (generic plugin host, no Pyrefly yet)
- Phase 3: Frontend LSP Client (monaco-languageclient hook)
- Phase 4: Pyrefly Plugin (on-demand download + first-run banner)
- Phase 5: Settings UI (full CRUD for LSP plugins)
- Phase 6: Polish (loose-file mode, Enterprise banner, E2E)

Phase 1 is independent — no other phase depends on it and it depends on nothing else. It can ship on its own.

---

## File Structure

**New files:**
- `frontend/src/languages/index.ts` — `registerNetstacksLanguages(monaco)` entry point
- `frontend/src/languages/yang.ts` — Monarch grammar + language configuration for YANG
- `frontend/src/languages/yangFormat.ts` — indent-based format provider
- `frontend/src/languages/xmlFormat.ts` — `xml-formatter`-backed format provider
- `frontend/src/languages/__tests__/yang.test.ts` — Monarch tokenization tests
- `frontend/src/languages/__tests__/yangFormat.test.ts` — formatter tests
- `frontend/src/languages/__tests__/xmlFormat.test.ts` — formatter tests

**Modified files:**
- `frontend/package.json` — add `xml-formatter` to dependencies
- `frontend/src/main.tsx` — import and call `registerNetstacksLanguages` after MonacoEnvironment setup (after line 41)
- `frontend/src/components/workspace/WorkspaceCodeEditor.tsx:35` — change `yang: 'plaintext'` → `yang: 'yang'`

---

## Task 1: Add `xml-formatter` dependency

**Files:**
- Modify: `frontend/package.json`
- Modify: `frontend/package-lock.json` (regenerated)

- [ ] **Step 1: Install the package**

Run from the repo root:
```bash
cd frontend && npm install --save xml-formatter
```

Expected: `xml-formatter` (latest 3.x) appears in `frontend/package.json` under `dependencies`, `package-lock.json` is updated. No vulnerability warnings; the package has zero runtime dependencies.

- [ ] **Step 2: Verify the package is usable**

Run from `frontend/`:
```bash
node -e "console.log(require('xml-formatter')('<a><b>hi</b></a>'))"
```

Expected output:
```
<a>
    <b>hi</b>
</a>
```

- [ ] **Step 3: Commit**

```bash
git add frontend/package.json frontend/package-lock.json
git commit -m "feat: add xml-formatter dependency for XML format provider"
```

---

## Task 2: YANG Monarch grammar — failing test first

**Files:**
- Create: `frontend/src/languages/__tests__/yang.test.ts`

Vitest auto-discovers `*.test.ts` under `src/`. Tests run from the `frontend/` directory.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/languages/__tests__/yang.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import * as monaco from 'monaco-editor';
import { yangLanguage, yangLanguageConfig } from '../yang';

beforeAll(() => {
  monaco.languages.register({ id: 'yang', extensions: ['.yang'] });
  monaco.languages.setMonarchTokensProvider('yang', yangLanguage);
  monaco.languages.setLanguageConfiguration('yang', yangLanguageConfig);
});

function tokenize(line: string): { token: string; text: string }[] {
  const tokens = monaco.editor.tokenize(line, 'yang')[0];
  return tokens.map((t, i) => ({
    token: t.type,
    text: line.substring(t.offset, tokens[i + 1]?.offset ?? line.length),
  }));
}

describe('YANG Monarch grammar', () => {
  it('tokenizes top-level keywords', () => {
    const result = tokenize('module example {');
    expect(result[0].token).toBe('keyword.yang');
    expect(result[0].text).toBe('module');
  });

  it('tokenizes statement keywords', () => {
    const result = tokenize('  container interfaces {');
    expect(result.find(t => t.text === 'container')?.token).toBe('keyword.yang');
  });

  it('tokenizes built-in types after `type`', () => {
    const result = tokenize('    type string;');
    const stringToken = result.find(t => t.text === 'string');
    expect(stringToken?.token).toMatch(/type\.yang/);
  });

  it('tokenizes double-quoted strings', () => {
    const result = tokenize('  description "Hello world";');
    const stringTokens = result.filter(t => t.token.startsWith('string'));
    expect(stringTokens.length).toBeGreaterThan(0);
  });

  it('tokenizes single-line comments', () => {
    const result = tokenize('// this is a comment');
    expect(result[0].token).toMatch(/comment/);
  });

  it('tokenizes block comments', () => {
    const result = tokenize('/* block comment */');
    expect(result[0].token).toMatch(/comment/);
  });

  it('tokenizes numbers', () => {
    const result = tokenize('  default 42;');
    const numToken = result.find(t => t.text === '42');
    expect(numToken?.token).toMatch(/number/);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run from `frontend/`:
```bash
npx vitest run src/languages/__tests__/yang.test.ts
```

Expected: FAIL with `Cannot find module '../yang'` (or similar import error). This proves Vitest is wired correctly and we're about to actually implement something that didn't exist.

- [ ] **Step 3: Write the YANG grammar**

Create `frontend/src/languages/yang.ts`:

```typescript
import type { languages } from 'monaco-editor';

// Keywords that introduce statements in a YANG module.
const STATEMENT_KEYWORDS = [
  'module', 'submodule', 'yang-version', 'namespace', 'prefix',
  'import', 'include', 'organization', 'contact', 'description',
  'reference', 'revision', 'revision-date',
  'extension', 'argument', 'yin-element',
  'feature', 'if-feature', 'identity', 'base',
  'typedef', 'type', 'units', 'default', 'status',
  'container', 'must', 'presence', 'leaf', 'leaf-list',
  'list', 'key', 'unique', 'min-elements', 'max-elements', 'ordered-by',
  'choice', 'case', 'mandatory', 'config', 'when',
  'uses', 'refine', 'augment', 'grouping',
  'rpc', 'input', 'output', 'action', 'notification',
  'anyxml', 'anydata',
  'deviation', 'deviate', 'not-supported', 'add', 'replace', 'delete',
  'belongs-to', 'pattern', 'modifier', 'range', 'length',
  'enum', 'value', 'bit', 'position',
  'fraction-digits', 'path', 'require-instance',
  'error-message', 'error-app-tag',
];

// YANG built-in types — highlighted differently when they appear as
// the argument to a `type` statement.
const BUILTIN_TYPES = [
  'binary', 'bits', 'boolean', 'decimal64', 'empty',
  'enumeration', 'identityref', 'instance-identifier',
  'int8', 'int16', 'int32', 'int64',
  'leafref', 'string', 'union',
  'uint8', 'uint16', 'uint32', 'uint64',
];

export const yangLanguage: languages.IMonarchLanguage = {
  defaultToken: '',
  ignoreCase: false,
  tokenPostfix: '.yang',

  keywords: STATEMENT_KEYWORDS,
  builtinTypes: BUILTIN_TYPES,

  // Identifiers in YANG can include letters, digits, hyphens, underscores, and dots.
  identifier: /[A-Za-z_][\w\-.]*/,

  tokenizer: {
    root: [
      // Whitespace
      { include: '@whitespace' },

      // Block comments
      [/\/\*/, 'comment', '@blockComment'],

      // Line comments
      [/\/\/.*$/, 'comment'],

      // The `type` statement gets special handling so its argument
      // can be tokenized as a built-in type.
      [/\btype\b/, { token: 'keyword.yang', next: '@typeArgument' }],

      // Keywords (statement names)
      [/@identifier/, {
        cases: {
          '@keywords': 'keyword.yang',
          '@default': 'identifier',
        },
      }],

      // Block delimiters
      [/[{}]/, '@brackets'],
      [/[;]/, 'delimiter'],

      // Strings
      [/"/, { token: 'string.quote', next: '@stringDouble' }],
      [/'/, { token: 'string.quote', next: '@stringSingle' }],

      // Numbers (integer + decimal)
      [/\d+\.\d+/, 'number.float'],
      [/\d+/, 'number'],

      // Operators (for when/must XPath-ish expressions)
      [/[+\-*/=<>!]+/, 'operator'],
    ],

    typeArgument: [
      [/\s+/, ''],
      [/@identifier/, {
        cases: {
          '@builtinTypes': { token: 'type.yang', next: '@pop' },
          '@default': { token: 'type.yang', next: '@pop' },
        },
      }],
      // Fallback if no identifier (e.g. malformed input)
      [/./, { token: '', next: '@pop' }],
    ],

    whitespace: [
      [/[ \t\r\n]+/, ''],
    ],

    blockComment: [
      [/[^/*]+/, 'comment'],
      [/\*\//, 'comment', '@pop'],
      [/[/*]/, 'comment'],
    ],

    stringDouble: [
      [/[^\\"]+/, 'string'],
      [/\\./, 'string.escape'],
      [/"/, { token: 'string.quote', next: '@pop' }],
    ],

    stringSingle: [
      [/[^\\']+/, 'string'],
      [/\\./, 'string.escape'],
      [/'/, { token: 'string.quote', next: '@pop' }],
    ],
  },
};

export const yangLanguageConfig: languages.LanguageConfiguration = {
  comments: {
    lineComment: '//',
    blockComment: ['/*', '*/'],
  },
  brackets: [
    ['{', '}'],
    ['[', ']'],
    ['(', ')'],
  ],
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
  surroundingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
};
```

- [ ] **Step 4: Run tests, verify they pass**

Run from `frontend/`:
```bash
npx vitest run src/languages/__tests__/yang.test.ts
```

Expected: all 7 tests PASS. If `type string;` test fails because `string` is being matched as a generic identifier first instead of a built-in type, double-check the `@typeArgument` state transition fired (Monarch is order-sensitive — the `\btype\b` rule MUST come before the `@identifier` rule).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/languages/yang.ts frontend/src/languages/__tests__/yang.test.ts
git commit -m "feat: add YANG Monarch grammar with keyword + type tokenization"
```

---

## Task 3: YANG format provider — failing test first

**Files:**
- Create: `frontend/src/languages/__tests__/yangFormat.test.ts`
- Create: `frontend/src/languages/yangFormat.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/languages/__tests__/yangFormat.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { formatYang } from '../yangFormat';

describe('YANG format provider', () => {
  it('indents nested braces with 2 spaces per level', () => {
    const input = `module foo {
container bar {
leaf baz {
type string;
}
}
}`;
    const expected = `module foo {
  container bar {
    leaf baz {
      type string;
    }
  }
}`;
    expect(formatYang(input)).toBe(expected);
  });

  it('preserves single-line statements with no brace change', () => {
    const input = `module foo {
yang-version 1.1;
namespace "urn:example:foo";
prefix "f";
}`;
    const expected = `module foo {
  yang-version 1.1;
  namespace "urn:example:foo";
  prefix "f";
}`;
    expect(formatYang(input)).toBe(expected);
  });

  it('preserves quoted strings verbatim (does not reformat their contents)', () => {
    const input = `module foo {
description "Line one
Line two
Line three";
}`;
    const expected = `module foo {
  description "Line one
Line two
Line three";
}`;
    expect(formatYang(input)).toBe(expected);
  });

  it('preserves block comments without rewriting them', () => {
    const input = `module foo {
/* This is a
   multi-line block comment */
container c {
}
}`;
    const expected = `module foo {
  /* This is a
   multi-line block comment */
  container c {
  }
}`;
    expect(formatYang(input)).toBe(expected);
  });

  it('handles closing braces on the same line as opening (one-liners)', () => {
    const input = `module foo { leaf x { type string; } }`;
    // Single-line input — formatter passes it through; users who want
    // expansion should re-format after splitting onto multiple lines.
    expect(formatYang(input)).toBe(input);
  });

  it('collapses trailing whitespace and tabs in indentation', () => {
    const input = `module foo {
\t\tleaf x {
   type string;
}
}`;
    const expected = `module foo {
  leaf x {
    type string;
  }
}`;
    expect(formatYang(input)).toBe(expected);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run from `frontend/`:
```bash
npx vitest run src/languages/__tests__/yangFormat.test.ts
```

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement `formatYang`**

Create `frontend/src/languages/yangFormat.ts`:

```typescript
import type { languages, editor } from 'monaco-editor';

const INDENT = '  ';

/**
 * Indent-based YANG pretty-printer.
 *
 * Walks the input character-by-character, tracking depth from { and }.
 * Quoted strings and block comments are passed through verbatim so their
 * contents are never reformatted. Single-line statements (ending in ;) get
 * the current depth's indent. Lines that contain both { and } at the same
 * depth on a single line are passed through as-is (the formatter does not
 * try to expand one-liners onto multiple lines).
 */
export function formatYang(input: string): string {
  const lines = input.split('\n');
  const output: string[] = [];
  let depth = 0;
  let inBlockComment = false;
  let inString: false | '"' | "'" = false;

  for (const rawLine of lines) {
    // If we're inside a multi-line string or block comment, the line
    // is passed through verbatim (don't touch its indentation).
    if (inString || inBlockComment) {
      output.push(rawLine);
      // Walk the line to see if the string/comment closes on it.
      for (let i = 0; i < rawLine.length; i++) {
        const c = rawLine[i];
        const next = rawLine[i + 1];
        if (inBlockComment && c === '*' && next === '/') {
          inBlockComment = false;
          i++;
        } else if (inString && c === inString && rawLine[i - 1] !== '\\') {
          inString = false;
        }
      }
      continue;
    }

    const trimmed = rawLine.trim();
    if (trimmed === '') {
      output.push('');
      continue;
    }

    // Count net brace change on this line, ignoring braces inside
    // strings or comments that open/close on the same line.
    let netChange = 0;
    let opensAtStart = 0; // leading } that should DEDENT before emit
    let sawNonBraceBeforeOpening = false;
    let localInString: false | '"' | "'" = false;
    let localInBlockComment = false;
    let localInLineComment = false;

    for (let i = 0; i < trimmed.length; i++) {
      const c = trimmed[i];
      const next = trimmed[i + 1];

      if (localInLineComment) break;
      if (localInString) {
        if (c === localInString && trimmed[i - 1] !== '\\') localInString = false;
        continue;
      }
      if (localInBlockComment) {
        if (c === '*' && next === '/') { localInBlockComment = false; i++; }
        continue;
      }

      if (c === '/' && next === '/') { localInLineComment = true; continue; }
      if (c === '/' && next === '*') { localInBlockComment = true; i++; continue; }
      if (c === '"' || c === "'") { localInString = c as '"' | "'"; continue; }

      if (c === '{') { netChange++; sawNonBraceBeforeOpening = sawNonBraceBeforeOpening || i > opensAtStart; }
      else if (c === '}') {
        netChange--;
        if (!sawNonBraceBeforeOpening && netChange < 0) opensAtStart++;
      } else if (c !== ' ' && c !== '\t') {
        sawNonBraceBeforeOpening = true;
      }
    }

    // Apply leading dedent for any close braces at the start of the line.
    const effectiveDepth = Math.max(0, depth - opensAtStart);
    output.push(INDENT.repeat(effectiveDepth) + trimmed);

    // Update running state for next line.
    depth = Math.max(0, depth + netChange);
    if (localInString) inString = localInString;
    if (localInBlockComment) inBlockComment = true;
  }

  return output.join('\n');
}

/**
 * Monaco format provider adapter. Wired into `monaco.languages.registerDocumentFormattingEditProvider('yang', ...)`.
 */
export const yangFormatProvider: languages.DocumentFormattingEditProvider = {
  provideDocumentFormattingEdits(model: editor.ITextModel): languages.TextEdit[] {
    const formatted = formatYang(model.getValue());
    return [{
      range: model.getFullModelRange(),
      text: formatted,
    }];
  },
};
```

- [ ] **Step 4: Run tests, verify they pass**

Run from `frontend/`:
```bash
npx vitest run src/languages/__tests__/yangFormat.test.ts
```

Expected: all 6 tests PASS. If the "preserves quoted strings verbatim" test fails because the formatter changes line 2 or 3 of the description, check the `inString` flag — it should remain `true` across line breaks until the closing quote.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/languages/yangFormat.ts frontend/src/languages/__tests__/yangFormat.test.ts
git commit -m "feat: add YANG indent-based document formatter"
```

---

## Task 4: XML format provider — failing test first

**Files:**
- Create: `frontend/src/languages/__tests__/xmlFormat.test.ts`
- Create: `frontend/src/languages/xmlFormat.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/languages/__tests__/xmlFormat.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { formatXml } from '../xmlFormat';

describe('XML format provider', () => {
  it('indents nested elements with 2 spaces', () => {
    const input = '<root><a><b>hi</b></a></root>';
    const result = formatXml(input);
    expect(result).toContain('<root>');
    expect(result).toContain('  <a>');
    expect(result).toContain('    <b>hi</b>');
    expect(result).toContain('  </a>');
    expect(result).toContain('</root>');
  });

  it('handles NETCONF-style XML config payloads', () => {
    const input = '<config xmlns="urn:ietf:params:xml:ns:netconf:base:1.0"><interfaces><interface><name>eth0</name></interface></interfaces></config>';
    const result = formatXml(input);
    expect(result.split('\n').length).toBeGreaterThan(4);
    expect(result).toContain('  <interfaces>');
  });

  it('returns input unchanged if XML is malformed', () => {
    const input = '<this is not <valid> xml';
    // formatXml should not throw; it returns the original on parse failure.
    expect(() => formatXml(input)).not.toThrow();
  });

  it('preserves XML declarations', () => {
    const input = '<?xml version="1.0"?><a><b/></a>';
    const result = formatXml(input);
    expect(result).toContain('<?xml version="1.0"?>');
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run from `frontend/`:
```bash
npx vitest run src/languages/__tests__/xmlFormat.test.ts
```

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement `formatXml`**

Create `frontend/src/languages/xmlFormat.ts`:

```typescript
import xmlFormatter from 'xml-formatter';
import type { languages, editor } from 'monaco-editor';

export function formatXml(input: string): string {
  try {
    return xmlFormatter(input, {
      indentation: '  ',
      collapseContent: true,
      lineSeparator: '\n',
    });
  } catch {
    // Malformed XML: return the original so the editor doesn't corrupt it.
    return input;
  }
}

/**
 * Monaco format provider adapter. Wired into `monaco.languages.registerDocumentFormattingEditProvider('xml', ...)`.
 */
export const xmlFormatProvider: languages.DocumentFormattingEditProvider = {
  provideDocumentFormattingEdits(model: editor.ITextModel): languages.TextEdit[] {
    const formatted = formatXml(model.getValue());
    return [{
      range: model.getFullModelRange(),
      text: formatted,
    }];
  },
};
```

- [ ] **Step 4: Run tests, verify they pass**

Run from `frontend/`:
```bash
npx vitest run src/languages/__tests__/xmlFormat.test.ts
```

Expected: all 4 tests PASS. The "malformed" test verifies the try/catch prevents corrupting unparseable input.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/languages/xmlFormat.ts frontend/src/languages/__tests__/xmlFormat.test.ts
git commit -m "feat: add XML document format provider using xml-formatter"
```

---

## Task 5: Registration entry point

**Files:**
- Create: `frontend/src/languages/index.ts`

- [ ] **Step 1: Create the registration entry point**

Create `frontend/src/languages/index.ts`:

```typescript
import type * as Monaco from 'monaco-editor';
import { yangLanguage, yangLanguageConfig } from './yang';
import { yangFormatProvider } from './yangFormat';
import { xmlFormatProvider } from './xmlFormat';

/**
 * Register all NetStacks-specific language features on the given Monaco
 * instance. Call this once at app bootstrap, after MonacoEnvironment is
 * configured but before any editor is created.
 *
 * Adds:
 *   - YANG language id ('yang') with Monarch tokenizer + language config
 *   - YANG document format provider (indent-based pretty-printer)
 *   - XML document format provider (xml-formatter)
 *
 * JSON is intentionally not registered — Monaco's bundled json.worker
 * already provides syntax, schema validation, and format-document.
 */
export function registerNetstacksLanguages(monaco: typeof Monaco): void {
  // YANG language
  monaco.languages.register({
    id: 'yang',
    extensions: ['.yang'],
    aliases: ['YANG', 'yang'],
  });
  monaco.languages.setMonarchTokensProvider('yang', yangLanguage);
  monaco.languages.setLanguageConfiguration('yang', yangLanguageConfig);
  monaco.languages.registerDocumentFormattingEditProvider('yang', yangFormatProvider);

  // XML — already registered by Monaco; just add the format provider.
  monaco.languages.registerDocumentFormattingEditProvider('xml', xmlFormatProvider);
}
```

- [ ] **Step 2: Type-check the new module**

Run from `frontend/`:
```bash
npx tsc --noEmit
```

Expected: zero new errors. If `monaco-editor` types complain about `IMonarchLanguage` or `DocumentFormattingEditProvider`, double-check the imports in `yang.ts` and `xmlFormat.ts` match the type names exported by `monaco-editor`'s `.d.ts`.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/languages/index.ts
git commit -m "feat: add registerNetstacksLanguages entry point for Monaco extensions"
```

---

## Task 6: Wire registration into `main.tsx`

**Files:**
- Modify: `frontend/src/main.tsx`

- [ ] **Step 1: Add the import and call**

In `frontend/src/main.tsx`, add the import alongside the existing Monaco imports (after line 4):

```typescript
import * as monaco from 'monaco-editor';
import { registerNetstacksLanguages } from './languages';
```

Then, immediately after the MonacoEnvironment block ends (after line 41), add:

```typescript
// Register NetStacks-specific language features (YANG, XML format).
// JSON is left to Monaco's built-in json.worker.
registerNetstacksLanguages(monaco);
```

The final structure of lines 4–44 should look like:

```typescript
import * as monaco from 'monaco-editor';
import { registerNetstacksLanguages } from './languages';
import './index.css';
// ...other imports...

// Use locally bundled Monaco instead of CDN (required for Tauri CSP)
loader.config({ monaco });

// Configure Monaco web workers for Vite
// @ts-ignore - self.MonacoEnvironment is a global Monaco config
self.MonacoEnvironment = {
  getWorker(_: string, label: string) {
    // ...existing worker setup...
  },
};

// Register NetStacks-specific language features (YANG, XML format).
// JSON is left to Monaco's built-in json.worker.
registerNetstacksLanguages(monaco);
```

- [ ] **Step 2: Type-check**

Run from `frontend/`:
```bash
npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 3: Smoke test in the dev server**

From the repo root:
```bash
./terminal-dev.sh -s
```

Wait for the app to launch. Open a workspace that contains any `.yang` file (or create one with `module foo { container bar { leaf baz { type string; } } }`). Confirm:

- YANG keywords (`module`, `container`, `leaf`, `type`) are colored differently from identifiers.
- Right-click → Format Document (or press Shift+Alt+F) reformats the file with 2-space indentation.

Then open any `.xml` file. Confirm:

- Format Document reformats it with 2-space indentation.

If the YANG file still shows as plaintext (no colors), that's expected at this point — Task 7 changes the language map in `WorkspaceCodeEditor`.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/main.tsx
git commit -m "feat: register NetStacks language features in main bootstrap"
```

---

## Task 7: Switch YANG to the new language in `WorkspaceCodeEditor`

**Files:**
- Modify: `frontend/src/components/workspace/WorkspaceCodeEditor.tsx:35`

- [ ] **Step 1: Update the extension map**

In `frontend/src/components/workspace/WorkspaceCodeEditor.tsx`, find line 35 (the `EXT_TO_LANG` map entry for YANG) and change:

```typescript
yang: 'plaintext',
```

to:

```typescript
yang: 'yang',
```

- [ ] **Step 2: Smoke test**

From the repo root:
```bash
./terminal-dev.sh -s
```

Open a `.yang` file in a workspace. Confirm:

- Keywords are highlighted with the dark-theme keyword color.
- Built-in types like `string`, `uint32` after `type` are highlighted as types.
- Quoted strings are highlighted as strings.
- Comments (`//` and `/* */`) are dimmed.
- Format Document (Shift+Alt+F) cleans up indentation.

Sample file content if you don't have one handy — save as `test.yang`:

```yang
module example-iface {
yang-version 1.1;
namespace "urn:example:iface";
prefix "iface";

revision 2026-05-16 {
description "Initial revision.";
}

container interfaces {
list interface {
key "name";
leaf name {
type string;
description "Interface name.";
}
leaf enabled {
type boolean;
default "true";
}
}
}
}
```

After Format Document, indentation should be consistent (2 spaces per nesting level).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/workspace/WorkspaceCodeEditor.tsx
git commit -m "feat: enable YANG syntax highlighting in WorkspaceCodeEditor"
```

---

## Task 8: Run the full test suite + final sanity check

**Files:** none

- [ ] **Step 1: Run all frontend tests**

Run from `frontend/`:
```bash
npm test
```

Expected: all tests pass. The new `languages/__tests__/` directory contributes 17 tests (7 grammar + 6 formatter + 4 XML); pre-existing tests should be unaffected.

- [ ] **Step 2: Run typecheck on the whole frontend**

Run from `frontend/`:
```bash
npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 3: Build the frontend (release-mode sanity check)**

Run from `frontend/`:
```bash
npm run build
```

Expected: build succeeds. Confirm `dist/assets/` still contains the existing workers (`json.worker-*.js`, `editor.worker-*.js`, etc.) — no Monaco workers should have been removed or renamed by this change.

- [ ] **Step 4: Verify the change is self-contained**

Run from the repo root:
```bash
git log --oneline main..HEAD
```

Expected: 7 commits, one per task that produced one. All on the current branch. No agent-side changes (Rust), no Settings UI changes, no new dependencies beyond `xml-formatter`.

---

## Done criteria for Phase 1

- ✅ YANG files (`.yang` extension) in `WorkspaceCodeEditor` display with proper syntax highlighting.
- ✅ Shift+Alt+F (Format Document) on a YANG file produces consistent 2-space-indented output.
- ✅ Shift+Alt+F on an XML file produces consistent 2-space-indented output.
- ✅ 17 new unit tests pass under Vitest.
- ✅ `npx tsc --noEmit` reports zero errors.
- ✅ `npm run build` succeeds.
- ✅ No backend/agent code changes; no new Tauri permissions; no Settings UI changes.

Once these are all green, Phase 1 is shippable on its own. Phase 2 (agent LSP foundation) is independent and can begin without integration risk.
