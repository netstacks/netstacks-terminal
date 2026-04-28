// Task tool-use approval API (AUDIT FIX EXEC-017).
//
// Background ReAct tasks now pause before any mutating tool dispatch.
// The frontend polls this surface while a task is running and shows a
// modal so the user can review the proposed action before it runs.

import { getClient } from './client';

export interface PendingTaskApproval {
  /** UUID — pass back to approve/reject. */
  id: string;
  task_id: string;
  tool_name: string;
  /** The arguments the LLM emitted, for the user to review. */
  tool_input: unknown;
  /** RFC3339 instant when the prompt was created. */
  created_at: string;
}

/** GET /api/task-approvals — every pending approval across all tasks. */
export async function listAllTaskApprovals(): Promise<PendingTaskApproval[]> {
  const { data } = await getClient().http.get('/task-approvals');
  return Array.isArray(data) ? data : [];
}

/** GET /api/tasks/:task_id/pending-approvals — pending approvals for one task. */
export async function listTaskPendingApprovals(taskId: string): Promise<PendingTaskApproval[]> {
  const { data } = await getClient().http.get(`/tasks/${taskId}/pending-approvals`);
  return Array.isArray(data) ? data : [];
}

/** POST /api/task-approvals/:approval_id/approve */
export async function approveTaskToolUse(approvalId: string): Promise<void> {
  await getClient().http.post(`/task-approvals/${approvalId}/approve`);
}

/** POST /api/task-approvals/:approval_id/reject */
export async function rejectTaskToolUse(approvalId: string): Promise<void> {
  await getClient().http.post(`/task-approvals/${approvalId}/reject`);
}
