import { describe, expect, it, vi } from "vitest";
import { CoalescingLruCache } from "./coalescing-lru";

describe("CoalescingLruCache", () => {
  it("runs once per key and serves later calls from cache", async () => {
    const run = vi.fn(async () => "value");
    const cache = new CoalescingLruCache<string>({ maxEntries: 10 });

    expect(await cache.getOrRun("a", run)).toBe("value");
    expect(await cache.getOrRun("a", run)).toBe("value");
    expect(run).toHaveBeenCalledTimes(1);
    expect(cache.size).toBe(1);
  });

  it("coalesces concurrent calls for the same key into one run", async () => {
    let resolve!: (value: string) => void;
    const run = vi.fn(() => new Promise<string>((r) => (resolve = r)));
    const cache = new CoalescingLruCache<string>({ maxEntries: 10 });

    const first = cache.getOrRun("a", run);
    const second = cache.getOrRun("a", run);
    expect(run).toHaveBeenCalledTimes(1);

    resolve("value");
    expect(await first).toBe("value");
    expect(await second).toBe("value");
  });

  it("runs distinct keys independently", async () => {
    const run = vi.fn(async () => "value");
    const cache = new CoalescingLruCache<string>({ maxEntries: 10 });

    await cache.getOrRun("a", run);
    await cache.getOrRun("b", run);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("propagates a rejection to every coalesced caller and caches nothing", async () => {
    let reject!: (thrown: Error) => void;
    const failing = vi.fn(() => new Promise<string>((_, r) => (reject = r)));
    const cache = new CoalescingLruCache<string>({ maxEntries: 10 });

    const first = cache.getOrRun("a", failing);
    const second = cache.getOrRun("a", failing);
    reject(new Error("boom"));
    await expect(first).rejects.toThrow("boom");
    await expect(second).rejects.toThrow("boom");
    expect(failing).toHaveBeenCalledTimes(1);
    expect(cache.size).toBe(0);

    // The failure is not remembered: the next call runs fresh.
    const recovered = vi.fn(async () => "recovered");
    expect(await cache.getOrRun("a", recovered)).toBe("recovered");
    expect(recovered).toHaveBeenCalledTimes(1);
  });

  it("does not cache values retain() rejects, but still coalesces their run", async () => {
    let resolve!: (value: string) => void;
    const run = vi.fn(() => new Promise<string>((r) => (resolve = r)));
    const cache = new CoalescingLruCache<string>({
      maxEntries: 10,
      retain: (value) => value !== "transient",
    });

    const first = cache.getOrRun("a", run);
    const second = cache.getOrRun("a", run);
    resolve("transient");
    expect(await first).toBe("transient");
    expect(await second).toBe("transient");
    expect(run).toHaveBeenCalledTimes(1);
    expect(cache.size).toBe(0);

    // Not cached, so the key runs again — and a retained value sticks.
    const retained = vi.fn(async () => "kept");
    expect(await cache.getOrRun("a", retained)).toBe("kept");
    expect(cache.size).toBe(1);
  });

  it("delete() drops the settled entry so the key runs fresh", async () => {
    const cache = new CoalescingLruCache<string>({ maxEntries: 10 });
    await cache.getOrRun("a", async () => "old");

    cache.delete("a");
    expect(cache.size).toBe(0);

    const rerun = vi.fn(async () => "new");
    expect(await cache.getOrRun("a", rerun)).toBe("new");
    expect(rerun).toHaveBeenCalledTimes(1);
  });

  it("evicts the least recently used entry past maxEntries", async () => {
    const cache = new CoalescingLruCache<string>({ maxEntries: 2 });
    await cache.getOrRun("a", async () => "A");
    await cache.getOrRun("b", async () => "B");

    // Touch "a" so "b" becomes least recently used.
    const runA = vi.fn(async () => "A2");
    await cache.getOrRun("a", runA);
    expect(runA).not.toHaveBeenCalled();

    await cache.getOrRun("c", async () => "C");
    expect(cache.size).toBe(2);

    // "b" was evicted; "c" (most recent) survives.
    const runB = vi.fn(async () => "B2");
    expect(await cache.getOrRun("b", runB)).toBe("B2");
    expect(runB).toHaveBeenCalledTimes(1);
    const runC = vi.fn(async () => "C2");
    expect(await cache.getOrRun("c", runC)).toBe("C");
    expect(runC).not.toHaveBeenCalled();
  });
});
