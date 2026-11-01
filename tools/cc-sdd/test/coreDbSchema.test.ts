import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { initHarnessDatabase, acquireStateLock, StateLockError } from '../src/core/db/schema.js';
import { AssignmentManager } from '../src/core/assignments.js';

describe('BND-STATE-ENGINE: SQLite Schema & Single-Replica State Lock', () => {
  let tempDir: string;
  let activeDbs: DatabaseSync[] = [];

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cc-sdd-state-test-'));
    activeDbs = [];
  });

  afterEach(async () => {
    for (const db of activeDbs) {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it('initializes all required tables in SQLite database', () => {
    const dbPath = join(tempDir, 'harness.db');
    const db = initHarnessDatabase(dbPath);
    activeDbs.push(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);

    const requiredTables = [
      'sources',
      'triggers',
      'threads',
      'tickets',
      'mandates',
      'assignments',
      'subscriptions',
      'effects_queue',
      'inbox_dedup',
      'outbox_receipts',
      'context_chunks',
    ];

    for (const table of requiredTables) {
      expect(tableNames).toContain(table);
    }
  });

  it('enforces single-replica state lock on the state directory', () => {
    const stateDir = join(tempDir, 'state');
    const lock1 = acquireStateLock(stateDir);
    expect(lock1).toBeDefined();

    expect(() => {
      acquireStateLock(stateDir);
    }).toThrowError(StateLockError);

    lock1.release();

    const lock2 = acquireStateLock(stateDir);
    expect(lock2).toBeDefined();
    lock2.release();
  });

  it('manages assignment lifecycle and thread ownership', () => {
    const dbPath = join(tempDir, 'harness.db');
    const db = initHarnessDatabase(dbPath);
    activeDbs.push(db);
    const mgr = new AssignmentManager(db);

    // Create a thread and a ticket
    db.prepare("INSERT INTO threads (id, title, status) VALUES ('th-1', 'Test Feature', 'ACTIVE')").run();
    db.prepare(
      "INSERT INTO tickets (id, thread_id, task_id, feature_name, title, status) VALUES ('tk-1', 'th-1', '1.1', 'test-feat', 'Task 1.1', 'PENDING')"
    ).run();

    // Assign to executor
    const assignment = mgr.createAssignment('tk-1', 'worker-tk-1', '/path/to/worktree');
    expect(assignment.id).toBeDefined();
    expect(assignment.status).toBe('ACTIVE');

    // Ticket status should be updated to DISPATCHED
    const ticket = db.prepare("SELECT * FROM tickets WHERE id = 'tk-1'").get() as any;
    expect(ticket.status).toBe('DISPATCHED');

    // Check thread ownership
    expect(mgr.getThreadOwner('th-1')).toBe('worker-tk-1');

    // Handoff to human
    mgr.handoffAssignment(assignment.id, 'WAITING_FOR_HUMAN');
    const updatedTicket = db.prepare("SELECT * FROM tickets WHERE id = 'tk-1'").get() as any;
    expect(updatedTicket.status).toBe('WAITING_FOR_HUMAN');
    expect(mgr.getThreadOwner('th-1')).toBeNull();
  });
});
