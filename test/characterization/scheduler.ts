/**
 * Deterministic timer scheduler for characterization tests (#326).
 *
 * Time advances only when a test calls `advanceBy`/`runDue`, so retry backoff,
 * ancestry deadlines, debounces and notice timeouts can be proven without
 * sleeping on the wall clock. The scheduler never patches global timers; it is
 * injected into the controller as an ordinary port.
 */
import type { TimerHandle, TimerScheduler } from '../../src/app/timer-scheduler.ts';

interface ScheduledTask {
  readonly id: number;
  readonly due: number;
  readonly handler: () => void;
}

/** Virtual-time timer queue with explicit inspection and cancellation. */
export class FakeScheduler implements TimerScheduler {
  private current: number;
  private nextId = 1;
  private readonly tasks = new Map<TimerHandle, ScheduledTask>();

  constructor(start = 1000) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  setTimeout(handler: () => void, delayMs: number): TimerHandle {
    const id = this.nextId;
    this.nextId += 1;
    this.tasks.set(id, { id, due: this.current + Math.max(0, delayMs), handler });
    return id;
  }

  clearTimeout(handle: TimerHandle): void {
    this.tasks.delete(handle);
  }

  /** Number of timers still owned by the controller. */
  pendingCount(): number {
    return this.tasks.size;
  }

  /** Runs only timers already due at the current virtual time. */
  runDue(): void {
    this.advanceBy(0);
  }

  /**
   * Advances virtual time to the target, running every timer that came due in
   * chronological order. Timers scheduled by a callback can run in the same
   * advance, which is how a chained backoff becomes observable deterministically.
   */
  advanceBy(milliseconds: number): void {
    const target = this.current + Math.max(0, milliseconds);
    for (;;) {
      let next: ScheduledTask | undefined;
      for (const task of this.tasks.values()) {
        if (task.due > target) continue;
        if (
          next === undefined ||
          task.due < next.due ||
          (task.due === next.due && task.id < next.id)
        ) {
          next = task;
        }
      }
      if (next === undefined) break;
      this.tasks.delete(next.id);
      this.current = Math.max(this.current, next.due);
      next.handler();
    }
    this.current = target;
  }

  /** Drops all pending timers (used to prove teardown owns its work). */
  dispose(): void {
    this.tasks.clear();
  }
}
