/**
 * Toast notification system
 * Simple toast notifications for user feedback
 */
import { useState, useEffect, useCallback } from 'react'
import './Toast.css'

export type ToastType = 'success' | 'error' | 'info' | 'warning'

// Toast icons by type
const TOAST_ICONS: Record<ToastType, React.ReactElement> = {
  success: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="20,6 9,17 4,12" />
    </svg>
  ),
  error: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <line x1="15" y1="9" x2="9" y2="15" />
      <line x1="9" y1="9" x2="15" y2="15" />
    </svg>
  ),
  warning: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  ),
  info: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  ),
}

export interface ToastAction {
  label: string
  onClick: () => void
}

export interface ToastMessage {
  id: string
  message: string | React.ReactNode
  type: ToastType
  duration?: number
  action?: ToastAction
}

// Global toast state management
type ToastListener = (toasts: ToastMessage[]) => void
let listeners: ToastListener[] = []
let toasts: ToastMessage[] = []

function notifyListeners() {
  listeners.forEach(listener => listener([...toasts]))
}

/**
 * Show a toast notification.
 * Optional action adds a clickable link inside the toast.
 */
export function showToast(
  message: string | React.ReactNode,
  type: ToastType = 'info',
  duration: number = 3000,
  action?: ToastAction,
): string {
  const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const newToast: ToastMessage = { id, message, type, duration, action }
  toasts = [...toasts, newToast]
  notifyListeners()

  // Auto-remove after duration
  if (duration > 0) {
    setTimeout(() => {
      removeToast(id)
    }, duration)
  }

  return id
}

/**
 * Remove a toast by ID
 */
export function removeToast(id: string) {
  toasts = toasts.filter(t => t.id !== id)
  notifyListeners()
}

/**
 * Hook to subscribe to toast state
 */
function useToasts(): ToastMessage[] {
  const [localToasts, setLocalToasts] = useState<ToastMessage[]>(toasts)

  useEffect(() => {
    const listener: ToastListener = (newToasts) => {
      setLocalToasts(newToasts)
    }
    listeners.push(listener)
    return () => {
      listeners = listeners.filter(l => l !== listener)
    }
  }, [])

  return localToasts
}

/**
 * Toast container component - renders all active toasts
 * Add this to your app root
 */
export function ToastContainer() {
  const toasts = useToasts()

  const handleDismiss = useCallback((id: string) => {
    removeToast(id)
  }, [])

  if (toasts.length === 0) return null

  return (
    <div className="toast-container">
      {toasts.map(toast => (
        <div
          key={toast.id}
          className={`toast toast-${toast.type}`}
          onClick={() => handleDismiss(toast.id)}
          role="alert"
        >
          <span className="toast-icon">{TOAST_ICONS[toast.type]}</span>
          <span className="toast-message">
            {toast.message}
            {toast.action && (
              <button
                className="toast-action"
                onClick={(e) => {
                  e.stopPropagation()
                  toast.action!.onClick()
                  handleDismiss(toast.id)
                }}
              >
                {toast.action.label}
              </button>
            )}
          </span>
          <button
            className="toast-close"
            onClick={(e) => { e.stopPropagation(); handleDismiss(toast.id) }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  )
}

export default ToastContainer
