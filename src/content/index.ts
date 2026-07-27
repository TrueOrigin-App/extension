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
    image.addEventListener("load", () => resolve(), { once: true });
    image.addEventListener("error", () => resolve(), { once: true });
  });
}

async function analyzeImage(image: HTMLImageElement): Promise<void> {
  await imageSettled(image);

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

  const response = await fetch(url);
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

  if ((image.currentSrc || image.src) !== url) {
    // The image swapped sources mid-analysis; this verdict describes bytes
    // no longer on screen. The src mutation has already re-queued it.
    return;
  }

  // Full evidence in the console for now; the popup's progressive
  // disclosure (task 5.3) is the real home for this detail.
  console.info(LOG_PREFIX, url, result.verdict);
  renderBadge(image, result.verdict.verdict);
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

/** Images currently under observation. */
const tracked = new WeakSet<HTMLImageElement>();

function track(image: HTMLImageElement): void {
  if (tracked.has(image)) return;
  tracked.add(image);
  intersectionObserver.observe(image);
}

function untrack(image: HTMLImageElement): void {
  tracked.delete(image);
  scheduler.reset(image);
  intersectionObserver.unobserve(image);
}

/** An image's source changed: any existing badge now describes the wrong
 * bytes. Drop it and rescan as if the image were new. */
function handleSrcChange(image: HTMLImageElement): void {
  removeBadgeFor(image);
  if (!tracked.has(image)) {
    track(image);
    return;
  }
  scheduler.reset(image);
  // Re-observing always yields a fresh entry, so a visible image re-enters
  // the scheduler immediately instead of waiting for a threshold crossing.
  intersectionObserver.unobserve(image);
  intersectionObserver.observe(image);
}

// Layout sync: badges are positioned in document coordinates (scrolling is
// free), so they only need re-anchoring when layout itself moves — resize,
// DOM mutations, subresources loading in above them, fonts swapping in.
// All rAF-coalesced into one pass over the (small) set of live badges.
let syncScheduled = false;
function scheduleSync(): void {
  if (syncScheduled) return;
  syncScheduled = true;
  requestAnimationFrame(() => {
    syncScheduled = false;
    syncBadges(untrack);
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
    } else if (record.target instanceof HTMLImageElement) {
      handleSrcChange(record.target);
    }
  }
  scheduleSync();
});

function main(): void {
  for (const image of Array.from(document.images)) {
    track(image);
  }

  mutationObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src", "srcset"],
  });

  window.addEventListener("resize", scheduleSync);
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
