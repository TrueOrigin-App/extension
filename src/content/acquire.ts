// Byte acquisition and analysis transport (tasks 5.2/5.5). The ladder:
//
//   1. In-page fetch, force-cache — reuses the HTTP-cache entry the render
//      stored (double-fetch collapse; the verdict describes on-screen
//      bytes).
//   2. In-page fetch, no-cache — revalidates past cache entries the CORS
//      layer refuses to serve (task-5.2 fix).
//   3. Worker-side fetch — when the page context cannot read the bytes at
//      all (strict-CORS hosts) or cannot ship them (message-size cap),
//      the worker fetches under its host permissions and analyzes there.
//
// The in-page path stays primary: it shares the page's cache partition,
// so when the render's cache entry is readable its bytes are exactly the
// render's bytes. (On a cache miss the match is close but not perfect —
// fetch() sends no cookies cross-origin, where the render did; an open
// question recorded in DECISIONS.md.) The worker path is the fallback
// precisely because it fetches from a different partition — a divergence
// risk accepted only when the in-page path has already failed (rationale
// in DECISIONS.md, task 5.5).
//
// Element-independent by design: every function here takes a URL and
// returns a claim about that URL, valid — and cacheable — regardless of
// what happened to the element that wanted it. Element staleness is the
// caller's business (generation and URL rechecks in index.ts).

import {
  ANALYZE_MESSAGE_TYPE,
  ANALYZE_URL_MESSAGE_TYPE,
  encodeBytes,
  isAnalyzeResponse,
  isAnalyzeUrlResponse,
  type AnalyzeRequest,
  type AnalyzeUrlRequest,
  type WireVerdict,
} from "../messaging/protocol";
import {
  ANALYSIS_FETCH_TIMEOUT_MS,
  IMAGE_ACCEPT,
  imageMimeTypeFor,
  isPinnableResponse,
} from "../lib/image-accept";

/** One analysis outcome, plus whether the URL cache may keep it: a
 * no-store response can serve different bytes on every fetch, so its
 * verdict is good for exactly the analysis that produced it. */
export interface UrlCacheEntry {
  verdict: WireVerdict;
  pinned: boolean;
}

// Ceiling for shipping bytes through sendMessage: the channel JSON-
// serializes, so bytes travel as base64 (4/3 inflation) against Chrome's
// 64 MB message cap. 32 MiB of bytes is ~44.7 MB of base64 — comfortably
// under the cap while covering essentially all real images. Larger
// http(s) images route to the worker fetch instead; larger data:/blob:
// payloads (which the worker cannot fetch) still attempt inline transport
// and fail as an analysis error if the channel refuses them.
const MAX_INLINE_TRANSPORT_BYTES = 32 * 1024 * 1024;

/** An in-page byte-acquisition failure the worker fetch may be able to
 * cure: the CORS layer refusing the read (TypeError) or the server
 * refusing the request with an Origin-conditioned status (401/403 — e.g.
 * hosts that 403 Origin-carrying requests they would happily serve
 * without one). Deliberately excludes timeouts (DOMException
 * "TimeoutError"): a 30 s stall is origin slowness, and the worker would
 * pay the same 30 s for the same likely outcome — the retry budget
 * already re-attempts transient stalls. Other HTTP errors (404, 429,
 * 5xx) are excluded too: the worker's request cannot change those
 * statuses, and re-hitting a host that just answered 429 with a second,
 * credentialed request would amplify the very limit it signalled. */
class AcquisitionError extends Error {}

function isAcquisitionFailure(thrown: unknown): boolean {
  return thrown instanceof AcquisitionError || thrown instanceof TypeError;
}

/** The message channel itself refusing the payload (size cap, channel
 * loss) — distinct from an analysis failure so the caller can retry via
 * the worker fetch, which does not use the channel for bytes at all. */
class TransportError extends Error {}

// An opaque-origin document — a sandboxed frame without allow-same-origin,
// or a data: frame, both now injected via match_origin_as_fallback —
// serializes its origin as "null". The page deliberately stripped that
// context's ambient authority, and the extension must not restore it on
// the frame's behalf: no credentialed request runs for an opaque-origin
// instance — the no-cache rung goes out cookieless (a credentialed CORS
// read would need `ACAO: null` + Allow-Credentials and fail anyway), and
// acquisition failures are terminal (no badge) instead of escalating to
// the worker's cookie-bearing fetch (owner-approved, PR #13 review,
// finding 6).
// (typeof-guarded: the test suite evaluates this module without a window.)
const hasOpaqueOrigin =
  typeof window !== "undefined" && window.origin === "null";

// ---------------------------------------------------------------------------
// Per-page-view acquisition memory (owner-accepted review follow-up,
// DECISIONS.md 2026-08-04). Two independent memories, both module state —
// alive exactly as long as the page view, like the URL verdict cache:
//
// 1. CORS-blocked memory: a URL is *proven* in-page-unreachable when both
//    in-page rungs hit the CORS layer AND the worker fetch then succeeded
//    (which rules out offline/DNS). Such URLs — and, after
//    ORIGIN_HINT_THRESHOLD distinct proofs, their whole origin — skip the
//    in-page rungs and go worker-first, eliminating the guaranteed-blocked
//    round trips the strict-CORS path otherwise re-pays. The origin hint
//    can over-generalize on mixed-CORS origins; the cost is only losing
//    the double-fetch collapse there, never a wrong verdict.
//
// 2. Failure memory: acquisition failures both paths rejected (a 404, a
//    refused redirect, an over-ceiling body) are deterministic on the
//    scale of a page view, so re-attempts within a short TTL fail fast
//    instead of re-paying the ladder. Deliberately excludes timeouts (the
//    retry budget exists to heal those) and analysis-side failures (a
//    worker restart can heal those). index.ts clears a URL's entry on
//    identity invalidation — content that rotated deserves a fresh try.

const ORIGIN_HINT_THRESHOLD = 2;
const FAILURE_MEMORY_TTL_MS = 30_000;
const FAILURE_MEMORY_MAX_ENTRIES = 500;

const corsBlockedUrls = new Set<string>();
const corsBlockedOriginCounts = new Map<string, number>();
const recentFailures = new Map<string, { at: number; message: string }>();

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

function shouldSkipInPagePath(url: string): boolean {
  if (corsBlockedUrls.has(url)) return true;
  const origin = originOf(url);
  return (
    origin !== undefined &&
    (corsBlockedOriginCounts.get(origin) ?? 0) >= ORIGIN_HINT_THRESHOLD
  );
}

function recordCorsBlocked(url: string): void {
  if (corsBlockedUrls.has(url)) return;
  corsBlockedUrls.add(url);
  const origin = originOf(url);
  if (origin !== undefined) {
    corsBlockedOriginCounts.set(
      origin,
      (corsBlockedOriginCounts.get(origin) ?? 0) + 1,
    );
  }
}

function recordAcquisitionFailure(url: string, message: string): void {
  if (recentFailures.size >= FAILURE_MEMORY_MAX_ENTRIES) {
    // Drop expired entries first; if none were, drop the oldest (Map
    // iteration is insertion-ordered) so the memory stays bounded.
    const now = Date.now();
    for (const [key, entry] of recentFailures) {
      if (now - entry.at >= FAILURE_MEMORY_TTL_MS) recentFailures.delete(key);
    }
    if (recentFailures.size >= FAILURE_MEMORY_MAX_ENTRIES) {
      const oldest = recentFailures.keys().next();
      if (!oldest.done) recentFailures.delete(oldest.value);
    }
  }
  recentFailures.set(url, { at: Date.now(), message });
}

function assertNoRecentFailure(url: string): void {
  const entry = recentFailures.get(url);
  if (!entry) return;
  if (Date.now() - entry.at >= FAILURE_MEMORY_TTL_MS) {
    recentFailures.delete(url);
    return;
  }
  throw new Error(
    `analysis failed for this URL moments ago (${entry.message}); not re-attempting yet`,
  );
}

/** Identity invalidation hook (index.ts): the URL's content is rotating,
 * so a remembered failure may no longer apply. CORS-blocked memory is
 * deliberately kept — CORS behavior is origin/server configuration, not
 * content. */
export function forgetAcquisitionFailure(url: string): void {
  recentFailures.delete(url);
}

/** Test seam: clears every per-page-view memory. */
export function resetAcquisitionMemory(): void {
  corsBlockedUrls.clear();
  corsBlockedOriginCounts.clear();
  recentFailures.clear();
}

async function fetchImage(url: string): Promise<Response> {
  // One deadline for the whole in-page ladder, not one per rung: stacked
  // per-rung budgets would let a host that stalls ~29 s then resets
  // (TypeError, so rung 2 still runs) hold one of the two analysis slots
  // for ~60 s in page context alone, ~90 s with the worker's own bound.
  // Shared, the worst case is ≤30 s here plus the worker fetch's own
  // ≤30 s when the fallback runs — the same total as before task 5.5
  // added a rung.
  const signal = AbortSignal.timeout(ANALYSIS_FETCH_TIMEOUT_MS);
  const request = (
    cache: RequestCache,
    credentials?: RequestCredentials,
  ): Promise<Response> =>
    fetch(url, {
      headers: { accept: IMAGE_ACCEPT },
      cache,
      ...(credentials ? { credentials } : {}),
      signal,
    });
  try {
    // force-cache reuses the HTTP-cache entry the render stored regardless
    // of freshness — collapsing the render+analyze double fetch observed at
    // the task-4 checkpoint, and keeping the verdict about the bytes on
    // screen rather than a newer representation a revalidation could
    // return. Content-script fetches share the page's cache partition, and
    // the pinned Accept header keeps Vary: Accept matching. Default
    // (same-origin) credentials, NOT include: a credentialed CORS read
    // requires an exact-origin ACAO + Allow-Credentials, so include would
    // fail exactly the common ACAO:* cache entries this rung exists to
    // read. The cache-hit path needs no cookies anyway — the entry was
    // stored by the render's own cookie-bearing request. The residual
    // divergence (a cache-*miss* here goes to the network cookieless) is
    // accepted and recorded (DECISIONS.md, 2026-08-04 review items).
    return await request("force-cache");
  } catch (thrown) {
    if (!(thrown instanceof TypeError)) throw thrown;
    // A cached entry can be unusable rather than merely missing: one
    // stored by the no-cors render on a server that only emits CORS
    // headers for Origin-carrying requests has none, and Chrome's HTTP
    // cache sits below the CORS layer (crbug.com/409090), so force-cache
    // serves it to this cors-mode fetch as a deterministic TypeError.
    // Revalidate past it — at the cost of possibly analyzing newer bytes
    // than the render (pre-5.2 behavior; the pinned bytes are unreadable
    // here by definition). Credentialed, unlike rung 1: this rung always
    // goes to the network, where the render sent cookies — and it only
    // runs after force-cache failed, so the ACAO:* cache-hit path above
    // is never affected. If a server refuses the credentialed read, the
    // failure lands in the worker fallback, whose cookie-bearing fetch
    // cures it anyway. Other TypeErrors (offline, DNS, strict CORS) just
    // fail the same way twice, quickly, and reach the worker fallback
    // below. Opaque-origin instances revalidate cookieless (see
    // hasOpaqueOrigin).
    return request("no-cache", hasOpaqueOrigin ? undefined : "include");
  }
}

/** The task-5.2/5.3 deferred policy, resolved (task 5.5): a verdict in
 * which no check completed — provider failures and zero collected
 * signals — supports no claim about the image, so it must take the same
 * path as any other failed analysis (no badge, no caching, bounded
 * retries) instead of badging "Unknown". A verdict that mixes completed
 * signals with failures still renders; the popover disclosure (task 5.3)
 * is what makes that partial state honest. */
function assertCompleted(verdict: WireVerdict): void {
  if (verdict.signals.length > 0 || verdict.failures.length === 0) return;
  const detail = verdict.failures
    .map((failure) => `${failure.providerId}: ${failure.message}`)
    .join("; ");
  throw new Error(`analysis incomplete — no check finished: ${detail}`);
}

async function analyzeInline(
  bytes: Uint8Array,
  mimeType: string,
  url: string,
  pinned: boolean,
): Promise<UrlCacheEntry> {
  const request: AnalyzeRequest = {
    type: ANALYZE_MESSAGE_TYPE,
    bytesBase64: encodeBytes(bytes),
    mimeType,
    sourceUrl: url,
  };
  let result: unknown;
  try {
    result = await chrome.runtime.sendMessage(request);
  } catch (thrown) {
    throw new TransportError(
      `analysis message failed: ${thrown instanceof Error ? thrown.message : String(thrown)}`,
    );
  }
  // Not a cast: the verdict below is cached and dereferenced again at
  // badge-click time, so a malformed reply must take this handled failure
  // path, not surface later as a TypeError inside a click handler.
  if (!isAnalyzeResponse(result)) {
    throw new Error("analysis failed: malformed worker reply");
  }
  if (!result.ok) {
    throw new Error(`analysis failed: ${result.error}`);
  }
  assertCompleted(result.verdict);
  return { verdict: result.verdict, pinned };
}

async function analyzeViaWorkerFetch(url: string): Promise<UrlCacheEntry> {
  const request: AnalyzeUrlRequest = { type: ANALYZE_URL_MESSAGE_TYPE, url };
  const result: unknown = await chrome.runtime.sendMessage(request);
  if (!isAnalyzeUrlResponse(result)) {
    throw new Error("analysis failed: malformed worker reply");
  }
  if (!result.ok) {
    // An ok:false reply is the worker's fetch/decode layer refusing the
    // URL (HTTP error, refused redirect, size ceiling, MIME guard) —
    // deterministic on the scale of a page view, so remember it. Analysis
    // failures proper arrive as ok:true verdicts with failure entries and
    // are never remembered (assertCompleted below rejects them fresh each
    // time, keeping them healable by retry).
    recordAcquisitionFailure(url, result.error);
    throw new Error(`analysis failed: ${result.error}`);
  }
  assertCompleted(result.verdict);
  return { verdict: result.verdict, pinned: result.pinned };
}

/** Acquires the bytes behind a URL and runs them through the worker's
 * pipeline, falling back to worker-side acquisition where the page
 * context cannot do the job (see the module header for the ladder). */
export async function acquireAndAnalyze(url: string): Promise<UrlCacheEntry> {
  // The worker can only re-fetch http(s): data: decodes in-page without
  // CORS, and blob: handles are scoped to this page's context. Opaque-
  // origin instances never escalate at all (see hasOpaqueOrigin) — every
  // fallback site below keys off this one flag.
  const workerCanFetch =
    !hasOpaqueOrigin && (url.startsWith("http:") || url.startsWith("https:"));

  if (workerCanFetch) {
    assertNoRecentFailure(url);
    if (shouldSkipInPagePath(url)) {
      // Proven in-page-unreachable (this URL, or enough of its origin):
      // the in-page rungs would only add guaranteed-blocked round trips.
      return analyzeViaWorkerFetch(url);
    }
  }

  let response: Response;
  let blob: Blob;
  try {
    response = await fetchImage(url);
    if (!response.ok) {
      const failure = `image fetch failed: HTTP ${response.status}`;
      // Only Origin-conditioned refusals escalate to the worker (see
      // AcquisitionError's comment for why nothing else does). The rest
      // are deterministic for the page view — remember them so retries
      // and duplicate images fail fast instead of re-fetching.
      if (response.status === 401 || response.status === 403) {
        throw new AcquisitionError(failure);
      }
      recordAcquisitionFailure(url, failure);
      throw new Error(failure);
    }
    blob = await response.blob();
  } catch (thrown) {
    if (workerCanFetch && isAcquisitionFailure(thrown)) {
      const entry = await analyzeViaWorkerFetch(url);
      // Worker success after an in-page CORS-layer failure proves the
      // in-page path is what's blocked (not the network) — remember, so
      // later attempts and origin siblings go worker-first.
      if (thrown instanceof TypeError) recordCorsBlocked(url);
      return entry;
    }
    throw thrown;
  }

  if (workerCanFetch && blob.size > MAX_INLINE_TRANSPORT_BYTES) {
    // The bytes are readable but too large for the message channel; the
    // worker re-fetches them itself. Costs a second fetch (different
    // cache partition) on this rare path — the alternative is a
    // guaranteed transport failure.
    return analyzeViaWorkerFetch(url);
  }

  const bytes = new Uint8Array(await blob.arrayBuffer());
  let mimeType: string;
  try {
    mimeType = imageMimeTypeFor(bytes, blob.type);
  } catch (thrown) {
    // A non-image response here is not proof the worker would see the
    // same thing: this in-page analysis fetch carries no cookies
    // cross-origin, so a session-gated host may have served a challenge
    // page it would not serve the worker's cookie-bearing request. Worth
    // one escalation; the worker applies the same guard to what it gets.
    if (workerCanFetch) return analyzeViaWorkerFetch(url);
    throw thrown;
  }

  try {
    return await analyzeInline(
      bytes,
      mimeType,
      url,
      isPinnableResponse(response),
    );
  } catch (thrown) {
    // The channel refusing the payload is not an analysis failure — the
    // worker fetch never ships bytes over the channel, so it can still
    // succeed. Genuine analysis errors propagate: re-running the same
    // pipeline on the same bytes would only repeat them.
    if (workerCanFetch && thrown instanceof TransportError) {
      return analyzeViaWorkerFetch(url);
    }
    throw thrown;
  }
}
