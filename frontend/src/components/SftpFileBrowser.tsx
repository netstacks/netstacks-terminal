import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  sftpConnect,
  sftpDisconnect,
  sftpLs,
  sftpDownload,
  sftpUpload,
  sftpMkdir,
  sftpRm,
  sftpRename,
  formatFileSize,
  formatPermissions,
  formatTimestamp,
  type FileEntry,
} from '../api/sftp';
import { downloadFile } from '../lib/formatters';
import TransferProgress, { type TransferItem } from './TransferProgress';
import './SftpFileBrowser.css';

// Icons
const FolderIcon = () => (
  <svg viewBox="0 0 16 16" fill="currentColor">
    <path d="M14.5 3H7.71l-.85-.85A.5.5 0 006.5 2h-5a.5.5 0 00-.5.5v11a.5.5 0 00.5.5h13a.5.5 0 00.5-.5v-10a.5.5 0 00-.5-.5z" />
  </svg>
);

const FileIcon = () => (
  <svg viewBox="0 0 16 16" fill="currentColor">
    <path d="M4 0a2 2 0 00-2 2v12a2 2 0 002 2h8a2 2 0 002-2V4.5L9.5 0H4zm5.5 1v3.5H13v9.5a1 1 0 01-1 1H4a1 1 0 01-1-1V2a1 1 0 011-1h5.5z" />
  </svg>
);

const RefreshIcon = () => (
  <svg viewBox="0 0 16 16" fill="currentColor">
    <path d="M11.534 7h3.932a.25.25 0 01.192.41l-1.966 2.36a.25.25 0 01-.384 0l-1.966-2.36a.25.25 0 01.192-.41zm-11 2h3.932a.25.25 0 00.192-.41L2.692 6.23a.25.25 0 00-.384 0L.342 8.59A.25.25 0 00.534 9z" />
    <path d="M8 3c-1.552 0-2.94.707-3.857 1.818a.5.5 0 11-.77-.636A6 6 0 0114 8a.5.5 0 01-1 0 5 5 0 00-5-5zM2.5 8a.5.5 0 01.5.5A5 5 0 008 13c1.552 0 2.94-.707 3.857-1.818a.5.5 0 11.77.636A6 6 0 012 8.5a.5.5 0 01.5-.5z" />
  </svg>
);

const UpIcon = () => (
  <svg viewBox="0 0 16 16" fill="currentColor">
    <path d="M8 0a.5.5 0 01.5.5v11.793l3.146-3.147a.5.5 0 01.708.708l-4 4a.5.5 0 01-.708 0l-4-4a.5.5 0 01.708-.708L7.5 12.293V.5A.5.5 0 018 0z" transform="rotate(180 8 8)" />
  </svg>
);

const HomeIcon = () => (
  <svg viewBox="0 0 16 16" fill="currentColor">
    <path d="M8.707 1.5a1 1 0 00-1.414 0L.646 8.146a.5.5 0 00.708.708L8 2.207l6.646 6.647a.5.5 0 00.708-.708L13 5.793V2.5a.5.5 0 00-.5-.5h-1a.5.5 0 00-.5.5v1.293L8.707 1.5z" />
    <path d="M13 7.207l-5-5-5 5V13.5a.5.5 0 00.5.5h3v-4h3v4h3a.5.5 0 00.5-.5V7.207z" />
  </svg>
);

const NewFolderIcon = () => (
  <svg viewBox="0 0 16 16" fill="currentColor">
    <path d="M11 6.5a.5.5 0 01.5-.5h2a.5.5 0 01.5.5v2a.5.5 0 01-.5.5h-2a.5.5 0 01-.5-.5v-2z" />
    <path d="M1.5 1a.5.5 0 00-.5.5v12a.5.5 0 00.5.5h13a.5.5 0 00.5-.5V3a.5.5 0 00-.5-.5H7.71l-.85-.85A.5.5 0 006.5 1h-5zm5.293 1H6.5a.5.5 0 01.354.146L8.207 3.5H13.5v10H2V2.5h4.293z" />
  </svg>
);

const UploadIcon = () => (
  <svg viewBox="0 0 16 16" fill="currentColor">
    <path d="M.5 9.9a.5.5 0 01.5.5v2.5a1 1 0 001 1h12a1 1 0 001-1v-2.5a.5.5 0 011 0v2.5a2 2 0 01-2 2H2a2 2 0 01-2-2v-2.5a.5.5 0 01.5-.5z" />
    <path d="M7.646 1.146a.5.5 0 01.708 0l3 3a.5.5 0 01-.708.708L8.5 2.707V11.5a.5.5 0 01-1 0V2.707L5.354 4.854a.5.5 0 11-.708-.708l3-3z" />
  </svg>
);

const DownloadIcon = () => (
  <svg viewBox="0 0 16 16" fill="currentColor">
    <path d="M.5 9.9a.5.5 0 01.5.5v2.5a1 1 0 001 1h12a1 1 0 001-1v-2.5a.5.5 0 011 0v2.5a2 2 0 01-2 2H2a2 2 0 01-2-2v-2.5a.5.5 0 01.5-.5z" />
    <path d="M7.646 11.854a.5.5 0 00.708 0l3-3a.5.5 0 00-.708-.708L8.5 10.293V1.5a.5.5 0 00-1 0v8.793L5.354 8.146a.5.5 0 10-.708.708l3 3z" />
  </svg>
);

const TrashIcon = () => (
  <svg viewBox="0 0 16 16" fill="currentColor">
    <path d="M5.5 5.5A.5.5 0 016 6v6a.5.5 0 01-1 0V6a.5.5 0 01.5-.5zm2.5 0a.5.5 0 01.5.5v6a.5.5 0 01-1 0V6a.5.5 0 01.5-.5zm3 .5a.5.5 0 00-1 0v6a.5.5 0 001 0V6z" />
    <path d="M14.5 3a1 1 0 01-1 1H13v9a2 2 0 01-2 2H5a2 2 0 01-2-2V4h-.5a1 1 0 01-1-1V2a1 1 0 011-1H6a1 1 0 011-1h2a1 1 0 011 1h3.5a1 1 0 011 1v1zM4.118 4L4 4.059V13a1 1 0 001 1h6a1 1 0 001-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z" />
  </svg>
);

const EditIcon = () => (
  <svg viewBox="0 0 16 16" fill="currentColor">
    <path d="M12.146.146a.5.5 0 01.708 0l3 3a.5.5 0 010 .708l-10 10a.5.5 0 01-.168.11l-5 2a.5.5 0 01-.65-.65l2-5a.5.5 0 01.11-.168l10-10zM11.207 2.5L13.5 4.793 14.793 3.5 12.5 1.207 11.207 2.5zm1.586 3L10.5 3.207 4 9.707V10h.5a.5.5 0 01.5.5v.5h.5a.5.5 0 01.5.5v.5h.293l6.5-6.5zm-9.761 5.175l-.106.106-1.528 3.821 3.821-1.528.106-.106A.5.5 0 015 12.5V12h-.5a.5.5 0 01-.5-.5V11h-.5a.5.5 0 01-.468-.325z" />
  </svg>
);

interface SftpFileBrowserProps {
  sessionId: string;
  sftpId?: string;
  initialPath?: string;
  onClose?: () => void;
}

export const SftpFileBrowser: React.FC<SftpFileBrowserProps> = ({
  sessionId,
  sftpId,
  initialPath,
  onClose: _onClose,
}) => {
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentPath, setCurrentPath] = useState(initialPath || '/');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [selectedEntry, setSelectedEntry] = useState<FileEntry | null>(null);
  const [homeDir, setHomeDir] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    entry: FileEntry | null;
  } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [showNewFolderDialog, setShowNewFolderDialog] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [renamingEntry, setRenamingEntry] = useState<FileEntry | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [transfers, setTransfers] = useState<TransferItem[]>([]);
  const [isTransferMinimized, setIsTransferMinimized] = useState(false);
  const transferIdRef = useRef(0);

  const sftp = sftpId || sessionId;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Connect on mount
  useEffect(() => {
    const connect = async () => {
      try {
        setLoading(true);
        setError(null);
        const result = await sftpConnect(sftp, sessionId);
        setConnected(result.connected);
        if (result.home_dir) {
          setHomeDir(result.home_dir);
          setCurrentPath(result.home_dir);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Connection failed');
      } finally {
        setLoading(false);
      }
    };
    connect();

    // Disconnect on unmount
    return () => {
      sftpDisconnect(sftp).catch(console.error);
    };
  }, [sftp, sessionId]);

  // Load directory when path changes
  useEffect(() => {
    if (!connected) return;

    const loadDir = async () => {
      try {
        setLoading(true);
        setError(null);
        const result = await sftpLs(sftp, currentPath);
        setEntries(result.entries);
        setSelectedEntry(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load directory');
      } finally {
        setLoading(false);
      }
    };
    loadDir();
  }, [sftp, currentPath, connected]);

  // Refresh current directory
  const refresh = useCallback(async () => {
    if (!connected) return;
    try {
      setLoading(true);
      const result = await sftpLs(sftp, currentPath);
      setEntries(result.entries);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to refresh');
    } finally {
      setLoading(false);
    }
  }, [sftp, currentPath, connected]);

  // Navigate to directory
  const navigateTo = useCallback((path: string) => {
    setCurrentPath(path);
  }, []);

  // Go up one level
  const goUp = useCallback(() => {
    const parts = currentPath.split('/').filter(Boolean);
    if (parts.length > 0) {
      parts.pop();
      setCurrentPath('/' + parts.join('/'));
    }
  }, [currentPath]);

  // Go to home
  const goHome = useCallback(() => {
    if (homeDir) {
      setCurrentPath(homeDir);
    }
  }, [homeDir]);

  // Handle double click on entry
  const handleDoubleClick = useCallback(
    (entry: FileEntry) => {
      if (entry.is_dir) {
        navigateTo(entry.path);
      } else {
        // Download file
        handleDownload(entry);
      }
    },
    [navigateTo]
  );

  // Handle transfer cancellation
  const handleCancelTransfer = useCallback((id: string) => {
    setTransfers(prev => prev.map(t =>
      t.id === id && (t.status === 'active' || t.status === 'pending')
        ? { ...t, status: 'cancelled' as const }
        : t
    ));
  }, []);

  // Handle clearing individual transfer
  const handleClearTransfer = useCallback((id: string) => {
    setTransfers(prev => prev.filter(t => t.id !== id));
  }, []);

  // Handle clearing all completed transfers
  const handleClearAllTransfers = useCallback(() => {
    setTransfers(prev => prev.filter(t => t.status === 'active' || t.status === 'pending'));
  }, []);

  // Handle download
  const handleDownload = async (entry: FileEntry) => {
    const transferId = `download-${++transferIdRef.current}`;
    const newTransfer: TransferItem = {
      id: transferId,
      filename: entry.name,
      path: entry.path,
      size: entry.size,
      type: 'download',
      status: 'active',
      progress: 0,
      bytesTransferred: 0,
      startTime: Date.now(),
    };

    setTransfers(prev => [...prev, newTransfer]);
    setIsTransferMinimized(false);

    try {
      // Simulate progress updates (actual progress would need backend streaming support)
      const progressInterval = setInterval(() => {
        setTransfers(prev => prev.map(t => {
          if (t.id !== transferId || t.status !== 'active') return t;
          const newProgress = Math.min(t.progress + Math.random() * 15, 95);
          return {
            ...t,
            progress: newProgress,
            bytesTransferred: Math.floor((newProgress / 100) * t.size),
          };
        }));
      }, 200);

      const blob = await sftpDownload(sftp, entry.path);
      clearInterval(progressInterval);

      // Check if cancelled
      const currentTransfer = transfers.find(t => t.id === transferId);
      if (currentTransfer?.status === 'cancelled') {
        return;
      }

      // Mark as completed
      setTransfers(prev => prev.map(t =>
        t.id === transferId
          ? { ...t, status: 'completed' as const, progress: 100, bytesTransferred: entry.size }
          : t
      ));

      // Trigger browser download
      downloadFile(blob, entry.name);
    } catch (err) {
      setTransfers(prev => prev.map(t =>
        t.id === transferId
          ? { ...t, status: 'error' as const, error: err instanceof Error ? err.message : 'Download failed' }
          : t
      ));
      setError(err instanceof Error ? err.message : 'Download failed');
    }
  };

  // Handle upload
  const handleUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;

    setIsTransferMinimized(false);

    // Create transfer items for all files
    const newTransfers: TransferItem[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const transferId = `upload-${++transferIdRef.current}`;
      const path = currentPath === '/' ? `/${file.name}` : `${currentPath}/${file.name}`;
      newTransfers.push({
        id: transferId,
        filename: file.name,
        path: path,
        size: file.size,
        type: 'upload',
        status: i === 0 ? 'active' : 'pending',
        progress: 0,
        bytesTransferred: 0,
        startTime: i === 0 ? Date.now() : undefined,
      });
    }

    setTransfers(prev => [...prev, ...newTransfers]);

    // Process uploads sequentially
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const transfer = newTransfers[i];

      // Mark as active if not first
      if (i > 0) {
        setTransfers(prev => prev.map(t =>
          t.id === transfer.id
            ? { ...t, status: 'active' as const, startTime: Date.now() }
            : t
        ));
      }

      // Check if cancelled before starting
      const currentState = transfers.find(t => t.id === transfer.id);
      if (currentState?.status === 'cancelled') {
        continue;
      }

      try {
        // Simulate progress updates
        const progressInterval = setInterval(() => {
          setTransfers(prev => prev.map(t => {
            if (t.id !== transfer.id || t.status !== 'active') return t;
            const newProgress = Math.min(t.progress + Math.random() * 15, 95);
            return {
              ...t,
              progress: newProgress,
              bytesTransferred: Math.floor((newProgress / 100) * t.size),
            };
          }));
        }, 200);

        const buffer = await file.arrayBuffer();
        await sftpUpload(sftp, transfer.path, buffer);
        clearInterval(progressInterval);

        // Mark as completed
        setTransfers(prev => prev.map(t =>
          t.id === transfer.id
            ? { ...t, status: 'completed' as const, progress: 100, bytesTransferred: file.size }
            : t
        ));
      } catch (err) {
        setTransfers(prev => prev.map(t =>
          t.id === transfer.id
            ? { ...t, status: 'error' as const, error: err instanceof Error ? err.message : 'Upload failed' }
            : t
        ));
        setError(err instanceof Error ? err.message : 'Upload failed');
      }
    }

    await refresh();
  };

  // Handle new folder
  const handleNewFolder = async () => {
    if (!newFolderName.trim()) return;

    try {
      setLoading(true);
      const path =
        currentPath === '/' ? `/${newFolderName}` : `${currentPath}/${newFolderName}`;
      await sftpMkdir(sftp, path);
      setShowNewFolderDialog(false);
      setNewFolderName('');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create folder');
    } finally {
      setLoading(false);
    }
  };

  // Handle delete
  const handleDelete = async (entry: FileEntry) => {
    try {
      setLoading(true);
      await sftpRm(sftp, entry.path, entry.is_dir);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setLoading(false);
    }
  };

  // Handle rename
  const startRename = (entry: FileEntry) => {
    setRenamingEntry(entry);
    setRenameValue(entry.name);
    setContextMenu(null);
    setTimeout(() => renameInputRef.current?.select(), 0);
  };

  const finishRename = async () => {
    if (!renamingEntry || !renameValue.trim() || renameValue === renamingEntry.name) {
      setRenamingEntry(null);
      return;
    }

    try {
      setLoading(true);
      const parentPath = renamingEntry.path.substring(
        0,
        renamingEntry.path.lastIndexOf('/')
      );
      const newPath = parentPath === '' ? `/${renameValue}` : `${parentPath}/${renameValue}`;
      await sftpRename(sftp, renamingEntry.path, newPath);
      setRenamingEntry(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Rename failed');
    } finally {
      setLoading(false);
    }
  };

  // Handle context menu
  const handleContextMenu = (e: React.MouseEvent, entry: FileEntry | null) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, entry });
  };

  // Handle drag & drop
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    handleUpload(e.dataTransfer.files);
  };

  // Close context menu on click outside
  useEffect(() => {
    const handleClick = () => setContextMenu(null);
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, []);

  // Build breadcrumbs
  const breadcrumbs = [
    { name: '/', path: '/' },
    ...currentPath
      .split('/')
      .filter(Boolean)
      .map((part, i, arr) => ({
        name: part,
        path: '/' + arr.slice(0, i + 1).join('/'),
      })),
  ];

  if (loading && !connected) {
    return (
      <div className="sftp-browser">
        <div className="sftp-loading">
          <div className="sftp-spinner" />
          <span>Connecting to SFTP...</span>
        </div>
      </div>
    );
  }

  if (error && !connected) {
    return (
      <div className="sftp-browser">
        <div className="sftp-error">
          <span>{error}</span>
          <button onClick={() => window.location.reload()}>Retry</button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="sftp-browser"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onContextMenu={(e) => handleContextMenu(e, null)}
    >
      {/* Toolbar */}
      <div className="sftp-toolbar">
        <button className="sftp-toolbar-btn" onClick={goUp} title="Go up">
          <UpIcon />
        </button>
        <button className="sftp-toolbar-btn" onClick={goHome} title="Go home">
          <HomeIcon />
        </button>
        <button className="sftp-toolbar-btn" onClick={refresh} disabled={loading} title="Refresh">
          <RefreshIcon />
        </button>
        <input
          className="sftp-path-input"
          value={currentPath}
          onChange={(e) => setCurrentPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              navigateTo(currentPath);
            }
          }}
        />
        <button
          className="sftp-toolbar-btn"
          onClick={() => setShowNewFolderDialog(true)}
          title="New folder"
        >
          <NewFolderIcon />
        </button>
        <button
          className="sftp-toolbar-btn"
          onClick={() => fileInputRef.current?.click()}
          title="Upload"
        >
          <UploadIcon />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => handleUpload(e.target.files)}
        />
      </div>

      {/* Breadcrumbs */}
      <div className="sftp-breadcrumbs">
        {breadcrumbs.map((crumb, i) => (
          <React.Fragment key={crumb.path}>
            {i > 0 && <span className="sftp-breadcrumb-sep">/</span>}
            <button
              className={`sftp-breadcrumb ${i === breadcrumbs.length - 1 ? 'active' : ''}`}
              onClick={() => navigateTo(crumb.path)}
            >
              {crumb.name}
            </button>
          </React.Fragment>
        ))}
      </div>

      {/* File list */}
      <div className="sftp-file-list">
        <div className="sftp-file-header">
          <span></span>
          <span>Name</span>
          <span>Size</span>
          <span>Permissions</span>
          <span>Modified</span>
        </div>

        {loading ? (
          <div className="sftp-loading">
            <div className="sftp-spinner" />
          </div>
        ) : entries.length === 0 ? (
          <div className="sftp-empty">
            <FolderIcon />
            <span>Empty directory</span>
          </div>
        ) : (
          entries.map((entry) => (
            <div
              key={entry.path}
              className={`sftp-file-row ${selectedEntry?.path === entry.path ? 'selected' : ''}`}
              onClick={() => setSelectedEntry(entry)}
              onDoubleClick={() => handleDoubleClick(entry)}
              onContextMenu={(e) => handleContextMenu(e, entry)}
            >
              <div className={`sftp-file-icon ${entry.is_dir ? 'folder' : 'file'}`}>
                {entry.is_dir ? <FolderIcon /> : <FileIcon />}
              </div>
              <div className="sftp-file-name">
                {renamingEntry?.path === entry.path ? (
                  <input
                    ref={renameInputRef}
                    className="sftp-rename-input"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={finishRename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') finishRename();
                      if (e.key === 'Escape') setRenamingEntry(null);
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  entry.name
                )}
              </div>
              <div className="sftp-file-size">
                {entry.is_dir ? '-' : formatFileSize(entry.size)}
              </div>
              <div className="sftp-file-perms">{formatPermissions(entry.permissions)}</div>
              <div className="sftp-file-modified">{formatTimestamp(entry.modified)}</div>
            </div>
          ))
        )}
      </div>

      {/* Status bar */}
      <div className="sftp-status-bar">
        <div className="sftp-status-left">
          <span>{entries.length} items</span>
          {selectedEntry && <span>Selected: {selectedEntry.name}</span>}
        </div>
        <div className="sftp-status-right">
          <span>SFTP</span>
        </div>
      </div>

      {/* Drop zone overlay */}
      {isDragging && (
        <div className="sftp-drop-zone">
          <div className="sftp-drop-zone-text">Drop files to upload</div>
        </div>
      )}

      {/* Context menu */}
      {contextMenu && (
        <div
          className="sftp-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {contextMenu.entry ? (
            <>
              {!contextMenu.entry.is_dir && (
                <div
                  className="sftp-context-item"
                  onClick={() => {
                    handleDownload(contextMenu.entry!);
                    setContextMenu(null);
                  }}
                >
                  <DownloadIcon /> Download
                </div>
              )}
              <div
                className="sftp-context-item"
                onClick={() => startRename(contextMenu.entry!)}
              >
                <EditIcon /> Rename
              </div>
              <div className="sftp-context-sep" />
              <div
                className="sftp-context-item danger"
                onClick={() => {
                  handleDelete(contextMenu.entry!);
                  setContextMenu(null);
                }}
              >
                <TrashIcon /> Delete
              </div>
            </>
          ) : (
            <>
              <div
                className="sftp-context-item"
                onClick={() => {
                  setShowNewFolderDialog(true);
                  setContextMenu(null);
                }}
              >
                <NewFolderIcon /> New Folder
              </div>
              <div
                className="sftp-context-item"
                onClick={() => {
                  fileInputRef.current?.click();
                  setContextMenu(null);
                }}
              >
                <UploadIcon /> Upload Files
              </div>
              <div className="sftp-context-sep" />
              <div
                className="sftp-context-item"
                onClick={() => {
                  refresh();
                  setContextMenu(null);
                }}
              >
                <RefreshIcon /> Refresh
              </div>
            </>
          )}
        </div>
      )}

      {/* New folder dialog */}
      {showNewFolderDialog && (
        <div className="sftp-dialog-overlay" onClick={() => setShowNewFolderDialog(false)}>
          <div className="sftp-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>New Folder</h3>
            <input
              type="text"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              placeholder="Folder name"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleNewFolder();
                if (e.key === 'Escape') setShowNewFolderDialog(false);
              }}
            />
            <div className="sftp-dialog-buttons">
              <button className="secondary" onClick={() => setShowNewFolderDialog(false)}>
                Cancel
              </button>
              <button className="primary" onClick={handleNewFolder}>
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Transfer progress */}
      <TransferProgress
        transfers={transfers}
        onCancel={handleCancelTransfer}
        onClear={handleClearTransfer}
        onClearAll={handleClearAllTransfers}
        onMinimize={() => setIsTransferMinimized(!isTransferMinimized)}
        isMinimized={isTransferMinimized}
      />
    </div>
  );
};

export default SftpFileBrowser;
