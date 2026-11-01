/**
 * Single source of truth for identifiers shared by the router, the worktree manager and recovery.
 * Keeping them in one place prevents drift such as `task-1.1` vs `task-1-1`.
 */

export function sanitizeTaskId(taskId: string): string {
  return taskId.replace(/[^a-zA-Z0-9_\-]/g, '-');
}

export function branchNameFor(featureName: string, taskId: string): string {
  return `sdd/${featureName}/task-${sanitizeTaskId(taskId)}`;
}

export function worktreeDirNameFor(taskId: string): string {
  return `task-${sanitizeTaskId(taskId)}`;
}

export function ticketIdFor(featureName: string, taskId: string): string {
  return `tk-${featureName}-${taskId}`;
}

export function executorIdFor(taskId: string): string {
  return `worker-${taskId}`;
}

