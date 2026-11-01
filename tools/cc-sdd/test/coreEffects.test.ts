import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { initHarnessDatabase } from '../src/core/db/schema.js';
import { EffectsQueue, AgentDelivery, OutboxReconciler } from '../src/core/effects.js';

describe('BND-STATE-ENGINE: Effects Queue, AgentDelivery & Outbox Reconciliation', () => {
  let tempDir: string;
  let db: DatabaseSync;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cc-sdd-effects-test-'));
    db = initHarnessDatabase(join(tempDir, 'harness.db'));

    // Insert dummy thread and ticket to satisfy foreign key constraints
    db.prepare("INSERT INTO threads (id, title) VALUES ('th-1', 'Test Thread')").run();
    db.prepare("INSERT INTO tickets (id, thread_id, task_id, feature_name, title) VALUES ('tk-1', 'th-1', '1.2', 'test', 'Task 1.2')").run();
  });

  afterEach(async () => {
    try {
      db.close();
    } catch {
      // ignore
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it('records write-ahead intent in EffectsQueue before execution', () => {
    const queue = new EffectsQueue(db);

    const effect = queue.enqueue('tk-1', 'SPAWN_WORKER', { role: 'implementer', model: 'flash' });
    expect(effect.id).toBeDefined();
    expect(effect.status).toBe('PENDING');

    const pending = queue.getPending();
    expect(pending.length).toBe(1);
    expect(pending[0].id).toBe(effect.id);

    queue.markInProgress(effect.id);
    expect(queue.getPending().length).toBe(0);

    queue.markCompleted(effect.id);
    const completed = db.prepare('SELECT * FROM effects_queue WHERE id = ?').get(effect.id) as any;
    expect(completed.status).toBe('COMPLETED');
  });

  it('ensures AgentDelivery executes duplicate message_id only once', async () => {
    const delivery = new AgentDelivery(db);
    let executions = 0;

    const action = async () => {
      executions++;
    };

    const res1 = await delivery.deliver('msg-001', 'ticket-dispatcher', action);
    expect(res1.processed).toBe(true);
    expect(res1.duplicate).toBe(false);
    expect(executions).toBe(1);

    // Replay same message
    const res2 = await delivery.deliver('msg-001', 'ticket-dispatcher', action);
    expect(res2.processed).toBe(false);
    expect(res2.duplicate).toBe(true);
    expect(executions).toBe(1);
  });

  it('embeds HTML marker in Outbox comments and skips posting if remote thread already has marker', async () => {
    const outbox = new OutboxReconciler(db);
    let postedBody = '';
    const sender = async (content: string) => {
      postedBody = content;
    };

    // First send to clean remote thread
    const res1 = await outbox.sendComment({
      ticketId: 'tk-1',
      channel: 'github-pr',
      messageId: 'msg-pr-101',
      body: 'All unit tests passed GREEN.',
      remoteComments: [],
      sender,
    });

    expect(res1.sent).toBe(true);
    expect(res1.skippedDuplicate).toBe(false);
    expect(postedBody).toContain('All unit tests passed GREEN.');
    expect(postedBody).toContain('<!-- cc-sdd-msg-id: msg-pr-101 -->');

    // Simulate network retry where GitHub already contains the posted comment
    const remoteWithComment = [postedBody];
    let rePostCount = 0;
    const res2 = await outbox.sendComment({
      ticketId: 'tk-1',
      channel: 'github-pr',
      messageId: 'msg-pr-101',
      body: 'All unit tests passed GREEN.',
      remoteComments: remoteWithComment,
      sender: async () => {
        rePostCount++;
      },
    });

    expect(res2.sent).toBe(false);
    expect(res2.skippedDuplicate).toBe(true);
    expect(rePostCount).toBe(0);
  });
});
