/**
 * useEditorFontSettings — derive font settings for Monaco editors from
 * the global app settings.
 *
 * Why this exists
 * ---------------
 * Every Monaco editor in the app (DocumentTabEditor, ScriptEditor,
 * TemplateDetailTab, WorkspaceCodeEditor) used to hardcode fontSize
 * (13 / 14 — drift) and fall back to Monaco's default fontFamily. The
 * Settings → Appearance → Font Size / Font Family controls only
 * affected the terminal. Consolidating here so:
 *
 *   - Every editor honors the user's setting.
 *   - Sizes stay in lockstep across editors.
 *   - Future split (editor.fontSize separate from global) is a
 *     one-line change here, not a sweep across components.
 *
 * Usage
 * -----
 *   const editorFont = useEditorFontSettings()
 *   <MonacoEditor options={{ ...editorFont, ...other }} />
 *
 * Dynamic updates: useSettings re-fires on change, so this hook
 * returns a fresh object on every change. Pass it as part of Monaco's
 * `options` prop — @monaco-editor/react diffs and applies via
 * editor.updateOptions automatically.
 */

import { useMemo } from 'react'
import { useSettings } from './useSettings'

interface EditorFontSettings {
  /** Monaco fontSize option (pixels). */
  fontSize: number
  /** Monaco fontFamily option. */
  fontFamily: string
}

/**
 * Heuristic — most picks under Settings → Appearance → Font Family are
 * sans-serif (good for app chrome but unreadable in a code editor).
 * If the chosen family looks like a UI font, fall back to a monospace
 * stack for Monaco. Mono picks (SF Mono, Menlo, JetBrains Mono, Fira
 * Code) pass through unchanged.
 */
function ensureMonoSafe(family: string): string {
  const f = family.toLowerCase()
  const looksMono =
    f.includes('mono') ||
    f.includes('menlo') ||
    f.includes('consolas') ||
    f.includes('fira code') ||
    f.includes('cascadia') ||
    f.includes('courier')
  if (looksMono) return family
  // Sans-serif setting — prepend a sensible mono so code stays
  // readable while still respecting the user's overall preference.
  return `'SF Mono', Menlo, Monaco, Consolas, 'Courier New', monospace`
}

export function useEditorFontSettings(): EditorFontSettings {
  const { settings } = useSettings()
  return useMemo<EditorFontSettings>(
    () => ({
      fontSize: settings.fontSize,
      fontFamily: ensureMonoSafe(settings.fontFamily),
    }),
    [settings.fontSize, settings.fontFamily],
  )
}
