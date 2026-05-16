import { useState, useEffect } from 'react';
import { getClient } from '../api/client';
import {
  listNetBoxSources,
  deleteNetBoxSource,
  type NetBoxSource,
} from '../api/netboxSources';
import {
  listLibreNmsSources,
  createLibreNmsSource,
  deleteLibreNmsSource,
  testLibreNmsConnection,
  type LibreNmsSource,
} from '../api/librenms';
import {
  listNetdiscoSources,
  createNetdiscoSource,
  updateNetdiscoSource,
  deleteNetdiscoSource,
  testNetdiscoSource,
  type NetdiscoSource,
} from '../api/netdisco';
import NetBoxSourceDialog from './NetBoxSourceDialog';
import NetBoxImportDialog from './NetBoxImportDialog';
import SmtpSettingsSection from './SmtpSettingsSection';
import SecureCRTImportDialog from './SecureCRTImportDialog';
import { downloadFile } from '../lib/formatters';
import { showToast } from './Toast';
import { confirmDialog } from './ConfirmDialog';
import { useSubmitting } from '../hooks/useSubmitting';
import './IntegrationsTab.css';

// Icons
const Icons = {
  netbox: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="7" y1="8" x2="17" y2="8" />
      <line x1="7" y1="12" x2="17" y2="12" />
      <line x1="7" y1="16" x2="12" y2="16" />
    </svg>
  ),
  sync: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
    </svg>
  ),
  edit: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  ),
  trash: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
    </svg>
  ),
  plus: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  ),
  import: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  ),
  export: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  ),
};

export default function IntegrationsTab() {
  // NetBox state
  const [sources, setSources] = useState<NetBoxSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // NetBox dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingSource, setEditingSource] = useState<NetBoxSource | null>(null);

  // NetBox delete confirmation state
  const [deleteConfirm, setDeleteConfirm] = useState<NetBoxSource | null>(null);
  const [deleting, setDeleting] = useState(false);

  // NetBox import dialog state
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [syncSourceId, setSyncSourceId] = useState<string | undefined>(undefined);

  // SecureCRT import dialog state
  const [secureCRTDialogOpen, setSecureCRTDialogOpen] = useState(false);

  // LibreNMS state — add-only (backend has no PUT for librenms-sources yet)
  const [libreSources, setLibreSources] = useState<LibreNmsSource[]>([]);
  const [libreAddOpen, setLibreAddOpen] = useState(false);
  const [libreForm, setLibreForm] = useState({ name: '', url: '', token: '' });
  const libreSubmit = useSubmitting();

  // Netdisco state — full CRUD (backend supports PUT)
  const [netdiscoSources, setNetdiscoSources] = useState<NetdiscoSource[]>([]);
  const [netdiscoEditingId, setNetdiscoEditingId] = useState<string | 'new' | null>(null);
  const [netdiscoForm, setNetdiscoForm] = useState<{
    name: string;
    url: string;
    authType: 'basic' | 'api_key';
    username: string;
    credential: string;
  }>({ name: '', url: '', authType: 'api_key', username: '', credential: '' });
  const netdiscoSubmit = useSubmitting();

  // Fetch sources on mount
  useEffect(() => {
    fetchSources();
    fetchLibreSources();
    fetchNetdiscoSources();
  }, []);

  const fetchSources = async () => {
    try {
      setLoading(true);
      const data = await listNetBoxSources();
      setSources(data);
      setError(null);
    } catch (err) {
      setError('Failed to load NetBox sources');
      console.error('Failed to fetch NetBox sources:', err);
    } finally {
      setLoading(false);
    }
  };

  const fetchLibreSources = async () => {
    try {
      setLibreSources(await listLibreNmsSources());
    } catch (err) {
      console.error('Failed to fetch LibreNMS sources:', err);
    }
  };

  const fetchNetdiscoSources = async () => {
    try {
      setNetdiscoSources(await listNetdiscoSources());
    } catch (err) {
      console.error('Failed to fetch Netdisco sources:', err);
    }
  };

  // === LibreNMS handlers ===

  const handleLibreAdd = async () => {
    if (!libreForm.name.trim() || !libreForm.url.trim() || !libreForm.token.trim()) {
      showToast('Name, URL, and API token are required', 'warning');
      return;
    }
    await libreSubmit.run(async () => {
      try {
        await createLibreNmsSource(libreForm.name.trim(), libreForm.url.trim(), libreForm.token.trim());
        setLibreForm({ name: '', url: '', token: '' });
        setLibreAddOpen(false);
        await fetchLibreSources();
        showToast('LibreNMS source added', 'success');
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Failed to add LibreNMS source', 'error');
      }
    });
  };

  const handleLibreTest = async (s: LibreNmsSource) => {
    showToast(`Testing ${s.name}…`, 'info');
    try {
      const result = await testLibreNmsConnection(s.id);
      if (result.success) {
        showToast(`${s.name}: ${result.message}${result.version ? ` (v${result.version})` : ''}`, 'success');
      } else {
        showToast(`${s.name}: ${result.message}`, 'error');
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Test failed', 'error');
    }
  };

  const handleLibreDelete = async (s: LibreNmsSource) => {
    const ok = await confirmDialog({
      title: 'Delete LibreNMS source?',
      body: <>Remove <strong>{s.name}</strong>? Topologies already discovered through it stay intact.</>,
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    await libreSubmit.run(async () => {
      try {
        await deleteLibreNmsSource(s.id);
        await fetchLibreSources();
        showToast('LibreNMS source deleted', 'success');
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Delete failed', 'error');
      }
    });
  };

  // === Netdisco handlers ===

  const openNetdiscoAdd = () => {
    setNetdiscoForm({ name: '', url: '', authType: 'api_key', username: '', credential: '' });
    setNetdiscoEditingId('new');
  };

  const openNetdiscoEdit = (s: NetdiscoSource) => {
    setNetdiscoForm({
      name: s.name,
      url: s.url,
      authType: s.auth_type,
      username: s.username ?? '',
      credential: '', // never echoed
    });
    setNetdiscoEditingId(s.id);
  };

  const closeNetdiscoForm = () => {
    setNetdiscoEditingId(null);
  };

  const handleNetdiscoSave = async () => {
    if (!netdiscoForm.name.trim() || !netdiscoForm.url.trim()) {
      showToast('Name and URL are required', 'warning');
      return;
    }
    const isNew = netdiscoEditingId === 'new';
    if (isNew && !netdiscoForm.credential.trim()) {
      showToast('Credential (API key or password) is required for new sources', 'warning');
      return;
    }
    if (netdiscoForm.authType === 'basic' && !netdiscoForm.username.trim()) {
      showToast('Username is required for basic auth', 'warning');
      return;
    }
    await netdiscoSubmit.run(async () => {
      try {
        if (isNew) {
          await createNetdiscoSource({
            name: netdiscoForm.name.trim(),
            url: netdiscoForm.url.trim(),
            auth_type: netdiscoForm.authType,
            username: netdiscoForm.authType === 'basic' ? netdiscoForm.username.trim() : undefined,
            credential: netdiscoForm.credential.trim(),
          });
        } else if (netdiscoEditingId) {
          await updateNetdiscoSource(netdiscoEditingId, {
            name: netdiscoForm.name.trim(),
            url: netdiscoForm.url.trim(),
            auth_type: netdiscoForm.authType,
            username: netdiscoForm.authType === 'basic' ? netdiscoForm.username.trim() : null,
            // Only send credential when the user typed a new one — empty means "keep stored value"
            ...(netdiscoForm.credential.trim() ? { credential: netdiscoForm.credential.trim() } : {}),
          });
        }
        await fetchNetdiscoSources();
        closeNetdiscoForm();
        showToast(`Netdisco source ${isNew ? 'added' : 'updated'}`, 'success');
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Save failed', 'error');
      }
    });
  };

  const handleNetdiscoTest = async (s: NetdiscoSource) => {
    showToast(`Testing ${s.name}…`, 'info');
    try {
      const result = await testNetdiscoSource(s.id);
      showToast(`${s.name}: ${result.message}`, result.success ? 'success' : 'error');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Test failed', 'error');
    }
  };

  const handleNetdiscoDelete = async (s: NetdiscoSource) => {
    const ok = await confirmDialog({
      title: 'Delete Netdisco source?',
      body: <>Remove <strong>{s.name}</strong>? Topologies already discovered through it stay intact.</>,
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    await netdiscoSubmit.run(async () => {
      try {
        await deleteNetdiscoSource(s.id);
        await fetchNetdiscoSources();
        showToast('Netdisco source deleted', 'success');
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Delete failed', 'error');
      }
    });
  };

  const handleAddSource = () => {
    setEditingSource(null);
    setDialogOpen(true);
  };

  const handleEditSource = (source: NetBoxSource) => {
    setEditingSource(source);
    setDialogOpen(true);
  };

  const handleDialogClose = () => {
    setDialogOpen(false);
    setEditingSource(null);
  };

  const handleDialogSaved = () => {
    setDialogOpen(false);
    setEditingSource(null);
    fetchSources();
  };

  const handleDeleteClick = (source: NetBoxSource) => {
    setDeleteConfirm(source);
  };

  const handleDeleteConfirm = async () => {
    if (!deleteConfirm) return;

    try {
      setDeleting(true);
      await deleteNetBoxSource(deleteConfirm.id);
      setDeleteConfirm(null);
      fetchSources();
    } catch (err) {
      console.error('Failed to delete NetBox source:', err);
      setError('Failed to delete NetBox source');
    } finally {
      setDeleting(false);
    }
  };

  const handleDeleteCancel = () => {
    setDeleteConfirm(null);
  };

  const handleSync = (source: NetBoxSource) => {
    setSyncSourceId(source.id);
    setImportDialogOpen(true);
  };

  const handleImportDialogClose = () => {
    setImportDialogOpen(false);
    setSyncSourceId(undefined);
  };

  const handleImportComplete = () => {
    // Refresh the source list (last_sync_at, etc.) but leave the import dialog
    // open. The dialog shows a per-import report that the user dismisses with
    // "Done" or "Import More" — auto-closing here would hide it.
    fetchSources();
  };

  const handleImportFromFile = () => {
    // Trigger file input for session import
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;

      try {
        const formData = new FormData();
        formData.append('file', file);
        const { data: result } = await getClient().http.post('/sessions/import', formData);
        showToast(`Imported ${result.sessions_created || result.imported || 0} sessions successfully.`, 'success');
      } catch (err) {
        console.error('Import error:', err);
        showToast('Failed to import sessions. Please check the file format.', 'error');
      }
    };
    input.click();
  };

  const handleExportToFile = async () => {
    try {
      const { data } = await getClient().http.get('/sessions/export');
      downloadFile(JSON.stringify(data, null, 2), `netstacks-sessions-${new Date().toISOString().slice(0, 10)}.json`, 'application/json');
    } catch (err) {
      console.error('Export error:', err);
      showToast('Failed to export sessions.', 'error');
    }
  };

  const formatLastSync = (syncAt: string | null): string => {
    if (!syncAt) return 'Never synced';
    const date = new Date(syncAt);
    return date.toLocaleString();
  };

  const getStatusClass = (source: NetBoxSource): string => {
    if (source.last_sync_result) {
      return 'success';
    }
    return 'inactive';
  };

  if (loading) {
    return <div className="integrations-tab"><div className="integrations-loading">Loading integrations...</div></div>;
  }

  return (
    <div className="integrations-tab">
      {/* NetBox Sources Section */}
      <section className="integrations-section">
        <div className="section-header">
          <h3>NETBOX SOURCES</h3>
        </div>

        {error && <div className="integrations-error">{error}</div>}

        <div className="sources-list">
          {sources.length === 0 ? (
            <div className="sources-empty">
              <p>No NetBox sources configured.</p>
              <p>Add a NetBox instance to import devices as sessions.</p>
            </div>
          ) : (
            sources.map((source) => (
              <div key={source.id} className="source-item">
                <div className="source-status">
                  <span className={`status-dot ${getStatusClass(source)}`} />
                </div>
                <div className="source-info">
                  <div className="source-header">
                    <span className="source-icon">{Icons.netbox}</span>
                    <span className="source-name">{source.name}</span>
                  </div>
                  <div className="source-details">
                    <span className="source-url">{source.url}</span>
                    <span className="source-separator">|</span>
                    <span className="source-sync">{formatLastSync(source.last_sync_at)}</span>
                  </div>
                </div>
                <div className="source-actions">
                  <button
                    className="source-action-btn"
                    onClick={() => handleSync(source)}
                    title="Sync"
                  >
                    {Icons.sync}
                    <span>Sync</span>
                  </button>
                  <button
                    className="source-action-btn"
                    onClick={() => handleEditSource(source)}
                    title="Edit"
                  >
                    {Icons.edit}
                    <span>Edit</span>
                  </button>
                  <button
                    className="source-action-btn delete"
                    onClick={() => handleDeleteClick(source)}
                    title="Delete"
                  >
                    {Icons.trash}
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        <div className="section-footer">
          <button className="btn-add-source" onClick={handleAddSource}>
            {Icons.plus}
            <span>Add NetBox Source</span>
          </button>
        </div>
      </section>

      {/* LibreNMS Sources Section */}
      <section className="integrations-section">
        <div className="section-header">
          <h3>LIBRENMS SOURCES</h3>
        </div>

        <div className="sources-list">
          {libreSources.length === 0 && !libreAddOpen ? (
            <div className="sources-empty">
              <p>No LibreNMS sources configured.</p>
              <p>Add a LibreNMS instance to pull devices and CDP/LLDP links into topology discovery.</p>
            </div>
          ) : (
            libreSources.map((s) => (
              <div key={s.id} className="source-item">
                <div className="source-status"><span className="status-dot inactive" /></div>
                <div className="source-info">
                  <div className="source-header">
                    <span className="source-name">{s.name}</span>
                  </div>
                  <div className="source-details">
                    <span className="source-url">{s.url}</span>
                  </div>
                </div>
                <div className="source-actions">
                  <button
                    className="source-action-btn"
                    onClick={() => handleLibreTest(s)}
                    title="Test connection"
                  >
                    <span>Test</span>
                  </button>
                  <button
                    className="source-action-btn delete"
                    onClick={() => handleLibreDelete(s)}
                    title="Delete"
                    disabled={libreSubmit.submitting}
                  >
                    {Icons.trash}
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        {libreAddOpen && (
          <div className="source-inline-form">
            <input
              type="text"
              placeholder="Name (e.g. Prod LibreNMS)"
              value={libreForm.name}
              onChange={(e) => setLibreForm({ ...libreForm, name: e.target.value })}
              disabled={libreSubmit.submitting}
            />
            <input
              type="url"
              placeholder="URL (e.g. https://librenms.example.com)"
              value={libreForm.url}
              onChange={(e) => setLibreForm({ ...libreForm, url: e.target.value })}
              disabled={libreSubmit.submitting}
            />
            <input
              type="password"
              placeholder="API token"
              value={libreForm.token}
              onChange={(e) => setLibreForm({ ...libreForm, token: e.target.value })}
              autoComplete="new-password"
              disabled={libreSubmit.submitting}
            />
            <div className="source-inline-form-actions">
              <button
                className="btn-secondary"
                onClick={() => { setLibreAddOpen(false); setLibreForm({ name: '', url: '', token: '' }); }}
                disabled={libreSubmit.submitting}
              >
                Cancel
              </button>
              <button className="btn-primary" onClick={handleLibreAdd} disabled={libreSubmit.submitting}>
                {libreSubmit.submitting ? 'Adding…' : 'Add'}
              </button>
            </div>
          </div>
        )}

        {!libreAddOpen && (
          <div className="section-footer">
            <button className="btn-add-source" onClick={() => setLibreAddOpen(true)}>
              {Icons.plus}
              <span>Add LibreNMS Source</span>
            </button>
          </div>
        )}
      </section>

      {/* Netdisco Sources Section */}
      <section className="integrations-section">
        <div className="section-header">
          <h3>NETDISCO SOURCES</h3>
        </div>

        <div className="sources-list">
          {netdiscoSources.length === 0 && netdiscoEditingId === null ? (
            <div className="sources-empty">
              <p>No Netdisco sources configured.</p>
              <p>Add a Netdisco instance for L2 topology and neighbor discovery.</p>
            </div>
          ) : (
            netdiscoSources.map((s) => (
              <div key={s.id} className="source-item">
                <div className="source-status"><span className="status-dot inactive" /></div>
                <div className="source-info">
                  <div className="source-header">
                    <span className="source-name">{s.name}</span>
                  </div>
                  <div className="source-details">
                    <span className="source-url">{s.url}</span>
                    <span className="source-separator">|</span>
                    <span>{s.auth_type === 'basic' ? `basic (${s.username || 'no user'})` : 'api key'}</span>
                  </div>
                </div>
                <div className="source-actions">
                  <button className="source-action-btn" onClick={() => handleNetdiscoTest(s)} title="Test connection">
                    <span>Test</span>
                  </button>
                  <button
                    className="source-action-btn"
                    onClick={() => openNetdiscoEdit(s)}
                    title="Edit"
                    disabled={netdiscoSubmit.submitting}
                  >
                    {Icons.edit}
                    <span>Edit</span>
                  </button>
                  <button
                    className="source-action-btn delete"
                    onClick={() => handleNetdiscoDelete(s)}
                    title="Delete"
                    disabled={netdiscoSubmit.submitting}
                  >
                    {Icons.trash}
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        {netdiscoEditingId !== null && (
          <div className="source-inline-form">
            <input
              type="text"
              placeholder="Name (e.g. Prod Netdisco)"
              value={netdiscoForm.name}
              onChange={(e) => setNetdiscoForm({ ...netdiscoForm, name: e.target.value })}
              disabled={netdiscoSubmit.submitting}
            />
            <input
              type="url"
              placeholder="URL (e.g. https://netdisco.example.com)"
              value={netdiscoForm.url}
              onChange={(e) => setNetdiscoForm({ ...netdiscoForm, url: e.target.value })}
              disabled={netdiscoSubmit.submitting}
            />
            <select
              value={netdiscoForm.authType}
              onChange={(e) => setNetdiscoForm({ ...netdiscoForm, authType: e.target.value as 'basic' | 'api_key' })}
              disabled={netdiscoSubmit.submitting}
            >
              <option value="api_key">API key</option>
              <option value="basic">Basic auth (username + password)</option>
            </select>
            {netdiscoForm.authType === 'basic' && (
              <input
                type="text"
                placeholder="Username"
                value={netdiscoForm.username}
                onChange={(e) => setNetdiscoForm({ ...netdiscoForm, username: e.target.value })}
                disabled={netdiscoSubmit.submitting}
              />
            )}
            <input
              type="password"
              placeholder={netdiscoEditingId === 'new' ? 'API key / password' : 'New API key / password (leave blank to keep current)'}
              value={netdiscoForm.credential}
              onChange={(e) => setNetdiscoForm({ ...netdiscoForm, credential: e.target.value })}
              autoComplete="new-password"
              disabled={netdiscoSubmit.submitting}
            />
            <div className="source-inline-form-actions">
              <button className="btn-secondary" onClick={closeNetdiscoForm} disabled={netdiscoSubmit.submitting}>
                Cancel
              </button>
              <button className="btn-primary" onClick={handleNetdiscoSave} disabled={netdiscoSubmit.submitting}>
                {netdiscoSubmit.submitting
                  ? 'Saving…'
                  : netdiscoEditingId === 'new'
                  ? 'Add'
                  : 'Save'}
              </button>
            </div>
          </div>
        )}

        {netdiscoEditingId === null && (
          <div className="section-footer">
            <button className="btn-add-source" onClick={openNetdiscoAdd}>
              {Icons.plus}
              <span>Add Netdisco Source</span>
            </button>
          </div>
        )}
      </section>

      {/* SMTP Email Settings Section */}
      <section className="integrations-section">
        <div className="section-header">
          <h3>EMAIL NOTIFICATIONS</h3>
        </div>
        <SmtpSettingsSection />
      </section>

      {/* Import/Export Section */}
      <section className="integrations-section">
        <div className="section-header">
          <h3>IMPORT / EXPORT</h3>
        </div>

        <div className="import-export-actions">
          <button className="btn-import-export" onClick={handleImportFromFile}>
            {Icons.import}
            <span>Import Sessions from File</span>
          </button>
          <button className="btn-import-export" onClick={() => setSecureCRTDialogOpen(true)}>
            {Icons.import}
            <span>Import from SecureCRT</span>
          </button>
          <button className="btn-import-export" onClick={handleExportToFile}>
            {Icons.export}
            <span>Export Sessions to File</span>
          </button>
        </div>
      </section>

      {/* NetBox Source Dialog */}
      <NetBoxSourceDialog
        isOpen={dialogOpen}
        source={editingSource}
        onClose={handleDialogClose}
        onSaved={handleDialogSaved}
      />

      {/* NetBox Import Dialog (for Sync) */}
      <NetBoxImportDialog
        isOpen={importDialogOpen}
        onClose={handleImportDialogClose}
        onImportComplete={handleImportComplete}
        preSelectedSourceId={syncSourceId}
      />

      {/* SecureCRT Import Dialog */}
      <SecureCRTImportDialog
        isOpen={secureCRTDialogOpen}
        onClose={() => setSecureCRTDialogOpen(false)}
        onImportComplete={() => setSecureCRTDialogOpen(false)}
      />

      {/* Delete Confirmation */}
      {deleteConfirm && (
        <div className="delete-confirm-overlay" onClick={handleDeleteCancel}>
          <div className="delete-confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Delete NetBox Source</h3>
            <p>Are you sure you want to delete "{deleteConfirm.name}"?</p>
            <p className="delete-confirm-warning">
              This will not delete sessions that were imported from this source.
            </p>
            <div className="delete-confirm-actions">
              <button className="btn-secondary" onClick={handleDeleteCancel} disabled={deleting}>
                Cancel
              </button>
              <button className="btn-danger" onClick={handleDeleteConfirm} disabled={deleting}>
                {deleting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
