/**
 * Injectable timer boundary for time-driven controller work (#326).
 *
 * The controller owns several timed workflows (summary coalescing, transcript
 * backoff, form ancestry deadlines, job probes, notices). Routing all of them
 * through one narrow port lets tests advance virtual time and assert exactly
 * which timers are pending, without patching global timers or sleeping on the
 * wall clock. Production passes {@link runtimeTimerScheduler}; the
 * characterization harness passes a deterministic fake.
 */
/** Opaque handle: runtime timers return a platform object, the fake returns an id. */
export type TimerHandle = number | ReturnType<typeof setTimeout>;

/** The minimal timer surface the controller needs. */
export interface TimerScheduler {
  /** Schedules one callback after `delayMs`; returns a cancellable handle. */
  setTimeout(handler: () => void, delayMs: number): TimerHandle;
  /** Cancels a handle produced by {@link TimerScheduler.setTimeout}. */
  clearTimeout(handle: TimerHandle): void;
}

/** Default scheduler: the ordinary runtime timers. */
export const runtimeTimerScheduler: TimerScheduler = {
  setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
  clearTimeout: (handle) => {
    clearTimeout(handle);
  },
};
