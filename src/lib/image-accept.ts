// Shared behavior of analysis fetches (task 5.1; shared home per the
// task-5.2 review): a verdict must describe the bytes the page displayed.
// Every byte-acquisition path — the content script's in-page fetch and the
// worker-side CORS fallback (task 5.5) — negotiates with the same Accept
// header the render used, falls back to the same extension-based MIME
// detection when servers omit Content-Type, bounds hangs with the same
// timeout, and applies the same pinnability rule to verdict retention.

// Chrome's Accept header for <img> requests. The analysis fetch has to
// negotiate the same representation the page displayed: on a `Vary: Accept`
// CDN, the default `*/*` can be served different bytes (e.g. the signed
// original where the page got an unsigned transcode), and the verdict
// would describe an image the user never saw.
//
// Pinned to Chrome's current value, which Chrome has revised across
// releases (apng/jxl churn). If it drifts, nothing breaks loudly — cached
// render entries on Vary: Accept CDNs silently stop matching, degrading
// the double-fetch collapse to a second network fetch — so re-check this
// string against DevTools when Chrome's image requests change shape.
export const IMAGE_ACCEPT =
  "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8";

// A hung analysis fetch must never hold resources forever: in the content
// script it occupies one of the two analysis slots; in the worker it holds
// the message channel (and with it the worker's lifetime extension) open.
export const ANALYSIS_FETCH_TIMEOUT_MS = 30_000;

/** Whether a verdict about this response's bytes may be replayed for the
 * URL: a no-store response can serve different bytes on every fetch, so
 * its verdict is good for exactly the analysis that produced it.
 * Cache-Control is CORS-safelisted — readable even cross-origin. */
export function isPinnableResponse(response: Response): boolean {
  return !(response.headers.get("cache-control") ?? "")
    .toLowerCase()
    .includes("no-store");
}

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

export function mimeTypeFor(blob: Blob, url: string): string | undefined {
  if (blob.type) return blob.type;
  const extension = new URL(url).pathname.split(".").pop()?.toLowerCase();
  return extension ? EXTENSION_MIME_TYPES[extension] : undefined;
}
