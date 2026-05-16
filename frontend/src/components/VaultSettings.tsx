import { useState, useEffect, useCallback } from 'react'
import { getVaultStatus, setMasterPassword, unlockVault } from '../api/sessions'
import {
  getApiKey,
  storeApiKey,
  deleteApiKey,
  lockVault,
  getBiometricStatus,
  enableBiometric,
  disableBiometric,
  type BiometricStatus,
  type ApiKeyType,
  API_KEY_LABELS,
} from '../api/vault'
import { confirmDialog } from './ConfirmDialog'
import { useSubmitting } from '../hooks/useSubmitting'
import './VaultSettings.css'

export default function VaultSettings() {
  const [status, setStatus] = useState<{ unlocked: boolean; has_master_password: boolean } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  // Form states
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [unlockPassword, setUnlockPassword] = useState('')

  // API key management states
  const [apiKeyStatuses, setApiKeyStatuses] = useState<Record<ApiKeyType, boolean>>({
    anthropic: false,
    openai: false,
    netbox: false,
    netdisco: false,
    librenms: false,
    smtp: false,
  })
  const [editingKey, setEditingKey] = useState<ApiKeyType | null>(null)
  const [editingValue, setEditingValue] = useState('')

  // Touch ID state
  const [biometric, setBiometric] = useState<BiometricStatus | null>(null)
  const [biometricBusy, setBiometricBusy] = useState(false)
  const [biometricEnableMode, setBiometricEnableMode] = useState(false)
  const [biometricPassword, setBiometricPassword] = useState('')

  // Fetch vault status on mount
  useEffect(() => {
    fetchStatus()
  }, [])

  const fetchStatus = async () => {
    try {
      const s = await getVaultStatus()
      setStatus(s)
      setError(null)
    } catch (err) {
      setError('Failed to fetch vault status')
    } finally {
      setLoading(false)
    }
  }

  // Single submitting flag covering set/unlock/lock and API-key save/delete.
  // The vault is small enough that multiple concurrent submits don't add
  // value — disabling the whole form during any one is fine.
  const { submitting, run } = useSubmitting()

  const handleSetMasterPassword = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setSuccess(null)

    if (newPassword.length < 8) {
      setError('Password must be at least 8 characters')
      return
    }

    if (newPassword !== confirmPassword) {
      setError('Passwords do not match')
      return
    }

    await run(async () => {
      try {
        await setMasterPassword(newPassword)
        setSuccess('Master password set successfully')
        setNewPassword('')
        setConfirmPassword('')
        await fetchStatus()
      } catch (err) {
        setError('Failed to set master password')
      }
    })
  }

  const handleUnlock = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setSuccess(null)

    if (!unlockPassword) {
      setError('Please enter your password')
      return
    }

    await run(async () => {
      try {
        await unlockVault(unlockPassword)
        setSuccess('Vault unlocked successfully')
        setUnlockPassword('')
        await fetchStatus()
      } catch (err) {
        setError('Incorrect password')
      }
    })
  }

  const handleLockVault = async () => {
    setError(null)
    setSuccess(null)

    await run(async () => {
      try {
        await lockVault()
        setSuccess('Vault locked successfully')
        await fetchStatus()
      } catch (err) {
        setError('Failed to lock vault')
      }
    })
  }

  // Touch ID
  const fetchBiometric = useCallback(async () => {
    try {
      const s = await getBiometricStatus()
      setBiometric(s)
    } catch {
      setBiometric({ supported: false, enrolled: false, enabled: false })
    }
  }, [])

  useEffect(() => {
    if (status?.unlocked) fetchBiometric()
  }, [status?.unlocked, fetchBiometric])

  const handleEnableBiometric = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setSuccess(null)
    if (!biometricPassword) {
      setError('Enter your master password to confirm enrollment')
      return
    }
    setBiometricBusy(true)
    try {
      await enableBiometric(biometricPassword)
      setSuccess('Touch ID is now enabled for vault unlock')
      setBiometricPassword('')
      setBiometricEnableMode(false)
      await fetchBiometric()
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } } }
      setError(e?.response?.data?.error || 'Failed to enable Touch ID')
    } finally {
      setBiometricBusy(false)
    }
  }

  const handleDisableBiometric = async () => {
    setError(null)
    setSuccess(null)
    setBiometricBusy(true)
    try {
      await disableBiometric()
      setSuccess('Touch ID disabled — keychain entry removed')
      await fetchBiometric()
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } } }
      setError(e?.response?.data?.error || 'Failed to disable Touch ID')
    } finally {
      setBiometricBusy(false)
    }
  }

  // Fetch all API key statuses
  const fetchAllApiKeys = async () => {
    const keyTypes: ApiKeyType[] = ['anthropic', 'openai', 'netbox', 'netdisco', 'librenms', 'smtp']
    const statuses: Record<ApiKeyType, boolean> = {
      anthropic: false,
      openai: false,
      netbox: false,
      netdisco: false,
      librenms: false,
      smtp: false,
    }

    for (const keyType of keyTypes) {
      try {
        const result = await getApiKey(keyType)
        statuses[keyType] = result !== null
      } catch (err) {
        // Ignore errors, default to false
      }
    }

    setApiKeyStatuses(statuses)
  }

  // Fetch API keys when vault is unlocked
  useEffect(() => {
    if (status?.unlocked) {
      fetchAllApiKeys()
    }
  }, [status?.unlocked])

  const handleStartEdit = (keyType: ApiKeyType) => {
    setEditingKey(keyType)
    setEditingValue('')
    setError(null)
    setSuccess(null)
  }

  const handleCancelEdit = () => {
    setEditingKey(null)
    setEditingValue('')
  }

  const handleSaveApiKey = async (keyType: ApiKeyType) => {
    setError(null)
    setSuccess(null)

    if (!editingValue) {
      setError('API key value cannot be empty')
      return
    }

    await run(async () => {
      try {
        await storeApiKey(keyType, editingValue)
        setSuccess(`${API_KEY_LABELS[keyType]} API key saved successfully`)
        setEditingKey(null)
        setEditingValue('')
        await fetchAllApiKeys()
      } catch (err) {
        setError(`Failed to save ${API_KEY_LABELS[keyType]} API key`)
      }
    })
  }

  const handleDeleteApiKey = async (keyType: ApiKeyType) => {
    const ok = await confirmDialog({
      title: 'Delete API key?',
      body: `Delete the stored ${API_KEY_LABELS[keyType]} API key?`,
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!ok) return

    setError(null)
    setSuccess(null)

    await run(async () => {
      try {
        await deleteApiKey(keyType)
        setSuccess(`${API_KEY_LABELS[keyType]} API key deleted successfully`)
        await fetchAllApiKeys()
      } catch (err) {
        setError(`Failed to delete ${API_KEY_LABELS[keyType]} API key`)
      }
    })
  }

  if (loading) {
    return <div className="vault-settings">Loading vault status...</div>
  }

  return (
    <div className="vault-settings">
      <div className="vault-header">
        <h3>Credential Vault</h3>
        <p className="vault-description">
          The credential vault securely stores your SSH passwords and key passphrases using AES-256-GCM encryption.
        </p>
      </div>

      {/* Status indicator */}
      <div className={`vault-status ${status?.unlocked ? 'unlocked' : 'locked'}`}>
        <span className="vault-status-icon">
          {status?.unlocked ? (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0110 0v4" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0110 0v4" />
              <line x1="12" y1="16" x2="12" y2="16.01" strokeWidth="3" />
            </svg>
          )}
        </span>
        <span className="vault-status-text">
          {status?.unlocked ? 'Vault Unlocked' : 'Vault Locked'}
        </span>
      </div>

      {error && <div className="vault-error">{error}</div>}
      {success && <div className="vault-success">{success}</div>}

      {/* No master password set yet */}
      {!status?.has_master_password && (
        <form className="vault-form" onSubmit={handleSetMasterPassword}>
          <p className="vault-form-info">
            Set a master password to enable the credential vault. This password will be used to encrypt your stored credentials.
          </p>
          <div className="form-group">
            <label htmlFor="new-password">Master Password</label>
            <input
              id="new-password"
              type="password"
              value={newPassword}
              onChange={e => setNewPassword(e.target.value)}
              placeholder="Enter master password (min 8 characters)"
              autoComplete="new-password"
            />
          </div>
          <div className="form-group">
            <label htmlFor="confirm-password">Confirm Password</label>
            <input
              id="confirm-password"
              type="password"
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              placeholder="Confirm master password"
              autoComplete="new-password"
            />
          </div>
          <button type="submit" className="btn-primary" disabled={submitting}>
            {submitting ? 'Setting…' : 'Set Master Password'}
          </button>
        </form>
      )}

      {/* Has master password but vault is locked */}
      {status?.has_master_password && !status?.unlocked && (
        <form className="vault-form" onSubmit={handleUnlock}>
          <p className="vault-form-info">
            Enter your master password to unlock the vault and access your stored credentials.
          </p>
          <div className="form-group">
            <label htmlFor="unlock-password">Master Password</label>
            <input
              id="unlock-password"
              type="password"
              value={unlockPassword}
              onChange={e => setUnlockPassword(e.target.value)}
              placeholder="Enter master password"
              autoComplete="current-password"
              autoFocus
            />
          </div>
          <button type="submit" className="btn-primary" disabled={submitting}>
            {submitting ? 'Unlocking…' : 'Unlock Vault'}
          </button>
        </form>
      )}

      {/* Vault is unlocked */}
      {status?.unlocked && (
        <>
          <div className="vault-unlocked-info">
            <p>Your credential vault is unlocked. Passwords can be stored and retrieved for SSH connections.</p>
            <p className="vault-note">
              The vault will lock automatically when the application restarts.
            </p>
          </div>

          <button className="btn-lock" onClick={handleLockVault} disabled={submitting}>
            {submitting ? 'Locking…' : 'Lock Vault'}
          </button>

          {/* Touch ID — macOS only */}
          {biometric?.supported && (
            <div className="vault-biometric-section">
              <h4>Touch ID Unlock</h4>
              {biometric.enabled && biometric.enrolled ? (
                <>
                  <p className="vault-biometric-status">
                    <span className="vault-biometric-dot enabled" /> Enabled — you can use Touch ID on the unlock screen.
                  </p>
                  <button
                    className="btn-disable-biometric"
                    onClick={handleDisableBiometric}
                    disabled={biometricBusy}
                  >
                    {biometricBusy ? 'Removing…' : 'Disable Touch ID'}
                  </button>
                </>
              ) : biometricEnableMode ? (
                <form onSubmit={handleEnableBiometric} className="vault-biometric-enable-form">
                  <p className="vault-biometric-warning">
                    Anyone with a registered fingerprint on this Mac will be able to unlock NetStacks.
                    Your master password remains the recovery method.
                  </p>
                  <input
                    type="password"
                    value={biometricPassword}
                    onChange={(e) => setBiometricPassword(e.target.value)}
                    placeholder="Confirm master password"
                    autoFocus
                    disabled={biometricBusy}
                  />
                  <div className="vault-biometric-enable-actions">
                    <button type="submit" className="btn-save" disabled={biometricBusy}>
                      {biometricBusy ? 'Enabling…' : 'Enable'}
                    </button>
                    <button
                      type="button"
                      className="btn-cancel"
                      onClick={() => {
                        setBiometricEnableMode(false)
                        setBiometricPassword('')
                      }}
                      disabled={biometricBusy}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              ) : (
                <>
                  <p className="vault-biometric-status">
                    <span className="vault-biometric-dot disabled" /> Not enabled. Use your fingerprint instead of typing the master password.
                  </p>
                  <button
                    className="btn-enable-biometric"
                    onClick={() => setBiometricEnableMode(true)}
                  >
                    Enable Touch ID
                  </button>
                </>
              )}
            </div>
          )}

          {/* API Keys Management */}
          <div className="vault-api-keys">
            <h4>API Keys</h4>
            <p className="vault-api-keys-description">
              Manage API keys for integrations and AI services. These keys are encrypted and stored securely in the vault.
            </p>

            <div className="api-key-list">
              {(Object.keys(API_KEY_LABELS) as ApiKeyType[]).map((keyType) => {
                const isStored = apiKeyStatuses[keyType]
                const isEditing = editingKey === keyType

                return (
                  <div key={keyType} className="api-key-item">
                    <div className="api-key-info">
                      <span className={`api-key-status ${isStored ? 'stored' : 'not-stored'}`} />
                      <span className="api-key-label">{API_KEY_LABELS[keyType]}</span>
                    </div>

                    {isEditing ? (
                      <div className="api-key-input">
                        <input
                          type="password"
                          value={editingValue}
                          onChange={(e) => setEditingValue(e.target.value)}
                          placeholder={`Enter ${API_KEY_LABELS[keyType]} API key`}
                          autoFocus
                        />
                        <div className="api-key-actions">
                          <button
                            className="btn-save"
                            onClick={() => handleSaveApiKey(keyType)}
                            disabled={submitting}
                          >
                            {submitting ? 'Saving…' : 'Save'}
                          </button>
                          <button
                            className="btn-cancel"
                            onClick={handleCancelEdit}
                            disabled={submitting}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="api-key-actions">
                        {isStored ? (
                          <>
                            <button
                              className="btn-update"
                              onClick={() => handleStartEdit(keyType)}
                              disabled={submitting}
                            >
                              Update
                            </button>
                            <button
                              className="btn-delete"
                              onClick={() => handleDeleteApiKey(keyType)}
                              disabled={submitting}
                            >
                              Delete
                            </button>
                          </>
                        ) : (
                          <button
                            className="btn-set"
                            onClick={() => handleStartEdit(keyType)}
                          >
                            Set
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
