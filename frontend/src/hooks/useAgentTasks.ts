/**
 * useAgentTasks - Hook for managing AI agent tasks with real-time updates
 *
 * Provides:
 * - WebSocket subscription for real-time task progress
 * - Zustand store for task state management
 * - CRUD operations via REST API
 * - Automatic reconnection on WebSocket disconnect
 */

import { useEffect, useCallback, useRef } from 'react';
import { create } from 'zustand';
import { getClient, getCurrentMode } from '../api/client';
import * as tasksApi from '../api/tasks';
import { listAgentExecutions } from '../api/agentDefinitions';
import { saveTaskResultToDoc } from '../lib/taskExport';
import type {
  AgentTask,
  TaskStatus,
  TaskWsMessage,
  TaskCancelCommand,
  FailurePolicyConfig,
} from '../types/tasks';

// Helper to check enterprise mode - must be called at runtime, not module load
// because getCurrentMode() returns null before client initialization
const checkIsEnterprise = () => getCurrentMode() === 'enterprise';

// ============================================================================
// Zustand Store
// ============================================================================

interface AgentTasksState {
  /** List of all tasks */
  tasks: AgentTask[];
  /** Count of currently running tasks */
  runningCount: number;
  /** Maximum concurrent tasks allowed */
  maxConcurrent: number;
  /** WebSocket connection status */
  isConnected: boolean;
  /** Set of task IDs that have been auto-saved to Documents (prevents duplicates) */
  savedTaskIds: Set<string>;
  /** Set of task IDs deleted locally (filtered out from poll results) */
  deletedTaskIds: Set<string>;

  // Actions
  setTasks: (tasks: AgentTask[]) => void;
  updateTask: (taskId: string, updates: Partial<AgentTask>) => void;
  addTask: (task: AgentTask) => void;
  removeTask: (taskId: string) => void;
  setRunningCount: (count: number) => void;
  setMaxConcurrent: (max: number) => void;
  setConnected: (connected: boolean) => void;
  addSavedTaskId: (taskId: string) => void;
  addDeletedTaskId: (taskId: string) => void;
}

const useAgentTasksStore = create<AgentTasksState>((set) => ({
  tasks: [],
  runningCount: 0,
  maxConcurrent: 3,
  isConnected: false,
  savedTaskIds: new Set<string>(),
  deletedTaskIds: new Set<string>(),

  setTasks: (tasks) =>
    set((state) => ({
      // Filter out tasks that were deleted locally
      tasks: tasks.filter((t) => !state.deletedTaskIds.has(t.id)),
    })),

  updateTask: (taskId, updates) =>
    set((state) => ({
      tasks: state.tasks.map((t) =>
        t.id === taskId ? { ...t, ...updates } : t
      ),
    })),

  addTask: (task) =>
    set((state) => ({
      tasks: [task, ...state.tasks],
    })),

  removeTask: (taskId) =>
    set((state) => ({
      tasks: state.tasks.filter((t) => t.id !== taskId),
    })),

  setRunningCount: (count) => set({ runningCount: count }),
  setMaxConcurrent: (max) => set({ maxConcurrent: max }),
  setConnected: (connected) => set({ isConnected: connected }),
  addSavedTaskId: (taskId) =>
    set((state) => {
      const newSet = new Set(state.savedTaskIds);
      newSet.add(taskId);
      return { savedTaskIds: newSet };
    }),
  addDeletedTaskId: (taskId) =>
    set((state) => {
      const newSet = new Set(state.deletedTaskIds);
      newSet.add(taskId);
      return { deletedTaskIds: newSet };
    }),
}));

// ============================================================================
// Hook Return Type
// ============================================================================

export interface UseAgentTasksReturn {
  /** List of all tasks */
  tasks: AgentTask[];
  /** Count of currently running tasks */
  runningCount: number;
  /** Maximum concurrent tasks allowed */
  maxConcurrent: number;
  /** WebSocket connection status */
  isConnected: boolean;

  /** Create a new task */
  createTask: (prompt: string, failurePolicy?: FailurePolicyConfig) => Promise<AgentTask>;
  /** Cancel a running task via WebSocket */
  cancelTask: (taskId: string) => Promise<void>;
  /** Delete a task from history */
  deleteTask: (taskId: string) => Promise<void>;
  /** Add a task to the store (e.g. after running an agent) */
  addTask: (task: AgentTask) => void;
  /** Refresh task list from server */
  refreshTasks: () => Promise<void>;
  /** Get a task by ID */
  getTaskById: (taskId: string) => AgentTask | undefined;
}

// ============================================================================
// Hook Implementation
// ============================================================================

export function useAgentTasks(): UseAgentTasksReturn {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isConnectingRef = useRef(false);

  const {
    tasks,
    runningCount,
    maxConcurrent,
    isConnected,
    setTasks,
    updateTask,
    addTask,
    removeTask,
    setRunningCount,
    setMaxConcurrent,
    setConnected,
    addSavedTaskId,
    addDeletedTaskId,
  } = useAgentTasksStore();

  // Connect to WebSocket (standalone mode only)
  // Enterprise mode uses REST polling since Controller doesn't have /ws/tasks
  // Note: We use useAgentTasksStore.getState() inside handlers to get current state
  // without adding state values to the dependency array (which would cause reconnection loops)
  const connect = useCallback(() => {
    // Skip WebSocket in enterprise mode - will use polling instead
    if (checkIsEnterprise()) {
      console.log('[useAgentTasks] Enterprise mode - using REST polling instead of WebSocket');
      setConnected(true); // Mark as "connected" for UI purposes
      return;
    }

    // Prevent duplicate connection attempts
    if (wsRef.current?.readyState === WebSocket.OPEN ||
        wsRef.current?.readyState === WebSocket.CONNECTING ||
        isConnectingRef.current) {
      return;
    }

    isConnectingRef.current = true;

    const client = getClient();
    const wsUrl = client.wsUrlWithAuth('/ws/tasks');

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('[useAgentTasks] WebSocket connected');
      isConnectingRef.current = false;
      setConnected(true);
    };

    ws.onmessage = (event) => {
      try {
        const msg: TaskWsMessage = JSON.parse(event.data);

        if (msg.type === 'init') {
          // Initial state from server
          setTasks(msg.tasks);
          setRunningCount(msg.running_count);
          setMaxConcurrent(msg.max_concurrent);
        } else if (msg.type === 'task_progress') {
          // Progress update for a specific task
          // Note: Backend sends camelCase (taskId, progressPct) per the Rust serde config
          const taskId = msg.taskId;
          const status = msg.status;
          const progressPct = msg.progressPct;
          const resultJson = msg.result ? JSON.stringify(msg.result) : undefined;

          // Get current state from store (not from closure)
          const state = useAgentTasksStore.getState();
          const currentTask = state.tasks.find(t => t.id === taskId);

          updateTask(taskId, {
            status: status as TaskStatus,
            progress_pct: progressPct,
            result_json: resultJson,
            error_message: msg.error,
          });

          // Update running count based on status transitions
          if (currentTask) {
            const wasRunning = currentTask.status === 'running';
            const isNowRunning = status === 'running';
            const isNowTerminal = ['completed', 'failed', 'cancelled'].includes(status);

            if (!wasRunning && isNowRunning) {
              // Task started running
              setRunningCount(state.runningCount + 1);
            } else if (wasRunning && isNowTerminal) {
              // Task finished
              setRunningCount(Math.max(0, state.runningCount - 1));
            }

            // Auto-save completed tasks to Documents
            if (status === 'completed' && resultJson && !state.savedTaskIds.has(taskId)) {
              // Build updated task object for saving
              const updatedTask: AgentTask = {
                ...currentTask,
                status: 'completed',
                progress_pct: progressPct,
                result_json: resultJson,
              };
              // Non-blocking save - use .then() to avoid blocking WebSocket handler
              saveTaskResultToDoc(updatedTask).then((docId) => {
                if (docId) {
                  addSavedTaskId(taskId);
                }
              });
            }
          }
        }
      } catch (e) {
        console.error('[useAgentTasks] Failed to parse WebSocket message:', e);
      }
    };

    ws.onclose = () => {
      console.log('[useAgentTasks] WebSocket disconnected');
      isConnectingRef.current = false;
      setConnected(false);
      wsRef.current = null;

      // Reconnect after delay
      reconnectTimeoutRef.current = setTimeout(() => {
        connect();
      }, 3000);
    };

    ws.onerror = (error) => {
      console.error('[useAgentTasks] WebSocket error:', error);
      isConnectingRef.current = false;
    };
  }, [setTasks, updateTask, setRunningCount, setMaxConcurrent, setConnected, addSavedTaskId]);

  // Connect on mount (WebSocket for standalone, polling for enterprise)
  useEffect(() => {
    connect();

    // For enterprise mode, poll for task updates since we don't have WebSocket
    let pollInterval: ReturnType<typeof setInterval> | null = null;
    if (checkIsEnterprise()) {
      let consecutiveErrors = 0;

      const pollTasks = async () => {
        try {
          const response = await listAgentExecutions({ limit: 50 });
          setTasks(response.tasks);
          setRunningCount(response.running_count);
          setMaxConcurrent(response.max_concurrent);
          consecutiveErrors = 0; // Reset on success
        } catch {
          consecutiveErrors++;
          // Only log the first error, then stay quiet
          if (consecutiveErrors === 1) {
            console.warn('[useAgentTasks] Agent executions endpoint not available');
          }
        }
      };

      // Initial load
      pollTasks();

      // Poll every 5 seconds for updates (faster for running tasks)
      pollInterval = setInterval(pollTasks, 5000);
    }

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (pollInterval) {
        clearInterval(pollInterval);
      }
    };
  }, [connect, setTasks, setRunningCount, setMaxConcurrent]);

  // Create a new task
  const createTask = useCallback(async (prompt: string, failurePolicy?: FailurePolicyConfig): Promise<AgentTask> => {
    const task = await tasksApi.createTask({
      prompt,
      failure_policy: failurePolicy,
    });
    addTask(task);
    return task;
  }, [addTask]);

  // Cancel a task via WebSocket (standalone) or REST API (enterprise)
  const cancelTask = useCallback(async (taskId: string): Promise<void> => {
    if (checkIsEnterprise()) {
      // Enterprise mode: use REST API
      await tasksApi.cancelTask(taskId);
      // Update will come via polling
    } else {
      // Standalone mode: send cancel command via WebSocket for immediate response
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        const cmd: TaskCancelCommand = { type: 'cancel', task_id: taskId };
        wsRef.current.send(JSON.stringify(cmd));
      }
      // Note: The WebSocket handler will broadcast the status change,
      // which will update the store via the onmessage handler
    }
  }, []);

  // Delete a task (removes from history)
  const deleteTask = useCallback(async (taskId: string): Promise<void> => {
    addDeletedTaskId(taskId);
    removeTask(taskId);
    await tasksApi.deleteTask(taskId).catch(() => {
      // Best-effort server deletion; local removal is already done
    });
  }, [removeTask, addDeletedTaskId]);

  // Refresh task list from server
  const refreshTasks = useCallback(async (): Promise<void> => {
    const response = await tasksApi.listTasks();
    setTasks(response.tasks);
    setRunningCount(response.running_count);
    setMaxConcurrent(response.max_concurrent);
  }, [setTasks, setRunningCount, setMaxConcurrent]);

  // Get a task by ID
  const getTaskById = useCallback((taskId: string): AgentTask | undefined => {
    return tasks.find((t) => t.id === taskId);
  }, [tasks]);

  return {
    tasks,
    runningCount,
    maxConcurrent,
    isConnected,
    createTask,
    cancelTask,
    deleteTask,
    addTask,
    refreshTasks,
    getTaskById,
  };
}

// Export the store for direct access if needed
export { useAgentTasksStore };
