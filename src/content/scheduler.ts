// Scan scheduling (plan.md §4: "debounce viewport churn"). Free choices
// recorded in DECISIONS.md (task 5.1).
//
// Deliberately DOM-free: items are opaque keys (the content script uses
// HTMLImageElements), viewport events arrive via enter()/leave(), and the
// scheduler only decides *when* to call analyze(). That keeps the churn/
// concurrency logic unit-testable in plain Node.

/** Where an item is in its scan lifecycle. Items the scheduler has never
 * seen (or has forgotten via reset()) have no state at all. */
type ScanState = "dwelling" | "queued" | "running" | "done";

export interface SchedulerOptions<T> {
  /** How long an item must stay in the viewport before it is queued.
   * Entering and leaving within this window costs nothing. */
  dwellMs: number;
  /** Maximum analyze() calls in flight at once. */
  maxConcurrent: number;
  /** The actual analysis. Must not reject for expected failures — a
   * rejection is swallowed here (the item still completes) because
   * scheduling must survive any analysis outcome. */
  analyze: (item: T) => Promise<void>;
}

export class ScanScheduler<T> {
  private readonly states = new Map<T, ScanState>();
  private readonly dwellTimers = new Map<T, ReturnType<typeof setTimeout>>();
  private readonly queue: T[] = [];
  private running = 0;

  constructor(private readonly options: SchedulerOptions<T>) {}

  /** The item became visible (entered the viewport or its lookahead margin). */
  enter(item: T): void {
    if (this.states.has(item)) return;
    this.states.set(item, "dwelling");
    this.dwellTimers.set(
      item,
      setTimeout(() => {
        this.dwellTimers.delete(item);
        this.states.set(item, "queued");
        this.queue.push(item);
        this.pump();
      }, this.options.dwellMs),
    );
  }

  /** The item left the viewport. Dwelling and queued items are abandoned
   * (they re-enter fresh next time); running items finish — the work is
   * already paid for and the result stays useful. */
  leave(item: T): void {
    const state = this.states.get(item);
    if (state === "dwelling") {
      this.clearDwell(item);
      this.states.delete(item);
    } else if (state === "queued") {
      this.dropFromQueue(item);
      this.states.delete(item);
    }
  }

  /** Forget the item entirely — used when its identity changes (src swap)
   * or it is removed from the document. A later enter() starts over. An
   * in-flight analyze() is not interrupted; its completion is ignored. */
  reset(item: T): void {
    const state = this.states.get(item);
    if (state === "dwelling") this.clearDwell(item);
    if (state === "queued") this.dropFromQueue(item);
    this.states.delete(item);
  }

  private clearDwell(item: T): void {
    const timer = this.dwellTimers.get(item);
    if (timer !== undefined) clearTimeout(timer);
    this.dwellTimers.delete(item);
  }

  private dropFromQueue(item: T): void {
    const index = this.queue.indexOf(item);
    if (index !== -1) this.queue.splice(index, 1);
  }

  private pump(): void {
    while (this.running < this.options.maxConcurrent && this.queue.length > 0) {
      const item = this.queue.shift() as T;
      this.states.set(item, "running");
      this.running++;
      void this.options
        .analyze(item)
        .catch(() => undefined)
        .finally(() => {
          this.running--;
          // Only running→done; if the item was reset() mid-flight its
          // slate stays clean for re-entry.
          if (this.states.get(item) === "running") {
            this.states.set(item, "done");
          }
          this.pump();
        });
    }
  }
}
