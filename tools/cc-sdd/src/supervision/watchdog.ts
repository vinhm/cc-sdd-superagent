import { DatabaseSync } from 'node:sqlite';
import type { WorkerSlotsManager } from '../execution/workerSlots.js';

export interface WatchdogOptions {
  db: DatabaseSync;
  workerSlots?: WorkerSlotsManager;
  maxIdenticalFailures?: number;
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
  private history = new Map<string, FailureSignature>();

  constructor(private options: WatchdogOptions) {
    this.maxIdenticalFailures = options.maxIdenticalFailures ?? 2;
  }

  recordIteration(ticketId: string, testError: string, diffHash: string): WatchdogEvaluation {
    const existing = this.history.get(ticketId);
    let consecutiveCount = 1;

    if (existing && existing.lastError === testError && existing.lastDiffHash === diffHash) {
      consecutiveCount = existing.consecutiveCount + 1;
    }

    if (consecutiveCount >= this.maxIdenticalFailures) {
      const now = new Date().toISOString();

      // Stop by impact: update SQLite ticket status to WAITING_FOR_HUMAN
      this.options.db
        .prepare("UPDATE tickets SET status = 'WAITING_FOR_HUMAN', updated_at = ? WHERE id = ?")
        .run(now, ticketId);

      // Release worker slot immediately so other parallel tasks can progress
      if (this.options.workerSlots) {
        this.options.workerSlots.releaseSlot(ticketId);
      }

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

  resetTicket(ticketId: string): void {
    this.history.delete(ticketId);
  }
}
