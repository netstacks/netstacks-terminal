/**
 * DeviceEditDialog - Modal dialog for editing device properties
 */

import { useState, useEffect } from 'react'
import type { Device, DeviceType, DeviceStatus } from '../types/topology'
import { useSubmitting } from '../hooks/useSubmitting'
import { useOverlayDismiss } from '../hooks/useOverlayDismiss'
import './DeviceEditDialog.css'

interface DeviceEditDialogProps {
  device: Device | null
  /** Sync or async — the dialog tracks pending state if it returns a Promise. */
  onSave: (updates: Partial<Device>) => void | Promise<void>
  onClose: () => void
}

const DEVICE_TYPES: { value: DeviceType; label: string }[] = [
  { value: 'router', label: 'Router' },
  { value: 'switch', label: 'Switch' },
  { value: 'firewall', label: 'Firewall' },
  { value: 'server', label: 'Server' },
  { value: 'cloud', label: 'Cloud' },
  { value: 'access-point', label: 'Access Point' },
  { value: 'load-balancer', label: 'Load Balancer' },
  { value: 'wan-optimizer', label: 'WAN Optimizer' },
  { value: 'voice-gateway', label: 'Voice Gateway' },
  { value: 'wireless-controller', label: 'Wireless Controller' },
  { value: 'storage', label: 'Storage' },
  { value: 'virtual', label: 'Virtual' },
  { value: 'sd-wan', label: 'SD-WAN' },
  { value: 'iot', label: 'IoT' },
  { value: 'unknown', label: 'Unknown' },
]

const DEVICE_STATUSES: { value: DeviceStatus; label: string }[] = [
  { value: 'online', label: 'Online' },
  { value: 'offline', label: 'Offline' },
  { value: 'warning', label: 'Warning' },
  { value: 'unknown', label: 'Unknown' },
]

export default function DeviceEditDialog({ device, onSave, onClose }: DeviceEditDialogProps) {
  const [name, setName] = useState('')
  const [type, setType] = useState<DeviceType>('unknown')
  const [status, setStatus] = useState<DeviceStatus>('unknown')
  const [site, setSite] = useState('')
  const [role, setRole] = useState('')

  // Initialize form when device changes
  useEffect(() => {
    if (device) {
      setName(device.name)
      setType(device.type)
      setStatus(device.status)
      setSite(device.site || '')
      setRole(device.role || '')
    }
  }, [device])

  const { submitting, run } = useSubmitting()

  if (!device) return null

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    run(async () => {
      await Promise.resolve(onSave({
        name,
        type,
        status,
        site: site || undefined,
        role: role || undefined,
      }))
    })
  }

  const { backdropProps, contentProps } = useOverlayDismiss({ onDismiss: onClose, enabled: !submitting })

  return (
    <div className="device-edit-dialog-overlay" {...backdropProps}>
      <div className="device-edit-dialog" {...contentProps}>
        <div className="device-edit-dialog-header">
          <h2>Edit Device</h2>
          <button className="device-edit-dialog-close" onClick={onClose} title="Close" disabled={submitting}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="device-edit-dialog-content">
          <div className="device-edit-field">
            <label htmlFor="device-name">Name</label>
            <input
              id="device-name"
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              required
              autoFocus
            />
          </div>

          <div className="device-edit-field">
            <label htmlFor="device-type">Type</label>
            <select
              id="device-type"
              value={type}
              onChange={e => setType(e.target.value as DeviceType)}
            >
              {DEVICE_TYPES.map(t => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>

          <div className="device-edit-field">
            <label htmlFor="device-status">Status</label>
            <select
              id="device-status"
              value={status}
              onChange={e => setStatus(e.target.value as DeviceStatus)}
            >
              {DEVICE_STATUSES.map(s => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
          </div>

          <div className="device-edit-field">
            <label htmlFor="device-site">Site</label>
            <input
              id="device-site"
              type="text"
              value={site}
              onChange={e => setSite(e.target.value)}
              placeholder="Optional"
            />
          </div>

          <div className="device-edit-field">
            <label htmlFor="device-role">Role</label>
            <input
              id="device-role"
              type="text"
              value={role}
              onChange={e => setRole(e.target.value)}
              placeholder="Optional"
            />
          </div>

          <div className="device-edit-dialog-actions">
            <button type="button" className="device-edit-btn-cancel" onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button type="submit" className="device-edit-btn-save" disabled={submitting}>
              {submitting ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
