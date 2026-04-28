import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { listDeviceConfigs, getDeviceConfigVersion, pullDeviceConfig, diffConfigVersions, type DeviceConfig, type DeviceConfigFull, type VersionDiffResponse } from '../api/configManagement'
import './BackupHistoryTab.css'

interface BackupHistoryTabProps {
  deviceId: string
  deviceName: string
  onAskAI?: (question: string, context: string) => void
}

interface BackupEntry {
  id: string
  version: number
  config_text: string | null
  config_format: string
  pulled_via: string
  config_hash: string
  created_at: string
  line_count: number
  size_bytes: number
}

interface SearchTimelineEntry {
  version: number
  date: string
  matchingLines: string[]
  present: boolean
}

function toBackupEntry(dc: DeviceConfig): BackupEntry {
  return {
    id: dc.id,
    version: dc.version,
    config_text: null,
    config_format: dc.config_format,
    pulled_via: dc.pulled_via,
    config_hash: dc.config_hash,
    created_at: dc.created_at,
    line_count: 0,
    size_bytes: 0,
  }
}

function toBackupEntryFull(dc: DeviceConfigFull): BackupEntry {
  return {
    id: dc.id,
    version: dc.version,
    config_text: dc.config_text,
    config_format: dc.config_format,
    pulled_via: dc.pulled_via,
    config_hash: dc.config_hash,
    created_at: dc.created_at,
    line_count: dc.config_text ? dc.config_text.split('\n').length : 0,
    size_bytes: dc.config_text ? new Blob([dc.config_text]).size : 0,
  }
}

export default function BackupHistoryTab({ deviceId, deviceName, onAskAI }: BackupHistoryTabProps) {
  const [backups, setBackups] = useState<BackupEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Filter
  const [filterTab, setFilterTab] = useState<'all' | 'cli' | 'structured'>('all')

  // Selection
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null)
  const [selectedConfig, setSelectedConfig] = useState<BackupEntry | null>(null)
  const [loadingConfig, setLoadingConfig] = useState(false)

  // Compare
  const [compareVersions, setCompareVersions] = useState<Set<number>>(new Set())
  const [diffResult, setDiffResult] = useState<VersionDiffResponse | null>(null)
  const [loadingDiff, setLoadingDiff] = useState(false)
  const [viewMode, setViewMode] = useState<'config' | 'diff' | 'timeline'>('config')

  // Pull new
  const [collecting, setCollecting] = useState(false)
  const [collectMessage, setCollectMessage] = useState<string | null>(null)

  // Search
  const [searchQuery, setSearchQuery] = useState('')
  const [searchVisible, setSearchVisible] = useState(false)
  const [currentMatchIdx, setCurrentMatchIdx] = useState(0)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const configViewRef = useRef<HTMLDivElement>(null)

  // Timeline search (cross-backup)
  const [timelineQuery, setTimelineQuery] = useState('')
  const [timelineResults, setTimelineResults] = useState<SearchTimelineEntry[]>([])
  const [loadingTimeline, setLoadingTimeline] = useState(false)

  // Copy
  const [copied, setCopied] = useState(false)

  // AI context menu
  const [aiContextMenu, setAiContextMenu] = useState<{
    x: number; y: number; selectedText: string
  } | null>(null)

  // All backup configs cache (for timeline search) — keyed by version
  const backupConfigsRef = useRef<Map<number, string>>(new Map())

  const fetchBackups = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await listDeviceConfigs(deviceId)
      const sorted = data
        .map(toBackupEntry)
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      setBackups(sorted)
      if (sorted.length > 0 && selectedVersion === null) {
        handleSelectBackup(sorted[0])
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load backups')
    } finally {
      setLoading(false)
    }
  }, [deviceId])

  useEffect(() => { fetchBackups() }, [fetchBackups])

  // Filtered backups based on filter tab
  const filteredBackups = useMemo(() => {
    if (filterTab === 'all') return backups
    return backups.filter(b => b.config_format === filterTab)
  }, [backups, filterTab])

  // Filter counts
  const filterCounts = useMemo(() => ({
    all: backups.length,
    cli: backups.filter(b => b.config_format === 'cli').length,
    structured: backups.filter(b => b.config_format === 'structured').length,
  }), [backups])

  // Keyboard shortcuts
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault()
        setSearchVisible(true)
        setTimeout(() => searchInputRef.current?.focus(), 50)
      }
      if (e.key === 'Escape' && searchVisible) {
        setSearchVisible(false)
        setSearchQuery('')
      }
      // Enter cycles through matches
      if (e.key === 'Enter' && searchVisible && searchMatches.size > 0) {
        e.preventDefault()
        const matchArray = Array.from(searchMatches)
        const nextIdx = (currentMatchIdx + (e.shiftKey ? -1 : 1) + matchArray.length) % matchArray.length
        setCurrentMatchIdx(nextIdx)
        // Scroll to match
        const lineEl = configViewRef.current?.querySelector(`[data-line="${matchArray[nextIdx]}"]`)
        lineEl?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [searchVisible, currentMatchIdx])

  const handleSelectBackup = async (backup: BackupEntry) => {
    setSelectedVersion(backup.version)
    setViewMode('config')
    setDiffResult(null)

    // If we have cached config text, use it
    const cached = backupConfigsRef.current.get(backup.version)
    if (cached) {
      setSelectedConfig({
        ...backup,
        config_text: cached,
        line_count: cached.split('\n').length,
        size_bytes: new Blob([cached]).size,
      })
      return
    }

    setLoadingConfig(true)
    try {
      const full = await getDeviceConfigVersion(deviceId, backup.version)
      const entry = toBackupEntryFull(full)
      setSelectedConfig(entry)
      if (full.config_text) backupConfigsRef.current.set(backup.version, full.config_text)
    } catch {
      setSelectedConfig(null)
    } finally {
      setLoadingConfig(false)
    }
  }

  const handleToggleCompare = (version: number) => {
    setCompareVersions(prev => {
      const next = new Set(prev)
      if (next.has(version)) {
        next.delete(version)
      } else {
        if (next.size >= 2) {
          const first = next.values().next().value
          if (first !== undefined) next.delete(first)
        }
        next.add(version)
      }
      return next
    })
  }

  const handleCompare = async () => {
    const versions = Array.from(compareVersions)
    if (versions.length !== 2) return

    const b1 = backups.find(b => b.version === versions[0])
    const b2 = backups.find(b => b.version === versions[1])
    if (!b1 || !b2) return

    const [oldVersion, newVersion] = new Date(b1.created_at) < new Date(b2.created_at)
      ? [b1.version, b2.version] : [b2.version, b1.version]

    setLoadingDiff(true)
    setViewMode('diff')
    try {
      const result = await diffConfigVersions(deviceId, oldVersion, newVersion)
      setDiffResult(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Diff failed')
      setViewMode('config')
    } finally {
      setLoadingDiff(false)
    }
  }

  const handleCollect = async () => {
    setCollecting(true)
    setCollectMessage(null)
    setError(null)
    try {
      await pullDeviceConfig(deviceId)
      setCollectMessage('Config pulled successfully (CLI + Structured)')
      setTimeout(() => setCollectMessage(null), 3000)
      await fetchBackups()
    } catch (err) {
      const axiosMsg = (err as { response?: { data?: string } })?.response?.data
      setError(typeof axiosMsg === 'string' ? axiosMsg : (err instanceof Error ? err.message : 'Collection failed'))
    } finally {
      setCollecting(false)
    }
  }

  // Timeline search: find a config element across all backups
  const handleTimelineSearch = async () => {
    if (!timelineQuery.trim()) return
    setLoadingTimeline(true)
    setViewMode('timeline')

    const q = timelineQuery.toLowerCase()
    const results: SearchTimelineEntry[] = []

    // Load all backup configs we don't have cached
    for (const backup of filteredBackups) {
      if (!backupConfigsRef.current.has(backup.version)) {
        try {
          const full = await getDeviceConfigVersion(deviceId, backup.version)
          if (full.config_text) backupConfigsRef.current.set(backup.version, full.config_text)
        } catch {
          // skip
        }
      }

      const config = backupConfigsRef.current.get(backup.version) || ''
      const matchingLines = config.split('\n').filter(line =>
        line.toLowerCase().includes(q)
      )

      results.push({
        version: backup.version,
        date: backup.created_at,
        matchingLines,
        present: matchingLines.length > 0,
      })
    }

    setTimelineResults(results)
    setLoadingTimeline(false)
  }

  const handleCopy = async () => {
    if (!selectedConfig?.config_text) return
    try {
      await navigator.clipboard.writeText(selectedConfig.config_text)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = selectedConfig.config_text
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  // Config lines and search matches
  const configLines = useMemo(() => {
    if (!selectedConfig?.config_text) return []
    return selectedConfig.config_text.split('\n')
  }, [selectedConfig])

  const searchMatches = useMemo(() => {
    if (!searchQuery || !configLines.length) return new Set<number>()
    const q = searchQuery.toLowerCase()
    const matches = new Set<number>()
    configLines.forEach((line, i) => {
      if (line.toLowerCase().includes(q)) matches.add(i)
    })
    return matches
  }, [searchQuery, configLines])

  // Close AI context menu on click outside
  useEffect(() => {
    if (!aiContextMenu) return
    const handleClick = () => setAiContextMenu(null)
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [aiContextMenu])

  const handleConfigContextMenu = useCallback((e: React.MouseEvent) => {
    const selection = window.getSelection()?.toString()?.trim()
    if (!selection || !onAskAI) return
    e.preventDefault()
    e.stopPropagation()
    // Position menu within viewport
    const x = Math.min(e.clientX, window.innerWidth - 240)
    const y = Math.min(e.clientY, window.innerHeight - 250)
    setAiContextMenu({ x, y, selectedText: selection })
  }, [onAskAI])

  const askAIAboutSelection = (action: string) => {
    if (!aiContextMenu || !onAskAI) return
    const text = aiContextMenu.selectedText
    const backupDate = selectedConfig ? new Date(selectedConfig.created_at).toLocaleString() : 'unknown'

    let question = ''
    switch (action) {
      case 'when_changed':
        question = `When did this config change on device "${deviceName}" (${deviceId})? Search config backups for: ${text}`
        break
      case 'explain':
        question = `Explain this configuration from device "${deviceName}": ${text}`
        break
      case 'investigate':
        question = `Investigate this config element on device "${deviceName}" (${deviceId}). Was there a MOP? Check audit logs. Config element: ${text}`
        break
      case 'impact':
        question = `What is the impact of this configuration on device "${deviceName}"? What does it do and what depends on it? Config: ${text}`
        break
      default:
        question = `About device "${deviceName}" config (backup from ${backupDate}): ${text}`
    }

    onAskAI(question, `Device: ${deviceName}\nDevice ID: ${deviceId}\nBackup: ${backupDate}\nSelected config:\n${text}`)
    setAiContextMenu(null)
  }

  // Auto-scroll to first match when search changes
  useEffect(() => {
    if (searchMatches.size > 0) {
      setCurrentMatchIdx(0)
      const firstMatch = Array.from(searchMatches)[0]
      const lineEl = configViewRef.current?.querySelector(`[data-line="${firstMatch}"]`)
      lineEl?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
  }, [searchQuery])

  const formatDate = (iso: string) => {
    const d = new Date(iso)
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString()
  }

  const formatDateShort = (iso: string) => {
    const d = new Date(iso)
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  const highlightText = (text: string, query: string) => {
    if (!query) return text
    const idx = text.toLowerCase().indexOf(query.toLowerCase())
    if (idx === -1) return text
    return (
      <>
        {text.substring(0, idx)}
        <mark className="config-search-match">{text.substring(idx, idx + query.length)}</mark>
        {text.substring(idx + query.length)}
      </>
    )
  }

  if (loading && backups.length === 0) {
    return <div className="backup-history-tab"><div className="backup-loading">Loading config backups...</div></div>
  }

  return (
    <div className="backup-history-tab">
      {/* Left sidebar */}
      <div className="backup-sidebar">
        <div className="backup-sidebar-header">
          <div className="backup-sidebar-title">
            <span>Config Backups</span>
            <span className="backup-count">{filteredBackups.length}</span>
          </div>
          <div className="backup-sidebar-actions">
            <button
              className="backup-btn backup-btn-collect"
              onClick={handleCollect}
              disabled={collecting}
              title="Pull running config from device (CLI + Structured)"
            >
              {collecting ? 'Pulling...' : 'Pull New'}
            </button>
            {compareVersions.size === 2 && (
              <button className="backup-btn backup-btn-compare" onClick={handleCompare} disabled={loadingDiff}>
                Compare
              </button>
            )}
            <button className="backup-btn backup-btn-refresh" onClick={fetchBackups} disabled={loading}>
              Refresh
            </button>
          </div>
        </div>

        {/* Filter tabs */}
        <div className="backup-filter-tabs">
          <button
            className={`backup-filter-tab ${filterTab === 'all' ? 'active' : ''}`}
            onClick={() => setFilterTab('all')}
          >
            All <span className="backup-filter-count">({filterCounts.all})</span>
          </button>
          <button
            className={`backup-filter-tab ${filterTab === 'cli' ? 'active' : ''}`}
            onClick={() => setFilterTab('cli')}
          >
            CLI <span className="backup-filter-count">({filterCounts.cli})</span>
          </button>
          <button
            className={`backup-filter-tab ${filterTab === 'structured' ? 'active' : ''}`}
            onClick={() => setFilterTab('structured')}
          >
            Structured <span className="backup-filter-count">({filterCounts.structured})</span>
          </button>
        </div>

        {/* Timeline search — search across ALL backups */}
        <div className="backup-timeline-search">
          <input
            type="text"
            className="backup-timeline-input"
            placeholder="Track config element across backups..."
            value={timelineQuery}
            onChange={(e) => setTimelineQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleTimelineSearch() }}
          />
          <button
            className="backup-btn"
            onClick={handleTimelineSearch}
            disabled={loadingTimeline || !timelineQuery.trim()}
            title="Find when this config was added, changed, or removed"
          >
            Track
          </button>
        </div>

        {collectMessage && <div className="backup-collect-success">{collectMessage}</div>}
        {error && <div className="backup-collect-error">{error}</div>}

        <div className="backup-list">
          {filteredBackups.length === 0 ? (
            <div className="backup-empty">
              <div>No config backups yet</div>
              <div className="backup-empty-hint">Click "Pull New" to collect a live config from {deviceName}</div>
            </div>
          ) : (
            filteredBackups.map((backup, idx) => {
              // Timeline indicator
              const timelineEntry = timelineResults.find(t => t.version === backup.version)
              return (
                <div
                  key={backup.id}
                  className={`backup-list-item ${selectedVersion === backup.version ? 'selected' : ''} ${timelineEntry && !timelineEntry.present ? 'backup-item-absent' : ''}`}
                  onClick={() => handleSelectBackup(backup)}
                >
                  <div className="backup-item-check">
                    <input
                      type="checkbox"
                      checked={compareVersions.has(backup.version)}
                      onChange={(e) => { e.stopPropagation(); handleToggleCompare(backup.version) }}
                    />
                  </div>
                  <div className="backup-item-info">
                    <div className="backup-item-date">
                      {formatDate(backup.created_at)}
                      {idx === 0 && <span className="backup-badge-latest">Latest</span>}
                      <span className="backup-badge-format">{backup.config_format}</span>
                      {timelineEntry && (
                        <span className={`backup-badge-timeline ${timelineEntry.present ? 'present' : 'absent'}`}>
                          {timelineEntry.present ? `${timelineEntry.matchingLines.length} hits` : 'not found'}
                        </span>
                      )}
                    </div>
                    <div className="backup-item-meta">
                      {backup.line_count > 0 && <span>{backup.line_count} lines</span>}
                      {backup.size_bytes > 0 && <span>{formatSize(backup.size_bytes)}</span>}
                      <span>{backup.pulled_via || 'manual'}</span>
                      <span>v{backup.version}</span>
                    </div>
                    <div className="backup-item-hash" title={backup.config_hash}>
                      {backup.config_hash?.substring(0, 12)}
                    </div>
                  </div>
                </div>
              )
            })
          )}
        </div>

        {compareVersions.size > 0 && (
          <div className="backup-sidebar-footer">
            {compareVersions.size}/2 selected for compare
          </div>
        )}
      </div>

      {/* Right content */}
      <div className="backup-content">
        {/* Timeline view */}
        {viewMode === 'timeline' && timelineResults.length > 0 ? (
          <>
            <div className="backup-content-header">
              <div className="backup-content-title">
                Config Timeline: "{timelineQuery}"
              </div>
              <div className="backup-content-meta">
                <span>{timelineResults.filter(t => t.present).length}/{timelineResults.length} backups contain this</span>
              </div>
              <button className="backup-btn" onClick={() => setViewMode('config')}>
                Close Timeline
              </button>
            </div>
            <div className="backup-timeline-view">
              {timelineResults.map((entry, idx) => {
                const prevEntry = idx < timelineResults.length - 1 ? timelineResults[idx + 1] : null
                const changed = prevEntry && prevEntry.present !== entry.present
                const added = changed && entry.present
                const removed = changed && !entry.present

                return (
                  <div key={entry.version} className={`timeline-entry ${entry.present ? 'timeline-present' : 'timeline-absent'} ${changed ? 'timeline-changed' : ''}`}>
                    <div className="timeline-dot-col">
                      <div className={`timeline-dot ${entry.present ? 'dot-present' : 'dot-absent'} ${changed ? 'dot-changed' : ''}`} />
                      {idx < timelineResults.length - 1 && <div className="timeline-line" />}
                    </div>
                    <div className="timeline-content">
                      <div className="timeline-header">
                        <span className="timeline-date">{formatDateShort(entry.date)}</span>
                        {added && <span className="timeline-badge timeline-badge-added">ADDED</span>}
                        {removed && <span className="timeline-badge timeline-badge-removed">REMOVED</span>}
                        {idx === 0 && <span className="backup-badge-latest">Latest</span>}
                      </div>
                      {entry.present && entry.matchingLines.length > 0 && (
                        <div className="timeline-lines">
                          {entry.matchingLines.slice(0, 5).map((line, li) => (
                            <div key={li} className="timeline-line-text">
                              {highlightText(line.trim(), timelineQuery)}
                            </div>
                          ))}
                          {entry.matchingLines.length > 5 && (
                            <div className="timeline-line-more">
                              +{entry.matchingLines.length - 5} more lines
                            </div>
                          )}
                        </div>
                      )}
                      {!entry.present && (
                        <div className="timeline-not-found">Not present in this backup</div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        ) : viewMode === 'diff' && diffResult ? (
          <>
            <div className="backup-content-header">
              <div className="backup-content-title">Config Diff</div>
              <div className="backup-diff-stats">
                <span className="diff-stat-add">+{diffResult.additions ?? 0}</span>
                <span className="diff-stat-del">-{diffResult.deletions ?? 0}</span>
              </div>
              <button className="backup-btn" onClick={() => setViewMode('config')}>
                Close Diff
              </button>
            </div>
            <div className="backup-diff-view">
              {loadingDiff ? (
                <div className="backup-loading">Generating diff...</div>
              ) : diffResult.diff ? (
                <pre className="backup-diff-text">
                  {diffResult.diff.split('\n').map((line, i) => {
                    let cls = 'diff-line'
                    if (line.startsWith('+') && !line.startsWith('+++')) cls += ' diff-add'
                    else if (line.startsWith('-') && !line.startsWith('---')) cls += ' diff-del'
                    else if (line.startsWith('@@')) cls += ' diff-hunk'
                    return <div key={i} className={cls}>{line}</div>
                  })}
                </pre>
              ) : (
                <div className="backup-loading">No differences — configs are identical</div>
              )}
            </div>
          </>
        ) : selectedConfig ? (
          <>
            <div className="backup-content-header">
              <div className="backup-content-title">
                {deviceName} — {formatDate(selectedConfig.created_at)}
              </div>
              <div className="backup-content-meta">
                <span>{selectedConfig.line_count} lines</span>
                <span>{formatSize(selectedConfig.size_bytes)}</span>
              </div>
              <div className="backup-content-actions">
                <button
                  className={`backup-btn ${searchVisible ? 'backup-btn-active' : ''}`}
                  onClick={() => {
                    setSearchVisible(v => !v)
                    if (searchVisible) setSearchQuery('')
                    else setTimeout(() => searchInputRef.current?.focus(), 50)
                  }}
                  title="Search config (Ctrl+F)"
                >
                  Search
                </button>
                <button className="backup-btn" onClick={handleCopy}>
                  {copied ? 'Copied!' : 'Copy'}
                </button>
              </div>
            </div>

            {searchVisible && (
              <div className="backup-search-bar">
                <input
                  ref={searchInputRef}
                  type="text"
                  className="backup-search-input"
                  placeholder="Search config... (Enter = next, Shift+Enter = prev)"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
                {searchQuery && (
                  <span className="backup-search-count">
                    {searchMatches.size > 0
                      ? `${currentMatchIdx + 1}/${searchMatches.size}`
                      : 'No matches'}
                  </span>
                )}
                <button className="backup-search-close" onClick={() => { setSearchVisible(false); setSearchQuery('') }}>
                  &times;
                </button>
              </div>
            )}

            <div className="backup-config-view" ref={configViewRef} onContextMenu={handleConfigContextMenu}>
              {loadingConfig ? (
                <div className="backup-loading">Loading config...</div>
              ) : (
                <pre className="backup-config-text" onContextMenu={handleConfigContextMenu}>
                  {configLines.map((line, i) => {
                    const isMatch = searchMatches.has(i)
                    const isCurrentMatch = isMatch && Array.from(searchMatches).indexOf(i) === currentMatchIdx
                    return (
                      <div
                        key={i}
                        data-line={i}
                        className={`config-line ${isMatch ? 'config-line-match' : ''} ${isCurrentMatch ? 'config-line-current' : ''}`}
                      >
                        <span className="config-line-num">{i + 1}</span>
                        <span className="config-line-text">
                          {isMatch ? highlightText(line, searchQuery) : line}
                        </span>
                      </div>
                    )
                  })}
                </pre>
              )}
            </div>
          </>
        ) : (
          <div className="backup-content-empty">
            {backups.length === 0
              ? `Click "Pull New" to collect a live config from ${deviceName}`
              : 'Select a backup to view its configuration'}
          </div>
        )}

        {/* AI context menu (right-click on selected text) */}
        {aiContextMenu && onAskAI && (
          <div
            className="backup-ai-context-menu"
            style={{ left: aiContextMenu.x, top: aiContextMenu.y }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="backup-ai-menu-header">AI Analysis</div>
            <button className="backup-ai-menu-item" onClick={() => askAIAboutSelection('when_changed')}>
              When did this change?
            </button>
            <button className="backup-ai-menu-item" onClick={() => askAIAboutSelection('investigate')}>
              Investigate change (MOP, audit)
            </button>
            <button className="backup-ai-menu-item" onClick={() => askAIAboutSelection('explain')}>
              Explain this config
            </button>
            <button className="backup-ai-menu-item" onClick={() => askAIAboutSelection('impact')}>
              Impact analysis
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
