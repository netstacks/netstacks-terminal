// TopologyPanel - Sidebar panel for saved topologies and device list
import { useState, useEffect, useCallback } from 'react';
import { listTopologies, deleteTopology, updateTopologyName, shareTopology, type SavedTopologyListItem } from '../api/topology';
import { getCurrentMode } from '../api/client';
import NewTopologyDialog from './NewTopologyDialog';
import TracerouteDialog from './TracerouteDialog';
import type { Topology, Device, DeviceStatus } from '../types/topology';
import './TopologyPanel.css';

interface TopologyPanelProps {
  // Active topology (when a topology tab is open)
  activeTopology?: Topology | null;
  selectedDeviceId?: string | null;
  onDeviceSelect?: (device: Device) => void;
  onDeviceConnect?: (device: Device) => void;
  // Open topology as tab (optional - provides saved topologies list if provided)
  onOpenTopology?: (topologyId: string, topologyName: string) => void;
  // Open traceroute topology (in-memory)
  onOpenTracerouteTopology?: (topology: Topology) => void;
  // Start discovery for new topology
  onStartDiscovery?: (name: string, sessions: { id: string; name: string; host?: string; profileId?: string; cliFlavor?: string; credentialId?: string; snmpCredentialId?: string }[]) => void;
  // Connected session IDs for session picker
  connectedSessionIds?: string[];
}

// Device status colors
const STATUS_COLORS: Record<DeviceStatus, string> = {
  online: '#4caf50',
  offline: '#f44336',
  warning: '#ff9800',
  unknown: '#9e9e9e',
};

// Icons
const Icons = {
  plus: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  ),
  route: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="5" cy="12" r="2" />
      <circle cx="12" cy="12" r="2" />
      <circle cx="19" cy="12" r="2" />
      <path d="M7 12h3M14 12h3" strokeDasharray="2 2" />
    </svg>
  ),
  refresh: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
    </svg>
  ),
  search: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  ),
  x: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  ),
};

export default function TopologyPanel({
  activeTopology,
  selectedDeviceId,
  onDeviceSelect,
  onDeviceConnect,
  onOpenTopology,
  onOpenTracerouteTopology,
  onStartDiscovery,
  connectedSessionIds = [],
}: TopologyPanelProps) {
  const currentTopology = activeTopology ?? null;
  const isEnterprise = getCurrentMode() === 'enterprise';
  const [topologies, setTopologies] = useState<SavedTopologyListItem[]>([]);
  const [teamTopologies, setTeamTopologies] = useState<SavedTopologyListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [newDialogOpen, setNewDialogOpen] = useState(false);
  const [tracerouteDialogOpen, setTracerouteDialogOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [contextMenu, setContextMenu] = useState<{
    topology: SavedTopologyListItem;
    position: { x: number; y: number };
  } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  // Load topologies list
  const loadTopologies = useCallback(async () => {
    try {
      setLoading(true);
      const data = await listTopologies();
      setTopologies(data);
      // In enterprise mode, also load shared team topologies
      if (isEnterprise) {
        const shared = await listTopologies({ shared: true });
        // Exclude own topologies (they're already in the personal list)
        const ownIds = new Set(data.map(t => t.id));
        setTeamTopologies(shared.filter(t => !ownIds.has(t.id)));
      }
    } catch (err) {
      console.error('Failed to load topologies:', err);
    } finally {
      setLoading(false);
    }
  }, [isEnterprise]);

  useEffect(() => {
    loadTopologies();
  }, [loadTopologies]);

  // Filter topologies by search
  const filteredTopologies = topologies.filter(t =>
    t.name.toLowerCase().includes(searchQuery.toLowerCase())
  );
  const filteredTeamTopologies = teamTopologies.filter(t =>
    t.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Handle context menu
  const handleContextMenu = (e: React.MouseEvent, topology: SavedTopologyListItem) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      topology,
      position: { x: e.clientX, y: e.clientY },
    });
  };

  // Close context menu
  const closeContextMenu = () => setContextMenu(null);

  // Handle rename
  const handleRename = (topology: SavedTopologyListItem) => {
    setRenaming(topology.id);
    setRenameValue(topology.name);
    closeContextMenu();
  };

  const submitRename = async (id: string) => {
    if (!renameValue.trim()) return;
    try {
      await updateTopologyName(id, renameValue.trim());
      setTopologies(prev =>
        prev.map(t => t.id === id ? { ...t, name: renameValue.trim() } : t)
      );
    } catch (err) {
      console.error('Failed to rename topology:', err);
    }
    setRenaming(null);
  };

  // Handle delete
  const handleDelete = async (topology: SavedTopologyListItem) => {
    closeContextMenu();
    try {
      await deleteTopology(topology.id);
      setTopologies(prev => prev.filter(t => t.id !== topology.id));
    } catch (err) {
      console.error('Failed to delete topology:', err);
    }
  };

  // Handle share/unshare (enterprise mode)
  const handleShare = async (topology: SavedTopologyListItem) => {
    closeContextMenu();
    const newShared = !topology.shared;
    try {
      await shareTopology(topology.id, newShared);
      setTopologies(prev =>
        prev.map(t => t.id === topology.id ? { ...t, shared: newShared } : t)
      );
    } catch (err) {
      console.error('Failed to share topology:', err);
    }
  };

  return (
    <div className="topology-panel" data-testid="topology-panel" onClick={closeContextMenu}>
      {/* Toolbar */}
      <div className="topology-panel-toolbar">
        <button
          className="topology-panel-btn icon-only primary"
          onClick={() => setNewDialogOpen(true)}
          title="New Topology"
        >
          {Icons.plus}
        </button>
        <button
          className="topology-panel-btn icon-only"
          onClick={() => setTracerouteDialogOpen(true)}
          title="Paste Traceroute / MTR"
        >
          {Icons.route}
        </button>
        <button
          className="topology-panel-btn icon-only"
          onClick={loadTopologies}
          title="Refresh"
          disabled={loading}
        >
          {Icons.refresh}
        </button>
      </div>

      {/* Search */}
      <div className="topology-search">
        <span className="topology-search-icon">{Icons.search}</span>
        <input
          type="text"
          className="topology-search-input"
          placeholder="Search topologies..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        {searchQuery && (
          <button
            className="topology-search-clear"
            onClick={() => setSearchQuery('')}
            title="Clear search"
          >
            {Icons.x}
          </button>
        )}
      </div>

      {/* Topology List */}
      <div className="topology-list">
        {loading ? (
          <div className="topology-panel-status">Loading...</div>
        ) : filteredTopologies.length === 0 ? (
          <div className="topology-panel-empty">
            {searchQuery ? `No topologies match "${searchQuery}"` : 'No saved topologies'}
          </div>
        ) : (
          filteredTopologies.map(topo => (
            <div
              key={topo.id}
              className={`topology-item ${currentTopology?.id === topo.id ? 'active' : ''}`}
              onClick={() => onOpenTopology?.(topo.id, topo.name)}
              onContextMenu={e => handleContextMenu(e, topo)}
            >
              <span className="topology-icon">&#128208;</span>
              {renaming === topo.id ? (
                <input
                  className="rename-input"
                  value={renameValue}
                  onChange={e => setRenameValue(e.target.value)}
                  onBlur={() => submitRename(topo.id)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') submitRename(topo.id);
                    if (e.key === 'Escape') setRenaming(null);
                  }}
                  autoFocus
                  onClick={e => e.stopPropagation()}
                />
              ) : (
                <>
                  <span className="topology-name">{topo.name}</span>
                  {isEnterprise && topo.shared && (
                    <span className="topology-shared-badge" title="Published to team">shared</span>
                  )}
                </>
              )}
            </div>
          ))
        )}

        {/* Search results count */}
        {searchQuery && filteredTopologies.length > 0 && (
          <div className="topology-search-results">
            {filteredTopologies.length} topology{filteredTopologies.length !== 1 ? 'ies' : ''} found
          </div>
        )}
      </div>

      {/* Team Topologies (enterprise mode) */}
      {isEnterprise && filteredTeamTopologies.length > 0 && (
        <div className="panel-section">
          <div className="section-header">
            <span>TEAM TOPOLOGIES</span>
          </div>
          <div className="topology-list">
            {filteredTeamTopologies.map(topo => (
              <div
                key={topo.id}
                className={`topology-item team ${currentTopology?.id === topo.id ? 'active' : ''}`}
                onClick={() => onOpenTopology?.(topo.id, topo.name)}
              >
                <span className="topology-icon">&#128208;</span>
                <span className="topology-name">{topo.name}</span>
                <span className="topology-shared-badge">team</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Devices Section (when topology tab is active) */}
      {currentTopology && (
        <div className="panel-section">
          <div className="section-header">
            <span>DEVICES ({currentTopology.name})</span>
          </div>
          <div className="device-list">
            {currentTopology.devices.map(device => (
              <div
                key={device.id}
                className={`device-item ${selectedDeviceId === device.id ? 'selected' : ''}`}
                onClick={() => onDeviceSelect?.(device)}
                onDoubleClick={() => onDeviceConnect?.(device)}
              >
                <span
                  className="status-indicator"
                  style={{ backgroundColor: STATUS_COLORS[device.status] }}
                />
                <span className="device-name">{device.name}</span>
                <span className="device-status">
                  {device.sessionId ? '(connected)' : '(no session)'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Context Menu */}
      {contextMenu && (
        <div
          className="context-menu"
          style={{ top: contextMenu.position.y, left: contextMenu.position.x }}
        >
          <div className="context-menu-item" onClick={() => handleRename(contextMenu.topology)}>
            Rename
          </div>
          {isEnterprise && (
            <div className="context-menu-item" onClick={() => handleShare(contextMenu.topology)}>
              {contextMenu.topology.shared ? 'Unpublish' : 'Publish to Team'}
            </div>
          )}
          <div className="context-menu-item danger" onClick={() => handleDelete(contextMenu.topology)}>
            Delete
          </div>
        </div>
      )}

      {/* New Topology Dialog — picks sessions then opens discovery */}
      <NewTopologyDialog
        isOpen={newDialogOpen}
        onClose={() => setNewDialogOpen(false)}
        onStartDiscovery={(name, sessions) => {
          setNewDialogOpen(false);
          onStartDiscovery?.(name, sessions);
        }}
        connectedSessionIds={connectedSessionIds}
      />

      {/* Traceroute Dialog */}
      <TracerouteDialog
        isOpen={tracerouteDialogOpen}
        onClose={() => setTracerouteDialogOpen(false)}
        onVisualize={(newTopology) => {
          onOpenTracerouteTopology?.(newTopology);
          setTracerouteDialogOpen(false);
        }}
      />
    </div>
  );
}
