import { useState, useEffect, useCallback } from 'react';
import './NetBoxImportDialog.css';
import {
  checkNetBoxConnection,
  fetchSites,
  fetchRoles,
  importDevicesAsSessions,
  type NetBoxSite,
  type NetBoxRole,
  type SessionImportResult,
  type ImportSourceConfig,
} from '../api/netbox';
import type { NetBoxConfig } from '../types/topology';
import { createSession, createFolder, listFolders, listSessions } from '../api/sessions';
import {
  listNetBoxSources,
  getNetBoxToken,
  markSyncComplete,
  type NetBoxSource,
  type DeviceFilters,
} from '../api/netboxSources';
import { listProfiles, type CredentialProfile } from '../api/profiles';

// Helper to format device filters for display
function formatDeviceFilters(filters: DeviceFilters): string {
  const parts: string[] = [];
  if (filters.sites?.length) parts.push(`Sites: ${filters.sites.join(', ')}`);
  if (filters.roles?.length) parts.push(`Roles: ${filters.roles.join(', ')}`);
  if (filters.manufacturers?.length) parts.push(`Vendors: ${filters.manufacturers.join(', ')}`);
  if (filters.platforms?.length) parts.push(`Platforms: ${filters.platforms.join(', ')}`);
  if (filters.statuses?.length) parts.push(`Statuses: ${filters.statuses.join(', ')}`);
  if (filters.tags?.length) parts.push(`Tags: ${filters.tags.join(', ')}`);
  return parts.length > 0 ? parts.join(' | ') : 'No filters';
}

// Helper to check if device filters are set
function hasDeviceFilters(filters: DeviceFilters | null | undefined): boolean {
  if (!filters) return false;
  return !!(
    filters.sites?.length || filters.roles?.length || filters.manufacturers?.length ||
    filters.platforms?.length || filters.statuses?.length || filters.tags?.length
  );
}

interface NetBoxImportDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onImportComplete: () => void;
  preSelectedSourceId?: string; // Optional: pre-select a source when opened from Integrations tab
}

type Step = 'source' | 'filter' | 'import';
type SourceMode = 'saved' | 'manual';

// Icons for the dialog
const Icons = {
  close: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  ),
  check: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  ),
  cloud: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M18 10h-1.26A8 8 0 109 20h9a5 5 0 000-10z" />
    </svg>
  ),
  download: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  ),
};

function NetBoxImportDialog({
  isOpen,
  onClose,
  onImportComplete,
  preSelectedSourceId,
}: NetBoxImportDialogProps) {
  // Source selection state
  const [sourceMode, setSourceMode] = useState<SourceMode>('saved');
  const [sources, setSources] = useState<NetBoxSource[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState<string>('');
  const [profiles, setProfiles] = useState<CredentialProfile[]>([]);

  // Form state (for manual mode)
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [selectedSite, setSelectedSite] = useState<string>('');
  const [selectedRole, setSelectedRole] = useState<string>('');
  const [manualProfileId, setManualProfileId] = useState('');

  // UI state
  const [step, setStep] = useState<Step>('source');
  const [isLoading, setIsLoading] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Data state
  const [sites, setSites] = useState<NetBoxSite[]>([]);
  const [roles, setRoles] = useState<NetBoxRole[]>([]);
  const [importResult, setImportResult] = useState<SessionImportResult | null>(null);

  // Get selected source object
  const selectedSource = sources.find(s => s.id === selectedSourceId);

  // Reset state when dialog opens
  useEffect(() => {
    if (isOpen) {
      setStep('source');
      setIsConnected(false);
      setError(null);
      setSites([]);
      setRoles([]);
      setImportResult(null);
      setSelectedSourceId('');
      // Load sources and profiles
      loadSourcesAndProfiles();
    }
  }, [isOpen]);

  // Load available sources and profiles
  const loadSourcesAndProfiles = async () => {
    try {
      const [sourcesData, profilesData] = await Promise.all([
        listNetBoxSources(),
        listProfiles(),
      ]);
      setSources(sourcesData);
      setProfiles(profilesData);
      // Use preSelectedSourceId if provided, otherwise auto-select first source
      if (preSelectedSourceId && sourcesData.some(s => s.id === preSelectedSourceId)) {
        setSelectedSourceId(preSelectedSourceId);
      } else if (sourcesData.length > 0) {
        setSelectedSourceId(sourcesData[0].id);
      }
    } catch (err) {
      console.error('Failed to load sources:', err);
    }
  };

  // Handle escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Get NetBox config from form values or selected source
  const getConfig = useCallback(async (): Promise<NetBoxConfig | null> => {
    if (sourceMode === 'manual') {
      return {
        url: url.trim(),
        token: token.trim(),
      };
    } else if (selectedSource) {
      try {
        const sourceToken = await getNetBoxToken(selectedSource.id);
        if (!sourceToken) {
          setError('Failed to retrieve API token. Please unlock the vault first.');
          return null;
        }
        return {
          url: selectedSource.url,
          token: sourceToken,
        };
      } catch (err) {
        setError('Failed to retrieve API token. Please unlock the vault first.');
        return null;
      }
    }
    return null;
  }, [sourceMode, url, token, selectedSource]);

  // Test connection handler
  const handleTestConnection = async () => {
    if (sourceMode === 'manual' && (!url.trim() || !token.trim())) {
      setError('Please enter NetBox URL and API token');
      return;
    }

    if (sourceMode === 'saved' && !selectedSourceId) {
      setError('Please select a NetBox source');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const config = await getConfig();
      if (!config) {
        setIsLoading(false);
        return;
      }

      const connected = await checkNetBoxConnection(config);

      if (connected) {
        setIsConnected(true);
        // Load sites and roles
        const [sitesData, rolesData] = await Promise.all([
          fetchSites(config),
          fetchRoles(config),
        ]);
        setSites(sitesData);
        setRoles(rolesData);
        setStep('filter');
      } else {
        setError('Connection failed. Check URL and API token.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed');
    } finally {
      setIsLoading(false);
    }
  };

  // Get profile name by ID
  const getProfileName = (profileId: string | null): string => {
    if (!profileId) return '-';
    const profile = profiles.find(p => p.id === profileId);
    return profile?.name ?? 'Unknown';
  };

  // Import devices handler
  const handleImport = async () => {
    // Require a profile for all imports
    const profileId = sourceMode === 'saved'
      ? selectedSource?.default_profile_id
      : manualProfileId;

    if (!profileId) {
      if (sourceMode === 'saved') {
        setError('No default profile configured. Configure a profile in Settings → Integrations → NetBox Sources.');
      } else {
        setError('Please select a credential profile');
      }
      return;
    }

    setIsLoading(true);
    setError(null);
    setStep('import');

    try {
      const config = await getConfig();
      if (!config) {
        setIsLoading(false);
        return;
      }

      // Build source config for profile resolution
      // For saved sources, use the source's profile configuration
      // For manual mode, create a simple config with the selected profile
      const sourceConfig: ImportSourceConfig = selectedSource
        ? {
            sourceId: selectedSource.id,
            defaultProfileId: selectedSource.default_profile_id,
            profileMappings: selectedSource.profile_mappings,
          }
        : {
            sourceId: 'manual-import',
            defaultProfileId: manualProfileId,
            profileMappings: { by_site: {}, by_role: {} },
          };

      // Build filters - use saved device_filters if available, otherwise use manual selection
      const filters = hasDeviceFilters(selectedSource?.device_filters)
        ? {
            // Use saved device filters from source
            sites: selectedSource?.device_filters?.sites,
            roles: selectedSource?.device_filters?.roles,
            manufacturers: selectedSource?.device_filters?.manufacturers,
            platforms: selectedSource?.device_filters?.platforms,
            statuses: selectedSource?.device_filters?.statuses,
            tags: selectedSource?.device_filters?.tags,
          }
        : {
            // Use manual site/role selection (legacy/manual mode)
            site: selectedSite || undefined,
            role: selectedRole || undefined,
          };

      const result = await importDevicesAsSessions(
        config,
        filters,
        createSession,
        createFolder,
        listFolders,
        sourceConfig,
        listSessions, // Pass listSessions for duplicate detection
      );

      setImportResult(result);

      // Mark sync complete if using a saved source
      if (selectedSource) {
        try {
          // Convert multi-value filters to single-value for sync metadata
          const deviceFilters = selectedSource?.device_filters;
          const syncFilters = hasDeviceFilters(deviceFilters)
            ? {
                site: deviceFilters?.sites?.[0],
                role: deviceFilters?.roles?.[0],
              }
            : {
                site: selectedSite || undefined,
                role: selectedRole || undefined,
              };
          await markSyncComplete(selectedSource.id, {
            filters: syncFilters,
            result: {
              sessions_created: result.sessions_created,
              sessions_updated: 0, // Not tracking updates yet
              skipped: result.skipped,
            },
          });
        } catch (err) {
          console.error('Failed to update sync metadata:', err);
        }
      }

      if (result.sessions_created > 0) {
        // Notify parent to refresh
        onImportComplete();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setIsLoading(false);
    }
  };

  // Reset and import more
  const handleImportMore = () => {
    setStep('filter');
    setImportResult(null);
    setError(null);
  };

  if (!isOpen) return null;

  return (
    <div className="netbox-dialog-overlay" onClick={onClose}>
      <div className="netbox-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="netbox-dialog-header">
          <h2>
            {Icons.cloud}
            <span>Import from NetBox</span>
          </h2>
          <button className="netbox-dialog-close" onClick={onClose} title="Close">
            {Icons.close}
          </button>
        </div>

        {/* Step indicator */}
        <div className="netbox-steps">
          <div className={`netbox-step ${step === 'source' ? 'active' : ''} ${isConnected ? 'complete' : ''}`}>
            <span className="step-number">{isConnected ? Icons.check : '1'}</span>
            <span className="step-label">Source</span>
          </div>
          <div className="step-divider" />
          <div className={`netbox-step ${step === 'filter' ? 'active' : ''} ${importResult ? 'complete' : ''}`}>
            <span className="step-number">{importResult ? Icons.check : '2'}</span>
            <span className="step-label">Filter</span>
          </div>
          <div className="step-divider" />
          <div className={`netbox-step ${step === 'import' ? 'active' : ''}`}>
            <span className="step-number">3</span>
            <span className="step-label">Import</span>
          </div>
        </div>

        <div className="netbox-dialog-content">
          {/* Step 1: Select Source */}
          {step === 'source' && (
            <div className="netbox-form">
              {/* Source mode toggle */}
              <div className="netbox-source-mode">
                <label>
                  <input
                    type="radio"
                    name="sourceMode"
                    value="saved"
                    checked={sourceMode === 'saved'}
                    onChange={() => setSourceMode('saved')}
                    disabled={isLoading}
                  />
                  <span>Use Saved Source</span>
                </label>
                <label>
                  <input
                    type="radio"
                    name="sourceMode"
                    value="manual"
                    checked={sourceMode === 'manual'}
                    onChange={() => setSourceMode('manual')}
                    disabled={isLoading}
                  />
                  <span>Enter Manually</span>
                </label>
              </div>

              {sourceMode === 'saved' && (
                <>
                  <div className="netbox-field">
                    <label htmlFor="netbox-source">NetBox Source</label>
                    <select
                      id="netbox-source"
                      value={selectedSourceId}
                      onChange={(e) => setSelectedSourceId(e.target.value)}
                      disabled={isLoading || sources.length === 0}
                    >
                      {sources.length === 0 && (
                        <option value="">No sources configured</option>
                      )}
                      {sources.map(source => (
                        <option key={source.id} value={source.id}>
                          {source.name} ({source.url})
                        </option>
                      ))}
                    </select>
                    {sources.length === 0 && (
                      <span className="netbox-hint">
                        Configure sources in Settings - Integrations
                      </span>
                    )}
                  </div>

                  {selectedSource && (
                    <div className="netbox-source-info">
                      <div className="source-info-row">
                        <span className="info-label">Default Profile:</span>
                        <span className="info-value">
                          {getProfileName(selectedSource.default_profile_id)}
                        </span>
                      </div>
                      {Object.keys(selectedSource.profile_mappings.by_role).length > 0 && (
                        <div className="source-info-row">
                          <span className="info-label">Role Mappings:</span>
                          <span className="info-value">
                            {Object.entries(selectedSource.profile_mappings.by_role)
                              .map(([role, profileId]) => `${role}: ${getProfileName(profileId)}`)
                              .join(', ')}
                          </span>
                        </div>
                      )}
                      {Object.keys(selectedSource.profile_mappings.by_site).length > 0 && (
                        <div className="source-info-row">
                          <span className="info-label">Site Mappings:</span>
                          <span className="info-value">
                            {Object.entries(selectedSource.profile_mappings.by_site)
                              .map(([site, profileId]) => `${site}: ${getProfileName(profileId)}`)
                              .join(', ')}
                          </span>
                        </div>
                      )}
                      {selectedSource.device_filters && (
                        <div className="source-info-row">
                          <span className="info-label">Device Filters:</span>
                          <span className="info-value">
                            {formatDeviceFilters(selectedSource.device_filters)}
                          </span>
                        </div>
                      )}
                      {selectedSource.last_sync_at && (
                        <div className="source-info-row">
                          <span className="info-label">Last Sync:</span>
                          <span className="info-value">
                            {new Date(selectedSource.last_sync_at).toLocaleString()}
                          </span>
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}

              {sourceMode === 'manual' && (
                <>
                  <div className="netbox-field">
                    <label htmlFor="netbox-url">NetBox URL</label>
                    <input
                      id="netbox-url"
                      type="url"
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                      placeholder="https://netbox.example.com"
                      disabled={isLoading}
                    />
                  </div>
                  <div className="netbox-field">
                    <label htmlFor="netbox-token">API Token</label>
                    <input
                      id="netbox-token"
                      type="password"
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                      placeholder="Enter your NetBox API token"
                      disabled={isLoading}
                    />
                    <span className="netbox-hint">
                      Generate a token in NetBox: Admin - API Tokens
                    </span>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Step 2: Filter */}
          {step === 'filter' && (
            <div className="netbox-form">
              <div className="netbox-connection-status">
                <span className="status-icon success">{Icons.check}</span>
                <span>Connected to {sourceMode === 'saved' && selectedSource ? selectedSource.name : url}</span>
              </div>

              {/* Show saved device filters if present */}
              {sourceMode === 'saved' && hasDeviceFilters(selectedSource?.device_filters) && (
                <div className="netbox-saved-filters">
                  <label>Device Filters (from source settings)</label>
                  <div className="saved-filters-display">
                    {formatDeviceFilters(selectedSource!.device_filters!)}
                  </div>
                  <span className="netbox-hint">
                    Edit filters in Settings → Integrations → NetBox Sources
                  </span>
                </div>
              )}

              {/* Show manual filter options only when no saved filters */}
              {!(sourceMode === 'saved' && hasDeviceFilters(selectedSource?.device_filters)) && (
                <>
                  <div className="netbox-field">
                    <label htmlFor="netbox-site">Site (optional)</label>
                    <select
                      id="netbox-site"
                      value={selectedSite}
                      onChange={(e) => setSelectedSite(e.target.value)}
                      disabled={isLoading}
                    >
                      <option value="">All Sites</option>
                      {sites.map(site => (
                        <option key={site.id} value={site.slug}>{site.name}</option>
                      ))}
                    </select>
                  </div>

                  <div className="netbox-field">
                    <label htmlFor="netbox-role">Device Role (optional)</label>
                    <select
                      id="netbox-role"
                      value={selectedRole}
                      onChange={(e) => setSelectedRole(e.target.value)}
                      disabled={isLoading}
                    >
                      <option value="">All Roles</option>
                      {roles.map(role => (
                        <option key={role.id} value={role.slug}>{role.name}</option>
                      ))}
                    </select>
                  </div>
                </>
              )}

              {/* Profile selector for manual mode */}
              {sourceMode === 'manual' && (
                <div className="netbox-field">
                  <label htmlFor="netbox-profile">Credential Profile <span className="required-marker">*</span></label>
                  {profiles.length === 0 ? (
                    <div className="profile-warning">
                      <span>No credential profiles configured.</span>
                      <span className="netbox-hint">Create a profile in Settings → Profiles first.</span>
                    </div>
                  ) : (
                    <>
                      <select
                        id="netbox-profile"
                        value={manualProfileId}
                        onChange={(e) => setManualProfileId(e.target.value)}
                        disabled={isLoading}
                      >
                        <option value="">Select a profile...</option>
                        {profiles.map(profile => (
                          <option key={profile.id} value={profile.id}>
                            {profile.name} ({profile.username})
                          </option>
                        ))}
                      </select>
                      <span className="netbox-hint">
                        All imported sessions will use this profile for authentication
                      </span>
                    </>
                  )}
                </div>
              )}

              {/* Profile mapping info for saved source */}
              {sourceMode === 'saved' && (
                <div className="netbox-profile-info">
                  <span className="profile-info-label">Profile Assignment:</span>
                  {selectedSource?.default_profile_id ? (
                    <span className="profile-info-text">
                      Sessions will be assigned profiles based on the source&apos;s role and site mappings.
                      Default: <strong>{getProfileName(selectedSource.default_profile_id)}</strong>
                    </span>
                  ) : (
                    <span className="profile-info-text" style={{ color: 'var(--color-warning)' }}>
                      No default profile configured. Please configure a profile in Settings → Integrations → NetBox Sources.
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Step 3: Import Results */}
          {step === 'import' && (
            <div className="netbox-results">
              {isLoading && (
                <div className="netbox-loading">
                  <div className="netbox-spinner" />
                  <span>Importing devices from NetBox...</span>
                </div>
              )}

              {importResult && (
                <div className="netbox-import-result">
                  <div className="result-summary">
                    <div className="result-stat success">
                      <span className="stat-value">{importResult.sessions_created}</span>
                      <span className="stat-label">Sessions Created</span>
                    </div>
                    <div className="result-stat info">
                      <span className="stat-value">{importResult.folders_created}</span>
                      <span className="stat-label">Folders Created</span>
                    </div>
                    <div className="result-stat warning">
                      <span className="stat-value">{importResult.skipped}</span>
                      <span className="stat-label">Skipped (No IP)</span>
                    </div>
                  </div>

                  {importResult.warnings.length > 0 && (
                    <div className="result-warnings">
                      <label>Warnings:</label>
                      <ul>
                        {importResult.warnings.slice(0, 10).map((warning, i) => (
                          <li key={i}>{warning}</li>
                        ))}
                        {importResult.warnings.length > 10 && (
                          <li className="more-warnings">
                            +{importResult.warnings.length - 10} more warnings...
                          </li>
                        )}
                      </ul>
                    </div>
                  )}

                  {importResult.sessions_created === 0 && importResult.skipped > 0 && (
                    <div className="result-note">
                      No sessions were created because all devices lacked a primary IP address.
                      Assign management IPs in NetBox and try again.
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Error display */}
          {error && (
            <div className="netbox-error">
              {error}
              <button onClick={() => setError(null)}>Dismiss</button>
            </div>
          )}
        </div>

        <div className="netbox-dialog-actions">
          {step === 'source' && (
            <>
              <button className="btn-secondary" onClick={onClose}>
                Cancel
              </button>
              <button
                className="btn-primary"
                onClick={handleTestConnection}
                disabled={
                  isLoading ||
                  (sourceMode === 'manual' && (!url.trim() || !token.trim())) ||
                  (sourceMode === 'saved' && !selectedSourceId)
                }
              >
                {isLoading ? 'Testing...' : 'Test Connection'}
              </button>
            </>
          )}

          {step === 'filter' && (
            <>
              <button
                className="btn-secondary"
                onClick={() => {
                  setStep('source');
                  setIsConnected(false);
                }}
              >
                Back
              </button>
              <button
                className="btn-primary"
                onClick={handleImport}
                disabled={
                  isLoading ||
                  (sourceMode === 'saved' && !selectedSource?.default_profile_id) ||
                  (sourceMode === 'manual' && !manualProfileId)
                }
              >
                {Icons.download}
                <span>Import Devices</span>
              </button>
            </>
          )}

          {step === 'import' && importResult && (
            <>
              <button className="btn-secondary" onClick={handleImportMore}>
                Import More
              </button>
              <button className="btn-primary" onClick={onClose}>
                Done
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default NetBoxImportDialog;
