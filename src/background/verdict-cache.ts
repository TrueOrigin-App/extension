// Worker-side verdict cache, keyed by content hash (task 5.2; plan.md §4
// "cache verdicts per URL/content-hash"). The URL-keyed layer lives in the
// content script and dies with the page view; this layer lives for the
// service worker's lifetime and is keyed by what the verdict actually
// depends on — the media bytes and their declared MIME type — so it also
// serves the same image reached under a different URL, from another tab,
// or after a page reload. sourceUrl is deliberately not part of the key.
//
// Retention is the shared isCacheableVerdict policy: only failure-free
// verdicts are kept, so transient conditions (WASM init failure, trust-list
// or remote-manifest outage) are never replayed after they clear.

import {
  isCacheableVerdict,
  type MediaInput,
  type Verdict,
} from "../core/types";
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
  const digest = await crypto.subtle.digest("SHA-256", input.bytes);
  return `${input.mimeType}:${toHex(digest)}`;
}

/** The worker-lifetime verdict cache, preconfigured. A factory rather than
 * a module-level instance so tests get isolated caches. */
export function createVerdictCache(): CoalescingLruCache<Verdict> {
  return new CoalescingLruCache<Verdict>({
    maxEntries: MAX_ENTRIES,
    retain: isCacheableVerdict,
  });
}
