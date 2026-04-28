/**
 * Task types for AI agent task management
 *
 * These types match the backend models in terminal/agent/src/tasks/models.rs
 */

/** Task status enum matching backend TaskStatus */
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/** Agent task record from backend */
export interface AgentTask {
  id: string;
  prompt: string;
  status: TaskStatus;
  progress_pct: number;
  result_json: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  agent_definition_id?: string | null;
}

/** Failure policy options for task execution */
export type FailurePolicy = 'stop' | 'continue' | 'retry';

/** Full failure policy configuration */
export interface FailurePolicyConfig {
  policy: FailurePolicy;
  /** Number of retries (only applicable when policy is 'retry') */
  retry_count?: number;
}

/** Request to create a new task */
export interface CreateTaskRequest {
  prompt: string;
  /** Failure policy configuration (optional, defaults to 'stop') */
  failure_policy?: FailurePolicyConfig;
}

/** Response from list tasks endpoint */
export interface ListTasksResponse {
  tasks: AgentTask[];
  running_count: number;
  max_concurrent: number;
}

/** Task progress event sent via WebSocket */
export interface TaskProgressEvent {
  type: 'task_progress';
  taskId: string;
  status: TaskStatus;
  progressPct: number;
  message?: string;
  result?: unknown;
  error?: string;
}

/** Init event sent on WebSocket connection */
export interface TaskInitEvent {
  type: 'init';
  tasks: AgentTask[];
  running_count: number;
  max_concurrent: number;
}

/** Union of all WebSocket message types */
export type TaskWsMessage = TaskProgressEvent | TaskInitEvent;

/** WebSocket command to cancel a task */
export interface TaskCancelCommand {
  type: 'cancel';
  task_id: string;
}
