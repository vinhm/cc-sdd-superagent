import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { initHarnessDatabase } from '../src/core/db/schema.js';
import { SubscriptionBus, type ThreadEvent } from '../src/context/subscriptionBus.js';

describe('BND-CONTEXT-MANDATE: SubscriptionBus Direct Event Pass-Through', () => {
  let tempDir: string;
  let db: DatabaseSync;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cc-sdd-bus-test-'));
    db = initHarnessDatabase(join(tempDir, 'harness.db'));

    db.prepare("INSERT INTO threads (id, title) VALUES ('th-sub', 'Feature Alpha')").run();
    db.prepare("INSERT INTO tickets (id, thread_id, task_id, feature_name, title) VALUES ('tk-sub', 'th-sub', '2.2', 'alpha', 'Task 2.2')").run();
  });

  afterEach(async () => {
    try {
      db.close();
    } catch {
      // ignore
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it('delivers thread events directly to active Executor with 0 Router evaluations', async () => {
    const bus = new SubscriptionBus(db);

    // Register executor subscription
    bus.subscribe('th-sub', 'tk-sub', 'worker-2.2');

    const receivedEvents: ThreadEvent[] = [];
    bus.registerExecutorHandler('worker-2.2', (event) => {
      receivedEvents.push(event);
    });

    const routerEvaluator = vi.fn();

    // Event 1: Test failure log
    const event1: ThreadEvent = {
      id: 'ev-1',
      threadId: 'th-sub',
      eventType: 'TEST_LOG',
      payload: { status: 'FAILED', error: 'AssertionError: expected true to be false' },
    };

    const res1 = await bus.dispatchThreadEvent(event1, routerEvaluator);
    expect(res1.routedDirectly).toBe(true);
    expect(res1.recipientExecutorId).toBe('worker-2.2');
    expect(res1.routerCalled).toBe(false);
    expect(routerEvaluator).toHaveBeenCalledTimes(0);
    expect(receivedEvents.length).toBe(1);
    expect(receivedEvents[0].id).toBe('ev-1');

    // Event 2: Human clarification comment
    const event2: ThreadEvent = {
      id: 'ev-2',
      threadId: 'th-sub',
      eventType: 'HUMAN_COMMENT',
      payload: { author: 'engineer', text: 'Please ensure JWT expiry is set to 3600s' },
    };

    const res2 = await bus.dispatchThreadEvent(event2, routerEvaluator);
    expect(res2.routedDirectly).toBe(true);
    expect(routerEvaluator).toHaveBeenCalledTimes(0);
    expect(receivedEvents.length).toBe(2);
  });

  it('routes to routerEvaluator when no active subscription exists on thread', async () => {
    const bus = new SubscriptionBus(db);
    const routerEvaluator = vi.fn();

    const event: ThreadEvent = {
      id: 'ev-unsub',
      threadId: 'th-unsub',
      eventType: 'NEW_SPEC_PROMPT',
      payload: { prompt: 'Create feature beta' },
    };

    const res = await bus.dispatchThreadEvent(event, routerEvaluator);
    expect(res.routedDirectly).toBe(false);
    expect(res.recipientExecutorId).toBeNull();
    expect(res.routerCalled).toBe(true);
    expect(routerEvaluator).toHaveBeenCalledTimes(1);
  });
});

