import { useState, useEffect } from 'react';
import { getClient } from '../api/client';
import {
  listNetBoxSources,
  deleteNetBoxSource,
  type NetBoxSource,
} from '../api/netboxSources';
import NetBoxSourceDialog from './NetBoxSourceDialog';
import NetBoxImportDialog from './NetBoxImportDialog';
import SmtpSettingsSection from './SmtpSettingsSection';
import SecureCRTImportDialog from './SecureCRTImportDialog';
import { downloadFile } from '../lib/formatters';
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

  // Fetch sources on mount
  useEffect(() => {
    fetchSources();
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
        alert(`Imported ${result.sessions_created || result.imported || 0} sessions successfully.`);
      } catch (err) {
        console.error('Import error:', err);
        alert('Failed to import sessions. Please check the file format.');
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
      alert('Failed to export sessions.');
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
