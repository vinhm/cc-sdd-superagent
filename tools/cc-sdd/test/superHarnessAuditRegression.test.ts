import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  initHarnessDatabase,
  acquireStateLock,
  StateLockError,
  MandateEnforcer,
  compileMandateFromBoundary,
  MandateViolationError,
  WorkerSlotsManager,
  SubscriptionBus,
  RecoveryEngine,
  syncStateToTasksMarkdown,
  SpecChunker,
  MasterAssessor,
  DagDispatcher,
  parseTasksDag,
  getExecutableWave,
  SemanticWatchdog,
  ConditionalAutoMerge,
  renderWebPanelApp,
  WebPanelServer,
  EvalBatcher,
  branchNameFor,
  sanitizeTaskId,
} from '../src/index.js';

describe('V4 Super-Harness Audit Regression Verification', () => {
  let tempDir: string;
  let db: DatabaseSync;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cc-sdd-regression-'));
    db = initHarnessDatabase(join(tempDir, 'harness.db'));
  });

  afterEach(async () => {
    try {
      db.close();
    } catch {
      // ignore
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('Fix C-1 & C-2: Mandate path traversal, prefix boundaries & command intercept', () => {
    it('blocks path traversal escapes and prefix trick attacks', () => {
      const mandate = compileMandateFromBoundary('tk-sec', 'src/core/*', ['src/config.ts'], {
        allowedCommands: ['npm test', 'npm run build'],
      });
      const enforcer = new MandateEnforcer(mandate, '/mock/workspace');

      // Valid files
      expect(enforcer.interceptFileWrite('src/core/utils.ts').allowed).toBe(true);
      expect(enforcer.interceptFileWrite('src/config.ts').allowed).toBe(true);

      // Traversal attacks must be BLOCKED
      expect(() => enforcer.interceptFileWrite('src/core/../../secret.ts')).toThrow(MandateViolationError);
      expect(() => enforcer.interceptFileWrite('src/core/../outside.ts')).toThrow(MandateViolationError);

      // Sibling prefix attacks (e.g. src/core-evil/) must be BLOCKED
      expect(() => enforcer.interceptFileWrite('src/core-evil/malicious.ts')).toThrow(MandateViolationError);

      // Commands: allowed vs forbidden
      expect(enforcer.interceptCommand('npm test').allowed).toBe(true);
      expect(enforcer.interceptCommand('npm run build --prod').allowed).toBe(true);
      expect(() => enforcer.interceptCommand('rm -rf /')).toThrow(MandateViolationError);
      expect(() => enforcer.interceptCommand('npm test; rm -rf /')).toThrow(MandateViolationError);
    });
  });

  describe('Fix C-3, D-1 & D-2: Real cc-sdd tasks format parsing, boundary matching & wave dispatch', () => {
    it('parses real cc-sdd tasks template format and handles component boundaries', () => {
      const markdown = `
# Tasks Specification
- [ ] 1.1 First task
  - Some detail item
  - _Boundary: tools/cc-sdd/src/core/db/schema.ts_
  - _Depends: None_
- [ ] 1.2 (P) Parallel task A
  - _Boundary: tools/cc-sdd/src/core/effects.ts_
  - _Depends: 1.1_
- [ ] 1.3 (P) Parallel task B
  - _Boundary: tools/cc-sdd/src/core/recovery.ts_
  - _Depends: 1.1_
- [ ] 1.4 Sequential downstream task
  - _Boundary: tools/cc-sdd/src/context/masterAssessor.ts_
  - _Depends: 1.2, 1.3_
`;

      const tasks = parseTasksDag(markdown);
      expect(tasks.length).toBe(4);
      expect(tasks[0].id).toBe('1.1');
      expect(tasks[0].isParallel).toBe(false);
      expect(tasks[1].id).toBe('1.2');
      expect(tasks[1].isParallel).toBe(true);
      expect(tasks[1].dependsOn).toEqual(['1.1']);

      // Wave calculation:
      // When 1.1 is NOT completed, wave contains only 1.1 (sequential)
      const wave1 = getExecutableWave(tasks);
      expect(wave1.map((t) => t.id)).toEqual(['1.1']);

      // When 1.1 is completed, wave contains 1.2 and 1.3 in parallel!
      tasks[0].completed = true;
      const wave2 = getExecutableWave(tasks);
      expect(wave2.map((t) => t.id)).toEqual(['1.2', '1.3']);

      // In-flight tasks are excluded from the next wave
      const wave3 = getExecutableWave(tasks, ['1.2']);
      expect(wave3.map((t) => t.id)).toEqual(['1.3']);
    });
  });

  describe('Fix W-1: WorkerSlots human priority slot idempotency', () => {
    it('does not leak or duplicate slots when human priority request arrives for ticket already holding normal slot', async () => {
      const manager = new WorkerSlotsManager({ maxWorkers: 2 });

      // Reserve 2 normal slots
      const r1 = await manager.reserveSlot('T1', false);
      const r2 = await manager.reserveSlot('T2', false);
      expect(manager.getActiveCount()).toBe(2);

      // T1 receives a human follow-up message: should reuse T1's active reservation
      const r1Human = await manager.reserveSlot('T1', true);
      expect(r1Human.ticketId).toBe('T1');
      expect(manager.getActiveCount()).toBe(2);

      // Releasing r1 normal reservation
      r1.release();

      // Now a new ticket T3 can acquire a slot without being locked out
      const r3Promise = manager.reserveSlot('T3', false);
      const r3 = await Promise.race([
        r3Promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 100)),
      ]);
      expect(r3).toBeDefined();
      expect(manager.getActiveCount()).toBe(2);

      r2.release();
    });
  });

  describe('Fix S-1 & S-2: SubscriptionBus broadcast across threads and offline inbox persistence', () => {
    it('delivers events to all active executors in a thread and queues for offline executors', async () => {
      db.prepare("INSERT INTO threads (id, title) VALUES ('th-multi', 'Multi-ticket thread')").run();
      db.prepare(`
        INSERT INTO tickets (id, thread_id, task_id, feature_name, title)
        VALUES ('t1', 'th-multi', '1', 'f', 'Task 1'), ('t2', 'th-multi', '2', 'f', 'Task 2')
      `).run();

      const bus = new SubscriptionBus(db);
      bus.subscribe('th-multi', 't1', 'w1');
      bus.subscribe('th-multi', 't2', 'w2');

      const receivedW1: any[] = [];
      await bus.registerExecutorHandler('w1', (ev) => {
        receivedW1.push(ev);
      });

      // Dispatch event to thread: w1 receives immediately, w2 is offline so queued in executor_inbox
      const dispatchRes = await bus.dispatchThreadEvent({
        id: 'ev-1',
        threadId: 'th-multi',
        eventType: 'TEST_EVENT',
        payload: { msg: 'hello' },
      });

      expect(dispatchRes.routedDirectly).toBe(true);
      expect(dispatchRes.deliveredTo).toContain('w1');
      expect(dispatchRes.queuedFor).toContain('w2');
      expect(receivedW1.length).toBe(1);

      // Now executor w2 comes online and registers its handler: queued event is flushed!
      const receivedW2: any[] = [];
      await bus.registerExecutorHandler('w2', (ev) => {
        receivedW2.push(ev);
      });

      expect(receivedW2.length).toBe(1);
      expect(receivedW2[0].id).toBe('ev-1');
      expect(receivedW2[0].payload.msg).toBe('hello');
    });
  });

  describe('Fix R-1, R-2, R-5 & D-3: Shared naming, idempotent worktree & stale lock recovery', () => {
    it('uses unified naming convention avoiding task-1.1 vs task-1-1 mismatch', () => {
      expect(sanitizeTaskId('1.1')).toBe('1-1');
      expect(branchNameFor('my-feat', '1.1')).toBe('sdd/my-feat/task-1-1');
    });

    it('auto-recovers from a stale lock left by a dead process PID', () => {
      const stateDir = join(tempDir, 'state');
      // Acquire and simulate crash by writing non-existent dead PID to .lock
      const lock1 = acquireStateLock(stateDir);
      lock1.release();

      // Write dead PID
      const lockPath = join(stateDir, '.lock');
      writeFileSync(lockPath, '99999999\n2026-01-01T00:00:00.000Z\n');

      // Next acquire should detect dead PID and acquire successfully
      const lock2 = acquireStateLock(stateDir);
      expect(lock2).toBeDefined();
      lock2.release();
    });

    it('syncStateToTasksMarkdown accurately matches both standard and bold task formats', async () => {
      const tasksPath = join(tempDir, 'tasks.md');
      const content = `
# Tasks
- [ ] 1.1 (P) Standard format task
- [ ]* 1.2 Deferred task
* [ ] **1.3 (P)** Bold format task
`;
      writeFileSync(tasksPath, content, 'utf8');

      db.prepare("INSERT INTO threads (id, title) VALUES ('th-sync', 'Sync')").run();
      db.prepare(`
        INSERT INTO tickets (id, thread_id, task_id, feature_name, title, status)
        VALUES 
          ('tk-1', 'th-sync', '1.1', 'f', 'T1', 'COMPLETED'),
          ('tk-2', 'th-sync', '1.2', 'f', 'T2', 'COMPLETED'),
          ('tk-3', 'th-sync', '1.3', 'f', 'T3', 'COMPLETED')
      `).run();

      const result = await syncStateToTasksMarkdown(db, tasksPath, 'f');
      expect(result.updatedCount).toBe(3);
    });
  });

  describe('Fix M-1 & M-2: MasterAssessor scope namespacing & frontmatter dependencies', () => {
    it('allows same section id across different files via scope namespacing', () => {
      const chunker = new SpecChunker(db);
      const assessor = new MasterAssessor(db);

      chunker.indexDocument('requirements.md', '### SEC-1.1: Requirements Intro\nReq details', 'requirements', 'requirements.md');
      chunker.indexDocument('design.md', '### SEC-1.1: Design Intro\nDesign details', 'design', 'design.md');

      const reqChunk = assessor.readChunk('SEC-1.1', 0, 500, 'requirements.md');
      expect(reqChunk.content).toContain('Req details');

      const designChunk = assessor.readChunk('SEC-1.1', 0, 500, 'design.md');
      expect(designChunk.content).toContain('Design details');
    });
  });

  describe('Fix V-4, V-3: Web Panel XSS escaping & server lifecycle', () => {
    it('escapes user inputs preventing XSS injection', () => {
      const maliciousState = {
        activeTab: 'Overview' as const,
        tickets: [
          {
            id: 'tk-evil',
            taskId: '<script>alert(1)</script>',
            title: '<img src=x onerror=alert(1)>',
            status: 'PENDING',
          },
        ],
        sources: [],
        triggers: [],
        evalQueue: [],
        settings: { proactiveMode: 'observe' as const },
      };

      const html = renderWebPanelApp(maliciousState);
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).not.toContain('<img src=x onerror=alert(1)>');
      expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    });

    it('WebPanelServer starts and closes cleanly', async () => {
      const server = new WebPanelServer(db, 3999);
      await server.start();
      await server.close();
    });
  });

  describe('Fix E-1: EvalBatcher grouping by thread', () => {
    it('batches events by thread preserving thread boundary context', () => {
      const batcher = new EvalBatcher();
      const events = [
        { id: '1', sender: 'u1', content: 'msg1', threadId: 'th-A' },
        { id: '2', sender: 'u1', content: 'msg2', threadId: 'th-B' },
        { id: '3', sender: 'u1', content: 'msg3', threadId: 'th-A' },
      ];

      const batches = batcher.groupEvents(events, 40);
      // Thread A events are batched together, Thread B in its own batch
      expect(batches.length).toBe(2);
      expect(batches[0].every((e) => e.threadId === 'th-A')).toBe(true);
      expect(batches[1].every((e) => e.threadId === 'th-B')).toBe(true);
    });
  });

  describe('Fix V-1: SemanticWatchdog scanAndEnforce', () => {
    it('detects excessive wait time and moves stalled ticket to WAITING_FOR_HUMAN', async () => {
      const slots = new WorkerSlotsManager({ maxWorkers: 2 });
      await slots.reserveSlot('tk-stalled', false);

      const oldTime = new Date(Date.now() - 3600 * 1000).toISOString();
      db.prepare("INSERT INTO threads (id, title) VALUES ('th-wd2', 'Watchdog 2')").run();
      db.prepare(`
        INSERT INTO tickets (id, thread_id, task_id, feature_name, title, status, updated_at)
        VALUES ('tk-stalled', 'th-wd2', '1.1', 'f', 'Stalled', 'DISPATCHED', ?)
      `).run(oldTime);

      const watchdog = new SemanticWatchdog({
        db,
        workerSlots: slots,
        maxWaitMs: 1800 * 1000, // 30 mins
      });

      const stopped = await watchdog.scanAndEnforce();
      expect(stopped.length).toBe(1);
      expect(stopped[0].ticketId).toBe('tk-stalled');
      expect(slots.getActiveCount()).toBe(0);

      const ticket = db.prepare("SELECT status FROM tickets WHERE id = 'tk-stalled'").get() as any;
      expect(ticket.status).toBe('WAITING_FOR_HUMAN');
    });
  });

  describe('Fix A-2: ConditionalAutoMerge author and approver separation', () => {
    it('disallows auto-merge when approver is identical to author', () => {
      const autoMerge = new ConditionalAutoMerge();
      const client = {
        merge: vi.fn(),
        cancelAutoMerge: vi.fn(),
      };

      const ctx = {
        prNumber: 99,
        additions: 10,
        deletions: 5,
        humanApproved: true,
        testsPassed: true,
        authorAccount: 'bot-coder',
        mergerAccount: 'bot-merger',
        approverAccount: 'bot-coder', // Invalid: approver cannot be author
      };

      const check = autoMerge.canAutoMerge(ctx);
      expect(check.eligible).toBe(false);
      expect(check.reason).toContain('APPROVER_CANNOT_BE_AUTHOR');
    });
  });
});
