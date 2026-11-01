import type { IncomingEvent } from './admission.js';

export class EvalBatcher {
  calculateTargetBatchSize(arrivalRatePerMin: number): number {
    const clampedRate = Math.max(1, Math.min(40, arrivalRatePerMin));
    const target = 1.0 + (clampedRate - 1) * (1.8 / 39);
    return Math.round(target * 100) / 100;
  }

  groupEvents(events: IncomingEvent[], arrivalRatePerMin = 1): IncomingEvent[][] {
    const targetSize = this.calculateTargetBatchSize(arrivalRatePerMin);
    const batchCapacity = Math.max(1, Math.round(targetSize));

    const batches: IncomingEvent[][] = [];
    for (let i = 0; i < events.length; i += batchCapacity) {
      batches.push(events.slice(i, i + batchCapacity));
    }

    return batches;
  }
}
