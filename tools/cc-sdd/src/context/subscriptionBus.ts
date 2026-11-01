import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export interface ThreadEvent {
  id: string;
  threadId: string;
  /** When set, the event is addressed to a single ticket instead of every ticket in the thread. */
  ticketId?: string;
  eventType: string;
  payload: any;
  timestamp?: string;
}

export interface DispatchResult {
  routedDirectly: boolean;
  /** Latest subscribed executor (kept for backward compatibility). */
  recipientExecutorId: string | null;
  recipientExecutorIds: string[];
  /** Executors whose handler processed the event. */
  deliveredTo: string[];
  /** Executors that are subscribed but offline: the event is persisted in their inbox. */
  queuedFor: string[];
  routerCalled: boolean;
}

type ExecutorHandler = (event: ThreadEvent) => Promise<void> | void;

interface SubscriptionRow {
  executor_id: string;
  ticket_id: string;
}

interface InboxRow {
  id: string;
  event_id: string;
  thread_id: string;
  ticket_id: string | null;
  event_type: string;
  payload: string | null;
  created_at: string;
}

export class SubscriptionBus {
  private handlers = new Map<string, ExecutorHandler>();

  constructor(private db: DatabaseSync) {}

  subscribe(threadId: string, ticketId: string, executorId: string): void {
    const existing = this.db
      .prepare(
        'SELECT id FROM subscriptions WHERE thread_id = ? AND ticket_id = ? AND executor_id = ? AND active = 1 LIMIT 1'
      )
      .get(threadId, ticketId, executorId);
    if (existing) return;

    const id = `sub-${randomUUID()}`;
    const now = new Date().toISOString();

    this.db
      .prepare(
        'INSERT INTO subscriptions (id, thread_id, ticket_id, executor_id, active, created_at) VALUES (?, ?, ?, ?, 1, ?)'
      )
      .run(id, threadId, ticketId, executorId, now);
  }

  unsubscribe(ticketId: string, executorId: string): void {
    this.db
      .prepare('UPDATE subscriptions SET active = 0 WHERE ticket_id = ? AND executor_id = ?')
      .run(ticketId, executorId);
  }

  /**
   * Registers the live handler of an executor and immediately replays events that were persisted
   * while it was offline (e.g. after a restart), oldest first.
   */
  registerExecutorHandler(executorId: string, handler: ExecutorHandler): Promise<void> {
    this.handlers.set(executorId, handler);
    return this.flushInbox(executorId);
  }

  unregisterExecutorHandler(executorId: string): void {
    this.handlers.delete(executorId);
  }

  async flushInbox(executorId: string): Promise<void> {
    const handler = this.handlers.get(executorId);
    if (!handler) return;

    const pending = this.db
      .prepare(
        "SELECT id, event_id, thread_id, ticket_id, event_type, payload, created_at FROM executor_inbox WHERE executor_id = ? AND status = 'PENDING' ORDER BY created_at ASC, rowid ASC"
      )
      .all(executorId) as unknown as InboxRow[];

    for (const row of pending) {
      await handler({
        id: row.event_id,
        threadId: row.thread_id,
        ticketId: row.ticket_id ?? undefined,
        eventType: row.event_type,
        payload: row.payload ? JSON.parse(row.payload) : undefined,
        timestamp: row.created_at,
      });
      this.markDelivered(row.id);
    }
  }

  private markDelivered(inboxId: string): void {
    this.db
      .prepare("UPDATE executor_inbox SET status = 'DELIVERED', delivered_at = ? WHERE id = ?")
      .run(new Date().toISOString(), inboxId);
  }

  async dispatchThreadEvent(
    event: ThreadEvent,
    routerEvaluator?: (event: ThreadEvent) => Promise<void> | void
  ): Promise<DispatchResult> {
    const subs = (
      event.ticketId
        ? this.db
            .prepare(
              'SELECT DISTINCT executor_id, ticket_id FROM subscriptions WHERE thread_id = ? AND ticket_id = ? AND active = 1 ORDER BY created_at DESC'
            )
            .all(event.threadId, event.ticketId)
        : this.db
            .prepare(
              'SELECT DISTINCT executor_id, ticket_id FROM subscriptions WHERE thread_id = ? AND active = 1 ORDER BY created_at DESC'
            )
            .all(event.threadId)
    ) as unknown as SubscriptionRow[];

    if (subs.length > 0) {
      const deliveredTo: string[] = [];
      const queuedFor: string[] = [];
      const recipients: string[] = [];

      for (const sub of subs) {
        if (recipients.includes(sub.executor_id)) continue;
        recipients.push(sub.executor_id);

        const inboxId = `inb-${randomUUID()}`;
        const now = new Date().toISOString();
        this.db
          .prepare(
            "INSERT OR IGNORE INTO executor_inbox (id, event_id, executor_id, thread_id, ticket_id, event_type, payload, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)"
          )
          .run(
            inboxId,
            event.id,
            sub.executor_id,
            event.threadId,
            sub.ticket_id,
            event.eventType,
            event.payload === undefined ? null : JSON.stringify(event.payload),
            now
          );

        const row = this.db
          .prepare('SELECT id, status FROM executor_inbox WHERE event_id = ? AND executor_id = ?')
          .get(event.id, sub.executor_id) as unknown as { id: string; status: string };

        if (row.status === 'DELIVERED') {
          // Duplicate event id for this executor: already handled, never replay.
          deliveredTo.push(sub.executor_id);
          continue;
        }

        const handler = this.handlers.get(sub.executor_id);
        if (!handler) {
          queuedFor.push(sub.executor_id);
          continue;
        }

        await handler(event);
        this.markDelivered(row.id);
        deliveredTo.push(sub.executor_id);
      }

      return {
        routedDirectly: true,
        recipientExecutorId: recipients[0] ?? null,
        recipientExecutorIds: recipients,
        deliveredTo,
        queuedFor,
        routerCalled: false,
      };
    }

    if (routerEvaluator) {
      await routerEvaluator(event);
    }

    return {
      routedDirectly: false,
      recipientExecutorId: null,
      recipientExecutorIds: [],
      deliveredTo: [],
      queuedFor: [],
      routerCalled: Boolean(routerEvaluator),
    };
  }
}
