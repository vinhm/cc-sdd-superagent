import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export interface Assignment {
  id: string;
  ticket_id: string;
  executor_id: string;
  worktree_path: string;
  status: 'ACTIVE' | 'HANDED_OFF' | 'COMPLETED' | 'CANCELLED';
  assigned_at: string;
  released_at?: string | null;
}

export class AssignmentManager {
  constructor(private db: DatabaseSync) { }

  createAssignment(ticketId: string, executorId: string, worktreePath: string): Assignment {
    const id = `asg-${randomUUID()}`;
    const assignedAt = new Date().toISOString();

    const ticket = this.db.prepare('SELECT thread_id FROM tickets WHERE id = ?').get(ticketId) as
      | { thread_id?: string }
      | undefined;

    this.db
      .prepare(
        'INSERT INTO assignments (id, ticket_id, executor_id, worktree_path, status, assigned_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(id, ticketId, executorId, worktreePath, 'ACTIVE', assignedAt);

    this.db.prepare("UPDATE tickets SET status = 'DISPATCHED', updated_at = ? WHERE id = ?").run(assignedAt, ticketId);

    if (ticket?.thread_id) {
      const hasSubscription = this.db
        .prepare(
          'SELECT id FROM subscriptions WHERE thread_id = ? AND ticket_id = ? AND executor_id = ? AND active = 1 LIMIT 1'
        )
        .get(ticket.thread_id, ticketId, executorId);

      if (!hasSubscription) {
        const subId = `sub-${randomUUID()}`;
        this.db
          .prepare(
            'INSERT INTO subscriptions (id, thread_id, ticket_id, executor_id, active, created_at) VALUES (?, ?, ?, ?, 1, ?)'
          )
          .run(subId, ticket.thread_id, ticketId, executorId, assignedAt);
      }
    }

    return {
      id,
      ticket_id: ticketId,
      executor_id: executorId,
      worktree_path: worktreePath,
      status: 'ACTIVE',
      assigned_at: assignedAt,
    };
  }

  getThreadOwner(threadId: string): string | null {
    const row = this.db
      .prepare(
        'SELECT executor_id FROM subscriptions WHERE thread_id = ? AND active = 1 ORDER BY created_at DESC LIMIT 1'
      )
      .get(threadId) as { executor_id?: string } | undefined;

    return row?.executor_id ?? null;
  }

  handoffAssignment(assignmentId: string, targetStatus: 'WAITING_FOR_HUMAN' | 'HANDED_OFF' = 'WAITING_FOR_HUMAN'): void {
    const releasedAt = new Date().toISOString();

    const asg = this.db.prepare('SELECT ticket_id, executor_id FROM assignments WHERE id = ?').get(assignmentId) as
      | { ticket_id: string; executor_id: string }
      | undefined;

    if (!asg) return;

    this.db
      .prepare("UPDATE assignments SET status = 'HANDED_OFF', released_at = ? WHERE id = ?")
      .run(releasedAt, assignmentId);

    this.db.prepare('UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?').run(targetStatus, releasedAt, asg.ticket_id);

    this.db
      .prepare('UPDATE subscriptions SET active = 0 WHERE ticket_id = ? AND executor_id = ?')
      .run(asg.ticket_id, asg.executor_id);
  }

  completeAssignment(assignmentId: string): void {
    const releasedAt = new Date().toISOString();

    const asg = this.db.prepare('SELECT ticket_id, executor_id FROM assignments WHERE id = ?').get(assignmentId) as
      | { ticket_id: string; executor_id: string }
      | undefined;

    if (!asg) return;

    this.db
      .prepare("UPDATE assignments SET status = 'COMPLETED', released_at = ? WHERE id = ?")
      .run(releasedAt, assignmentId);

    this.db.prepare("UPDATE tickets SET status = 'COMPLETED', updated_at = ? WHERE id = ?").run(releasedAt, asg.ticket_id);

    this.db
      .prepare('UPDATE subscriptions SET active = 0 WHERE ticket_id = ? AND executor_id = ?')
      .run(asg.ticket_id, asg.executor_id);
  }
}

