import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { initHarnessDatabase } from '../src/core/db/schema.js';
import { WorkerSlotsManager } from '../src/execution/workerSlots.js';
import { SubscriptionBus } from '../src/context/subscriptionBus.js';
import {
  parseTasksDag,
  DagDispatcher,
  getExecutableWave,
} from '../src/router/dagDispatcher.js';

describe('BND-ROUTER-DISCOVERY: DagDispatcher (P) Wave Execution & Non-Disruptive policy-changed', () => {
  let tempDir: string;
  let db: DatabaseSync;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cc-sdd-dag-test-'));
    db = initHarnessDatabase(join(tempDir, 'harness.db'));

    db.prepare("INSERT INTO threads (id, title) VALUES ('th-dag', 'DAG Feature')").run();
  });

  afterEach(async () => {
    try {
      db.close();
    } catch {
      // ignore
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it('parses tasks.md DAG dependencies and (P) markers correctly', () => {
    const markdown = `
### 1. Group 1
* [x] **1.1** Schema design
  * *Boundary:* tools/cc-sdd/src/core/db/schema.ts
  * *Depends:* None
* [ ] **1.2 (P)** Effects queue
  * *Boundary:* tools/cc-sdd/src/core/effects.ts
  * *Depends:* 1.1
* [ ] **1.3 (P)** Recovery engine
  * *Boundary:* tools/cc-sdd/src/core/recovery.ts
  * *Depends:* 1.1
* [ ] **2.1** Assessor
  * *Boundary:* tools/cc-sdd/src/context/masterAssessor.ts
  * *Depends:* 1.2, 1.3
`;

    const tasks = parseTasksDag(markdown);
    expect(tasks.length).toBe(4);

    expect(tasks[0].id).toBe('1.1');
    expect(tasks[0].completed).toBe(true);

    expect(tasks[1].id).toBe('1.2');
    expect(tasks[1].isParallel).toBe(true);
    expect(tasks[1].dependsOn).toEqual(['1.1']);
    expect(tasks[1].completed).toBe(false);

    expect(tasks[2].id).toBe('1.3');
    expect(tasks[2].isParallel).toBe(true);
    expect(tasks[2].dependsOn).toEqual(['1.1']);

    expect(tasks[3].id).toBe('2.1');
    expect(tasks[3].dependsOn).toEqual(['1.2', '1.3']);

    // Next executable wave should contain BOTH 1.2 and 1.3 in parallel because 1.1 is completed!
    const nextWave = getExecutableWave(tasks);
    expect(nextWave.map((t) => t.id)).toEqual(['1.2', '1.3']);
  });

  it('dispatches parallel tasks simultaneously with WorkerSlots and worktrees', async () => {
    const slots = new WorkerSlotsManager({ maxWorkers: 3 });
    const bus = new SubscriptionBus(db);
    const mockWorktreeManager = {
      createWorktree: async (featureName: string, taskId: string) => ({
        worktreePath: `/mock/worktrees/${featureName}/task-${taskId}`,
        branchName: `sdd/${featureName}/task-${taskId}`,
      }),
    };

    const dispatcher = new DagDispatcher({
      db,
      workerSlots: slots,
      worktreeManager: mockWorktreeManager as any,
      bus,
    });

    const tasks = [
      {
        id: '1.2',
        title: 'Effects queue',
        isParallel: true,
        dependsOn: [],
        boundary: 'src/effects.ts',
        completed: false,
      },
      {
        id: '1.3',
        title: 'Recovery engine',
        isParallel: true,
        dependsOn: [],
        boundary: 'src/recovery.ts',
        completed: false,
      },
    ];

    const dispatched = await dispatcher.dispatchWave('my-feat', 'th-dag', tasks);
    expect(dispatched.length).toBe(2);
    expect(dispatched[0].taskId).toBe('1.2');
    expect(dispatched[1].taskId).toBe('1.3');
    expect(slots.getActiveCount()).toBe(2);
  });

  it('sends non-disruptive policy-changed event to running executors instead of killing them', async () => {
    const slots = new WorkerSlotsManager({ maxWorkers: 3 });
    const bus = new SubscriptionBus(db);
    const mockWorktreeManager = {
      createWorktree: async () => ({ worktreePath: '', branchName: '' }),
    };

    const dispatcher = new DagDispatcher({
      db,
      workerSlots: slots,
      worktreeManager: mockWorktreeManager as any,
      bus,
    });

    // Setup active running ticket and subscription
    db.prepare(`
      INSERT INTO tickets (id, thread_id, task_id, feature_name, title, status)
      VALUES ('tk-running', 'th-dag', '1.2', 'my-feat', 'Running Task', 'DISPATCHED')
    `).run();

    bus.subscribe('th-dag', 'tk-running', 'worker-1.2');

    const receivedNotifications: any[] = [];
    bus.registerExecutorHandler('worker-1.2', (ev) => {
      receivedNotifications.push(ev);
    });

    // Notify policy changed (e.g. tech.md changed)
    const res = await dispatcher.notifyPolicyChanged(
      'my-feat',
      '.kiro/steering/tech.md',
      'Node.js target updated to Node 24'
    );

    expect(res.notifiedExecutors).toContain('worker-1.2');
    expect(receivedNotifications.length).toBe(1);
    expect(receivedNotifications[0].eventType).toBe('POLICY_CHANGED');
    expect(receivedNotifications[0].payload.changedFile).toBe('.kiro/steering/tech.md');

    // Confirm ticket was NOT cancelled or destroyed in DB
    const ticket = db.prepare("SELECT * FROM tickets WHERE id = 'tk-running'").get() as any;
    expect(ticket.status).toBe('DISPATCHED');
  });
});
