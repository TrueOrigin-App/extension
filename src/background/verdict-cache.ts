// Worker-side verdict cache, keyed by content hash (task 5.2; plan.md §4
// "cache verdicts per URL/content-hash"). The URL-keyed layer lives in the
// content script and dies with the page view; this layer lives for the
// service worker's lifetime and is keyed by what the verdict actually
// depends on — the media bytes and their declared MIME type — so it also
// serves the same image reached under a different URL, from another tab,
// or after a page reload. sourceUrl is deliberately not part of the key.
//
// Only failure-free verdicts are retained: a verdict carrying provider
// failures reflects a transient condition (WASM init failure, trust-list
// fetch outage) that must not be replayed once the condition clears.

import type { MediaInput, Verdict } from "../core/types";
import { CoalescingLruCache } from "../lib/coalescing-lru";

// Provisional, like the other tuning constants: verdict objects are small
// (the manifest-store detail dominates), and the worker is torn down after
// ~30s idle anyway — the bound only guards pathological browsing sessions.
const MAX_ENTRIES = 256;

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** The cache key: MIME type plus SHA-256 of the bytes. The MIME type joins
 * because it is an analysis input — the reader parses the same bytes
 * differently under a different declared type. */
export async function contentHashKey(input: MediaInput): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    // Copy into a fresh ArrayBuffer-backed view: digest() rejects views
    // over SharedArrayBuffer, which Uint8Array's type admits.
    new Uint8Array(input.bytes),
  );
  return `${input.mimeType}:${toHex(digest)}`;
}

export class VerdictCache {
  private readonly cache = new CoalescingLruCache<Verdict>({
    maxEntries: MAX_ENTRIES,
    retain: (verdict) => verdict.failures.length === 0,
  });

  /** Number of cached verdicts (test seam). */
  get size(): number {
    return this.cache.size;
  }

  /** Returns the cached verdict for this media, or runs analyze() and
   * caches its result. Concurrent requests for the same bytes share one
   * analysis. */
  async analyze(
    input: MediaInput,
    run: (input: MediaInput) => Promise<Verdict>,
  ): Promise<Verdict> {
    const key = await contentHashKey(input);
    return this.cache.getOrRun(key, () => run(input));
  }
}
