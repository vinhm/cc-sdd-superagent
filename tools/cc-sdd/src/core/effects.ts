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

  getInProgress(): EffectRecord[] {
    return this.db
      .prepare("SELECT * FROM effects_queue WHERE status = 'IN_PROGRESS' ORDER BY created_at ASC")
      .all() as unknown as EffectRecord[];
  }

  /**
   * Startup recovery: an effect still IN_PROGRESS belongs to a process that died, so it is put back
   * on the queue (attempt_count is kept). Handlers must be idempotent. Returns the re-queued effects.
   */
  recoverInterrupted(): EffectRecord[] {
    const interrupted = this.getInProgress();
    if (interrupted.length === 0) return [];

    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE effects_queue SET status = 'PENDING', updated_at = ? WHERE status = 'IN_PROGRESS'")
      .run(now);
    return interrupted;
  }

  /** Re-queues a failed attempt until `maxAttempts` is reached, then marks it FAILED. */
  retryOrFail(id: string, error: string, maxAttempts = 5): 'RETRY' | 'FAILED' {
    const row = this.db.prepare('SELECT attempt_count FROM effects_queue WHERE id = ?').get(id) as
      | { attempt_count: number }
      | undefined;
    if (row && row.attempt_count < maxAttempts) {
      this.db
        .prepare("UPDATE effects_queue SET status = 'PENDING', error = ?, updated_at = ? WHERE id = ?")
        .run(error, new Date().toISOString(), id);
      return 'RETRY';
    }
    this.markFailed(id, error);
    return 'FAILED';
  }

  markFailed(id: string, error: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE effects_queue SET status = 'FAILED', error = ?, updated_at = ? WHERE id = ?")
      .run(error, now, id);
  }
}

export class AgentDelivery {
  /** Claims owned by this process that are still executing (guards concurrent duplicates). */
  private inFlight = new Set<string>();

  constructor(private db: DatabaseSync) {}

  /**
   * Delivers a message exactly once per successful handling.
   *
   * The message id is claimed (`PROCESSING`) *before* the action runs, so two concurrent deliveries
   * of the same id cannot both pass. A claim left behind by a crashed process (PROCESSING, but not in
   * flight in this process) is re-run, and a failed action releases its claim so it can be retried.
   */
  async deliver(
    messageId: string,
    handler: string,
    action: () => Promise<void> | void
  ): Promise<{ processed: boolean; duplicate: boolean }> {
    if (this.inFlight.has(messageId)) {
      return { processed: false, duplicate: true };
    }

    const now = new Date().toISOString();
    const claim = this.db
      .prepare(
        "INSERT OR IGNORE INTO inbox_dedup (message_id, handler, processed_at, status) VALUES (?, ?, ?, 'PROCESSING')"
      )
      .run(messageId, handler, now);

    if (Number(claim.changes) === 0) {
      const row = this.db.prepare('SELECT status FROM inbox_dedup WHERE message_id = ?').get(messageId) as
        | { status: string }
        | undefined;
      if (!row || row.status === 'DONE') {
        return { processed: false, duplicate: true };
      }
      // Stale PROCESSING claim from a previous (crashed) process: take it over.
      this.db
        .prepare("UPDATE inbox_dedup SET handler = ?, processed_at = ? WHERE message_id = ? AND status = 'PROCESSING'")
        .run(handler, now, messageId);
    }

    this.inFlight.add(messageId);
    try {
      await action();
    } catch (err) {
      this.db.prepare("DELETE FROM inbox_dedup WHERE message_id = ? AND status = 'PROCESSING'").run(messageId);
      throw err;
    } finally {
      this.inFlight.delete(messageId);
    }

    this.db
      .prepare("UPDATE inbox_dedup SET status = 'DONE', processed_at = ? WHERE message_id = ?")
      .run(new Date().toISOString(), messageId);

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

