import type { IncomingEvent } from './admission.js';

export class EvalBatcher {
  calculateTargetBatchSize(arrivalRatePerMin: number): number {
    const clampedRate = Math.max(1, Math.min(40, arrivalRatePerMin));
    const target = 1.0 + (clampedRate - 1) * (1.8 / 39);
    return Math.round(target * 100) / 100;
  }

  /**
   * Groups events into dynamic batches based on arrival rate.
   * By default, events belonging to the same thread are batched together
   * so thread context remains cohesive during evaluation.
   */
  groupEvents(
    events: IncomingEvent[],
    arrivalRatePerMin = 1,
    options: { groupByThread?: boolean } = {}
  ): IncomingEvent[][] {
    const targetSize = this.calculateTargetBatchSize(arrivalRatePerMin);
    const batchCapacity = Math.max(1, Math.round(targetSize));

    const shouldGroupByThread = options.groupByThread ?? true;
    if (!shouldGroupByThread) {
      const batches: IncomingEvent[][] = [];
      for (let i = 0; i < events.length; i += batchCapacity) {
        batches.push(events.slice(i, i + batchCapacity));
      }
      return batches;
    }

    // Group events by threadId first, preserving arrival order
    const threadMap = new Map<string, IncomingEvent[]>();
    for (const ev of events) {
      const threadId = ev.threadId || 'default';
      const list = threadMap.get(threadId) ?? [];
      list.push(ev);
      threadMap.set(threadId, list);
    }

    const batches: IncomingEvent[][] = [];
    for (const threadEvents of threadMap.values()) {
      for (let i = 0; i < threadEvents.length; i += batchCapacity) {
        batches.push(threadEvents.slice(i, i + batchCapacity));
      }
    }

    return batches;
  }
}
