/**
 * @fileoverview A simple in-memory task manager for handling long-running, async operations.
 * This is used to work around short execution timeouts in the hosting environment.
 */

export const TASK_STATUS = {
  PENDING: 'PENDING',
  RUNNING: 'RUNNING',
  COMPLETE: 'COMPLETE',
  FAILED: 'FAILED',
};

const tasks = new Map();

/**
 * Creates a new task and kicks off the async worker function.
 * @param {Function} worker - The async function to execute.
 * @returns {string} The ID of the created task.
 */
export function createTask(worker) {
  const taskId = `task_${Math.random().toString(36).substring(2, 15)}`;
  const task = {
    id: taskId,
    status: TASK_STATUS.PENDING,
    result: null,
    error: null,
  };
  tasks.set(taskId, task);

  // Do not await the worker. Let it run in the background.
  // The IFFE is immediately invoked.
  (async () => {
    try {
      task.status = TASK_STATUS.RUNNING;
      const result = await worker();
      task.status = TASK_STATUS.COMPLETE;
      task.result = result;
    } catch (e) {
      console.error(`Task ${taskId} failed:`, e);
      task.status = TASK_STATUS.FAILED;
      task.error = e.message || 'Unknown error';
    }
  })();

  return taskId;
}

/**
 * Gets the status of a task.
 * @param {string} taskId The ID of the task to check.
 * @returns {{status: string, error?: string}|null} An object with the task's current status.
 */
export function getTaskStatus(taskId) {
  if (!tasks.has(taskId)) {
    return { status: 'NOT_FOUND', error: 'No task with that ID was found.' };
  }
  const { status, error } = tasks.get(taskId);
  return { status, error };
}

/**
 * Gets the result of a completed task and removes it from memory.
 * @param {string} taskId The ID of the task to retrieve.
 * @returns {any} The task result, or null if not ready or not found.
 */
export function getTaskResult(taskId) {
  if (!tasks.has(taskId)) {
    return null;
  }
  const task = tasks.get(taskId);
  if (task.status !== TASK_STATUS.COMPLETE) {
    return null;
  }

  const result = task.result;
  // Clean up the task from memory to prevent leaks
  tasks.delete(taskId);
  return result;
} 