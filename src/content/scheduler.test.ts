import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScanScheduler } from "./scheduler";

const DWELL_MS = 250;

function deferredAnalyze(): {
  analyze: (item: string) => Promise<void>;
  started: string[];
  finish: (item: string) => void;
  fail: (item: string) => void;
} {
  const started: string[] = [];
  const handles = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void }
  >();
  return {
    started,
    analyze: (item) =>
      new Promise<void>((resolve, reject) => {
        started.push(item);
        handles.set(item, { resolve, reject });
      }),
    finish: (item) => handles.get(item)?.resolve(),
    fail: (item) => handles.get(item)?.reject(new Error(`failed: ${item}`)),
  };
}

// Lets promise continuations queued by resolve/reject run. Timers are faked
// in these tests, so flush microtasks directly — enough ticks to drain the
// scheduler's analyze → catch → finally chain.
async function settle(): Promise<void> {
  for (let tick = 0; tick < 10; tick++) await Promise.resolve();
}

describe("ScanScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("analyzes an item only after it dwells for the configured time", () => {
    const { analyze, started } = deferredAnalyze();
    const scheduler = new ScanScheduler({
      dwellMs: DWELL_MS,
      maxConcurrent: 2,
      analyze,
    });

    scheduler.enter("a");
    vi.advanceTimersByTime(DWELL_MS - 1);
    expect(started).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(started).toEqual(["a"]);
  });

  it("never analyzes an item that leaves before the dwell elapses (scroll churn)", () => {
    const { analyze, started } = deferredAnalyze();
    const scheduler = new ScanScheduler({
      dwellMs: DWELL_MS,
      maxConcurrent: 2,
      analyze,
    });

    scheduler.enter("a");
    vi.advanceTimersByTime(DWELL_MS - 1);
    scheduler.leave("a");
    vi.advanceTimersByTime(DWELL_MS * 10);
    expect(started).toEqual([]);

    // Re-entering starts a fresh dwell rather than being remembered as seen.
    scheduler.enter("a");
    vi.advanceTimersByTime(DWELL_MS);
    expect(started).toEqual(["a"]);
  });

  it("caps concurrent analyses and drains the queue as slots free up", async () => {
    const { analyze, started, finish } = deferredAnalyze();
    const scheduler = new ScanScheduler({
      dwellMs: DWELL_MS,
      maxConcurrent: 2,
      analyze,
    });

    for (const item of ["a", "b", "c", "d"]) scheduler.enter(item);
    vi.advanceTimersByTime(DWELL_MS);
    expect(started).toEqual(["a", "b"]);

    finish("a");
    await settle();
    expect(started).toEqual(["a", "b", "c"]);

    finish("b");
    finish("c");
    await settle();
    expect(started).toEqual(["a", "b", "c", "d"]);
  });

  it("keeps scheduling after an analysis rejects", async () => {
    const { analyze, started, fail } = deferredAnalyze();
    const scheduler = new ScanScheduler({
      dwellMs: DWELL_MS,
      maxConcurrent: 1,
      analyze,
    });

    scheduler.enter("a");
    scheduler.enter("b");
    vi.advanceTimersByTime(DWELL_MS);
    expect(started).toEqual(["a"]);

    fail("a");
    await settle();
    expect(started).toEqual(["a", "b"]);
  });

  it("removes a queued item when it leaves the viewport", async () => {
    const { analyze, started, finish } = deferredAnalyze();
    const scheduler = new ScanScheduler({
      dwellMs: DWELL_MS,
      maxConcurrent: 1,
      analyze,
    });

    scheduler.enter("a");
    scheduler.enter("b");
    vi.advanceTimersByTime(DWELL_MS);
    expect(started).toEqual(["a"]); // b is queued behind the single slot
    scheduler.leave("b");

    finish("a");
    await settle();
    expect(started).toEqual(["a"]);
  });

  it("does not re-analyze a completed item on re-entry", async () => {
    const { analyze, started, finish } = deferredAnalyze();
    const scheduler = new ScanScheduler({
      dwellMs: DWELL_MS,
      maxConcurrent: 1,
      analyze,
    });

    scheduler.enter("a");
    vi.advanceTimersByTime(DWELL_MS);
    finish("a");
    await settle();

    scheduler.leave("a");
    scheduler.enter("a");
    vi.advanceTimersByTime(DWELL_MS * 10);
    expect(started).toEqual(["a"]);
  });

  it("ignores enter() while the item is dwelling, queued, or running", async () => {
    const { analyze, started, finish } = deferredAnalyze();
    const scheduler = new ScanScheduler({
      dwellMs: DWELL_MS,
      maxConcurrent: 1,
      analyze,
    });

    scheduler.enter("a");
    scheduler.enter("a"); // dwelling
    vi.advanceTimersByTime(DWELL_MS);
    scheduler.enter("a"); // running
    finish("a");
    await settle();
    expect(started).toEqual(["a"]);
  });

  it("reset() makes an item analyzable again, even mid-flight", async () => {
    const { analyze, started, finish } = deferredAnalyze();
    const scheduler = new ScanScheduler({
      dwellMs: DWELL_MS,
      maxConcurrent: 2,
      analyze,
    });

    scheduler.enter("a");
    vi.advanceTimersByTime(DWELL_MS);
    expect(started).toEqual(["a"]);

    // Identity change while running (e.g. src swap): forget it, re-enter.
    scheduler.reset("a");
    scheduler.enter("a");
    vi.advanceTimersByTime(DWELL_MS);
    expect(started).toEqual(["a", "a"]);

    // The stale run's completion must not mark the fresh state done…
    finish("a");
    await settle();
    scheduler.reset("a");
    scheduler.enter("a");
    vi.advanceTimersByTime(DWELL_MS);
    expect(started).toEqual(["a", "a", "a"]);
  });

  it("reset() of a queued item frees its place in line", async () => {
    const { analyze, started, finish } = deferredAnalyze();
    const scheduler = new ScanScheduler({
      dwellMs: DWELL_MS,
      maxConcurrent: 1,
      analyze,
    });

    scheduler.enter("a");
    scheduler.enter("b");
    vi.advanceTimersByTime(DWELL_MS);
    scheduler.reset("b");

    finish("a");
    await settle();
    expect(started).toEqual(["a"]);
  });
});
