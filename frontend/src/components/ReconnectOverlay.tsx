import './ReconnectOverlay.css'

interface ReconnectOverlayProps {
  visible: boolean
  countdown: number
  attemptCount: number
  onReconnectNow: () => void
  onCancel: () => void
  onDisableAutoReconnect: () => void
  autoReconnectDisabled: boolean
  maxAttempts?: number
}

export default function ReconnectOverlay({
  visible,
  countdown,
  attemptCount,
  onReconnectNow,
  onCancel,
  onDisableAutoReconnect,
  autoReconnectDisabled,
  maxAttempts = 0,
}: ReconnectOverlayProps) {
  if (!visible) return null

  const hasMaxAttempts = maxAttempts > 0
  const isLastAttempt = hasMaxAttempts && attemptCount >= maxAttempts
  const title = isLastAttempt ? 'Session Ended' : 'Connection Lost'

  return (
    <div className="reconnect-overlay">
      <div className="reconnect-overlay-content">
        <div className="reconnect-overlay-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4M12 16h.01" />
          </svg>
        </div>

        <h3 className="reconnect-overlay-title">{title}</h3>

        {!autoReconnectDisabled && countdown > 0 && !isLastAttempt ? (
          <p className="reconnect-overlay-message">
            Reconnecting in <span className="reconnect-countdown">{countdown}</span> second{countdown !== 1 ? 's' : ''}...
            {attemptCount > 0 && hasMaxAttempts && (
              <span className="reconnect-attempts">
                <br />
                Attempt {attemptCount}/{maxAttempts}
              </span>
            )}
            {attemptCount > 0 && !hasMaxAttempts && (
              <span className="reconnect-attempts"> (Attempt {attemptCount + 1})</span>
            )}
          </p>
        ) : isLastAttempt ? (
          <p className="reconnect-overlay-message">
            Maximum reconnection attempts reached. Click Reconnect to try again.
          </p>
        ) : (
          <p className="reconnect-overlay-message">
            {autoReconnectDisabled ? 'Auto-reconnect is disabled' : 'Ready to reconnect'}
          </p>
        )}

        <div className="reconnect-overlay-actions">
          <button
            className="reconnect-btn reconnect-btn-primary"
            onClick={onReconnectNow}
          >
            Reconnect Now
          </button>
          <button
            className="reconnect-btn reconnect-btn-secondary"
            onClick={onCancel}
          >
            Cancel
          </button>
        </div>

        {!autoReconnectDisabled && (
          <label className="reconnect-overlay-checkbox">
            <input
              type="checkbox"
              onChange={(e) => {
                if (e.target.checked) {
                  onDisableAutoReconnect()
                }
              }}
            />
            <span>Don't auto-reconnect this session</span>
          </label>
        )}
      </div>
    </div>
  )
}
