import { DatabaseSync } from 'node:sqlite';
import type { WorkerSlotsManager } from '../execution/workerSlots.js';

export interface WatchdogOptions {
  db: DatabaseSync;
  workerSlots?: WorkerSlotsManager;
  maxIdenticalFailures?: number;
  maxWaitMs?: number; // default: 30 minutes
  maxEffectAttempts?: number; // default: 3 attempts
}

export interface WatchdogEvaluation {
  healthy: boolean;
  action: 'CONTINUE' | 'STOP_BY_IMPACT';
  reason?: string;
}

interface FailureSignature {
  lastError: string;
  lastDiffHash: string;
  consecutiveCount: number;
}

export class SemanticWatchdog {
  private maxIdenticalFailures: number;
  private maxWaitMs: number;
  private maxEffectAttempts: number;
  private history = new Map<string, FailureSignature>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private options: WatchdogOptions) {
    this.maxIdenticalFailures = options.maxIdenticalFailures ?? 2;
    this.maxWaitMs = options.maxWaitMs ?? 30 * 60 * 1000;
    this.maxEffectAttempts = options.maxEffectAttempts ?? 3;
  }

  /**
   * Records a TDD failure iteration and checks for zero-progress loops.
   * If identical error and diff occur repeatedly, stops the ticket by impact.
   */
  recordIteration(ticketId: string, testError: string, diffHash: string): WatchdogEvaluation {
    const existing = this.history.get(ticketId);
    let consecutiveCount = 1;

    if (existing && existing.lastError === testError && existing.lastDiffHash === diffHash) {
      consecutiveCount = existing.consecutiveCount + 1;
    }

    if (consecutiveCount >= this.maxIdenticalFailures) {
      this.stopByImpact(
        ticketId,
        `REPEATED_ZERO_PROGRESS_LOOP: ${consecutiveCount} identical failures without semantic progress. Escalating to human decision.`
      );
      this.history.delete(ticketId);

      return {
        healthy: false,
        action: 'STOP_BY_IMPACT',
        reason: `REPEATED_ZERO_PROGRESS_LOOP: ${consecutiveCount} identical failures without semantic progress. Escalating to human decision.`,
      };
    }

    this.history.set(ticketId, {
      lastError: testError,
      lastDiffHash: diffHash,
      consecutiveCount,
    });

    return {
      healthy: true,
      action: 'CONTINUE',
    };
  }

  /**
   * Scans active tickets and effects_queue to detect stalled work, excessive retries,
   * or deadlocks, stopping offending tickets by impact.
   */
  async scanAndEnforce(): Promise<Array<{ ticketId: string; reason: string }>> {
    const stopped: Array<{ ticketId: string; reason: string }> = [];
    const now = Date.now();

    // 1. Scan active tickets for excessive wait times
    const activeTickets = this.options.db
      .prepare(
        "SELECT id, task_id, status, updated_at FROM tickets WHERE status IN ('DISPATCHED', 'RUNNING', 'IN_PROGRESS')"
      )
      .all() as unknown as Array<{ id: string; task_id: string; status: string; updated_at: string }>;

    for (const t of activeTickets) {
      const updatedAtMs = new Date(t.updated_at).getTime();
      if (!Number.isNaN(updatedAtMs) && now - updatedAtMs > this.maxWaitMs) {
        const reason = `MAX_WAIT_TIME_EXCEEDED: Ticket ${t.id} has had no progress update for ${Math.round((now - updatedAtMs) / 1000)}s (limit: ${this.maxWaitMs / 1000}s).`;
        this.stopByImpact(t.id, reason);
        stopped.push({ ticketId: t.id, reason });
      }
    }

    // 2. Scan effects_queue for failed retries exceeding threshold
    const excessiveEffects = this.options.db
      .prepare(
        `SELECT DISTINCT ticket_id, effect_type, attempt_count, error 
         FROM effects_queue 
         WHERE ticket_id IS NOT NULL AND status IN ('PENDING', 'FAILED', 'IN_PROGRESS') AND attempt_count >= ?`
      )
      .all(this.maxEffectAttempts) as unknown as Array<{
      ticket_id: string;
      effect_type: string;
      attempt_count: number;
      error: string | null;
    }>;

    for (const eff of excessiveEffects) {
      // Check if ticket is still active before stopping
      const ticket = this.options.db.prepare('SELECT status FROM tickets WHERE id = ?').get(eff.ticket_id) as
        | { status: string }
        | undefined;

      if (ticket && ticket.status !== 'WAITING_FOR_HUMAN' && ticket.status !== 'CANCELLED') {
        const reason = `EXCESSIVE_EFFECT_RETRIES: Effect '${eff.effect_type}' failed ${eff.attempt_count} times on ticket ${eff.ticket_id}: ${eff.error ?? 'unknown'}.`;
        this.stopByImpact(eff.ticket_id, reason);
        stopped.push({ ticketId: eff.ticket_id, reason });
      }
    }

    return stopped;
  }

  /**
   * Stops a task by impact: escalates status in DB to WAITING_FOR_HUMAN and immediately
   * frees up worker slots for other parallel tasks.
   */
  private stopByImpact(ticketId: string, reason: string): void {
    const now = new Date().toISOString();
    this.options.db
      .prepare(
        "UPDATE tickets SET status = 'WAITING_FOR_HUMAN', metadata = json_set(coalesce(metadata, '{}'), '$.stopReason', ?), updated_at = ? WHERE id = ?"
      )
      .run(reason, now, ticketId);

    if (this.options.workerSlots) {
      this.options.workerSlots.releaseSlot(ticketId);
    }
  }

  /** Starts the periodic background supervision loop. */
  start(intervalMs = 10000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.scanAndEnforce().catch(() => {});
    }, intervalMs);
    // Don't keep Node.js process alive just for the watchdog timer
    this.timer.unref();
  }

  /** Stops the periodic supervision loop. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  resetTicket(ticketId: string): void {
    this.history.delete(ticketId);
  }
}
