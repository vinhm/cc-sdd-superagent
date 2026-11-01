import { describe, it, expect } from 'vitest';
import { WorkerSlotsManager } from '../src/execution/workerSlots.js';

describe('BND-EXEC-RUNTIME: WorkerSlots Concurrency & Human Priority Slot', () => {
  it('pre-allocates slots within maxWorkers limit and prevents race condition overflow', async () => {
    const slots = new WorkerSlotsManager({ maxWorkers: 3 });

    // Request 10 concurrent tasks
    const acquired: string[] = [];
    const reservations: Promise<any>[] = [];

    for (let i = 1; i <= 10; i++) {
      const p = slots.reserveSlot(`tk-${i}`, false).then((res) => {
        acquired.push(`tk-${i}`);
        return res;
      });
      reservations.push(p);
    }

    // Allow event loop to process initial requests
    await new Promise((r) => setTimeout(r, 20));

    // Only 3 should be active immediately
    expect(slots.getActiveCount()).toBe(3);
    expect(acquired.length).toBe(3);
    expect(slots.getQueueLength()).toBe(7);

    // Release one slot
    const firstRes = await reservations[0];
    firstRes.release();

    await new Promise((r) => setTimeout(r, 20));

    expect(slots.getActiveCount()).toBe(3);
    expect(acquired.length).toBe(4);
    expect(slots.getQueueLength()).toBe(6);
  });

  it('allocates human priority slot (maxWorkers + 1) immediately ahead of queued tasks', async () => {
    const slots = new WorkerSlotsManager({ maxWorkers: 2 });

    // Fill normal capacity
    const r1 = await slots.reserveSlot('tk-1', false);
    const r2 = await slots.reserveSlot('tk-2', false);
    expect(slots.getActiveCount()).toBe(2);

    // Queue a normal task
    let normalStarted = false;
    slots.reserveSlot('tk-queued', false).then(() => {
      normalStarted = true;
    });

    expect(slots.getQueueLength()).toBe(1);
    expect(normalStarted).toBe(false);

    // Human priority request arrives
    let humanStarted = false;
    const humanReservation = await slots.reserveSlot('tk-human-urgent', true);
    humanStarted = true;

    // Human should be active immediately in slot maxWorkers + 1
    expect(humanStarted).toBe(true);
    expect(humanReservation.isHumanPriority).toBe(true);
    // Total active = 3 (2 normal + 1 human)
    expect(slots.getActiveCount()).toBe(3);
    // Normal queued task should STILL be in queue
    expect(normalStarted).toBe(false);
    expect(slots.getQueueLength()).toBe(1);

    humanReservation.release();
    expect(slots.getActiveCount()).toBe(2);

    // Clean up normal
    r1.release();
    r2.release();
  });

  it('releases slot immediately upon handoff to human waiting state', async () => {
    const slots = new WorkerSlotsManager({ maxWorkers: 1 });
    const r1 = await slots.reserveSlot('tk-worker-1', false);
    expect(slots.getActiveCount()).toBe(1);

    let nextStarted = false;
    slots.reserveSlot('tk-worker-2', false).then(() => {
      nextStarted = true;
    });

    expect(nextStarted).toBe(false);

    // Worker calls handoff
    slots.onHandoff('tk-worker-1');

    await new Promise((r) => setTimeout(r, 10));

    expect(nextStarted).toBe(true);
    expect(slots.getActiveCount()).toBe(1);
  });
});
