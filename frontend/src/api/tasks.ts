/**
 * REST API client for task management
 *
 * Provides CRUD operations for AI agent tasks.
 *
 * NOTE: Endpoints differ between standalone and enterprise mode:
 * - Standalone: Uses local agent's /tasks endpoint
 * - Enterprise: Uses Controller's /agent-tasks and /tasks/agent-schedules endpoints
 */

import { getClient, getCurrentMode } from './client';
import type { AgentTask, CreateTaskRequest, ListTasksResponse } from '../types/tasks';

const isEnterprise = () => getCurrentMode() === 'enterprise';

/**
 * Create a new task
 *
 * In enterprise mode, creates a one-off agent task execution via schedule endpoint.
 */
export async function createTask(req: CreateTaskRequest): Promise<AgentTask> {
  const client = getClient();

  if (isEnterprise()) {
    // Enterprise mode: use agent schedule's run endpoint or create a one-time task
    // For now, we create a scheduled task and immediately run it
    const scheduleResp = await client.http.post('/tasks/agent-schedules', {
      name: `One-off: ${req.prompt.slice(0, 30)} [${Date.now()}]`,
      prompt: req.prompt,
      cron_expression: '0 0 31 2 *', // Never runs (Feb 31)
      enabled: false, // Disabled so it won't run on schedule
    });

    // Run it immediately
    const runResp = await client.http.post(`/tasks/agent-schedules/${scheduleResp.data.id}/run`);

    // Return in AgentTask format
    return {
      id: runResp.data.id, // execution ID
      prompt: req.prompt,
      status: 'pending',
      progress_pct: 0,
      result_json: null,
      error_message: null,
      created_at: runResp.data.started_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
      started_at: runResp.data.started_at || null,
      completed_at: null,
    };
  }

  // Standalone mode: direct task creation
  const response = await client.http.post('/tasks', req);
  return response.data;
}

/**
 * List tasks with optional filtering
 *
 * In enterprise mode, fetches from agent-tasks history endpoint.
 */
export async function listTasks(params?: {
  status?: string;
  limit?: number;
  offset?: number;
}): Promise<ListTasksResponse> {
  const client = getClient();

  if (isEnterprise()) {
    // Enterprise mode: use agent-tasks history endpoint
    const response = await client.http.get('/agent-tasks/history', { params });

    // Transform to ListTasksResponse format
    // Note: Controller returns 'state' field, not 'status'
    const executions = Array.isArray(response.data?.executions) ? response.data.executions : [];
    return {
      tasks: executions.map((exec: Record<string, unknown>) => ({
        id: exec.id,
        prompt: (exec.input_task || exec.prompt || '') as string,
        status: mapExecutionStatus(exec.state as string),
        progress_pct: exec.state === 'running' ? 50 : (exec.state === 'success' ? 100 : 0),
        result_json: (exec.output || exec.final_answer || null) as string | null,
        error_message: (exec.error_message || null) as string | null,
        created_at: exec.created_at,
        updated_at: exec.completed_at || exec.created_at,
        started_at: exec.started_at || exec.created_at,
        completed_at: exec.completed_at || null,
      })),
      running_count: executions.filter((e: Record<string, unknown>) => e.state === 'running').length,
      max_concurrent: 3, // Default, could fetch from limits endpoint
    };
  }

  // Standalone mode: direct list
  const response = await client.http.get('/tasks', { params });
  return response.data;
}

/**
 * Map Controller execution status to frontend TaskStatus
 */
function mapExecutionStatus(status: string): 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' {
  switch (status?.toLowerCase()) {
    case 'success':
    case 'completed':
      return 'completed';
    case 'failed':
    case 'error':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'running':
      return 'running';
    default:
      return 'pending';
  }
}

/**
 * Get a task by ID
 */
export async function getTask(id: string): Promise<AgentTask> {
  const client = getClient();

  if (isEnterprise()) {
    // Enterprise mode: get from history endpoint
    // Note: Controller returns 'state' field, not 'status'
    const response = await client.http.get(`/agent-tasks/history/${id}`);
    const exec = response.data;

    return {
      id: exec.id,
      prompt: exec.input_task || exec.prompt || '',
      status: mapExecutionStatus(exec.state),
      progress_pct: exec.state === 'running' ? 50 : (exec.state === 'success' ? 100 : 0),
      result_json: exec.output || exec.final_answer || null,
      error_message: exec.error_message || null,
      created_at: exec.created_at,
      updated_at: exec.completed_at || exec.created_at,
      started_at: exec.started_at || exec.created_at,
      completed_at: exec.completed_at || null,
    };
  }

  const response = await client.http.get(`/tasks/${id}`);
  return response.data;
}

/**
 * Delete a task
 *
 * In enterprise mode, this deletes the execution record.
 */
export async function deleteTask(id: string): Promise<void> {
  const client = getClient();

  if (isEnterprise()) {
    // Enterprise mode: cancel first if running, then the record is kept for history
    // (Controller doesn't have delete for executions, they're kept for audit)
    await client.http.post(`/tasks/executions/${id}/cancel`).catch(() => {
      // Ignore if already completed or not found
    });
    return;
  }

  await client.http.delete(`/tasks/${id}`);
}

/**
 * Cancel a running task
 */
export async function cancelTask(taskId: string): Promise<void> {
  const client = getClient();

  if (isEnterprise()) {
    // Enterprise mode: cancel via executions endpoint
    await client.http.post(`/tasks/executions/${taskId}/cancel`);
    return;
  }

  // Standalone mode: delete endpoint also cancels if running
  await client.http.delete(`/tasks/${taskId}`);
}

/**
 * Re-run a completed task with the same prompt (Enterprise only)
 * Creates a new task using the original task's prompt
 */
export async function rerunTask(taskId: string): Promise<AgentTask> {
  // First get the original task to extract prompt
  const original = await getTask(taskId);

  // The prompt is stored directly on the task
  const prompt = original.prompt;

  if (!prompt) {
    throw new Error('Cannot re-run task: no prompt found');
  }

  // Create new task with same prompt
  const newTask = await createTask({ prompt });
  return newTask;
}
