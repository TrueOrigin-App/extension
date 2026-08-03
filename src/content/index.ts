// Content script (task 5.1): viewport-based lazy scanning (plan.md §4).
// Images are discovered on load and as the DOM changes, but only analyzed
// once they enter the viewport (plus lookahead) and dwell there — fast
// scrolling past an image costs nothing. Scheduling policy lives in
// scheduler.ts; free choices recorded in DECISIONS.md.
//
// Byte acquisition still happens here, in page context, with the page's own
// origin privileges — so cross-origin images depend on permissive CORS until
// the worker-side fallback lands (task 5.5). Verdict caching is task 5.2.

import {
  ANALYZE_MESSAGE_TYPE,
  encodeBytes,
  type AnalyzeRequest,
  type AnalyzeResponse,
} from "../messaging/protocol";
import { removeBadgeFor, renderBadge, syncBadges } from "./badge";
import { ScanScheduler } from "./scheduler";

const LOG_PREFIX = "[TrueOrigin]";

// Scheduling constants (provisional; rationale in DECISIONS.md task 5.1).
const DWELL_MS = 250;
const MAX_CONCURRENT_ANALYSES = 2;
const VIEWPORT_LOOKAHEAD = "200px";
// Images smaller than this on their short side are page furniture (icons,
// avatars, spacers) — skipped, not analyzed, no badge.
const MIN_IMAGE_DIMENSION_PX = 64;
// A hung image load or fetch must never hold an analysis slot forever —
// two of them would silently stop all scanning for the page view.
const SETTLE_TIMEOUT_MS = 10_000;
const FETCH_TIMEOUT_MS = 30_000;
// Chrome's Accept header for <img> requests. The analysis fetch has to
// negotiate the same representation the page displayed: on a `Vary: Accept`
// CDN, the default `*/*` can be served different bytes (e.g. the signed
// original where the page got an unsigned transcode), and the verdict
// would describe an image the user never saw.
const IMAGE_ACCEPT =
  "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8";

// Attribute writes that change which bytes an <img> displays — on the img
// itself, and on <source> children of its enclosing <picture>.
const IMG_IDENTITY_ATTRIBUTES = new Set(["src", "srcset", "sizes"]);
const SOURCE_IDENTITY_ATTRIBUTES = new Set([
  "srcset",
  "sizes",
  "media",
  "type",
]);

/** Fallback MIME detection for servers that omit Content-Type. */
const EXTENSION_MIME_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  avif: "image/avif",
  gif: "image/gif",
  svg: "image/svg+xml",
  tif: "image/tiff",
  tiff: "image/tiff",
};

function mimeTypeFor(blob: Blob, url: string): string | undefined {
  if (blob.type) return blob.type;
  const extension = new URL(url).pathname.split(".").pop()?.toLowerCase();
  return extension ? EXTENSION_MIME_TYPES[extension] : undefined;
}

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

  const rect = image.getBoundingClientRect();
  if (Math.min(rect.width, rect.height) < MIN_IMAGE_DIMENSION_PX) {
    // Too small to be content. Forgotten rather than marked done, so an
    // image that later grows past the threshold is reconsidered when it
    // re-enters the viewport.
    scheduler.reset(image);
    return;
  }

  const response = await fetch(url, {
    headers: { accept: IMAGE_ACCEPT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`image fetch failed: HTTP ${response.status}`);
  }
  const blob = await response.blob();
  const mimeType = mimeTypeFor(blob, response.url);
  if (!mimeType) {
    throw new Error("could not determine image MIME type");
  }

  const request: AnalyzeRequest = {
    type: ANALYZE_MESSAGE_TYPE,
    bytesBase64: encodeBytes(new Uint8Array(await blob.arrayBuffer())),
    mimeType,
    sourceUrl: url,
  };
  const result = (await chrome.runtime.sendMessage(request)) as AnalyzeResponse;

  if (!result.ok) {
    throw new Error(`analysis failed: ${result.error}`);
  }

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

  // Full evidence in the console for now; the popup's progressive
  // disclosure (task 5.3) is the real home for this detail.
  console.info(LOG_PREFIX, url, result.verdict);
  renderBadge(image, result.verdict.verdict, url);
}

const scheduler = new ScanScheduler<HTMLImageElement>({
  dwellMs: DWELL_MS,
  maxConcurrent: MAX_CONCURRENT_ANALYSES,
  analyze: (image) =>
    analyzeImage(image).catch((thrown: unknown) => {
      // No badge on failure: a badge is a claim about the image, and a
      // failed check supports none — not even "Unknown", which the mapper
      // reserves for checks that ran (plan.md §2). Failures are terminal
      // for this page view; verdict caching (task 5.2) revisits retries.
      console.warn(LOG_PREFIX, "could not analyze", image.currentSrc, thrown);
    }),
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
  scheduler.reset(image);
  intersectionObserver.unobserve(image);
}

/** The image's displayed source changed identity: any badge or scan state
 * now describes the wrong bytes. Drop both and rescan as if new. */
function invalidateScan(image: HTMLImageElement): void {
  generations.set(image, generationOf(image) + 1);
  removeBadgeFor(image);
  scheduler.reset(image);
  // Re-observing always yields a fresh entry, so a visible image re-enters
  // the scheduler immediately instead of waiting for a threshold crossing —
  // and for a never-observed image this is simply observe().
  intersectionObserver.unobserve(image);
  intersectionObserver.observe(image);
}

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

function main(): void {
  for (const image of Array.from(document.images)) {
    track(image);
  }

  // No attributeFilter: identity needs src/srcset/sizes on <img> plus
  // srcset/sizes/media/type on <source>, and badge sync needs the
  // class/style toggles pages use to show and hide images. Per-record
  // cost is an instanceof plus a Set lookup; sync is rAF-coalesced and
  // exits immediately on pages with no badges.
  mutationObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeOldValue: true,
  });

  window.addEventListener("resize", scheduleSync);
  // Scroll events don't bubble; capture also catches inner scrollers.
  document.addEventListener("scroll", scheduleSync, true);
  // Capture-phase load events from images/iframes/embeds anywhere in the
  // page — each one can shift layout below it without any DOM mutation.
  document.addEventListener("load", scheduleSync, true);
  document.fonts?.ready.then(scheduleSync, () => undefined);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", main, { once: true });
} else {
  main();
}
