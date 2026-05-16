import { useState, useEffect, useCallback } from 'react'
import {
  listApiResources,
  createApiResource,
  updateApiResource,
  deleteApiResource,
  testApiResource,
  testAuthFlowStep,
  type AuthStepTestResult,
} from '../api/quickActions'
import type {
  ApiResource,
  CreateApiResourceRequest,
  UpdateApiResourceRequest,
  ApiResourceAuthType,
  AuthFlowStep,
  QuickActionResult,
} from '../types/quickAction'
import './ApiResourcesTab.css'
import { PasswordInput } from './PasswordInput'

// Icons
const Icons = {
  plus: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  ),
  edit: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  ),
  trash: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
    </svg>
  ),
  check: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  ),
  x: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  ),
}

const AUTH_TYPE_LABELS: Record<ApiResourceAuthType, string> = {
  none: 'No Auth',
  bearer_token: 'Bearer Token',
  basic: 'Basic Auth',
  api_key_header: 'API Key Header',
  multi_step: 'Multi-Step Auth',
}

// === API Resource Dialog ===

function ApiResourceDialog({
  resource,
  onClose,
  onSave,
}: {
  resource: ApiResource | null
  onClose: () => void
  onSave: () => void
}) {
  const isEdit = resource !== null
  const [name, setName] = useState(resource?.name || '')
  const [baseUrl, setBaseUrl] = useState(resource?.base_url || '')
  const [authType, setAuthType] = useState<ApiResourceAuthType>(resource?.auth_type || 'none')
  const [authToken, setAuthToken] = useState('')
  const [authUsername, setAuthUsername] = useState('')
  const [authPassword, setAuthPassword] = useState('')
  const [authHeaderName, setAuthHeaderName] = useState(resource?.auth_header_name || '')
  const [authFlow, setAuthFlow] = useState<AuthFlowStep[]>(resource?.auth_flow || [])
  // Parallel array of stable per-step React keys, kept in sync with
  // authFlow's add/remove (update mutates content in place so rids stay).
  // The defaultValue textarea for headers (line ~356) relies on stable
  // keys — without this, removing step N leaves the textarea at index N
  // showing the deleted step's content because React reuses the DOM node.
  const [stepRids, setStepRids] = useState<string[]>(
    () => (resource?.auth_flow || []).map(() => crypto.randomUUID()),
  )
  const [defaultHeaders, setDefaultHeaders] = useState(
    JSON.stringify(resource?.default_headers || {}, null, 2)
  )
  const [verifySsl, setVerifySsl] = useState(resource?.verify_ssl ?? true)
  const [timeoutSecs, setTimeoutSecs] = useState(resource?.timeout_secs ?? 30)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<QuickActionResult | null>(null)
  const [testing, setTesting] = useState(false)
  // Per-step test results, keyed by step index. Each entry is the rich result
  // returned by /api-resources/:id/auth-flow/:idx/test. Cleared on save.
  const [stepResults, setStepResults] = useState<Record<number, AuthStepTestResult>>({})
  const [stepTesting, setStepTesting] = useState<number | null>(null)

  const handleSave = async () => {
    if (!name.trim() || !baseUrl.trim()) {
      setError('Name and Base URL are required')
      return
    }

    let parsedHeaders: Record<string, string> = {}
    try {
      parsedHeaders = JSON.parse(defaultHeaders || '{}')
    } catch {
      setError('Default headers must be valid JSON')
      return
    }

    setSaving(true)
    setError(null)

    try {
      if (isEdit) {
        const update: UpdateApiResourceRequest = {
          name: name.trim(),
          base_url: baseUrl.trim(),
          auth_type: authType,
          default_headers: parsedHeaders,
          verify_ssl: verifySsl,
          timeout_secs: timeoutSecs,
        }
        if (authToken) update.auth_token = authToken
        if (authUsername) update.auth_username = authUsername
        if (authPassword) update.auth_password = authPassword
        if (authHeaderName) update.auth_header_name = authHeaderName
        if (authType === 'multi_step' && authFlow.length > 0) update.auth_flow = authFlow
        await updateApiResource(resource!.id, update)
      } else {
        const create: CreateApiResourceRequest = {
          name: name.trim(),
          base_url: baseUrl.trim(),
          auth_type: authType,
          default_headers: parsedHeaders,
          verify_ssl: verifySsl,
          timeout_secs: timeoutSecs,
        }
        if (authToken) create.auth_token = authToken
        if (authUsername) create.auth_username = authUsername
        if (authPassword) create.auth_password = authPassword
        if (authHeaderName) create.auth_header_name = authHeaderName
        if (authType === 'multi_step' && authFlow.length > 0) create.auth_flow = authFlow
        await createApiResource(create)
      }
      onSave()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const handleTest = async () => {
    if (!isEdit) return
    setTesting(true)
    setTestResult(null)
    try {
      const result = await testApiResource(resource!.id)
      setTestResult(result)
    } catch {
      setTestResult({ success: false, status_code: 0, duration_ms: 0, error: 'Test failed' })
    } finally {
      setTesting(false)
    }
  }

  const addAuthFlowStep = () => {
    setAuthFlow([...authFlow, { method: 'POST', path: '', body: '', extract_path: '', store_as: '' }])
    setStepRids((prev) => [...prev, crypto.randomUUID()])
  }

  const updateAuthFlowStep = (index: number, field: keyof AuthFlowStep, value: string) => {
    const updated = [...authFlow]
    updated[index] = { ...updated[index], [field]: value }
    setAuthFlow(updated)
  }

  const toggleStepBasicAuth = (index: number, checked: boolean) => {
    const updated = [...authFlow]
    updated[index] = { ...updated[index], use_basic_auth: checked }
    setAuthFlow(updated)
  }

  const updateStepHeaders = (index: number, jsonText: string) => {
    const updated = [...authFlow]
    // Store the raw text in a side state so the user can type freely; only
    // commit when it parses cleanly. We just always set headers when valid JSON
    // and leave it untouched when invalid (the textarea reflects the typed text).
    try {
      const parsed = jsonText.trim() ? JSON.parse(jsonText) : {}
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        updated[index] = { ...updated[index], headers: parsed as Record<string, string> }
        setAuthFlow(updated)
      }
    } catch {
      // ignore parse error during typing
    }
  }

  const removeAuthFlowStep = (index: number) => {
    setAuthFlow(authFlow.filter((_, i) => i !== index))
    setStepRids((prev) => prev.filter((_, i) => i !== index))
    setStepResults((prev) => {
      const next = { ...prev }
      delete next[index]
      return next
    })
  }

  const handleTestStep = async (index: number) => {
    if (!resource?.id) {
      setError('Save the resource first — per-step test runs against the saved configuration.')
      return
    }
    setStepTesting(index)
    try {
      const result = await testAuthFlowStep(resource.id, index)
      setStepResults((prev) => ({ ...prev, [index]: result }))
    } catch (err) {
      const e = err as { response?: { data?: { error?: string } }; message?: string }
      setStepResults((prev) => ({
        ...prev,
        [index]: {
          success: false,
          status_code: 0,
          url: '',
          response_preview: null,
          extracted_value: null,
          store_as: authFlow[index]?.store_as || '',
          error: e?.response?.data?.error || e?.message || 'Step test failed',
          duration_ms: 0,
        },
      }))
    } finally {
      setStepTesting(null)
    }
  }

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog-content api-resource-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <h3>{isEdit ? 'Edit API Resource' : 'Add API Resource'}</h3>
          <button className="dialog-close" onClick={onClose}>{Icons.x}</button>
        </div>

        <div className="dialog-body">
          {error && <div className="dialog-error">{error}</div>}

          <div className="form-group">
            <label>Name</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g., SolarWinds Production" />
          </div>

          <div className="form-group">
            <label>Base URL</label>
            <input type="text" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com" />
          </div>

          <div className="form-group">
            <label>Authentication</label>
            <select value={authType} onChange={(e) => setAuthType(e.target.value as ApiResourceAuthType)}>
              {Object.entries(AUTH_TYPE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </div>

          {authType === 'bearer_token' && (
            <div className="form-group">
              <label>Bearer Token</label>
              <PasswordInput value={authToken} onChange={(e) => setAuthToken(e.target.value)} placeholder={isEdit ? '(unchanged if blank)' : 'Token'} />
            </div>
          )}

          {authType === 'basic' && (
            <>
              <div className="form-group">
                <label>Username</label>
                <input type="text" value={authUsername} onChange={(e) => setAuthUsername(e.target.value)} placeholder={isEdit ? '(unchanged if blank)' : ''} />
              </div>
              <div className="form-group">
                <label>Password</label>
                <PasswordInput value={authPassword} onChange={(e) => setAuthPassword(e.target.value)} placeholder={isEdit ? '(unchanged if blank)' : ''} />
              </div>
            </>
          )}

          {authType === 'api_key_header' && (
            <>
              <div className="form-group">
                <label>Header Name</label>
                <input type="text" value={authHeaderName} onChange={(e) => setAuthHeaderName(e.target.value)} placeholder="X-API-Key" />
              </div>
              <div className="form-group">
                <label>API Key</label>
                <PasswordInput value={authToken} onChange={(e) => setAuthToken(e.target.value)} placeholder={isEdit ? '(unchanged if blank)' : 'Key value'} />
              </div>
            </>
          )}

          {authType === 'multi_step' && (
            <div className="auth-flow-section">
              <div className="auth-flow-header">
                <label>Authentication Flow</label>
                <button className="btn-small" onClick={addAuthFlowStep}>{Icons.plus} Add Step</button>
              </div>
              <div className="form-group">
                <label>Username</label>
                <input type="text" value={authUsername} onChange={(e) => setAuthUsername(e.target.value)} placeholder={isEdit ? '(unchanged if blank)' : 'For {{username}} variable'} />
              </div>
              <div className="form-group">
                <label>Password</label>
                <PasswordInput value={authPassword} onChange={(e) => setAuthPassword(e.target.value)} placeholder={isEdit ? '(unchanged)' : 'For {{password}} variable'} />
              </div>
              {authFlow.map((step, index) => (
                <div key={stepRids[index] ?? index} className="auth-flow-step">
                  <div className="auth-flow-step-header">
                    <span>Step {index + 1}</span>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <button
                        className="btn-small"
                        onClick={() => handleTestStep(index)}
                        disabled={!resource?.id || stepTesting === index}
                        title={
                          resource?.id
                            ? `Run step ${index + 1} in isolation against the saved resource`
                            : 'Save the resource before testing individual steps'
                        }
                      >
                        {stepTesting === index ? 'Testing…' : '▶ Test'}
                      </button>
                      <button className="btn-icon-small" onClick={() => removeAuthFlowStep(index)}>{Icons.trash}</button>
                    </div>
                  </div>
                  <div className="auth-flow-step-fields">
                    <select value={step.method} onChange={(e) => updateAuthFlowStep(index, 'method', e.target.value)}>
                      <option value="GET">GET</option>
                      <option value="POST">POST</option>
                      <option value="PUT">PUT</option>
                    </select>
                    <input type="text" value={step.path} onChange={(e) => updateAuthFlowStep(index, 'path', e.target.value)} placeholder="/api/v1/login" />
                  </div>
                  <div className="form-group">
                    <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={!!step.use_basic_auth}
                        onChange={(e) => toggleStepBasicAuth(index, e.target.checked)}
                      />
                      Send HTTP Basic Auth using the resource's username/password
                    </label>
                  </div>
                  <div className="form-group">
                    <label>Headers (JSON, optional)</label>
                    <textarea
                      defaultValue={step.headers ? JSON.stringify(step.headers, null, 2) : ''}
                      onChange={(e) => updateStepHeaders(index, e.target.value)}
                      placeholder='{"Accept": "application/json"}'
                      rows={2}
                    />
                  </div>
                  <div className="form-group">
                    <label>Body Template (optional)</label>
                    <textarea value={step.body || ''} onChange={(e) => updateAuthFlowStep(index, 'body', e.target.value)} placeholder='{"username":"{{username}}","password":"{{password}}"}' rows={2} />
                  </div>
                  <div className="auth-flow-step-fields">
                    <input type="text" value={step.extract_path} onChange={(e) => updateAuthFlowStep(index, 'extract_path', e.target.value)} placeholder="Extract path (e.g., api_key)" />
                    <input type="text" value={step.store_as} onChange={(e) => updateAuthFlowStep(index, 'store_as', e.target.value)} placeholder="Store as (e.g., api_key)" />
                  </div>

                  {stepResults[index] && (
                    <div className={`step-test-result ${stepResults[index].success ? 'ok' : 'err'}`}>
                      <div className="step-test-result-row">
                        <strong>{stepResults[index].success ? '✓ Success' : '✗ Failed'}</strong>
                        <span className="step-test-meta">
                          HTTP {stepResults[index].status_code} · {stepResults[index].duration_ms}ms
                        </span>
                      </div>
                      {stepResults[index].url && (
                        <div className="step-test-meta-row">
                          <span className="step-test-label">URL</span>
                          <code>{stepResults[index].url}</code>
                        </div>
                      )}
                      {stepResults[index].extracted_value && (
                        <div className="step-test-meta-row">
                          <span className="step-test-label">
                            Captured <code>{`{{${stepResults[index].store_as}}}`}</code>
                          </span>
                          <code className="step-test-value">{stepResults[index].extracted_value}</code>
                        </div>
                      )}
                      {stepResults[index].error && (
                        <div className="step-test-error">{stepResults[index].error}</div>
                      )}
                      {stepResults[index].response_preview && (
                        <details className="step-test-body">
                          <summary>Response body (first 1000 chars)</summary>
                          <pre>{stepResults[index].response_preview}</pre>
                        </details>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="form-group">
            <label>Default Headers (JSON)</label>
            <textarea value={defaultHeaders} onChange={(e) => setDefaultHeaders(e.target.value)} rows={3} placeholder='{"Accept": "application/json"}' />
          </div>

          <div className="form-row">
            <label className="checkbox-label">
              <input type="checkbox" checked={verifySsl} onChange={(e) => setVerifySsl(e.target.checked)} />
              Verify SSL
            </label>
            <div className="form-group inline">
              <label>Timeout (sec)</label>
              <input type="number" value={timeoutSecs} onChange={(e) => setTimeoutSecs(parseInt(e.target.value) || 30)} min={1} max={300} style={{ width: 70 }} />
            </div>
          </div>

          {testResult && (
            <div className={`test-result ${testResult.success ? 'success' : 'failure'}`}>
              {testResult.success ? Icons.check : Icons.x}
              {testResult.success ? `Connected (${testResult.duration_ms}ms)` : `Failed: ${testResult.error}`}
            </div>
          )}
        </div>

        <div className="dialog-footer">
          {isEdit && (
            <button className="btn-secondary" onClick={handleTest} disabled={testing}>
              {testing ? 'Testing...' : 'Test Connection'}
            </button>
          )}
          <div className="dialog-footer-right">
            <button className="btn-secondary" onClick={onClose}>Cancel</button>
            <button className="btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving...' : isEdit ? 'Update' : 'Create'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// === Main Tab Component ===

export default function ApiResourcesTab() {
  const [resources, setResources] = useState<ApiResource[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Resource dialog
  const [resourceDialogOpen, setResourceDialogOpen] = useState(false)
  const [editingResource, setEditingResource] = useState<ApiResource | null>(null)
  const [deleteResourceConfirm, setDeleteResourceConfirm] = useState<ApiResource | null>(null)

  const [deleting, setDeleting] = useState(false)

  const fetchData = useCallback(async () => {
    try {
      setLoading(true)
      const resourceData = await listApiResources()
      setResources(resourceData)
      setError(null)
    } catch (err) {
      setError('Failed to load data')
      console.error('Failed to fetch API resources:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const handleDeleteResource = async () => {
    if (!deleteResourceConfirm) return
    setDeleting(true)
    try {
      await deleteApiResource(deleteResourceConfirm.id)
      setDeleteResourceConfirm(null)
      fetchData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete')
    } finally {
      setDeleting(false)
    }
  }

  if (loading) {
    return <div className="api-resources-tab"><div className="api-resources-loading">Loading...</div></div>
  }

  return (
    <div className="api-resources-tab">
      {error && <div className="api-resources-error">{error}</div>}

      {/* API Resources section */}
      <div className="api-resources-section">
        <div className="section-header">
          <h3>API Resources</h3>
          <button className="btn-small" onClick={() => { setEditingResource(null); setResourceDialogOpen(true) }}>
            {Icons.plus} Add Resource
          </button>
        </div>
        <p className="section-description">
          External API endpoints with authentication. Quick actions are managed from the sidebar panel.
        </p>

        {resources.length === 0 ? (
          <div className="empty-state">
            <p>No API resources configured.</p>
            <p>Add one to start creating quick actions.</p>
          </div>
        ) : (
          <div className="items-list">
            {resources.map((resource) => (
              <div key={resource.id} className="item-row">
                <div className="item-info">
                  <span className="item-name">{resource.name}</span>
                  <span className="item-detail">{resource.base_url}</span>
                  <span className="item-badge">{AUTH_TYPE_LABELS[resource.auth_type]}</span>
                </div>
                <div className="item-actions">
                  <button className="btn-icon" title="Edit" onClick={() => { setEditingResource(resource); setResourceDialogOpen(true) }}>
                    {Icons.edit}
                  </button>
                  <button className="btn-icon danger" title="Delete" onClick={() => setDeleteResourceConfirm(resource)}>
                    {Icons.trash}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Dialogs */}
      {resourceDialogOpen && (
        <ApiResourceDialog
          resource={editingResource}
          onClose={() => { setResourceDialogOpen(false); setEditingResource(null) }}
          onSave={() => { setResourceDialogOpen(false); setEditingResource(null); fetchData() }}
        />
      )}

      {/* Delete confirmation */}
      {deleteResourceConfirm && (
        <div className="dialog-overlay" onClick={() => setDeleteResourceConfirm(null)}>
          <div className="dialog-content dialog-small" onClick={(e) => e.stopPropagation()}>
            <div className="dialog-header">
              <h3>Delete API Resource</h3>
            </div>
            <div className="dialog-body">
              <p>Delete "{deleteResourceConfirm.name}"? This will also delete all associated quick actions.</p>
            </div>
            <div className="dialog-footer">
              <button className="btn-secondary" onClick={() => setDeleteResourceConfirm(null)}>Cancel</button>
              <button className="btn-danger" onClick={handleDeleteResource} disabled={deleting}>
                {deleting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
