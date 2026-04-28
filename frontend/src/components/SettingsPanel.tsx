import { useState, useMemo, useEffect } from 'react'
import './SettingsPanel.css'
import KeyboardSettings from './KeyboardSettings'
import ProfilesTab from './ProfilesTab'
import VaultSettings from './VaultSettings'
import MyCredentialsTab from './MyCredentialsTab'
import IntegrationsTab from './IntegrationsTab'
import AISettingsTab from './AISettingsTab'
import AIEngineerSettingsTab from './AIEngineerSettingsTab'
import EnterpriseProfileSelector from './EnterpriseProfileSelector'
import PromptsSettingsTab from './PromptsSettingsTab'
import SnippetsSettingsTab from './SnippetsSettingsTab'
import CustomCommandsSettingsTab from './CustomCommandsSettingsTab'
import SettingsHighlighting from './SettingsHighlighting'
import StatusBarSettingsPanel from './StatusBarSettings'
import SettingsMappedKeys from './SettingsMappedKeys'
import PanelSettingsPanel from './PanelSettings'
import SettingsTroubleshooting from './SettingsTroubleshooting'
import JumpHostsTab from './JumpHostsTab'
import ApiResourcesTab from './ApiResourcesTab'
import { useKeyboard } from '../hooks/useKeyboard'
import { useSettings, type AppSettings } from '../hooks/useSettings'
import { TERMINAL_THEMES } from '../lib/terminalThemes'
import { useMode } from '../hooks/useMode'
import { useAuthStore } from '../stores/authStore'
import { useCapabilitiesStore } from '../stores/capabilitiesStore'
import { getCertStatus, type CertStatus } from '../api/cert'
import SettingsConnection from './SettingsConnection'
import SettingsTunnels from './SettingsTunnels'

interface Setting {
  id: string
  category: string
  label: string
  description: string
  type: 'boolean' | 'string' | 'number' | 'select'
  value: unknown
  options?: { label: string; value: string }[]
}

export type SettingsTab = 'general' | 'ai' | 'aiEngineer' | 'prompts' | 'snippets' | 'customCommands' | 'keyboard' | 'mappedKeys' | 'profiles' | 'jumpHosts' | 'tunnels' | 'highlighting' | 'security' | 'integrations' | 'apiResources' | 'troubleshooting' | 'account' | 'myCredentials' | 'sshCerts'

interface SettingsPanelProps {
  onSettingChange?: (id: string, value: unknown) => void
  initialTab?: SettingsTab
}

// Tab keyword registry for cross-tab search
const TAB_SEARCH_INDEX: { tab: SettingsTab; label: string; keywords: string[] }[] = [
  { tab: 'general', label: 'General', keywords: ['font', 'size', 'family', 'theme', 'terminal', 'copy', 'select', 'appearance', 'status bar', 'panels', 'weight', 'ssh', 'host key', 'known hosts'] },
  { tab: 'ai', label: 'AI', keywords: ['ai', 'provider', 'anthropic', 'openai', 'ollama', 'openrouter', 'litellm', 'model', 'mcp', 'server', 'tools', 'agent', 'highlighting', 'token', 'sanitization', 'sanitize', 'suggestions', 'autocomplete', 'next step', 'enabled providers', 'config changes', 'configuration changes'] },
  { tab: 'aiEngineer', label: 'AI Engineer', keywords: ['ai engineer', 'profile', 'personality', 'behavior', 'vendor', 'autonomy', 'onboarding', 'safety rules', 'troubleshooting', 'verbosity'] },
  { tab: 'prompts', label: 'Prompts', keywords: ['prompt', 'custom prompt', 'system prompt'] },
  { tab: 'snippets', label: 'Snippets', keywords: ['snippet', 'text expansion', 'shortcut'] },
  { tab: 'customCommands', label: 'Custom Actions', keywords: ['custom command', 'custom action', 'alias', 'macro', 'script'] },
  { tab: 'keyboard', label: 'Keyboard', keywords: ['keyboard', 'shortcut', 'keybinding', 'hotkey', 'key'] },
  { tab: 'mappedKeys', label: 'Mapped Keys', keywords: ['mapped key', 'key mapping', 'remap'] },
  { tab: 'profiles', label: 'Profiles', keywords: ['profile', 'connection', 'ssh', 'telnet'] },
  { tab: 'jumpHosts', label: 'Jump Hosts', keywords: ['jump host', 'bastion', 'proxy', 'hop'] },
  { tab: 'tunnels', label: 'Tunnels', keywords: ['tunnel', 'ssh tunnel', 'port forward', 'socks', 'proxy'] },
  { tab: 'highlighting', label: 'Highlighting', keywords: ['highlight', 'color', 'pattern', 'regex', 'rule'] },
  { tab: 'security', label: 'Security', keywords: ['security', 'vault', 'credential', 'password', 'encryption'] },
  { tab: 'integrations', label: 'Integrations', keywords: ['integration', 'netbox', 'netdisco', 'librenms'] },
  { tab: 'apiResources', label: 'API Resources', keywords: ['api', 'resource', 'quick', 'action', 'endpoint', 'solarwinds', 'prtg', 'http', 'rest'] },
  { tab: 'troubleshooting', label: 'Troubleshooting', keywords: ['troubleshoot', 'recording', 'session', 'capture'] },
  { tab: 'account', label: 'Account', keywords: ['account', 'controller', 'username', 'sign out', 'logout'] },
  { tab: 'myCredentials', label: 'My Credentials', keywords: ['credential', 'password', 'secret'] },
  { tab: 'sshCerts', label: 'SSH Certificates', keywords: ['ssh', 'certificate', 'cert', 'ca', 'public key'] },
]

// Default settings configuration - only includes settings that are actually functional
const defaultSettings: Setting[] = [
  // Appearance
  {
    id: 'fontSize',
    category: 'Appearance',
    label: 'Font Size',
    description: 'Controls the base font size in pixels for the entire application',
    type: 'number',
    value: 13,
  },
  {
    id: 'fontFamily',
    category: 'Appearance',
    label: 'Font Family',
    description: 'Controls the font family for the entire application UI',
    type: 'select',
    value: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif",
    options: [
      { label: 'System Default', value: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif" },
      { label: 'VS Code (Segoe UI)', value: "-apple-system, BlinkMacSystemFont, 'Segoe WPC', 'Segoe UI', system-ui, 'Ubuntu', 'Droid Sans', sans-serif" },
      { label: 'Helvetica Neue', value: "'Helvetica Neue', Helvetica, Arial, sans-serif" },
      { label: 'Inter', value: "Inter, -apple-system, BlinkMacSystemFont, sans-serif" },
      { label: 'SF Mono', value: "'SF Mono', Menlo, Monaco, monospace" },
      { label: 'Menlo', value: 'Menlo, Monaco, Consolas, monospace' },
      { label: 'JetBrains Mono', value: "'JetBrains Mono', Menlo, Monaco, monospace" },
      { label: 'Fira Code', value: "'Fira Code', Menlo, Monaco, monospace" },
    ],
  },
  // Terminal
  {
    id: 'terminal.defaultTheme',
    category: 'Terminal',
    label: 'Default Theme',
    description: 'Default color theme for new terminal sessions',
    type: 'select',
    value: 'default',
    options: TERMINAL_THEMES.map(t => ({ label: t.name, value: t.id })),
  },
  {
    id: 'terminal.copyOnSelect',
    category: 'Terminal',
    label: 'Copy on Select',
    description: 'Automatically copy selected text to clipboard (SecureCRT-style)',
    type: 'boolean',
    value: false,
  },
  {
    id: 'terminal.fontWeight',
    category: 'Terminal',
    label: 'Font Weight',
    description: 'Make terminal text bolder/thicker',
    type: 'select',
    value: 'normal',
    options: [
      { label: 'Normal', value: 'normal' },
      { label: 'Bold', value: 'bold' },
    ],
  },
  {
    id: 'terminal.lineNumbers',
    category: 'Terminal',
    label: 'Line Numbers',
    description: 'Show line numbers in a gutter alongside terminal sessions',
    type: 'boolean',
    value: false,
  },
  // AUDIT FIX (REMOTE-002): the global "Host Key Checking" toggle was
  // removed. Strict host-key checking is now always on; per-session opt-in
  // is the only remaining escape hatch. The backend rejects any attempt
  // to PUT /settings/ssh.hostKeyChecking with a 400.
]

export default function SettingsPanel({ onSettingChange, initialTab }: SettingsPanelProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab ?? 'general')

  // Respond to initialTab changes (e.g. when opened from a popover)
  useEffect(() => {
    if (initialTab) setActiveTab(initialTab)
  }, [initialTab])
  const [search, setSearch] = useState('')
  const keyboard = useKeyboard()
  const { isEnterprise } = useMode()
  const user = useAuthStore(state => state.user)
  const logout = useAuthStore(state => state.logout)
  const hasFeature = useCapabilitiesStore((s) => s.hasFeature)

  // Use the persisted settings hook
  const { settings: appSettings, updateSetting } = useSettings()

  // Initialize local settings state with persisted values
  const [settings, setSettings] = useState<Setting[]>(() =>
    defaultSettings.map(s => ({
      ...s,
      value: (appSettings as unknown as Record<string, unknown>)[s.id] ?? s.value
    }))
  )

  // Filter and group settings by category
  const filteredSettings = useMemo(() => {
    const searchLower = search.toLowerCase()
    return settings.filter(
      (s) =>
        s.label.toLowerCase().includes(searchLower) ||
        s.description.toLowerCase().includes(searchLower) ||
        s.category.toLowerCase().includes(searchLower) ||
        s.id.toLowerCase().includes(searchLower)
    )
  }, [settings, search])

  // Group by category
  const groupedSettings = useMemo(() => {
    const groups: Record<string, Setting[]> = {}
    for (const setting of filteredSettings) {
      if (!groups[setting.category]) {
        groups[setting.category] = []
      }
      groups[setting.category].push(setting)
    }
    return groups
  }, [filteredSettings])

  // Cross-tab search: find which tabs match the current search query
  const matchingTabs = useMemo(() => {
    if (!search.trim()) return null
    const q = search.toLowerCase()
    const matched = new Set<SettingsTab>()
    for (const entry of TAB_SEARCH_INDEX) {
      if (
        entry.label.toLowerCase().includes(q) ||
        entry.keywords.some(kw => kw.includes(q))
      ) {
        matched.add(entry.tab)
      }
    }
    return matched
  }, [search])

  // Auto-navigate to first matching tab when search changes
  useEffect(() => {
    if (!matchingTabs || matchingTabs.size === 0) return
    if (matchingTabs.has(activeTab)) return
    const first = TAB_SEARCH_INDEX.find(e => matchingTabs.has(e.tab))
    if (first) setActiveTab(first.tab)
  }, [matchingTabs, activeTab])

  const handleChange = (id: string, value: unknown) => {
    // Update local state for UI
    setSettings((prev) =>
      prev.map((s) => (s.id === id ? { ...s, value } : s))
    )
    // Persist to localStorage via useSettings hook
    if (id in appSettings) {
      updateSetting(id as keyof AppSettings, value as AppSettings[keyof AppSettings])
    }
    // AUDIT FIX (REMOTE-002): backend sync of `ssh.hostKeyChecking` removed
    // (the setting itself is gone — strict host-key checking is always on).
    onSettingChange?.(id, value)
  }

  const renderSettingItem = (setting: Setting) => {
    // For boolean and select, put control on same line as label
    if (setting.type === 'boolean' || setting.type === 'select' || setting.type === 'number') {
      return (
        <div key={setting.id} className="setting-item">
          <div className="setting-header">
            <span className="setting-label">{setting.label}</span>
            <div className="setting-control">
              {setting.type === 'boolean' && (
                <label className="setting-toggle">
                  <input
                    type="checkbox"
                    checked={setting.value as boolean}
                    onChange={(e) => handleChange(setting.id, e.target.checked)}
                  />
                  <span className="toggle-slider" />
                </label>
              )}
              {setting.type === 'select' && (
                <select
                  className="setting-select"
                  value={setting.value as string}
                  onChange={(e) => handleChange(setting.id, e.target.value)}
                >
                  {setting.options?.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              )}
              {setting.type === 'number' && (
                <input
                  type="number"
                  className="setting-input setting-input-number"
                  value={setting.value as number}
                  onChange={(e) => handleChange(setting.id, parseInt(e.target.value, 10))}
                />
              )}
            </div>
          </div>
          <div className="setting-description">{setting.description}</div>
        </div>
      )
    }

    // For string inputs, put input below
    return (
      <div key={setting.id} className="setting-item">
        <div className="setting-label">{setting.label}</div>
        <div className="setting-description">{setting.description}</div>
        <div className="setting-control-block">
          <input
            type="text"
            className="setting-input"
            value={setting.value as string}
            onChange={(e) => handleChange(setting.id, e.target.value)}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="settings-panel">
      {/* Sidebar navigation */}
      <div className="settings-sidebar">
        <button
          className={`settings-nav-item ${activeTab === 'general' ? 'active' : ''}${matchingTabs && !matchingTabs.has('general') ? ' dimmed' : ''}`}
          onClick={() => setActiveTab('general')}
        >
          General
        </button>
        <button
          className={`settings-nav-item ${activeTab === 'ai' ? 'active' : ''}${matchingTabs && !matchingTabs.has('ai') ? ' dimmed' : ''}`}
          onClick={() => setActiveTab('ai')}
        >
          AI
        </button>
        <button
          className={`settings-nav-item ${activeTab === 'aiEngineer' ? 'active' : ''}${matchingTabs && !matchingTabs.has('aiEngineer') ? ' dimmed' : ''}`}
          onClick={() => setActiveTab('aiEngineer')}
        >
          AI Engineer
        </button>
        {hasFeature('local_custom_prompts') && (
        <button
          className={`settings-nav-item ${activeTab === 'prompts' ? 'active' : ''}${matchingTabs && !matchingTabs.has('prompts') ? ' dimmed' : ''}`}
          onClick={() => setActiveTab('prompts')}
        >
          Prompts
        </button>
        )}
        {!isEnterprise && (
          <button
            className={`settings-nav-item ${activeTab === 'snippets' ? 'active' : ''}${matchingTabs && !matchingTabs.has('snippets') ? ' dimmed' : ''}`}
            onClick={() => setActiveTab('snippets')}
          >
            Snippets
          </button>
        )}
        {hasFeature('local_integrations') && (
        <button
          className={`settings-nav-item ${activeTab === 'customCommands' ? 'active' : ''}${matchingTabs && !matchingTabs.has('customCommands') ? ' dimmed' : ''}`}
          onClick={() => setActiveTab('customCommands')}
        >
          Custom Actions
        </button>
        )}
        <button
          className={`settings-nav-item ${activeTab === 'keyboard' ? 'active' : ''}${matchingTabs && !matchingTabs.has('keyboard') ? ' dimmed' : ''}`}
          onClick={() => setActiveTab('keyboard')}
        >
          Keyboard
        </button>
        <button
          className={`settings-nav-item ${activeTab === 'mappedKeys' ? 'active' : ''}${matchingTabs && !matchingTabs.has('mappedKeys') ? ' dimmed' : ''}`}
          onClick={() => setActiveTab('mappedKeys')}
        >
          Mapped Keys
        </button>
        {!isEnterprise && (
          <button
            className={`settings-nav-item ${activeTab === 'profiles' ? 'active' : ''}${matchingTabs && !matchingTabs.has('profiles') ? ' dimmed' : ''}`}
            onClick={() => setActiveTab('profiles')}
          >
            Profiles
          </button>
        )}
        {!isEnterprise && (
          <button
            className={`settings-nav-item ${activeTab === 'jumpHosts' ? 'active' : ''}${matchingTabs && !matchingTabs.has('jumpHosts') ? ' dimmed' : ''}`}
            onClick={() => setActiveTab('jumpHosts')}
          >
            Jump Hosts
          </button>
        )}
        {!isEnterprise && (
          <button
            className={`settings-nav-item ${activeTab === 'tunnels' ? 'active' : ''}${matchingTabs && !matchingTabs.has('tunnels') ? ' dimmed' : ''}`}
            onClick={() => setActiveTab('tunnels')}
          >
            Tunnels
          </button>
        )}
        <button
          className={`settings-nav-item ${activeTab === 'highlighting' ? 'active' : ''}${matchingTabs && !matchingTabs.has('highlighting') ? ' dimmed' : ''}`}
          onClick={() => setActiveTab('highlighting')}
        >
          Highlighting
        </button>
        {!isEnterprise && (
          <button
            className={`settings-nav-item ${activeTab === 'security' ? 'active' : ''}${matchingTabs && !matchingTabs.has('security') ? ' dimmed' : ''}`}
            onClick={() => setActiveTab('security')}
          >
            Security
          </button>
        )}
        {!isEnterprise && hasFeature('local_integrations') && (
          <button
            className={`settings-nav-item ${activeTab === 'integrations' ? 'active' : ''}${matchingTabs && !matchingTabs.has('integrations') ? ' dimmed' : ''}`}
            onClick={() => setActiveTab('integrations')}
          >
            Integrations
          </button>
        )}
        {hasFeature('local_integrations') && (
          <button
            className={`settings-nav-item ${activeTab === 'apiResources' ? 'active' : ''}${matchingTabs && !matchingTabs.has('apiResources') ? ' dimmed' : ''}`}
            onClick={() => setActiveTab('apiResources')}
          >
            API Resources
          </button>
        )}
        {hasFeature('local_session_recording') && (
        <button
          className={`settings-nav-item ${activeTab === 'troubleshooting' ? 'active' : ''}${matchingTabs && !matchingTabs.has('troubleshooting') ? ' dimmed' : ''}`}
          onClick={() => setActiveTab('troubleshooting')}
        >
          Troubleshooting
        </button>
        )}
        {isEnterprise && (
          <button
            className={`settings-nav-item ${activeTab === 'account' ? 'active' : ''}${matchingTabs && !matchingTabs.has('account') ? ' dimmed' : ''}`}
            onClick={() => setActiveTab('account')}
          >
            Account
          </button>
        )}
        {isEnterprise && (
          <button
            className={`settings-nav-item ${activeTab === 'myCredentials' ? 'active' : ''}${matchingTabs && !matchingTabs.has('myCredentials') ? ' dimmed' : ''}`}
            onClick={() => setActiveTab('myCredentials')}
          >
            My Credentials
          </button>
        )}
        {isEnterprise && (
          <button
            className={`settings-nav-item ${activeTab === 'sshCerts' ? 'active' : ''}${matchingTabs && !matchingTabs.has('sshCerts') ? ' dimmed' : ''}`}
            onClick={() => setActiveTab('sshCerts')}
          >
            SSH Certificates
          </button>
        )}
      </div>

      {/* Main content area */}
      <div className="settings-main">
        <div className="settings-search">
          <input
            type="text"
            placeholder="Search all settings..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="settings-search-input"
          />
        </div>

        {/* General settings tab */}
        {activeTab === 'general' && (
          <>
            <div className="settings-content">
              {Object.keys(groupedSettings).length === 0 ? (
                <div className="settings-empty">No settings found</div>
              ) : (
                Object.entries(groupedSettings).map(([category, categorySettings]) => (
                  <div key={category} className="settings-category">
                    <h3 className="settings-category-title">{category}</h3>
                    {categorySettings.map((setting) => renderSettingItem(setting))}
                  </div>
                ))
              )}

              {/* Status Bar Customization */}
              <div className="settings-category">
                <h3 className="settings-category-title">Status Bar</h3>
                <StatusBarSettingsPanel />
              </div>

              {/* Panel Auto-Hide Behavior */}
              <div className="settings-category">
                <h3 className="settings-category-title">Panels</h3>
                <PanelSettingsPanel />
              </div>
            </div>
          </>
        )}

        {/* AI settings tab */}
        {activeTab === 'ai' && (
          <AISettingsTab />
        )}

        {/* AI Engineer Profile tab */}
        {activeTab === 'aiEngineer' && (
          isEnterprise ? <EnterpriseProfileSelector /> : <AIEngineerSettingsTab />
        )}

        {/* Prompts settings tab */}
        {activeTab === 'prompts' && (
          <PromptsSettingsTab />
        )}

        {/* Snippets settings tab */}
        {activeTab === 'snippets' && (
          <SnippetsSettingsTab />
        )}

        {activeTab === 'customCommands' && (
          <CustomCommandsSettingsTab />
        )}

        {/* Keyboard settings tab */}
        {activeTab === 'keyboard' && (
          <KeyboardSettings keyboard={keyboard} />
        )}

        {/* Mapped Keys settings tab */}
        {activeTab === 'mappedKeys' && (
          <SettingsMappedKeys />
        )}

        {/* Profiles settings tab */}
        {activeTab === 'profiles' && (
          <ProfilesTab />
        )}

        {/* Jump Hosts settings tab */}
        {activeTab === 'jumpHosts' && (
          <JumpHostsTab />
        )}

        {/* Tunnels settings tab */}
        {activeTab === 'tunnels' && (
          <SettingsTunnels />
        )}

        {/* Highlighting settings tab */}
        {activeTab === 'highlighting' && (
          <SettingsHighlighting />
        )}

        {/* Security settings tab */}
        {activeTab === 'security' && (
          <VaultSettings />
        )}

        {/* Integrations settings tab */}
        {activeTab === 'integrations' && (
          <IntegrationsTab />
        )}

        {/* API Resources settings tab */}
        {activeTab === 'apiResources' && (
          <ApiResourcesTab />
        )}

        {/* Troubleshooting settings tab */}
        {activeTab === 'troubleshooting' && (
          <SettingsTroubleshooting />
        )}

        {/* My Credentials tab (Enterprise mode only) */}
        {activeTab === 'myCredentials' && isEnterprise && (
          <MyCredentialsTab />
        )}

        {/* Account settings tab (Enterprise mode only) — combines account info + connection */}
        {activeTab === 'account' && isEnterprise && (
          <div className="settings-content">
            <div className="settings-category">
              <h3 className="settings-category-title">Your Account</h3>
              <div className="settings-account-info">
                {user && (
                  <>
                    <div className="settings-account-row">
                      <span className="settings-account-label">Username</span>
                      <span className="settings-account-value">{user.username}</span>
                    </div>
                    <div className="settings-account-row">
                      <span className="settings-account-label">Auth Provider</span>
                      <span className="settings-account-value">{user.auth_provider}</span>
                    </div>
                  </>
                )}
              </div>
              <div className="settings-account-actions">
                <button
                  className="settings-logout-btn"
                  onClick={() => logout()}
                >
                  Sign Out
                </button>
              </div>
            </div>
            <div className="settings-category" style={{ marginTop: '24px' }}>
              <h3 className="settings-category-title">Controller Connection</h3>
              <SettingsConnection />
            </div>
          </div>
        )}

        {/* SSH Certificates tab (Enterprise mode only) */}
        {activeTab === 'sshCerts' && isEnterprise && (
          <div className="settings-content">
            <div className="settings-category">
              <h3 className="settings-category-title">SSH Certificate Authentication</h3>
              <SshCertSettings />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function SshCertSettings() {
  const [certStatus, setCertStatus] = useState<CertStatus | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getCertStatus()
      .then(setCertStatus)
      .catch(() => setCertStatus(null))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="settings-account-info">Loading...</div>

  return (
    <div className="settings-account-info">
      <div className="settings-account-row">
        <span className="settings-account-label">Status</span>
        <span className="settings-account-value">
          {certStatus?.valid ? 'Valid' : 'Not available'}
        </span>
      </div>
      {certStatus?.expires_at && (
        <div className="settings-account-row">
          <span className="settings-account-label">Expires</span>
          <span className="settings-account-value">
            {new Date(certStatus.expires_at).toLocaleString()}
          </span>
        </div>
      )}
      {certStatus?.public_key_fingerprint && (
        <div className="settings-account-row">
          <span className="settings-account-label">Public Key</span>
          <span className="settings-account-value" style={{ fontFamily: 'monospace', fontSize: '0.85em' }}>
            {certStatus.public_key_fingerprint}
          </span>
        </div>
      )}
    </div>
  )
}
