import { DatabaseSync } from 'node:sqlite';

export interface EvalQueueEntry {
  id: string;
  thread_id: string;
  status: 'PENDING' | 'REQUEUED' | 'DONE';
  reason: string | null;
}

/**
 * Pending Eval passes. When policy (steering / requirements / design) changes, entries are not
 * dropped: they are marked REQUEUED so they are re-evaluated under the new policy.
 */
export class EvalQueue {
  constructor(private db: DatabaseSync) {}

  enqueue(id: string, threadId: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "INSERT OR IGNORE INTO eval_queue (id, thread_id, status, created_at, updated_at) VALUES (?, ?, 'PENDING', ?, ?)"
      )
      .run(id, threadId, now, now);
  }

  listPending(): EvalQueueEntry[] {
    return this.db
      .prepare("SELECT id, thread_id, status, reason FROM eval_queue WHERE status IN ('PENDING', 'REQUEUED') ORDER BY created_at ASC")
      .all() as unknown as EvalQueueEntry[];
  }

  /** Invalidates the verdicts of waiting evals so they run again under the new policy. */
  requeueAllPending(reason: string): number {
    const res = this.db
      .prepare("UPDATE eval_queue SET status = 'REQUEUED', reason = ?, updated_at = ? WHERE status IN ('PENDING', 'REQUEUED')")
      .run(reason, new Date().toISOString());
    return Number(res.changes);
  }

  markDone(id: string): void {
    this.db
      .prepare("UPDATE eval_queue SET status = 'DONE', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
  }
}

