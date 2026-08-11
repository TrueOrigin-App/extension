// Content script (task 5.1): viewport-based lazy scanning (plan.md §4).
// Images are discovered on load and as the DOM changes, but only analyzed
// once they enter the viewport (plus lookahead) and dwell there — fast
// scrolling past an image costs nothing. Scheduling policy lives in
// scheduler.ts; free choices recorded in DECISIONS.md.
//
// Byte acquisition (acquire.ts) runs primarily here in page context, with
// the page's own cache partition and request context; strict-CORS hosts
// and oversized payloads fall back to a worker-side fetch under the
// extension's host permissions (task 5.5).
//
// Verdict caching (task 5.2): analyses are keyed by URL for the page view,
// so duplicate images and re-inserted elements cost one analysis per URL —
// and the fetch itself runs force-cache, so byte acquisition reads the
// bytes the render already downloaded instead of hitting the network a
// second time. Verdicts for unpinnable (no-store) responses are not
// retained, and identity invalidations evict their URL's entry, so bytes
// that rotate under a stable URL are re-analyzed rather than replayed. The
// worker keeps a second, content-hash-keyed layer that outlives the page
// view.

import { isCacheableVerdict } from "../core/types";
import { CoalescingLruCache } from "../lib/coalescing-lru";
import {
  acquireAndAnalyze,
  forgetAcquisitionFailure,
  type UrlCacheEntry,
} from "./acquire";
import { passesBootGate } from "./boot-gate";
import {
  clearPending,
  markPending,
  removeBadgeFor,
  renderBadge,
  syncBadges,
} from "./badge";
import { ScanScheduler } from "./scheduler";

const LOG_PREFIX = "[TrueOrigin]";

// Scheduling constants (provisional; rationale in DECISIONS.md task 5.1).
const DWELL_MS = 250;
const MAX_CONCURRENT_ANALYSES = 2;
const VIEWPORT_LOOKAHEAD = "200px";
// Images smaller than this on their short side are page furniture (icons,
// avatars, spacers) — skipped, not analyzed, no badge. Raised from 64
// after the task-5.5 soak: real pages badge large icons and app tiles at
// 64–95px, and the badge pill itself outsizes such images. Still
// provisional; tune against soak feel.
const MIN_IMAGE_DIMENSION_PX = 96;
// A hung image load must never hold an analysis slot forever — two of
// them would silently stop all scanning for the page view. (Byte
// acquisition is bounded inside acquire.ts: one shared 30 s deadline for
// the in-page ladder, plus the worker fetch's own 30 s when the fallback
// runs.)
const SETTLE_TIMEOUT_MS = 10_000;
// Bound on the page-view verdict cache. Provisional: entries are one
// WireVerdict each (manifest-store detail dominates), so this only guards
// unbounded growth on infinite-scroll pages.
const MAX_CACHED_VERDICTS = 200;
// A failed analysis may be transient (503, timeout, a coalesced rejection
// from another element's failure), so each scan cycle gets one retry on a
// later viewport re-entry before the element goes terminal — bounding what
// a deterministically failing URL (one both acquisition paths reject) can
// cost to one extra attempt per cycle.
const MAX_ANALYSIS_ATTEMPTS = 2;

// Attribute writes that change which bytes an <img> displays — on the img
// itself, and on <source> children of its enclosing <picture>.
const IMG_IDENTITY_ATTRIBUTES = new Set(["src", "srcset", "sizes"]);
const SOURCE_IDENTITY_ATTRIBUTES = new Set([
  "srcset",
  "sizes",
  "media",
  "type",
]);

function imageSettled(image: HTMLImageElement): Promise<void> {
  if (image.complete) return Promise.resolve();
  return new Promise((resolve) => {
    // One shared signal removes both listeners on settle ({once} alone
    // would leak whichever of the pair never fires), and the timeout caps
    // how long a load that never settles can occupy an analysis slot —
    // after it, analysis proceeds with whatever currentSrc holds.
    const settled = new AbortController();
    const settle = (): void => {
      settled.abort();
      resolve();
    };
    image.addEventListener("load", settle, { signal: settled.signal });
    image.addEventListener("error", settle, { signal: settled.signal });
    setTimeout(settle, SETTLE_TIMEOUT_MS);
  });
}

// Page-view verdict cache, keyed by the analyzed URL — the same identity
// badges carry (a badge is a claim about a specific URL). Duplicate images
// share one in-flight analysis. Entries are retained only when the verdict
// is failure-free (transient conditions must not stick — the same
// isCacheableVerdict policy as the worker layer) and the response is
// pinnable (see UrlCacheEntry). Rejections are never cached, so a URL that
// failed outright is retried when another element (or a retry re-entry)
// asks for it.
const verdictsByUrl = new CoalescingLruCache<UrlCacheEntry>({
  maxEntries: MAX_CACHED_VERDICTS,
  retain: (entry) => entry.pinned && isCacheableVerdict(entry.verdict),
});

async function analyzeImage(image: HTMLImageElement): Promise<void> {
  // Ownership: this run acts for the element's current generation. Any
  // invalidation (src swap, <picture> change, removal) bumps it, at which
  // point this run must touch nothing — the newer cycle owns the state.
  const generation = generationOf(image);
  await imageSettled(image);
  if (generationOf(image) !== generation) return;

  const url = image.currentSrc || image.src;
  if (!url) {
    // Nothing to analyze yet; forget the image so a later src assignment
    // (which arrives as an attribute mutation) scans it fresh.
    scheduler.reset(image);
    return;
  }

  if (image.complete && image.naturalWidth === 0) {
    // The render failed (error event, or already-broken): whatever bytes
    // the URL names, the user is not seeing them, so a badge would be a
    // claim about invisible content — and with force-cache the analysis
    // could even succeed against a stale prior-session cache entry while
    // the origin is unreachable. Forgotten rather than terminal: a scroll
    // re-entry re-checks cheaply, and a recovered load usually arrives as
    // a src reset (an invalidation) anyway. Still-loading images past the
    // settle timeout have complete === false and proceed as before.
    scheduler.reset(image);
    return;
  }

  // Layout (border-box) size, not the transformed rect: it is what the
  // page allocated to the image (transforms are usually transient
  // animation), and it is the same metric the ResizeObserver below
  // reports — gating on the visual rect would make a persistently
  // scaled-down image revive, re-fail, and loop forever.
  if (
    Math.min(image.offsetWidth, image.offsetHeight) < MIN_IMAGE_DIMENSION_PX
  ) {
    // Too small to be content. Forgotten rather than marked done, and
    // watched for growth: an already-intersecting image never receives
    // another IntersectionObserver entry, so in-place growth (placeholder
    // hydrating, container expanding, display toggled on) must revive it
    // through the ResizeObserver.
    scheduler.reset(image);
    resizeObserver.observe(image);
    return;
  }

  // Intent-gated "checking" indicator, started only now — after the
  // settle wait and every skip gate above — so it can never claim a
  // check on an image that will produce no verdict (no URL, broken
  // render, too small). renderBadge hands it off to the verdict badge;
  // the scheduler callback's finally covers every failure path.
  markPending(image);

  // data: URLs skip the URL cache: the URL *is* the payload, so a Map key
  // would retain the whole string (the worker's content-hash layer dedupes
  // their analysis anyway). blob: URLs are short opaque handles to content
  // that is immutable for the handle's lifetime — they cache like http(s).
  const { verdict } = url.startsWith("data:")
    ? await acquireAndAnalyze(url)
    : await verdictsByUrl.getOrRun(url, () => acquireAndAnalyze(url));

  if (generationOf(image) !== generation || !image.isConnected) {
    // Invalidated or removed mid-analysis; whatever re-queued or reaped
    // the element owns its state now — this verdict describes bytes no
    // longer on screen.
    return;
  }
  if ((image.currentSrc || image.src) !== url) {
    // The displayed source changed with no mutation record and no
    // invalidation — responsive srcset re-selection (resize, DPR change).
    // Nothing else has re-queued the element, so do it here: this verdict
    // is about bytes the image no longer shows.
    invalidateScan(image);
    return;
  }

  renderBadge(image, verdict, url);
  failedAttempts.delete(image);
}

// Failed analyses per scan cycle; cleared on success and on invalidation
// (a new cycle gets a fresh budget).
const failedAttempts = new WeakMap<HTMLImageElement, number>();

const scheduler = new ScanScheduler<HTMLImageElement>({
  dwellMs: DWELL_MS,
  maxConcurrent: MAX_CONCURRENT_ANALYSES,
  analyze: async (image) => {
    const generation = generationOf(image);
    try {
      await analyzeImage(image);
    } catch (thrown) {
      // No badge on failure: a badge is a claim about the image, and a
      // failed check supports none — not even "Unknown", which the mapper
      // reserves for checks that ran (plan.md §2). This includes analyses
      // in which no provider check completed (acquire.ts rejects those
      // rather than letting them badge Unknown). Failures are never
      // cached, and the element gets MAX_ANALYSIS_ATTEMPTS per cycle: the
      // first failure forgets it so a later viewport re-entry retries
      // (transient failures — 503s, timeouts, rejections shared through
      // coalescing — heal there); the last is terminal for the cycle.
      console.warn(LOG_PREFIX, "could not analyze", image.currentSrc, thrown);
      if (generationOf(image) !== generation) return;
      const attempts = (failedAttempts.get(image) ?? 0) + 1;
      failedAttempts.set(image, attempts);
      if (attempts < MAX_ANALYSIS_ATTEMPTS) scheduler.reset(image);
    } finally {
      // Generation-guarded like every other side effect: analysis runs
      // overlap (ScanScheduler.reset leaves in-flight runs going), so a
      // stale run settling here must not destroy the pending indicator —
      // and its intent listeners — of the fresh cycle that replaced it.
      // Every generation bump clears pending itself (invalidateScan via
      // removeBadgeFor, untrack directly), so nothing leaks.
      if (generationOf(image) === generation) clearPending(image);
    }
  },
});

const intersectionObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      const image = entry.target as HTMLImageElement;
      if (entry.isIntersecting) {
        scheduler.enter(image);
      } else {
        scheduler.leave(image);
      }
    }
  },
  { rootMargin: VIEWPORT_LOOKAHEAD },
);

// Scan generations: every invalidation bumps an element's generation, and
// an analysis run only acts on shared state (scheduler resets, badges)
// while the generation it captured is still current. A run that lost
// ownership mid-flight can never clobber the fresh cycle that replaced it.
const generations = new WeakMap<HTMLImageElement, number>();

function generationOf(image: HTMLImageElement): number {
  return generations.get(image) ?? 0;
}

function track(image: HTMLImageElement): void {
  // observe() is spec-idempotent (re-observing an observed target is a
  // no-op), so track() needs no bookkeeping to be safe to repeat.
  intersectionObserver.observe(image);
}

function untrack(image: HTMLImageElement): void {
  generations.set(image, generationOf(image) + 1);
  failedAttempts.delete(image);
  // The generation bump above stops the in-flight run's finally from
  // clearing pending state, so the removal path must do it — a removed
  // image's "checking" chip and intent listeners die with the image.
  clearPending(image);
  scheduler.reset(image);
  intersectionObserver.unobserve(image);
  resizeObserver.unobserve(image);
}

/** The image's displayed source changed identity: any badge or scan state
 * now describes the wrong bytes. Drop both and rescan as if new. */
function invalidateScan(image: HTMLImageElement): void {
  generations.set(image, generationOf(image) + 1);
  failedAttempts.delete(image);
  // The entry cached for the displayed URL may describe bytes this
  // invalidation is replacing (same-URL content rotation: live images,
  // re-insertions that revalidate). Evict it so the fresh cycle
  // re-fetches — usually straight from disk cache, and the worker's hash
  // layer still absorbs the WASM cost when the bytes are unchanged.
  // Duplicate-element absorption (the dominant cache win) is unaffected.
  const url = image.currentSrc || image.src;
  if (url) {
    verdictsByUrl.delete(url);
    // Same reasoning as the verdict eviction: rotating content may fetch
    // fine now, so the remembered acquisition failure must not outlive
    // the identity it described.
    forgetAcquisitionFailure(url);
  }
  removeBadgeFor(image);
  scheduler.reset(image);
  // The fresh cycle re-gates and re-registers for growth if still small.
  resizeObserver.unobserve(image);
  // Re-observing always yields a fresh entry, so a visible image re-enters
  // the scheduler immediately instead of waiting for a threshold crossing —
  // and for a never-observed image this is simply observe().
  intersectionObserver.unobserve(image);
  intersectionObserver.observe(image);
}

// Revival channel for images the min-size gate skipped. Observation starts
// only at the gate and ends at the first grown entry (or any
// untrack/invalidation), so the initial entry a fresh observe() delivers —
// which reports the same too-small size the gate just measured — never
// revives, and a revival fires once per gating.
const resizeObserver = new ResizeObserver((entries) => {
  for (const entry of entries) {
    const image = entry.target as HTMLImageElement;
    const box = entry.borderBoxSize[0];
    if (
      !box ||
      Math.min(box.inlineSize, box.blockSize) < MIN_IMAGE_DIMENSION_PX
    ) {
      continue;
    }
    resizeObserver.unobserve(image);
    invalidateScan(image);
  }
});

// Layout sync: badges are positioned in document coordinates, so plain
// window scrolling over normal-flow content is free. Everything else that
// moves an image re-anchors: resize, DOM mutations, subresources loading
// in above it, fonts swapping in — and scrolls themselves, because
// position:fixed/sticky subtrees and inner scrollers do move images in
// document coordinates. All rAF-coalesced into one pass over the (small)
// set of live badges.
let syncScheduled = false;
function scheduleSync(): void {
  if (syncScheduled) return;
  syncScheduled = true;
  requestAnimationFrame(() => {
    syncScheduled = false;
    syncBadges(untrack, invalidateScan);
  });
}

const mutationObserver = new MutationObserver((records) => {
  for (const record of records) {
    if (record.type === "childList") {
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node instanceof HTMLImageElement) track(node);
        for (const image of node.querySelectorAll("img")) {
          track(image);
        }
      }
      for (const node of record.removedNodes) {
        // Still-connected means the node was moved in the same task, not
        // removed (re-insertion happened before this microtask); moved
        // images keep their scan state and badge.
        if (!(node instanceof Element) || node.isConnected) continue;
        if (node instanceof HTMLImageElement) untrack(node);
        for (const image of node.querySelectorAll("img")) {
          untrack(image);
        }
      }
      if (record.target instanceof HTMLPictureElement) {
        // Adding or removing a <source> re-runs source selection for the
        // sibling <img> without producing any record on the img itself.
        const image = record.target.querySelector("img");
        if (image) invalidateScan(image);
      }
    } else if (
      record.target instanceof HTMLImageElement &&
      IMG_IDENTITY_ATTRIBUTES.has(record.attributeName ?? "") &&
      record.target.getAttribute(record.attributeName ?? "") !== record.oldValue
    ) {
      // Only actual value changes are identity changes: setAttribute
      // queues a record even when the value is identical (jQuery .attr,
      // the `img.src = img.src` reload idiom), and reacting to those
      // would strip the badge and restart the dwell on every write.
      invalidateScan(record.target);
    } else if (
      record.target instanceof HTMLSourceElement &&
      record.target.parentElement instanceof HTMLPictureElement &&
      SOURCE_IDENTITY_ATTRIBUTES.has(record.attributeName ?? "") &&
      record.target.getAttribute(record.attributeName ?? "") !== record.oldValue
    ) {
      // A <source> mutation can swap the sibling <img>'s currentSrc with
      // no record on the img. Invalidate unconditionally: whether the
      // selection actually changed is only knowable after the browser
      // re-runs it, and a spurious rescan is the safe direction.
      const image = record.target.parentElement.querySelector("img");
      if (image) invalidateScan(image);
    }
  }
  // Every record batch schedules a sync — including class/style toggles,
  // which is how carousels and tabs hide slides: the sync pass is what
  // hides, reveals, and re-anchors their badges (and its URL recheck
  // catches identity changes none of the branches above can see).
  scheduleSync();
});

// Split out of main() because a document rewrite erases exactly these
// registrations (see the rewrite sentinel below) and they must be
// re-installable alone. Idempotent by addEventListener semantics — the
// same (type, listener, capture) triple registers once — so calling it
// when nothing was erased is free.
function installPageListeners(): void {
  window.addEventListener("resize", scheduleSync);
  // Scroll events don't bubble; capture also catches inner scrollers.
  document.addEventListener("scroll", scheduleSync, true);
  // Capture-phase load events from images/iframes/embeds anywhere in the
  // page — each one can shift layout below it without any DOM mutation.
  document.addEventListener("load", scheduleSync, true);
  document.fonts?.ready.then(scheduleSync, () => undefined);
}

let mainStarted = false;

function main(): void {
  mainStarted = true;
  for (const image of Array.from(document.images)) {
    track(image);
  }

  // No attributeFilter: identity needs src/srcset/sizes on <img> plus
  // srcset/sizes/media/type on <source>, and badge sync needs the
  // class/style toggles pages use to show and hide images. Per-record
  // cost is an instanceof plus a Set lookup; sync is rAF-coalesced and
  // exits immediately on pages with no badges.
  //
  // Observed on the Document node, not documentElement: document.open()
  // replaces the root element, and an observer bound to the old root
  // would watch a detached tree forever. The Document node is the
  // identity that survives a rewrite — the root swap itself then arrives
  // as an ordinary childList record (old root untracked, new root's
  // images tracked by the branches above).
  mutationObserver.observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeOldValue: true,
  });

  installPageListeners();
}

// Iframe scanning (roadmap chunk 2): this script runs in every frame
// (all_frames + match_origin_as_fallback), each instance scanning its own
// document with its own observers and scheduler; the service worker — and
// its cross-frame content-hash verdict cache — is shared. A child frame
// whose viewport is shorter than MIN_IMAGE_DIMENSION_PX on either side
// installs nothing (tracking-pixel and ad-slot frames are legion;
// injection itself is the only cost Chrome has already paid). This is an
// accepted blind spot, not an equivalence: the min-size gate measures the
// image's layout box, which a short-but-scrollable frame can lay out
// larger than its viewport — such frames stay unscanned until the frame
// itself grows, because content overflowing a sub-minimum frame is
// treated as non-content (PR #13 review, finding 3). The gate's resize
// listener revives a frame that grows — display:none frames report a 0×0
// viewport until shown, and reveal arrives as a resize.
function start(): void {
  if (mainStarted) return;
  if (passesBootGate(window, MIN_IMAGE_DIMENSION_PX, start)) main();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start, { once: true });
} else {
  start();
}

// Rewrite sentinel (PR #13 review, finding 1 — the friendly-iframe ad
// pattern): an ad tag calling document.open()/write() on an injected
// about:blank document erases every event listener on the document AND
// window (HTML spec "document open steps") and replaces the root element,
// silently disarming everything start() and main() installed — including
// the gate's revive listener — while Chrome never re-injects, because no
// navigation commits. MutationObservers are not event listeners and the
// Document node persists through a rewrite, so a childList observer on the
// Document is the one hook that outlives it: when the root's identity
// changes, re-install what the rewrite erased. Image tracking needs no
// help here — the main observer targets the same surviving Document node
// and sees the swap as a childList record.
let observedRoot: Element | null = document.documentElement;
new MutationObserver(() => {
  const root = document.documentElement;
  if (root === null || root === observedRoot) return;
  observedRoot = root;
  if (mainStarted) installPageListeners();
  else start(); // re-evaluates the gate; re-arms the erased revive listener
}).observe(document, { childList: true });
