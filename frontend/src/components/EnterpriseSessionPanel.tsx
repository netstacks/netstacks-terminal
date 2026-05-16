import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import './EnterpriseSessionPanel.css';
import {
  listEnterpriseSessionDefinitions,
  createSessionDefinition,
  updateSessionDefinition,
  deleteSessionDefinition,
  listUserFolders,
  createUserFolder,
  updateUserFolder,
  deleteUserFolder,
  assignSessionToFolder,
  listUserAssignments,
  type EnterpriseSession,
  type CreateEnterpriseSession,
  type UserSessionFolder,
  type SessionAssignment,
} from '../api/enterpriseSessions';
import { CLI_FLAVOR_OPTIONS, type CliFlavor } from '../api/sessions';
import { listAccessibleCredentials } from '../api/enterpriseCredentials';
import type { AccessibleCredential } from '../types/enterpriseCredential';
import { listEnterpriseDevices, type DeviceSummary } from '../api/enterpriseDevices';
import { confirmDialog } from './ConfirmDialog';

// Icons (reuse from SessionPanel patterns)
const Icons = {
  search: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  ),
  folder: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
    </svg>
  ),
  folderOpen: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2v1" />
      <path d="M2 10l4 9h14l4-9H6" />
    </svg>
  ),
  plus: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  ),
  chevronRight: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  ),
  chevronDown: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  ),
  edit: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  ),
  trash: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
    </svg>
  ),
  refresh: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
    </svg>
  ),
  folderPlus: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
      <line x1="12" y1="11" x2="12" y2="17" />
      <line x1="9" y1="14" x2="15" y2="14" />
    </svg>
  ),
  x: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  ),
  moreVertical: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="1" />
      <circle cx="12" cy="5" r="1" />
      <circle cx="12" cy="19" r="1" />
    </svg>
  ),
  terminal: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  ),
};

interface EnterpriseSessionPanelProps {
  onSessionSelect: (session: EnterpriseSession) => void;
  onSessionConnect: (session: EnterpriseSession) => void;
  onOpenLocalTerminal?: () => void;
  refreshKey?: number;
}

export default function EnterpriseSessionPanel({
  onSessionSelect,
  onSessionConnect,
  onOpenLocalTerminal,
  refreshKey,
}: EnterpriseSessionPanelProps) {
  const [sessions, setSessions] = useState<EnterpriseSession[]>([]);
  const [folders, setFolders] = useState<UserSessionFolder[]>([]);
  const [assignments, setAssignments] = useState<SessionAssignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [sessionContextMenu, setSessionContextMenu] = useState<{
    x: number;
    y: number;
    sessionId: string;
  } | null>(null);
  const [folderContextMenu, setFolderContextMenu] = useState<{
    x: number;
    y: number;
    folderId: string;
  } | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [editingSession, setEditingSession] = useState<EnterpriseSession | null>(null);
  const [formData, setFormData] = useState<CreateEnterpriseSession & { device_id?: string | null }>({
    name: '',
    host: '',
    port: 22,
    description: '',
    cli_flavor: 'auto',
    device_id: null, // Phase 42.2-03: Optional device link for auto-fill
  });
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [renameFolderValue, setRenameFolderValue] = useState('');
  const [accessibleCredentials, setAccessibleCredentials] = useState<AccessibleCredential[]>([]);
  const [deviceList, setDeviceList] = useState<DeviceSummary[]>([]); // Phase 42.2-03: Device picker

  const renameInputRef = useRef<HTMLInputElement>(null);

  // Fetch data on mount
  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [sessionsRes, foldersData, assignmentsData] = await Promise.all([
        listEnterpriseSessionDefinitions(),
        listUserFolders(),
        listUserAssignments(),
      ]);
      setSessions(sessionsRes.items);
      setFolders(foldersData);
      setAssignments(assignmentsData);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load sessions');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Re-fetch when parent signals a refresh (e.g. device saved from Controller tab)
  useEffect(() => {
    if (refreshKey) fetchData();
  }, [refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Active connection count polling (15s interval)
  useEffect(() => {
    // Only poll when not editing/searching to avoid disrupting user interactions
    if (showCreateForm || editingSession || renamingFolderId || searchQuery) {
      return;
    }

    const pollInterval = setInterval(async () => {
      try {
        // Re-fetch session definitions to update active_connections counts
        const sessionsRes = await listEnterpriseSessionDefinitions();
        setSessions((prev) => {
          // Update sessions in-place without resetting state
          const updated = prev.map((existingSession) => {
            const newSession = sessionsRes.items.find((s) => s.id === existingSession.id);
            if (newSession && newSession.active_connections !== existingSession.active_connections) {
              // Mark as recently changed for animation (using a ref or state if needed)
              return newSession;
            }
            return newSession || existingSession;
          });
          return updated;
        });
      } catch (err) {
        // Silently fail polling - don't disrupt UI
        console.error('Failed to poll active connections:', err);
      }
    }, 15000); // 15 seconds

    return () => clearInterval(pollInterval);
  }, [showCreateForm, editingSession, renamingFolderId, searchQuery]);

  // Close context menus on click outside
  useEffect(() => {
    const handleClick = () => {
      setSessionContextMenu(null);
      setFolderContextMenu(null);
    };
    if (sessionContextMenu || folderContextMenu) {
      document.addEventListener('click', handleClick);
      return () => document.removeEventListener('click', handleClick);
    }
  }, [sessionContextMenu, folderContextMenu]);

  // Focus rename input when renaming
  useEffect(() => {
    if (renamingFolderId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingFolderId]);

  // Fetch devices when session form opens (Phase 42.2-03: Device picker)
  useEffect(() => {
    if (showCreateForm || editingSession) {
      listEnterpriseDevices({ limit: 1000 })
        .then(res => setDeviceList(res.items))
        .catch(() => setDeviceList([])); // Silently fail - picker is optional
    }
  }, [showCreateForm, editingSession]);

  // Toggle folder expansion
  const toggleFolder = (folderId: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
      }
      return next;
    });
  };

  // Filter sessions based on search query
  const searchLower = searchQuery.toLowerCase().trim();
  const filteredSessions = useMemo(() => {
    if (!searchLower) return sessions;
    return sessions.filter(
      (s) =>
        s.name.toLowerCase().includes(searchLower) ||
        s.host.toLowerCase().includes(searchLower)
    );
  }, [sessions, searchLower]);

  // Build folder tree
  const rootFolders = folders
    .filter((f) => f.parent_id === null)
    .sort((a, b) => a.sort_order - b.sort_order);

  const childFoldersByParent = new Map<string, UserSessionFolder[]>();
  folders.forEach((f) => {
    if (f.parent_id) {
      if (!childFoldersByParent.has(f.parent_id)) {
        childFoldersByParent.set(f.parent_id, []);
      }
      childFoldersByParent.get(f.parent_id)!.push(f);
    }
  });
  childFoldersByParent.forEach((children) => {
    children.sort((a, b) => a.sort_order - b.sort_order);
  });

  // Group sessions by folder based on assignments
  const sessionsByFolder = new Map<string | null, EnterpriseSession[]>();
  sessions.forEach((session) => {
    const assignment = assignments.find((a) => a.session_definition_id === session.id);
    const folderId = assignment?.folder_id || null;
    if (!sessionsByFolder.has(folderId)) {
      sessionsByFolder.set(folderId, []);
    }
    sessionsByFolder.get(folderId)!.push(session);
  });

  // Sort sessions within each folder by assignment sort_order
  sessionsByFolder.forEach((folderSessions, _folderId) => {
    folderSessions.sort((a, b) => {
      const aAssignment = assignments.find((asn) => asn.session_definition_id === a.id);
      const bAssignment = assignments.find((asn) => asn.session_definition_id === b.id);
      return (aAssignment?.sort_order || 0) - (bAssignment?.sort_order || 0);
    });
  });

  // Get folders with matching sessions (for search results)
  const foldersWithMatches = useMemo(() => {
    if (!searchLower) return new Set<string>();
    const ids = new Set<string>();
    filteredSessions.forEach((s) => {
      const assignment = assignments.find((a) => a.session_definition_id === s.id);
      if (assignment?.folder_id) ids.add(assignment.folder_id);
    });
    // Also include parent folders
    const addParents = (folderId: string) => {
      const folder = folders.find((f) => f.id === folderId);
      if (folder?.parent_id) {
        ids.add(folder.parent_id);
        addParents(folder.parent_id);
      }
    };
    [...ids].forEach(addParents);
    return ids;
  }, [filteredSessions, folders, assignments, searchLower]);

  // Handle device selection (Phase 42.2-03: Device picker auto-fill)
  const handleDeviceSelect = (deviceId: string) => {
    if (!deviceId) {
      // "None" selected - clear device_id and re-enable manual host/port
      setFormData((prev) => ({ ...prev, device_id: null }));
      return;
    }

    const device = deviceList.find((d) => d.id === deviceId);
    if (device) {
      // Auto-fill host and port from device
      setFormData((prev) => ({
        ...prev,
        device_id: deviceId,
        host: device.host,
        port: device.port,
      }));
    }
  };

  // Session CRUD handlers
  const handleCreateSession = async () => {
    try {
      // Note: device_id may not be accepted by API yet (migration adds column, API may not handle it)
      // Send it anyway - worst case, it's ignored. The auto-filled host/port are what matter.
      const newSession = await createSessionDefinition(formData);
      setSessions((prev) => [...prev, newSession]);
      setShowCreateForm(false);
      setFormData({ name: '', host: '', port: 22, description: '', cli_flavor: 'auto', device_id: null });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create session');
    }
  };

  const handleUpdateSession = async () => {
    if (!editingSession) return;
    try {
      const updated = await updateSessionDefinition(editingSession.id, formData);
      setSessions((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
      setEditingSession(null);
      setFormData({ name: '', host: '', port: 22, description: '', cli_flavor: 'auto', device_id: null });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update session');
    }
  };

  const handleDeleteSession = async (sessionId: string) => {
    const ok = await confirmDialog({
      title: 'Delete session?',
      body: 'This removes the session definition. Active connections are unaffected.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteSessionDefinition(sessionId);
      setSessions((prev) => prev.filter((s) => s.id !== sessionId));
      setAssignments((prev) => prev.filter((a) => a.session_definition_id !== sessionId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete session');
    }
    setSessionContextMenu(null);
  };

  const handleOpenEditForm = (session: EnterpriseSession) => {
    setEditingSession(session);
    setFormData({
      name: session.name,
      host: session.host,
      port: session.port,
      description: session.description || '',
      cli_flavor: session.cli_flavor,
      tags: session.tags,
      credential_override_id: session.credential_override_id,
    });
    setSessionContextMenu(null);
    // Fetch credentials for the dropdown
    listAccessibleCredentials()
      .then(setAccessibleCredentials)
      .catch(err => console.warn('Failed to load credentials:', err));
  };

  const handleCancelForm = () => {
    setShowCreateForm(false);
    setEditingSession(null);
    setFormData({ name: '', host: '', port: 22, description: '', cli_flavor: 'auto', device_id: null });
  };

  // Folder CRUD handlers
  const handleNewFolder = async () => {
    try {
      const newFolder = await createUserFolder('New Folder');
      setFolders((prev) => [...prev, newFolder]);
      setRenamingFolderId(newFolder.id);
      setRenameFolderValue(newFolder.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create folder');
    }
  };

  const handleNewSubfolder = async (parentId: string) => {
    try {
      const newFolder = await createUserFolder('New Folder', parentId);
      setFolders((prev) => [...prev, newFolder]);
      setExpandedFolders((prev) => new Set([...prev, parentId]));
      setRenamingFolderId(newFolder.id);
      setRenameFolderValue(newFolder.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create folder');
    }
    setFolderContextMenu(null);
  };

  const handleRenameFolder = (folderId: string) => {
    const folder = folders.find((f) => f.id === folderId);
    if (folder) {
      setRenamingFolderId(folderId);
      setRenameFolderValue(folder.name);
    }
    setFolderContextMenu(null);
  };

  const handleRenameFolderSubmit = async () => {
    if (!renamingFolderId || !renameFolderValue.trim()) {
      setRenamingFolderId(null);
      return;
    }

    try {
      const updated = await updateUserFolder(renamingFolderId, {
        name: renameFolderValue.trim(),
      });
      setFolders((prev) => prev.map((f) => (f.id === updated.id ? updated : f)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to rename folder');
    }
    setRenamingFolderId(null);
  };

  const handleDeleteFolder = async (folderId: string) => {
    const ok = await confirmDialog({
      title: 'Delete folder?',
      body: 'Sessions inside this folder will be moved to root.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteUserFolder(folderId);
      setFolders((prev) => prev.filter((f) => f.id !== folderId));
      // Update assignments - sessions in deleted folder now have folder_id = null
      setAssignments((prev) =>
        prev.map((a) => (a.folder_id === folderId ? { ...a, folder_id: null } : a))
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete folder');
    }
    setFolderContextMenu(null);
  };

  const handleMoveToFolder = async (sessionId: string, targetFolderId: string | null) => {
    try {
      await assignSessionToFolder(sessionId, targetFolderId, 1000);
      // Update local assignments
      const existingIdx = assignments.findIndex((a) => a.session_definition_id === sessionId);
      if (existingIdx >= 0) {
        setAssignments((prev) =>
          prev.map((a, idx) =>
            idx === existingIdx ? { ...a, folder_id: targetFolderId } : a
          )
        );
      } else {
        // Create new assignment entry
        await fetchData(); // Refetch to get the new assignment from server
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to move session');
    }
    setSessionContextMenu(null);
  };

  // Render session item
  const renderSession = (session: EnterpriseSession) => {
    // Skip if doesn't match search
    if (searchLower && !filteredSessions.some((s) => s.id === session.id)) return null;

    const isSelected = selectedSessionId === session.id;

    return (
      <div
        key={session.id}
        className={`enterprise-session-item ${isSelected ? 'selected' : ''}`}
        onClick={() => {
          setSelectedSessionId(session.id);
          onSessionSelect(session);
        }}
        onDoubleClick={() => onSessionConnect(session)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setFolderContextMenu(null);
          setSessionContextMenu({ x: e.clientX, y: e.clientY, sessionId: session.id });
        }}
        title={`${session.host}:${session.port}`}
      >
        <span className="enterprise-session-color" />
        <span className="enterprise-session-name">{session.name}</span>
        {session.active_connections > 0 && (
          <span className="enterprise-session-badge">{session.active_connections}</span>
        )}
        <button
          className="enterprise-session-connect-btn"
          onClick={(e) => {
            e.stopPropagation();
            onSessionConnect(session);
          }}
          title="Connect"
        >
          Connect
        </button>
      </div>
    );
  };

  // Render folder with sessions and subfolders
  const renderFolder = (folder: UserSessionFolder, depth: number = 0): React.ReactNode => {
    // Skip folder if searching and no matching sessions
    if (searchLower && !foldersWithMatches.has(folder.id)) return null;

    const isExpanded = expandedFolders.has(folder.id) || !!searchLower;
    const folderSessions = sessionsByFolder.get(folder.id) || [];
    const childFolders = childFoldersByParent.get(folder.id) || [];
    const isRenaming = renamingFolderId === folder.id;

    // Count matching sessions for badge
    const matchingCount = searchLower
      ? folderSessions.filter((s) => filteredSessions.some((fs) => fs.id === s.id)).length
      : folderSessions.length + childFolders.length;

    return (
      <div key={folder.id} className="enterprise-folder-group">
        <div
          className="enterprise-folder-header"
          onClick={(e) => {
            if (isRenaming) return;
            e.stopPropagation();
            toggleFolder(folder.id);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setSessionContextMenu(null);
            setFolderContextMenu({ x: e.clientX, y: e.clientY, folderId: folder.id });
          }}
        >
          <span className="enterprise-folder-chevron">
            {isExpanded ? Icons.chevronDown : Icons.chevronRight}
          </span>
          <span className="enterprise-folder-icon">
            {isExpanded ? Icons.folderOpen : Icons.folder}
          </span>
          {isRenaming ? (
            <input
              ref={renameInputRef}
              className="enterprise-folder-rename-input"
              value={renameFolderValue}
              onChange={(e) => setRenameFolderValue(e.target.value)}
              onBlur={handleRenameFolderSubmit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleRenameFolderSubmit();
                if (e.key === 'Escape') setRenamingFolderId(null);
              }}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <span className="enterprise-folder-name">{folder.name}</span>
          )}
          <span className="enterprise-folder-count">{matchingCount}</span>
        </div>
        {isExpanded && (
          <div className="enterprise-folder-sessions">
            {childFolders.map((child) => renderFolder(child, depth + 1))}
            {folderSessions.map(renderSession)}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="enterprise-session-panel">
      <div className="enterprise-session-panel-toolbar">
        <button
          className="enterprise-session-panel-btn icon-only primary"
          onClick={() => setShowCreateForm(true)}
          title="New Session"
        >
          {Icons.plus}
        </button>
        <button
          className="enterprise-session-panel-btn icon-only"
          onClick={handleNewFolder}
          title="New Folder"
        >
          {Icons.folderPlus}
        </button>
        {onOpenLocalTerminal && (
          <button
            className="enterprise-session-panel-btn icon-only"
            onClick={onOpenLocalTerminal}
            title="Local Terminal"
          >
            {Icons.terminal}
          </button>
        )}
        <button
          className="enterprise-session-panel-btn icon-only"
          onClick={fetchData}
          title="Refresh"
          disabled={loading}
        >
          {Icons.refresh}
        </button>
      </div>

      {/* Search input */}
      <div className="enterprise-session-search">
        <span className="enterprise-session-search-icon">{Icons.search}</span>
        <input
          type="text"
          className="enterprise-session-search-input"
          placeholder="Search sessions..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        {searchQuery && (
          <button
            className="enterprise-session-search-clear"
            onClick={() => setSearchQuery('')}
            title="Clear search"
          >
            {Icons.x}
          </button>
        )}
      </div>

      {loading && (
        <div className="enterprise-session-panel-status">Loading sessions...</div>
      )}

      {error && (
        <div className="enterprise-session-panel-error">
          {error}
          <button onClick={fetchData}>Retry</button>
        </div>
      )}

      {!loading && !error && (
        <div className="enterprise-session-list">
          {rootFolders.map((folder) => renderFolder(folder))}
          {(sessionsByFolder.get(null) || []).map(renderSession)}

          {/* Empty state */}
          {sessions.length === 0 && folders.length === 0 && (
            <div className="enterprise-session-panel-empty">
              No sessions configured.
              <br />
              Click + to add one.
            </div>
          )}

          {/* Search results info */}
          {searchLower && filteredSessions.length > 0 && (
            <div className="enterprise-session-search-results">
              {filteredSessions.length} session{filteredSessions.length !== 1 ? 's' : ''}{' '}
              found
            </div>
          )}

          {/* No search results */}
          {searchLower && filteredSessions.length === 0 && (
            <div className="enterprise-session-panel-empty">
              No sessions match &quot;{searchQuery}&quot;
            </div>
          )}
        </div>
      )}

      {/* Session Context Menu */}
      {sessionContextMenu && (
        <div
          className="enterprise-context-menu"
          style={{ left: sessionContextMenu.x, top: sessionContextMenu.y }}
        >
          <button
            className="enterprise-context-menu-item"
            onClick={() => {
              const session = sessions.find((s) => s.id === sessionContextMenu.sessionId);
              if (session) onSessionConnect(session);
              setSessionContextMenu(null);
            }}
          >
            Connect
          </button>
          <button
            className="enterprise-context-menu-item"
            onClick={() => {
              const session = sessions.find((s) => s.id === sessionContextMenu.sessionId);
              if (session) handleOpenEditForm(session);
            }}
          >
            {Icons.edit}
            <span>Edit</span>
          </button>
          <div className="enterprise-context-menu-divider" />
          <button
            className="enterprise-context-menu-item"
            onClick={() => handleMoveToFolder(sessionContextMenu.sessionId, null)}
          >
            Move to Root
          </button>
          {folders.map((folder) => (
            <button
              key={folder.id}
              className="enterprise-context-menu-item"
              onClick={() => handleMoveToFolder(sessionContextMenu.sessionId, folder.id)}
            >
              Move to {folder.name}
            </button>
          ))}
          <div className="enterprise-context-menu-divider" />
          <button
            className="enterprise-context-menu-item danger"
            onClick={() => handleDeleteSession(sessionContextMenu.sessionId)}
          >
            {Icons.trash}
            <span>Delete</span>
          </button>
        </div>
      )}

      {/* Folder Context Menu */}
      {folderContextMenu && (
        <div
          className="enterprise-context-menu"
          style={{ left: folderContextMenu.x, top: folderContextMenu.y }}
        >
          <button
            className="enterprise-context-menu-item"
            onClick={() => handleNewSubfolder(folderContextMenu.folderId)}
          >
            {Icons.folderPlus}
            <span>New Subfolder</span>
          </button>
          <button
            className="enterprise-context-menu-item"
            onClick={() => handleRenameFolder(folderContextMenu.folderId)}
          >
            {Icons.edit}
            <span>Rename</span>
          </button>
          <div className="enterprise-context-menu-divider" />
          <button
            className="enterprise-context-menu-item danger"
            onClick={() => handleDeleteFolder(folderContextMenu.folderId)}
          >
            {Icons.trash}
            <span>Delete</span>
          </button>
        </div>
      )}

      {/* Create/Edit Session Form */}
      {(showCreateForm || editingSession) && (
        <div className="enterprise-session-form-overlay">
          <div className="enterprise-session-form">
            <h3>{editingSession ? 'Edit Session' : 'New Session'}</h3>
            <div className="enterprise-form-field">
              <label>Name</label>
              <input
                type="text"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="Session name"
              />
            </div>

            {/* Device picker (Phase 42.2-03) */}
            <div className="enterprise-form-field">
              <label>Link to Device (optional)</label>
              <select
                className="device-picker-select"
                value={formData.device_id || ''}
                onChange={(e) => handleDeviceSelect(e.target.value)}
              >
                <option value="">None - enter host/port manually</option>
                {deviceList.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name} ({d.host}:{d.port})
                  </option>
                ))}
              </select>
              {formData.device_id && (
                <div className="device-linked-indicator">
                  Linked to device - host and port auto-filled
                </div>
              )}
            </div>

            <div className="enterprise-form-field">
              <label>Host</label>
              <input
                type="text"
                value={formData.host}
                onChange={(e) => setFormData({ ...formData, host: e.target.value })}
                placeholder="hostname or IP"
                readOnly={!!formData.device_id}
                className={formData.device_id ? 'device-auto-filled' : ''}
              />
            </div>
            <div className="enterprise-form-field">
              <label>Port</label>
              <input
                type="number"
                value={formData.port}
                onChange={(e) =>
                  setFormData({ ...formData, port: parseInt(e.target.value) || 22 })
                }
                readOnly={!!formData.device_id}
                className={formData.device_id ? 'device-auto-filled' : ''}
              />
            </div>
            <div className="enterprise-form-field">
              <label>CLI Flavor</label>
              <select
                value={formData.cli_flavor}
                onChange={(e) =>
                  setFormData({ ...formData, cli_flavor: e.target.value as CliFlavor })
                }
              >
                {CLI_FLAVOR_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="enterprise-form-field">
              <label>Description</label>
              <textarea
                value={formData.description || ''}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                placeholder="Optional description"
                rows={3}
              />
            </div>
            {editingSession && (
              <div className="enterprise-form-field">
                <label>Credential</label>
                <select
                  value={formData.credential_override_id || ''}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      credential_override_id: e.target.value || null,
                    })
                  }
                >
                  <option value="">Ask on connect</option>
                  {accessibleCredentials.map((cred) => (
                    <option key={cred.id} value={cred.id}>
                      {cred.name} ({cred.username}@{cred.host || '*'})
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="enterprise-form-actions">
              <button className="enterprise-form-btn secondary" onClick={handleCancelForm}>
                Cancel
              </button>
              <button
                className="enterprise-form-btn primary"
                onClick={editingSession ? handleUpdateSession : handleCreateSession}
                disabled={!formData.name || !formData.host}
              >
                {editingSession ? 'Update' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
