import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { initHarnessDatabase } from '../src/core/db/schema.js';
import { WorkerSlotsManager } from '../src/execution/workerSlots.js';
import { SemanticWatchdog } from '../src/supervision/watchdog.js';

describe('BND-SUPERVISION-INTEGRATION: SemanticWatchdog Loop', () => {
  let tempDir: string;
  let db: DatabaseSync;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cc-sdd-watchdog-test-'));
    db = initHarnessDatabase(join(tempDir, 'harness.db'));

    db.prepare("INSERT INTO threads (id, title) VALUES ('th-wd', 'Watchdog Thread')").run();
    db.prepare(`
      INSERT INTO tickets (id, thread_id, task_id, feature_name, title, status)
      VALUES ('tk-loop', 'th-wd', '5.1', 'feat-watchdog', 'Stuck Task', 'DISPATCHED')
    `).run();
  });

  afterEach(async () => {
    try {
      db.close();
    } catch {
      // ignore
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it('detects zero progress loops with identical diffs/test errors and stops by impact', async () => {
    const slots = new WorkerSlotsManager({ maxWorkers: 3 });
    const slotRes = await slots.reserveSlot('tk-loop', false);
    expect(slots.getActiveCount()).toBe(1);

    const watchdog = new SemanticWatchdog({
      db,
      workerSlots: slots,
      maxIdenticalFailures: 2,
    });

    const errorMsg = 'TypeError: Cannot read properties of undefined (reading token)';
    const diffHash = 'hash-abc-123';

    // Iteration 1: Failure occurs
    const eval1 = watchdog.recordIteration('tk-loop', errorMsg, diffHash);
    expect(eval1.healthy).toBe(true);
    expect(eval1.action).toBe('CONTINUE');
    expect(slots.getActiveCount()).toBe(1);

    // Iteration 2: Identical failure without semantic progress!
    const eval2 = watchdog.recordIteration('tk-loop', errorMsg, diffHash);
    expect(eval2.healthy).toBe(false);
    expect(eval2.action).toBe('STOP_BY_IMPACT');
    expect(eval2.reason).toContain('REPEATED_ZERO_PROGRESS_LOOP');

    // Slot should be released immediately
    expect(slots.getActiveCount()).toBe(0);

    // Ticket status should be updated to WAITING_FOR_HUMAN
    const ticket = db.prepare("SELECT * FROM tickets WHERE id = 'tk-loop'").get() as any;
    expect(ticket.status).toBe('WAITING_FOR_HUMAN');
  });

  it('resets repetition counter when substantial progress or different error occurs', () => {
    const watchdog = new SemanticWatchdog({ db, maxIdenticalFailures: 2 });

    const eval1 = watchdog.recordIteration('tk-loop', 'Error A', 'diff-1');
    expect(eval1.healthy).toBe(true);

    // Different error and diff -> real progress/change
    const eval2 = watchdog.recordIteration('tk-loop', 'Error B', 'diff-2');
    expect(eval2.healthy).toBe(true);
    expect(eval2.action).toBe('CONTINUE');
  });
});
