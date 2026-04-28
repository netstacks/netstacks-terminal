import React, { useState, useEffect, useRef, useCallback } from 'react';
import { listIncidents } from '../api/incidents';
import type { Incident } from '../types/incidents';
import { formatRelativeTime } from '../lib/enrichmentHelpers';
import './IncidentsPanel.css';

interface IncidentsPanelProps {
  onOpenIncidentTab: (id?: string) => void;
}

export const IncidentsPanel: React.FC<IncidentsPanelProps> = ({ onOpenIncidentTab }) => {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isMountedRef = useRef(true);
  const intervalRef = useRef<number | null>(null);

  const fetchIncidents = useCallback(async () => {
    if (!isMountedRef.current) return;

    try {
      const result = await listIncidents(1, 50);

      if (!isMountedRef.current) return;

      setIncidents(result.data);
      setError(null);
      setIsLoading(false);
    } catch (err) {
      if (!isMountedRef.current) return;

      const message = err instanceof Error ? err.message : 'Failed to load incidents';
      setError(message);
      setIsLoading(false);
    }
  }, []);

  const handleRefresh = () => {
    setIsLoading(true);
    fetchIncidents();
  };

  const handleRowClick = (incidentId: string) => {
    onOpenIncidentTab(incidentId);
  };

  const handleCreateClick = () => {
    onOpenIncidentTab();
  };

  // Initial fetch and polling setup
  useEffect(() => {
    isMountedRef.current = true;
    fetchIncidents();

    // Poll every 30 seconds
    intervalRef.current = window.setInterval(() => {
      fetchIncidents();
    }, 30000);

    return () => {
      isMountedRef.current = false;
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
      }
    };
  }, [fetchIncidents]);

  const getSeverityColor = (severity: string): string => {
    switch (severity) {
      case 'critical':
        return '#f44336';
      case 'high':
        return '#ff9800';
      case 'medium':
        return '#ffc107';
      case 'low':
        return '#2196f3';
      default:
        return '#9e9e9e';
    }
  };

  const getStateColor = (state: string): string => {
    switch (state) {
      case 'open':
        return '#f44336';
      case 'acknowledged':
        return '#ff9800';
      case 'in_progress':
        return '#2196f3';
      case 'resolved':
        return '#4caf50';
      case 'closed':
        return '#9e9e9e';
      default:
        return '#9e9e9e';
    }
  };

  return (
    <div className="incidents-panel">
      <div className="incidents-panel-header">
        <div className="incidents-panel-title">Incidents</div>
        <div className="incidents-panel-header-actions">
          <button
            className="incidents-panel-create-btn"
            onClick={handleCreateClick}
            title="Create Incident"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
          <button
            className="incidents-panel-refresh-btn"
            onClick={handleRefresh}
            disabled={isLoading}
            title="Refresh"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="23 4 23 10 17 10" />
              <polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
            </svg>
          </button>
        </div>
      </div>

      {isLoading && incidents.length === 0 && (
        <div className="incidents-panel-loading">
          <div className="incidents-panel-spinner" />
          <span>Loading...</span>
        </div>
      )}

      {error && (
        <div className="incidents-panel-error">
          <div>Error: {error}</div>
          <button onClick={handleRefresh}>Retry</button>
        </div>
      )}

      {!isLoading && !error && incidents.length === 0 && (
        <div className="incidents-panel-empty">No incidents</div>
      )}

      {!error && incidents.length > 0 && (
        <div className="incidents-panel-list">
          {incidents.map((incident) => (
            <div
              key={incident.id}
              className="incidents-panel-row"
              onClick={() => handleRowClick(incident.id)}
            >
              <div className="incidents-panel-row-header">
                <div className="incidents-panel-row-title">{incident.title}</div>
                <div className="incidents-panel-row-badges">
                  <span
                    className="incidents-panel-severity-badge"
                    style={{ backgroundColor: getSeverityColor(incident.severity) }}
                  >
                    {incident.severity}
                  </span>
                  <span
                    className="incidents-panel-state-badge"
                    style={{ backgroundColor: getStateColor(incident.state) }}
                  >
                    {incident.state}
                  </span>
                </div>
              </div>
              <div className="incidents-panel-row-time">
                {formatRelativeTime(new Date(incident.created_at))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
