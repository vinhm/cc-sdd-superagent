export interface WorkerSlotsConfig {
  maxWorkers: number;
}

export interface WorkerSlotReservation {
  slotId: number;
  ticketId: string;
  isHumanPriority: boolean;
  acquiredAt: string;
  release: () => void;
}

interface QueuedRequest {
  ticketId: string;
  isHumanPriority: boolean;
  resolve: (res: WorkerSlotReservation) => void;
}

export class WorkerSlotsManager {
  private activeSlots = new Map<string, WorkerSlotReservation>();
  private queue: QueuedRequest[] = [];
  private hasActiveHumanSlot = false;

  constructor(private config: WorkerSlotsConfig) {}

  getActiveCount(): number {
    return this.activeSlots.size;
  }

  getQueueLength(): number {
    return this.queue.length;
  }

  private getNormalActiveCount(): number {
    let count = 0;
    for (const res of this.activeSlots.values()) {
      if (!res.isHumanPriority) {
        count++;
      }
    }
    return count;
  }

  private getNextAvailableNormalSlotId(): number {
    const occupied = new Set<number>();
    for (const res of this.activeSlots.values()) {
      if (!res.isHumanPriority) {
        occupied.add(res.slotId);
      }
    }
    for (let i = 1; i <= this.config.maxWorkers; i++) {
      if (!occupied.has(i)) return i;
    }
    return 1;
  }

  private createReservation(ticketId: string, slotId: number, isHumanPriority: boolean): WorkerSlotReservation {
    const now = new Date().toISOString();
    let released = false;

    const reservation: WorkerSlotReservation = {
      slotId,
      ticketId,
      isHumanPriority,
      acquiredAt: now,
      release: () => {
        if (released) return;
        released = true;
        // Only drop the map entry if it still belongs to this reservation.
        if (this.activeSlots.get(ticketId) === reservation) {
          this.activeSlots.delete(ticketId);
        }
        if (isHumanPriority) {
          this.hasActiveHumanSlot = false;
        }
        this.processQueue();
      },
    };

    this.activeSlots.set(ticketId, reservation);
    if (isHumanPriority) {
      this.hasActiveHumanSlot = true;
    }

    return reservation;
  }

  /** Resolves a queued request, reusing the ticket's live reservation if it already holds one. */
  private grant(req: QueuedRequest, slotId: number): void {
    const existing = this.activeSlots.get(req.ticketId);
    if (existing) {
      req.resolve(existing);
      return;
    }
    req.resolve(this.createReservation(req.ticketId, slotId, req.isHumanPriority));
  }

  private processQueue(): void {
    // 1. Process human priority requests first if human slot is free
    if (!this.hasActiveHumanSlot) {
      const humanIndex = this.queue.findIndex((q) => q.isHumanPriority);
      if (humanIndex !== -1) {
        const [humanReq] = this.queue.splice(humanIndex, 1);
        this.grant(humanReq, this.config.maxWorkers + 1);
      }
    }

    // 2. Process normal queue while normal slots are available
    while (this.getNormalActiveCount() < this.config.maxWorkers && this.queue.length > 0) {
      const normalIndex = this.queue.findIndex((q) => !q.isHumanPriority);
      if (normalIndex === -1) break;

      const [normalReq] = this.queue.splice(normalIndex, 1);
      this.grant(normalReq, this.getNextAvailableNormalSlotId());
    }
  }

  async reserveSlot(ticketId: string, isHumanPriority = false): Promise<WorkerSlotReservation> {
    // A ticket that already holds a slot (e.g. a human follow-up on a running executor) keeps it:
    // never create a second reservation for the same ticket.
    const held = this.activeSlots.get(ticketId);
    if (held) {
      return held;
    }

    if (isHumanPriority) {
      if (!this.hasActiveHumanSlot) {
        return this.createReservation(ticketId, this.config.maxWorkers + 1, true);
      }
      return new Promise<WorkerSlotReservation>((resolve) => {
        this.queue.unshift({ ticketId, isHumanPriority: true, resolve });
      });
    }

    if (this.getNormalActiveCount() < this.config.maxWorkers) {
      const slotId = this.getNextAvailableNormalSlotId();
      return this.createReservation(ticketId, slotId, false);
    }

    return new Promise<WorkerSlotReservation>((resolve) => {
      this.queue.push({ ticketId, isHumanPriority: false, resolve });
    });
  }

  releaseSlot(ticketId: string): void {
    const reservation = this.activeSlots.get(ticketId);
    if (reservation) {
      reservation.release();
    }
  }

  onHandoff(ticketId: string): void {
    this.releaseSlot(ticketId);
  }
}
