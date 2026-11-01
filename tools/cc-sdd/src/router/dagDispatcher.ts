import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { WorkerSlotsManager, WorkerSlotReservation } from '../execution/workerSlots.js';
import type { GitWorktreeManager } from '../execution/worktreeManager.js';
import type { SubscriptionBus } from '../context/subscriptionBus.js';
import {
  compileMandateFromBoundary,
  extractBoundaryPaths,
  matchesMandatePattern,
  type CompileMandateOptions,
} from '../security/mandateEnforcer.js';
import { AssignmentManager } from '../core/assignments.js';
import { EffectsQueue } from '../core/effects.js';
import { branchNameFor, executorIdFor, ticketIdFor } from '../core/naming.js';
import { EvalQueue } from './evalQueue.js';

export interface TaskItem {
  id: string;
  title: string;
  isParallel: boolean;
  dependsOn: string[];
  boundary: string;
  completed: boolean;
}

const TASK_ID = String.raw`\d+(?:\.\d+)*`;

// `* [ ] **1.2 (P)** Title` (bold ids as in the refactor spec)
const BOLD_TASK_LINE = new RegExp(String.raw`^[*-]\s*\[([ xX])\]\*?\s*\*\*(${TASK_ID})(?:\s*\((P)\))?\*\*\s*(.*)$`);
// `- [ ] 1.2 (P) Title` / `- [ ]* 1.2 Title` / `- [ ] 1. Major` (cc-sdd tasks.md template)
const PLAIN_TASK_LINE = new RegExp(String.raw`^[*-]\s*\[([ xX])\]\*?\s*(${TASK_ID})\.?(?:\s*\((P)\))?(?:\s+(.*))?$`);

const DEPENDS_LINE = /[*_]\s*Depends\s*:\s*[*_]?\s*(.*?)\s*[*_]?\s*$/i;
const BOUNDARY_LINE = /[*_]\s*Boundary\s*:\s*[*_]?\s*(.*?)\s*[*_]?\s*$/i;

/**
 * Parses `tasks.md` into a task graph. Accepts the cc-sdd template format
 * (`- [ ] 1.1 (P) Title`, `_Boundary: X_`, `_Depends: 1.0, 1.1_`) as well as the bold variant
 * (`* [ ] **1.1 (P)** Title`, `*Boundary:* X`, `*Depends:* 1.0`).
 */
export function parseTasksDag(markdown: string): TaskItem[] {
  const tasks: TaskItem[] = [];
  const lines = markdown.split(/\r?\n/);

  let currentTask: TaskItem | null = null;

  const flush = () => {
    if (currentTask) tasks.push(currentTask);
    currentTask = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // A new section ends the previous task: its annotations must not leak into the next heading.
    if (/^#{1,6}\s/.test(line)) {
      flush();
      continue;
    }

    const taskMatch = line.match(BOLD_TASK_LINE) ?? line.match(PLAIN_TASK_LINE);
    if (taskMatch) {
      flush();
      currentTask = {
        id: taskMatch[2],
        title: (taskMatch[4] ?? '').trim(),
        isParallel: Boolean(taskMatch[3]),
        completed: taskMatch[1].toLowerCase() === 'x',
        dependsOn: [],
        boundary: '',
      };
      continue;
    }

    if (!currentTask) continue;

    const dependsMatch = line.match(DEPENDS_LINE);
    if (dependsMatch) {
      currentTask.dependsOn = dependsMatch[1]
        .split(/[\s,]+/)
        .map((d) => d.replace(/\.+$/, ''))
        .filter((d) => new RegExp(`^${TASK_ID}$`).test(d));
      continue;
    }

    const boundaryMatch = line.match(BOUNDARY_LINE);
    if (boundaryMatch) {
      currentTask.boundary = boundaryMatch[1].trim();
    }
  }
  flush();

  // `- [ ] 1. Group` headings are categories when `1.x` sub-tasks exist; only sub-tasks execute.
  const ids = new Set(tasks.map((t) => t.id));
  return tasks.filter((t) => {
    if (t.id.includes('.')) return true;
    return !Array.from(ids).some((other) => other.startsWith(`${t.id}.`));
  });
}

function boundariesOverlap(a: TaskItem, b: TaskItem): boolean {
  const pathsA = extractBoundaryPaths(a.boundary);
  const pathsB = extractBoundaryPaths(b.boundary);

  if (pathsA.length > 0 && pathsB.length > 0) {
    return pathsA.some((pa) => pathsB.some((pb) => matchesMandatePattern(pa, pb) || matchesMandatePattern(pb, pa)));
  }

  // Component-name boundaries: the same component cannot be edited by two workers at once.
  const na = a.boundary.trim().toLowerCase();
  const nb = b.boundary.trim().toLowerCase();
  return na.length > 0 && na === nb;
}

/**
 * Next wave of tasks that can start now.
 *
 * - only tasks whose `_Depends:_` are all completed and that are not already in flight
 * - `(P)` tasks run together, except two tasks whose boundaries overlap are never in the same wave
 * - a task without `(P)` is sequential: it only starts alone, when nothing else is running
 */
export function getExecutableWave(tasks: TaskItem[], inFlightIds: Iterable<string> = []): TaskItem[] {
  const completedIds = new Set(tasks.filter((t) => t.completed).map((t) => t.id));
  const inFlight = new Set(inFlightIds);

  const ready = tasks.filter(
    (task) => !task.completed && !inFlight.has(task.id) && task.dependsOn.every((dep) => completedIds.has(dep))
  );

  const wave: TaskItem[] = [];
  for (const task of ready.filter((t) => t.isParallel)) {
    if (!wave.some((accepted) => boundariesOverlap(accepted, task))) {
      wave.push(task);
    }
  }
  if (wave.length > 0) return wave;

  const sequential = ready.find((t) => !t.isParallel);
  if (sequential && inFlight.size === 0) return [sequential];
  return [];
}

export interface DispatchedTask {
  taskId: string;
  ticketId: string;
  executorId: string;
  worktreePath: string;
  branchName: string;
  reservation: WorkerSlotReservation;
  /** True when the ticket already had an active assignment and was resumed instead of recreated. */
  resumed: boolean;
}

export interface DispatchOptions {
  /** Extra allowed paths per task (e.g. resolved from the design.md File Structure Plan). */
  fileStructurePlan?: string[] | ((task: TaskItem) => string[]);
  mandate?: CompileMandateOptions;
}

export class DispatchWaveError extends Error {
  constructor(
    public readonly dispatched: DispatchedTask[],
    public readonly failures: Array<{ taskId: string; error: unknown }>
  ) {
    super(
      `Failed to dispatch ${failures.length} task(s): ` +
        failures.map((f) => `${f.taskId}: ${f.error instanceof Error ? f.error.message : String(f.error)}`).join('; ')
    );
    this.name = 'DispatchWaveError';
  }
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

  /** Task ids of a feature that already have a live ticket (to exclude from the next wave). */
  getInFlightTaskIds(featureName: string): string[] {
    const rows = this.options.db
      .prepare(
        "SELECT task_id FROM tickets WHERE feature_name = ? AND status IN ('DISPATCHED', 'RUNNING', 'IN_PROGRESS', 'WAITING_FOR_HUMAN')"
      )
      .all(featureName) as unknown as Array<{ task_id: string }>;
    return rows.map((r) => r.task_id);
  }

  async dispatchWave(
    featureName: string,
    threadId: string,
    tasks: TaskItem[],
    dispatchOptions: DispatchOptions = {}
  ): Promise<DispatchedTask[]> {
    const results = await Promise.allSettled(
      tasks.map((task) => this.dispatchTask(featureName, threadId, task, dispatchOptions))
    );

    const dispatched: DispatchedTask[] = [];
    const failures: Array<{ taskId: string; error: unknown }> = [];
    results.forEach((res, i) => {
      if (res.status === 'fulfilled') dispatched.push(res.value);
      else failures.push({ taskId: tasks[i].id, error: res.reason });
    });

    if (failures.length > 0) {
      throw new DispatchWaveError(dispatched, failures);
    }
    return dispatched;
  }

  private async dispatchTask(
    featureName: string,
    threadId: string,
    task: TaskItem,
    dispatchOptions: DispatchOptions
  ): Promise<DispatchedTask> {
    const { db, workerSlots, worktreeManager, bus } = this.options;
    const effects = new EffectsQueue(db);
    const assignments = new AssignmentManager(db);

    const ticketId = ticketIdFor(featureName, task.id);
    const executorId = executorIdFor(task.id);

    // A live assignment means this task was already dispatched (re-run / restart): resume it.
    const live = db
      .prepare("SELECT worktree_path FROM assignments WHERE ticket_id = ? AND status = 'ACTIVE' LIMIT 1")
      .get(ticketId) as { worktree_path: string } | undefined;
    if (live) {
      const reservation = await workerSlots.reserveSlot(ticketId, false);
      bus.subscribe(threadId, ticketId, executorId);
      return {
        taskId: task.id,
        ticketId,
        executorId,
        worktreePath: live.worktree_path,
        branchName: branchNameFor(featureName, task.id),
        reservation,
        resumed: true,
      };
    }

    // Compile the mandate first: a task that cannot be bounded must never reach a worker.
    const plan =
      typeof dispatchOptions.fileStructurePlan === 'function'
        ? dispatchOptions.fileStructurePlan(task)
        : (dispatchOptions.fileStructurePlan ?? []);
    const mandate = compileMandateFromBoundary(ticketId, task.boundary, plan, dispatchOptions.mandate);
    if (mandate.allowedFiles.length === 0) {
      throw new Error(
        `MANDATE_EMPTY: task ${task.id} has no resolvable file scope from _Boundary: ${task.boundary || '(none)'}_ . ` +
          'Provide file paths in the boundary or pass dispatchOptions.fileStructurePlan.'
      );
    }

    const reservation = await workerSlots.reserveSlot(ticketId, false);
    let effectId: string | undefined;
    let createdWorktreePath: string | undefined;

    try {
      // 1. Write-ahead intent: ticket + immutable mandate + PENDING effect commit atomically.
      //    (Synchronous block: no await between BEGIN and COMMIT, so concurrent tasks cannot interleave.)
      const now = new Date().toISOString();
      db.exec('BEGIN');
      try {
        db.prepare(
          `INSERT INTO tickets (id, thread_id, task_id, feature_name, title, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?)
           ON CONFLICT(id) DO UPDATE SET thread_id = excluded.thread_id, title = excluded.title, updated_at = excluded.updated_at`
        ).run(ticketId, threadId, task.id, featureName, task.title, now, now);

        // Mandates are immutable: keep the first one compiled for this ticket.
        const existingMandate = db.prepare('SELECT id FROM mandates WHERE ticket_id = ? LIMIT 1').get(ticketId);
        if (!existingMandate) {
          db.prepare(
            `INSERT INTO mandates (id, ticket_id, allowed_files, forbidden_files, allowed_commands, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`
          ).run(
            mandate.id,
            ticketId,
            JSON.stringify(mandate.allowedFiles),
            JSON.stringify(mandate.forbiddenFiles),
            JSON.stringify(mandate.allowedCommands),
            now
          );
        }

        effectId = effects.enqueue(ticketId, 'DISPATCH_TASK', { featureName, taskId: task.id, executorId }).id;
        effects.markInProgress(effectId);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }

      // 2. Act on the outside world (worktree), then record the assignment + subscription.
      const worktree = await worktreeManager.createWorktree(featureName, task.id);
      createdWorktreePath = worktree.worktreePath;

      assignments.createAssignment(ticketId, executorId, worktree.worktreePath);
      bus.subscribe(threadId, ticketId, executorId);
      effects.markCompleted(effectId);

      return {
        taskId: task.id,
        ticketId,
        executorId,
        worktreePath: worktree.worktreePath,
        branchName: worktree.branchName,
        reservation,
        resumed: false,
      };
    } catch (err) {
      // Roll back side effects of this attempt so no slot or worktree is leaked.
      reservation.release();
      if (effectId) effects.markFailed(effectId, err instanceof Error ? err.message : String(err));
      if (createdWorktreePath) {
        await worktreeManager.removeWorktree(createdWorktreePath, true).catch(() => {});
      }
      throw err;
    }
  }

  /**
   * Announces a policy change without killing running work: executors receive a POLICY_CHANGED event
   * in their own inbox and pending Eval passes are re-queued under the new policy.
   * Omit `featureName` for project-wide documents (e.g. steering) to notify every active ticket.
   */
  async notifyPolicyChanged(
    featureName: string | undefined,
    changedFile: string,
    newPolicySummary: string
  ): Promise<{ notifiedExecutors: string[]; requeuedEvals: number }> {
    const { db, bus } = this.options;

    const requeuedEvals = new EvalQueue(db).requeueAllPending(`policy-changed: ${changedFile}`);

    const rows = (
      featureName === undefined
        ? db
            .prepare(
              `SELECT DISTINCT s.executor_id, s.thread_id, t.id as ticket_id
               FROM subscriptions s
               JOIN tickets t ON s.ticket_id = t.id
               WHERE s.active = 1`
            )
            .all()
        : db
            .prepare(
              `SELECT DISTINCT s.executor_id, s.thread_id, t.id as ticket_id
               FROM subscriptions s
               JOIN tickets t ON s.ticket_id = t.id
               WHERE t.feature_name = ? AND s.active = 1`
            )
            .all(featureName)
    ) as unknown as Array<{ executor_id: string; thread_id: string; ticket_id: string }>;

    const notifiedExecutors: string[] = [];

    for (const row of rows) {
      await bus.dispatchThreadEvent({
        id: `ev-policy-${randomUUID()}`,
        threadId: row.thread_id,
        ticketId: row.ticket_id,
        eventType: 'POLICY_CHANGED',
        payload: {
          changedFile,
          newPolicySummary,
          ticketId: row.ticket_id,
        },
      });
      notifiedExecutors.push(row.executor_id);
    }

    return { notifiedExecutors, requeuedEvals };
  }
}
