// API client for API Resources and Quick Actions

import { getClient } from './client'
import type {
  ApiResource,
  CreateApiResourceRequest,
  UpdateApiResourceRequest,
  QuickAction,
  CreateQuickActionRequest,
  UpdateQuickActionRequest,
  QuickActionResult,
  ExecuteInlineRequest,
} from '../types/quickAction'

// === API Resources ===

export async function listApiResources(): Promise<ApiResource[]> {
  const { data } = await getClient().http.get('/api-resources')
  return data
}

export async function getApiResource(id: string): Promise<ApiResource> {
  const { data } = await getClient().http.get(`/api-resources/${id}`)
  return data
}

export async function createApiResource(req: CreateApiResourceRequest): Promise<ApiResource> {
  try {
    const { data } = await getClient().http.post('/api-resources', req)
    return data
  } catch (err: unknown) {
    const axiosErr = err as { response?: { data?: { code?: string; error?: string } } }
    const responseData = axiosErr.response?.data
    if (responseData?.code === 'VAULT_LOCKED') {
      throw new Error('Vault is locked. Go to Settings → Security to unlock with your master password.')
    }
    throw new Error(responseData?.error || 'Failed to create API resource')
  }
}

export async function updateApiResource(id: string, req: UpdateApiResourceRequest): Promise<void> {
  await getClient().http.put(`/api-resources/${id}`, req)
}

export async function deleteApiResource(id: string): Promise<void> {
  await getClient().http.delete(`/api-resources/${id}`)
}

export async function testApiResource(id: string): Promise<QuickActionResult> {
  const { data } = await getClient().http.post(`/api-resources/${id}/test`)
  return data
}

// === Quick Actions ===

export async function listQuickActions(): Promise<QuickAction[]> {
  const { data } = await getClient().http.get('/quick-actions')
  return data
}

export async function getQuickAction(id: string): Promise<QuickAction> {
  const { data } = await getClient().http.get(`/quick-actions/${id}`)
  return data
}

export async function createQuickAction(req: CreateQuickActionRequest): Promise<QuickAction> {
  const { data } = await getClient().http.post('/quick-actions', req)
  return data
}

export async function updateQuickAction(id: string, req: UpdateQuickActionRequest): Promise<void> {
  await getClient().http.put(`/quick-actions/${id}`, req)
}

export async function deleteQuickAction(id: string): Promise<void> {
  await getClient().http.delete(`/quick-actions/${id}`)
}

export async function executeQuickAction(
  id: string,
  variables?: Record<string, string>,
): Promise<QuickActionResult> {
  const body = { variables: variables && Object.keys(variables).length > 0 ? variables : {} }
  const { data } = await getClient().http.post(`/quick-actions/${id}/execute`, body)
  return data
}

export async function executeInlineQuickAction(req: ExecuteInlineRequest): Promise<QuickActionResult> {
  const { data } = await getClient().http.post('/quick-actions/execute-inline', req)
  return data
}
