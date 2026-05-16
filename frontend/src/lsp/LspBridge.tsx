import { type FC } from 'react'
import type * as Monaco from 'monaco-editor'
import type { editor as MonacoEditor } from 'monaco-editor'
import { useLspClient } from './useLspClient'

interface LspBridgeProps {
  monaco: typeof Monaco
  editor: MonacoEditor.IStandaloneCodeEditor
  model: MonacoEditor.ITextModel
  language: string
  workspace: string | null
}

/**
 * Headless component that registers an LSP client for the given Monaco
 * editor + model. Renders nothing — its only purpose is to scope the
 * useLspClient hook's lifetime to the editor's lifetime.
 *
 * In Phase 3 this is inert (no plugins exist). Phase 4 adds Pyrefly,
 * Phase 5 adds the Settings UI for custom plugins.
 */
export const LspBridge: FC<LspBridgeProps> = (props) => {
  useLspClient(props)
  return null
}
