import React, { useState, useEffect, useRef, useCallback } from 'react';
import { listAlerts } from '../api/alerts';
import type { Alert, AlertState } from '../types/incidents';
import { formatRelativeTime } from '../lib/enrichmentHelpers';
import './AlertsPanel.css';

interface AlertsPanelProps {
  onOpenAlertTab: (id: string) => void;
}

type FilterState = 'all' | AlertState;

export const AlertsPanel: React.FC<AlertsPanelProps> = ({ onOpenAlertTab }) => {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stateFilter, setStateFilter] = useState<FilterState>('all');
  const isMountedRef = useRef(true);
  const intervalRef = useRef<number | null>(null);

  const fetchAlerts = useCallback(async () => {
    if (!isMountedRef.current) return;

    try {
      const filters: Record<string, unknown> = {};
      if (stateFilter !== 'all') {
        filters.state = stateFilter;
      }

      const result = await listAlerts(1, 50, filters);

      if (!isMountedRef.current) return;

      setAlerts(result.data);
      setError(null);
      setIsLoading(false);
    } catch (err) {
      if (!isMountedRef.current) return;

      const message = err instanceof Error ? err.message : 'Failed to load alerts';
      setError(message);
      setIsLoading(false);
    }
  }, [stateFilter]);

  const handleRefresh = () => {
    setIsLoading(true);
    fetchAlerts();
  };

  const handleRowClick = (alertId: string) => {
    onOpenAlertTab(alertId);
  };

  const handleFilterChange = (filter: FilterState) => {
    setStateFilter(filter);
    setIsLoading(true);
  };

  // Initial fetch and polling setup
  useEffect(() => {
    isMountedRef.current = true;
    fetchAlerts();

    // Poll every 15 seconds
    intervalRef.current = window.setInterval(() => {
      fetchAlerts();
    }, 15000);

    return () => {
      isMountedRef.current = false;
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
      }
    };
  }, [fetchAlerts]);

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
      case 'info':
        return '#9e9e9e';
      default:
        return '#9e9e9e';
    }
  };

  const getStateColor = (state: string): string => {
    switch (state) {
      case 'active':
      case 'open':
        return '#f44336';
      case 'acknowledged':
        return '#ff9800';
      case 'resolved':
        return '#4caf50';
      case 'suppressed':
        return '#9e9e9e';
      default:
        return '#9e9e9e';
    }
  };

  const getTriageStateColor = (triageState: string): string => {
    switch (triageState) {
      case 'pending':
        return '#9e9e9e';
      case 'routing':
      case 'triaging':
        return '#2196f3';
      case 'triaged':
        return '#4caf50';
      case 'resolved':
        return '#4caf50';
      case 'escalated':
        return '#ff9800';
      case 'failed':
        return '#f44336';
      case 'skipped':
        return '#757575';
      default:
        return '#9e9e9e';
    }
  };

  return (
    <div className="alerts-panel">
      <div className="alerts-panel-header">
        <div className="alerts-panel-title">Alerts</div>
        <button
          className="alerts-panel-refresh-btn"
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

      <div className="alerts-panel-filters">
        <button
          className={`alerts-panel-filter-chip ${stateFilter === 'all' ? 'active' : ''}`}
          onClick={() => handleFilterChange('all')}
        >
          All
        </button>
        <button
          className={`alerts-panel-filter-chip ${stateFilter === 'active' ? 'active' : ''}`}
          onClick={() => handleFilterChange('active')}
        >
          Active
        </button>
        <button
          className={`alerts-panel-filter-chip ${stateFilter === 'acknowledged' ? 'active' : ''}`}
          onClick={() => handleFilterChange('acknowledged')}
        >
          Acknowledged
        </button>
        <button
          className={`alerts-panel-filter-chip ${stateFilter === 'resolved' ? 'active' : ''}`}
          onClick={() => handleFilterChange('resolved')}
        >
          Resolved
        </button>
      </div>

      {isLoading && alerts.length === 0 && (
        <div className="alerts-panel-loading">
          <div className="alerts-panel-spinner" />
          <span>Loading...</span>
        </div>
      )}

      {error && (
        <div className="alerts-panel-error">
          <div>Error: {error}</div>
          <button onClick={handleRefresh}>Retry</button>
        </div>
      )}

      {!isLoading && !error && alerts.length === 0 && (
        <div className="alerts-panel-empty">No alerts</div>
      )}

      {!error && alerts.length > 0 && (
        <div className="alerts-panel-list">
          {alerts.map((alert) => (
            <div
              key={alert.id}
              className="alerts-panel-row"
              onClick={() => handleRowClick(alert.id)}
            >
              <div className="alerts-panel-row-header">
                <div className="alerts-panel-row-title">{alert.title}</div>
                <div className="alerts-panel-row-badges">
                  <span
                    className="alerts-panel-severity-badge"
                    style={{ backgroundColor: getSeverityColor(alert.severity) }}
                  >
                    {alert.severity}
                  </span>
                  <span
                    className="alerts-panel-state-badge"
                    style={{ backgroundColor: getStateColor(alert.state) }}
                  >
                    {alert.state}
                  </span>
                  {alert.triage_state && (
                    <span
                      className="alerts-panel-triage-badge"
                      style={{ backgroundColor: getTriageStateColor(alert.triage_state) }}
                    >
                      {alert.triage_state}
                    </span>
                  )}
                </div>
              </div>
              <div className="alerts-panel-row-time">
                {formatRelativeTime(new Date(alert.first_seen_at))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
