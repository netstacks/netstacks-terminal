import { useState, useEffect, useCallback } from 'react'
import { getClient } from '../api/client'
import type { AiToolType } from '../types/workspace'
import GitAccountsSettingsTab from './GitAccountsSettingsTab'

interface WorkspaceDefaults {
  defaultAiTool: AiToolType
  defaultCustomCommand: string
  autoLaunchAi: boolean
  defaultTerminalPanelHeight: number
  defaultFileExplorerWidth: number
}

const AI_TOOLS: { value: AiToolType; label: string }[] = [
  { value: 'claude', label: 'Claude Code' },
  { value: 'aider', label: 'Aider' },
  { value: 'opencode', label: 'OpenCode' },
  { value: 'kimicode', label: 'KimiCode' },
  { value: 'netstacks-agent', label: 'NetStacks Agent' },
  { value: 'none', label: 'None' },
  { value: 'custom', label: 'Custom...' },
]

export default function WorkspaceSettingsTab() {
  const [defaults, setDefaults] = useState<WorkspaceDefaults>({
    defaultAiTool: 'claude',
    defaultCustomCommand: '',
    autoLaunchAi: true,
    defaultTerminalPanelHeight: 250,
    defaultFileExplorerWidth: 220,
  })
  const [wsSection, setWsSection] = useState(true)
  const [gitSection, setGitSection] = useState(true)

  useEffect(() => {
    getClient().http.get('/settings/workspace-defaults').then(({ data }) => {
      if (data && typeof data === 'object') {
        setDefaults(prev => ({ ...prev, ...data }))
      }
    }).catch(() => {})
  }, [])

  const saveDefaults = useCallback(async (updated: WorkspaceDefaults) => {
    setDefaults(updated)
    try {
      await getClient().http.put('/settings/workspace-defaults', updated)
    } catch {
      // Settings endpoint may not exist yet — save locally
    }
  }, [])

  const sectionHeaderStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '8px 0',
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--color-text-primary)',
    cursor: 'pointer',
    userSelect: 'none',
    borderBottom: '1px solid var(--color-border)',
    marginBottom: 12,
  }

  const fieldStyle: React.CSSProperties = {
    marginBottom: 16,
  }

  const labelStyle: React.CSSProperties = {
    display: 'block',
    fontSize: 12,
    color: 'var(--color-text-secondary)',
    marginBottom: 4,
  }

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '6px 8px',
    background: 'var(--color-bg-primary)',
    border: '1px solid var(--color-border)',
    borderRadius: 4,
    color: 'var(--color-text-primary)',
    fontSize: 13,
    fontFamily: 'var(--font-family)',
  }

  const selectStyle: React.CSSProperties = {
    ...inputStyle,
  }

  return (
    <div className="settings-tab-content" style={{ padding: 16 }}>
      {/* Workspace Defaults Section */}
      <div style={sectionHeaderStyle} onClick={() => setWsSection(!wsSection)}>
        <span style={{ fontSize: 10 }}>{wsSection ? '▾' : '▸'}</span>
        Workspace Defaults
      </div>

      {wsSection && (
        <div style={{ marginBottom: 24 }}>
          <div style={fieldStyle}>
            <label style={labelStyle}>Default AI Coding Tool</label>
            <select
              style={selectStyle}
              value={defaults.defaultAiTool}
              onChange={e => saveDefaults({ ...defaults, defaultAiTool: e.target.value as AiToolType })}
            >
              {AI_TOOLS.map(t => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
            <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 4 }}>
              Used as the default when creating new workspaces
            </div>
          </div>

          {defaults.defaultAiTool === 'custom' && (
            <div style={fieldStyle}>
              <label style={labelStyle}>Custom AI Command</label>
              <input
                style={{ ...inputStyle, fontFamily: 'var(--font-family-mono)' }}
                value={defaults.defaultCustomCommand}
                onChange={e => saveDefaults({ ...defaults, defaultCustomCommand: e.target.value })}
                placeholder="e.g. aider --model claude-3.5-sonnet"
              />
            </div>
          )}

          <div style={fieldStyle}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--color-text-secondary)' }}>
              <input
                type="checkbox"
                checked={defaults.autoLaunchAi}
                onChange={e => saveDefaults({ ...defaults, autoLaunchAi: e.target.checked })}
              />
              Auto-launch AI tool when workspace opens
            </label>
          </div>

          <div style={fieldStyle}>
            <label style={labelStyle}>Default Terminal Panel Height (px)</label>
            <input
              type="number"
              style={{ ...inputStyle, width: 100 }}
              value={defaults.defaultTerminalPanelHeight}
              onChange={e => saveDefaults({ ...defaults, defaultTerminalPanelHeight: parseInt(e.target.value) || 250 })}
              min={100}
              max={800}
            />
          </div>

          <div style={fieldStyle}>
            <label style={labelStyle}>Default File Explorer Width (px)</label>
            <input
              type="number"
              style={{ ...inputStyle, width: 100 }}
              value={defaults.defaultFileExplorerWidth}
              onChange={e => saveDefaults({ ...defaults, defaultFileExplorerWidth: parseInt(e.target.value) || 220 })}
              min={150}
              max={500}
            />
          </div>
        </div>
      )}

      {/* Git Accounts Section */}
      <div style={sectionHeaderStyle} onClick={() => setGitSection(!gitSection)}>
        <span style={{ fontSize: 10 }}>{gitSection ? '▾' : '▸'}</span>
        Git Accounts
      </div>

      {gitSection && (
        <GitAccountsSettingsTab />
      )}
    </div>
  )
}
