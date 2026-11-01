import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export interface EffectRecord {
  id: string;
  ticket_id: string | null;
  effect_type: string;
  payload: string;
  status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  attempt_count: number;
  error?: string | null;
  created_at: string;
  updated_at: string;
}

export class EffectsQueue {
  constructor(private db: DatabaseSync) {}

  enqueue(ticketId: string | null, effectType: string, payload: any): EffectRecord {
    const id = `eff-${randomUUID()}`;
    const now = new Date().toISOString();
    const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);

    this.db
      .prepare(
        'INSERT INTO effects_queue (id, ticket_id, effect_type, payload, status, attempt_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(id, ticketId, effectType, payloadStr, 'PENDING', 0, now, now);

    return {
      id,
      ticket_id: ticketId,
      effect_type: effectType,
      payload: payloadStr,
      status: 'PENDING',
      attempt_count: 0,
      created_at: now,
      updated_at: now,
    };
  }

  getPending(): EffectRecord[] {
    return this.db
      .prepare("SELECT * FROM effects_queue WHERE status = 'PENDING' ORDER BY created_at ASC")
      .all() as unknown as EffectRecord[];
  }

  markInProgress(id: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE effects_queue SET status = 'IN_PROGRESS', attempt_count = attempt_count + 1, updated_at = ? WHERE id = ?")
      .run(now, id);
  }

  markCompleted(id: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE effects_queue SET status = 'COMPLETED', updated_at = ? WHERE id = ?")
      .run(now, id);
  }

  markFailed(id: string, error: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE effects_queue SET status = 'FAILED', error = ?, updated_at = ? WHERE id = ?")
      .run(error, now, id);
  }
}

export class AgentDelivery {
  constructor(private db: DatabaseSync) {}

  async deliver(
    messageId: string,
    handler: string,
    action: () => Promise<void> | void
  ): Promise<{ processed: boolean; duplicate: boolean }> {
    const existing = this.db.prepare('SELECT message_id FROM inbox_dedup WHERE message_id = ?').get(messageId);
    if (existing) {
      return { processed: false, duplicate: true };
    }

    await action();

    const now = new Date().toISOString();
    this.db
      .prepare('INSERT INTO inbox_dedup (message_id, handler, processed_at) VALUES (?, ?, ?)')
      .run(messageId, handler, now);

    return { processed: true, duplicate: false };
  }
}

export interface SendCommentOptions {
  ticketId: string;
  channel: string;
  messageId: string;
  body: string;
  remoteComments: string[];
  sender: (content: string) => Promise<void> | void;
}

export class OutboxReconciler {
  constructor(private db: DatabaseSync) {}

  static createHtmlMarker(messageId: string): string {
    return `<!-- cc-sdd-msg-id: ${messageId} -->`;
  }

  static hasHtmlMarker(content: string, messageId: string): boolean {
    const marker = OutboxReconciler.createHtmlMarker(messageId);
    return content.includes(marker);
  }

  async sendComment(options: {
    ticketId: string;
    channel: string;
    messageId: string;
    body: string;
    remoteComments: string[];
    sender: (content: string) => Promise<void> | void;
  }): Promise<{ sent: boolean; skippedDuplicate: boolean; htmlMarker: string }> {
    const { ticketId, channel, messageId, body, remoteComments, sender } = options;
    const htmlMarker = OutboxReconciler.createHtmlMarker(messageId);

    // 1. Check local receipts
    const existingReceipt = this.db
      .prepare('SELECT id FROM outbox_receipts WHERE message_id = ? AND channel = ?')
      .get(messageId, channel);

    if (existingReceipt) {
      return { sent: false, skippedDuplicate: true, htmlMarker };
    }

    // 2. Check remote thread for the HTML marker
    const alreadyOnRemote = remoteComments.some((comment) =>
      OutboxReconciler.hasHtmlMarker(comment, messageId)
    );

    if (alreadyOnRemote) {
      const now = new Date().toISOString();
      const id = `rcpt-${randomUUID()}`;
      this.db
        .prepare(
          'INSERT OR IGNORE INTO outbox_receipts (id, ticket_id, channel, message_id, idempotency_key, html_marker, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(id, ticketId, channel, messageId, messageId, htmlMarker, 'SENT', now);

      return { sent: false, skippedDuplicate: true, htmlMarker };
    }

    // 3. Not sent yet: embed marker and send
    const finalContent = `${body}\n\n${htmlMarker}`;
    await sender(finalContent);

    const now = new Date().toISOString();
    const id = `rcpt-${randomUUID()}`;
    this.db
      .prepare(
        'INSERT INTO outbox_receipts (id, ticket_id, channel, message_id, idempotency_key, html_marker, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(id, ticketId, channel, messageId, messageId, htmlMarker, 'SENT', now);

    return { sent: true, skippedDuplicate: false, htmlMarker };
  }
}
