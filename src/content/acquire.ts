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
// The in-page path stays primary: it shares the page's cache partition
// and request context (cookies, Referer), so its bytes are the render's
// bytes. The worker path is the fallback precisely because it fetches
// from a different partition — a divergence risk accepted only when the
// in-page path has already failed (rationale in DECISIONS.md, task 5.5).
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
  isPinnableResponse,
  mimeTypeFor,
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
 * refusing the request (HTTP error — e.g. hosts that 403 Origin-carrying
 * requests they would happily serve without one). Deliberately excludes
 * timeouts (DOMException "TimeoutError"): a 30 s stall is origin
 * slowness, and the worker would pay the same 30 s for the same likely
 * outcome — the retry budget already re-attempts transient stalls. */
class AcquisitionError extends Error {}

function isAcquisitionFailure(thrown: unknown): boolean {
  return thrown instanceof AcquisitionError || thrown instanceof TypeError;
}

async function fetchImage(url: string): Promise<Response> {
  const request = (cache: RequestCache): Promise<Response> =>
    fetch(url, {
      headers: { accept: IMAGE_ACCEPT },
      cache,
      signal: AbortSignal.timeout(ANALYSIS_FETCH_TIMEOUT_MS),
    });
  try {
    // force-cache reuses the HTTP-cache entry the render stored regardless
    // of freshness — collapsing the render+analyze double fetch observed at
    // the task-4 checkpoint, and keeping the verdict about the bytes on
    // screen rather than a newer representation a revalidation could
    // return. Content-script fetches share the page's cache partition, and
    // the pinned Accept header keeps Vary: Accept matching.
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
    // here by definition). Other TypeErrors (offline, DNS, strict CORS)
    // just fail the same way twice, quickly, and reach the worker
    // fallback below.
    return request("no-cache");
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
  const result: unknown = await chrome.runtime.sendMessage(request);
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
  // CORS, and blob: handles are scoped to this page's context.
  const workerCanFetch = url.startsWith("http:") || url.startsWith("https:");

  let response: Response;
  let blob: Blob;
  try {
    response = await fetchImage(url);
    if (!response.ok) {
      throw new AcquisitionError(`image fetch failed: HTTP ${response.status}`);
    }
    blob = await response.blob();
  } catch (thrown) {
    if (workerCanFetch && isAcquisitionFailure(thrown)) {
      return analyzeViaWorkerFetch(url);
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

  const mimeType = mimeTypeFor(blob, response.url);
  if (!mimeType) {
    // Not an acquisition failure: the worker's fetch would see the same
    // headers and the same extension-less URL.
    throw new Error("could not determine image MIME type");
  }

  return analyzeInline(
    new Uint8Array(await blob.arrayBuffer()),
    mimeType,
    url,
    isPinnableResponse(response),
  );
}
