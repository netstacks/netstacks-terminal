// ConnectionDetailsOverlay - Floating overlay showing connection/link details on click
// Part of the immersive topology interaction system

import { useEffect, type ReactNode } from 'react';
import type { Connection, ConnectionStatus, ProtocolSession, ProtocolType, ProtocolState } from '../types/topology';
import './ConnectionDetailsOverlay.css';

interface ConnectionDetailsOverlayProps {
  /** Connection to display details for */
  connection: Connection | null;
  /** Source device name */
  sourceDeviceName?: string;
  /** Target device name */
  targetDeviceName?: string;
  /** Screen position to anchor the overlay */
  position: { x: number; y: number } | null;
  /** Close handler */
  onClose: () => void;
}

/** Status to color mapping */
const STATUS_COLORS: Record<ConnectionStatus, string> = {
  active: '#4caf50',
  inactive: '#f44336',
  degraded: '#ff9800',
};

/** Protocol type to icon mapping */
const PROTOCOL_ICONS: Record<ProtocolType, ReactNode> = {
  bgp: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="12" cy="12" r="8" />
      <path d="M12 4v16M4 12h16" />
    </svg>
  ),
  ospf: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <polygon points="12 2 22 12 12 22 2 12" />
    </svg>
  ),
  stp: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="12" cy="6" r="4" />
      <path d="M12 10v4M8 18h8M8 22h8" />
    </svg>
  ),
  vxlan: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M4 12h16M4 6h16M4 18h16" strokeDasharray="2 2" />
      <circle cx="8" cy="12" r="2" />
      <circle cx="16" cy="12" r="2" />
    </svg>
  ),
  generic: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M8 12h8M12 8v8" />
    </svg>
  ),
};

/** Protocol state to badge style */
const STATE_BADGE_COLORS: Record<ProtocolState, { bg: string; text: string }> = {
  established: { bg: 'rgba(76, 175, 80, 0.2)', text: '#4caf50' },
  active: { bg: 'rgba(76, 175, 80, 0.2)', text: '#4caf50' },
  idle: { bg: 'rgba(158, 158, 158, 0.2)', text: '#9e9e9e' },
  down: { bg: 'rgba(244, 67, 54, 0.2)', text: '#f44336' },
};

export default function ConnectionDetailsOverlay({
  connection,
  sourceDeviceName,
  targetDeviceName,
  position,
  onClose,
}: ConnectionDetailsOverlayProps) {
  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    if (connection && position) {
      document.addEventListener('keydown', handleKeyDown);
      return () => document.removeEventListener('keydown', handleKeyDown);
    }
  }, [connection, position, onClose]);

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.connection-details-overlay')) {
        onClose();
      }
    };

    if (connection && position) {
      // Delay to prevent immediate close
      setTimeout(() => {
        document.addEventListener('mousedown', handleClickOutside);
      }, 0);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [connection, position, onClose]);

  if (!connection || !position) return null;

  // Adjust position to keep overlay in viewport
  const overlayWidth = 320;
  const overlayHeight = 300;
  const adjustedX = Math.min(position.x + 10, window.innerWidth - overlayWidth - 20);
  const adjustedY = Math.min(position.y - 20, window.innerHeight - overlayHeight - 20);

  const srcName = sourceDeviceName || connection.sourceDeviceId;
  const tgtName = targetDeviceName || connection.targetDeviceId;

  return (
    <div
      className="connection-details-overlay"
      style={{
        left: Math.max(20, adjustedX),
        top: Math.max(20, adjustedY),
      }}
    >
      {/* Header */}
      <div className="connection-details-header">
        <div className="connection-details-link-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
          </svg>
        </div>
        <div className="connection-details-title">
          <h3>{srcName} ↔ {tgtName}</h3>
          <span className="connection-details-label">{connection.label || 'Link'}</span>
        </div>
        <div
          className="connection-details-status"
          style={{ backgroundColor: STATUS_COLORS[connection.status] }}
          title={connection.status}
        />
        <button className="connection-details-close" onClick={onClose} title="Close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Interface Info */}
      <div className="connection-details-interfaces">
        <div className="connection-details-interface">
          <span className="connection-details-interface-device">{srcName}</span>
          <span className="connection-details-interface-name">
            {connection.sourceInterface || 'N/A'}
          </span>
        </div>
        <div className="connection-details-arrow">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M5 12h14M12 5l7 7-7 7" />
          </svg>
        </div>
        <div className="connection-details-interface">
          <span className="connection-details-interface-device">{tgtName}</span>
          <span className="connection-details-interface-name">
            {connection.targetInterface || 'N/A'}
          </span>
        </div>
      </div>

      {/* Protocol Sessions */}
      {connection.protocols && connection.protocols.length > 0 && (
        <div className="connection-details-protocols">
          <div className="connection-details-section-title">Protocol Sessions</div>
          <div className="connection-details-protocol-list">
            {connection.protocols.map((proto, i) => (
              <ProtocolBadge key={i} protocol={proto} />
            ))}
          </div>
        </div>
      )}

      {/* NetBox References */}
      {(connection.cableId || connection.circuitId) && (
        <div className="connection-details-refs">
          {connection.cableId && (
            <div className="connection-details-ref">
              <span className="connection-details-ref-label">Cable ID</span>
              <span className="connection-details-ref-value">{connection.cableId}</span>
            </div>
          )}
          {connection.circuitId && (
            <div className="connection-details-ref">
              <span className="connection-details-ref-label">Circuit</span>
              <span className="connection-details-ref-value">{connection.circuitId}</span>
            </div>
          )}
        </div>
      )}

      {/* Statistics Placeholder */}
      <div className="connection-details-stats">
        <div className="connection-details-section-title">Traffic Statistics</div>
        <div className="connection-details-placeholder">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M18 20V10M12 20V4M6 20v-6" />
          </svg>
          <span>Statistics will be available when connected to monitoring</span>
        </div>
      </div>
    </div>
  );
}

/** Individual protocol session badge */
function ProtocolBadge({ protocol }: { protocol: ProtocolSession }) {
  const stateColors = STATE_BADGE_COLORS[protocol.state] || STATE_BADGE_COLORS.idle;

  return (
    <div className="connection-details-protocol">
      <div className="connection-details-protocol-icon">
        {PROTOCOL_ICONS[protocol.protocol] || PROTOCOL_ICONS.generic}
      </div>
      <div className="connection-details-protocol-info">
        <span className="connection-details-protocol-type">
          {protocol.protocol.toUpperCase()}
        </span>
        {protocol.label && (
          <span className="connection-details-protocol-label">{protocol.label}</span>
        )}
      </div>
      <span
        className="connection-details-protocol-state"
        style={{
          backgroundColor: stateColors.bg,
          color: stateColors.text,
        }}
      >
        {protocol.state}
      </span>
    </div>
  );
}
