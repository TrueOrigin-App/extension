// Worker-side byte acquisition (task 5.5): the fallback for images whose
// bytes the page context cannot read. The worker's broad host permissions
// (task 5.1) exempt this fetch from CORS, so it succeeds exactly where the
// in-page path deterministically fails — hosts that serve images without
// CORS headers, or that reject Origin-carrying requests outright.
//
// Constraint 3 (plan.md §8): the only request this module makes goes to
// the image's own host — the host that already served these bytes to this
// user for the render. The URL is never sent anywhere else, and the bytes
// come *to* the machine. Unit tests pin the single-fetch, single-URL
// behavior the provider-level egress suite pins for the pipeline.
//
// Known divergence, accepted on this path only: the worker fetches from
// the extension's cache partition without the page's Referer, so on
// exotic servers the bytes may differ from the render's. The fallback
// only runs when the render's own bytes are unreachable from the page
// context — some divergence risk beats no verdict at all. The text/*
// guard below catches the common catastrophic form (an HTML challenge or
// login page in place of the image), which must fail the analysis rather
// than become an "Unknown" claim about bytes that are not the image.

import {
  ANALYSIS_FETCH_TIMEOUT_MS,
  IMAGE_ACCEPT,
  isPinnableResponse,
  mimeTypeFor,
} from "../lib/image-accept";

export interface FetchedImage {
  bytes: Uint8Array<ArrayBuffer>;
  mimeType: string;
  /** Whether a verdict about these bytes may be replayed for the URL
   * (isPinnableResponse) — threaded back to the content script's URL
   * cache, which never saw the response headers. */
  pinned: boolean;
}

export async function fetchImageForAnalysis(
  url: string,
): Promise<FetchedImage> {
  const protocol = new URL(url).protocol;
  if (protocol !== "http:" && protocol !== "https:") {
    // data:/blob: never reach here (the content script reads those
    // in-page); anything else is a request this worker should not make.
    throw new Error(`refusing to fetch non-http(s) URL (${protocol})`);
  }

  const response = await fetch(url, {
    headers: { accept: IMAGE_ACCEPT },
    // Mirror the render request as closely as this context can: the
    // render sent the user's cookies, and an anonymous refetch is
    // likelier to be answered with a different representation (or a
    // login page) than the one on screen. Host permissions exempt
    // extension-initiated requests from SameSite blocking, so the
    // cookies actually attach.
    credentials: "include",
    signal: AbortSignal.timeout(ANALYSIS_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`image fetch failed: HTTP ${response.status}`);
  }

  const blob = await response.blob();
  const mimeType = mimeTypeFor(blob, response.url);
  if (!mimeType) {
    throw new Error("could not determine image MIME type");
  }
  if (mimeType.startsWith("text/")) {
    // The render displayed an image; a text response means this context
    // was served something else entirely. Analyzing it would produce a
    // verdict about bytes the user never saw.
    throw new Error(`fallback fetch got ${mimeType}, not the rendered image`);
  }

  return {
    bytes: new Uint8Array(await blob.arrayBuffer()),
    mimeType,
    pinned: isPinnableResponse(response),
  };
}
