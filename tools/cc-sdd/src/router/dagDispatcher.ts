import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { WorkerSlotsManager, WorkerSlotReservation } from '../execution/workerSlots.js';
import type { GitWorktreeManager } from '../execution/worktreeManager.js';
import type { SubscriptionBus } from '../context/subscriptionBus.js';
import { compileMandateFromBoundary } from '../security/mandateEnforcer.js';

export interface TaskItem {
  id: string;
  title: string;
  isParallel: boolean;
  dependsOn: string[];
  boundary: string;
  completed: boolean;
}

export function parseTasksDag(markdown: string): TaskItem[] {
  const tasks: TaskItem[] = [];
  const lines = markdown.split('\n');

  let currentTask: Partial<TaskItem> | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Check for task checkbox e.g. * [ ] **1.2 (P)** Description or * [x] **1.1** Description
    const taskMatch = line.match(/^[*\\-]\s*\[([ xX])\]\s*\*\*([0-9]+(?:\.[0-9]+)*)(?:\s*\((P)\))?\*\*\s*(.*)$/);

    if (taskMatch) {
      if (currentTask && currentTask.id) {
        tasks.push({
          id: currentTask.id,
          title: currentTask.title ?? '',
          isParallel: Boolean(currentTask.isParallel),
          dependsOn: currentTask.dependsOn ?? [],
          boundary: currentTask.boundary ?? '',
          completed: Boolean(currentTask.completed),
        });
      }

      const completed = taskMatch[1].toLowerCase() === 'x';
      const id = taskMatch[2];
      const isParallel = Boolean(taskMatch[3]);
      const title = taskMatch[4]?.trim() ?? '';

      currentTask = {
        id,
        title,
        isParallel,
        completed,
        dependsOn: [],
        boundary: '',
      };
      continue;
    }

    if (currentTask) {
      // Check for *Depends:*
      const dependsMatch = line.match(/[*_]Depends:[*_]\s*([^\n\r]+)/i);
      if (dependsMatch) {
        const raw = dependsMatch[1].trim();
        if (raw.toLowerCase() !== 'none' && raw.length > 0) {
          const deps = raw.split(/[\s,]+/).map((d) => d.trim()).filter(Boolean);
          currentTask.dependsOn = deps;
        }
      }

      // Check for *Boundary:*
      const boundaryMatch = line.match(/[*_]Boundary:[*_]\s*([^\n\r]+)/i);
      if (boundaryMatch) {
        currentTask.boundary = boundaryMatch[1].trim();
      }
    }
  }

  if (currentTask && currentTask.id) {
    tasks.push({
      id: currentTask.id,
      title: currentTask.title ?? '',
      isParallel: Boolean(currentTask.isParallel),
      dependsOn: currentTask.dependsOn ?? [],
      boundary: currentTask.boundary ?? '',
      completed: Boolean(currentTask.completed),
    });
  }

  return tasks;
}

export function getExecutableWave(tasks: TaskItem[]): TaskItem[] {
  const completedIds = new Set(tasks.filter((t) => t.completed).map((t) => t.id));
  const uncompleted = tasks.filter((t) => !t.completed);

  const ready = uncompleted.filter((task) => {
    return task.dependsOn.every((dep) => completedIds.has(dep));
  });

  return ready;
}

export interface DispatchedTask {
  taskId: string;
  worktreePath: string;
  branchName: string;
  reservation: WorkerSlotReservation;
}

export class DagDispatcher {
  constructor(
    private options: {
      db: DatabaseSync;
      workerSlots: WorkerSlotsManager;
      worktreeManager: GitWorktreeManager;
      bus: SubscriptionBus;
    }
  ) {}

  async dispatchWave(
    featureName: string,
    threadId: string,
    tasks: TaskItem[]
  ): Promise<DispatchedTask[]> {
    const { db, workerSlots, worktreeManager, bus } = this.options;
    const now = new Date().toISOString();

    const dispatchPromises = tasks.map(async (task) => {
      const ticketId = `tk-${featureName}-${task.id}`;
      const executorId = `worker-${task.id}`;

      // 1. Reserve slot
      const reservation = await workerSlots.reserveSlot(ticketId, false);

      // 2. Create worktree
      const worktree = await worktreeManager.createWorktree(featureName, task.id);

      // 3. Persist ticket in DB
      db.prepare(
        `INSERT OR REPLACE INTO tickets (id, thread_id, task_id, feature_name, title, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'DISPATCHED', ?, ?)`
      ).run(ticketId, threadId, task.id, featureName, task.title, now, now);

      // 4. Persist mandate
      const mandate = compileMandateFromBoundary(ticketId, task.boundary);
      db.prepare(
        `INSERT OR REPLACE INTO mandates (id, ticket_id, allowed_files, forbidden_files, allowed_commands, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        mandate.id,
        ticketId,
        JSON.stringify(mandate.allowedFiles),
        JSON.stringify(mandate.forbiddenFiles),
        JSON.stringify(mandate.allowedCommands),
        now
      );

      // 5. Persist assignment
      const asgId = `asg-${randomUUID()}`;
      db.prepare(
        `INSERT INTO assignments (id, ticket_id, executor_id, worktree_path, status, assigned_at)
         VALUES (?, ?, ?, ?, 'ACTIVE', ?)`
      ).run(asgId, ticketId, executorId, worktree.worktreePath, now);

      // 6. Subscribe executor to thread
      bus.subscribe(threadId, ticketId, executorId);

      return {
        taskId: task.id,
        worktreePath: worktree.worktreePath,
        branchName: worktree.branchName,
        reservation,
      };
    });

    return Promise.all(dispatchPromises);
  }

  async notifyPolicyChanged(
    featureName: string,
    changedFile: string,
    newPolicySummary: string
  ): Promise<{ notifiedExecutors: string[] }> {
    const { db, bus } = this.options;

    const rows = db
      .prepare(
        `SELECT DISTINCT s.executor_id, s.thread_id, t.id as ticket_id
         FROM subscriptions s
         JOIN tickets t ON s.ticket_id = t.id
         WHERE t.feature_name = ? AND s.active = 1`
      )
      .all(featureName) as Array<{ executor_id: string; thread_id: string; ticket_id: string }>;

    const notifiedExecutors: string[] = [];

    for (const row of rows) {
      await bus.dispatchThreadEvent({
        id: `ev-policy-${randomUUID()}`,
        threadId: row.thread_id,
        eventType: 'POLICY_CHANGED',
        payload: {
          changedFile,
          newPolicySummary,
          ticketId: row.ticket_id,
        },
      });
      notifiedExecutors.push(row.executor_id);
    }

    return { notifiedExecutors };
  }
}
