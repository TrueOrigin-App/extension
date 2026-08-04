// Async cache with in-flight coalescing and LRU eviction — the shared
// mechanism behind both verdict cache layers (task 5.2): the content
// script's URL-keyed cache and the service worker's content-hash-keyed
// cache. Free choices recorded in DECISIONS.md.
//
// Semantics:
// - Concurrent getOrRun() calls for the same key share one run() — the
//   coalescing that task 5.1 deferred to the cache.
// - Rejections propagate to every coalesced caller and are never cached;
//   the next getOrRun() for that key runs fresh.
// - Resolved values are cached only if retain() accepts them, so callers
//   can keep transient outcomes (e.g. verdicts with provider failures)
//   out of the cache without losing coalescing while they are in flight.

export interface CoalescingLruOptions<V> {
  /** Maximum settled entries kept; least-recently-used are evicted first. */
  maxEntries: number;
  /** Gate on resolved values: only values this accepts are cached.
   * Defaults to retaining everything. */
  retain?: (value: V) => boolean;
}

export class CoalescingLruCache<V> {
  // Map iteration order is insertion order; refreshing an entry on hit
  // (delete + set) makes the first key the least recently used.
  private readonly settled = new Map<string, V>();
  private readonly inflight = new Map<string, Promise<V>>();

  constructor(private readonly options: CoalescingLruOptions<V>) {}

  /** Number of settled (cached) entries — in-flight runs are not counted. */
  get size(): number {
    return this.settled.size;
  }

  /** Drops the settled entry for a key, if any. An in-flight run is not
   * affected: it may still be retained when it settles — a caller
   * invalidating harder than that must gate on its own generations. */
  delete(key: string): void {
    this.settled.delete(key);
  }

  getOrRun(key: string, run: () => Promise<V>): Promise<V> {
    if (this.settled.has(key)) {
      const value = this.settled.get(key) as V;
      this.settled.delete(key);
      this.settled.set(key, value);
      return Promise.resolve(value);
    }

    const pending = this.inflight.get(key);
    if (pending) return pending;

    const promise = run().then(
      (value) => {
        this.inflight.delete(key);
        if ((this.options.retain ?? (() => true))(value)) {
          this.settled.set(key, value);
          this.evict();
        }
        return value;
      },
      (thrown: unknown) => {
        this.inflight.delete(key);
        throw thrown;
      },
    );
    this.inflight.set(key, promise);
    return promise;
  }

  private evict(): void {
    while (this.settled.size > this.options.maxEntries) {
      const oldest = this.settled.keys().next().value as string;
      this.settled.delete(oldest);
    }
  }
}
