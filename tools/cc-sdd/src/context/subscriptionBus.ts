import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export interface ThreadEvent {
  id: string;
  threadId: string;
  eventType: string;
  payload: any;
  timestamp?: string;
}

export interface DispatchResult {
  routedDirectly: boolean;
  recipientExecutorId: string | null;
  routerCalled: boolean;
}

export class SubscriptionBus {
  private handlers = new Map<string, (event: ThreadEvent) => Promise<void> | void>();

  constructor(private db: DatabaseSync) {}

  subscribe(threadId: string, ticketId: string, executorId: string): void {
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

  registerExecutorHandler(executorId: string, handler: (event: ThreadEvent) => Promise<void> | void): void {
    this.handlers.set(executorId, handler);
  }

  unregisterExecutorHandler(executorId: string): void {
    this.handlers.delete(executorId);
  }

  async dispatchThreadEvent(
    event: ThreadEvent,
    routerEvaluator?: (event: ThreadEvent) => Promise<void> | void
  ): Promise<DispatchResult> {
    const activeSub = this.db
      .prepare(
        'SELECT executor_id FROM subscriptions WHERE thread_id = ? AND active = 1 ORDER BY created_at DESC LIMIT 1'
      )
      .get(event.threadId) as { executor_id?: string } | undefined;

    if (activeSub?.executor_id) {
      const executorId = activeSub.executor_id;
      const handler = this.handlers.get(executorId);
      if (handler) {
        await handler(event);
      }
      return {
        routedDirectly: true,
        recipientExecutorId: executorId,
        routerCalled: false,
      };
    }

    if (routerEvaluator) {
      await routerEvaluator(event);
    }

    return {
      routedDirectly: false,
      recipientExecutorId: null,
      routerCalled: Boolean(routerEvaluator),
    };
  }
}
