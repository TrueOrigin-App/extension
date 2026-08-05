// Worker-side byte acquisition (task 5.5): the fallback for images whose
// bytes the page context cannot read. The worker's broad host permissions
// (task 5.1) exempt this fetch from CORS, so it succeeds exactly where the
// in-page path deterministically fails — hosts that serve images without
// CORS headers, or that reject Origin-carrying requests outright.
//
// Constraint 3 (plan.md §8): the only request this module makes goes to
// the image's own host — the host that already served these bytes to this
// user for the render. Redirects are refused (redirect: "manual") to keep
// that true: this fetch is CORS-exempt and credentialed, so following a
// redirect would let the image host choose where a cookie-bearing request
// lands (an intranet or localhost target it should never reach). The URL
// is never sent anywhere else, and the bytes come *to* the machine. Unit
// tests pin the single-fetch, single-URL, no-redirect behavior the
// provider-level egress suite pins for the pipeline.
//
// Known divergence, accepted on this path only: the worker fetches from
// the extension's cache partition without the page's Referer, so on
// exotic servers the bytes may differ from the render's. The fallback
// only runs when the render's own bytes are unreachable from the page
// context — some divergence risk beats no verdict at all. The shared
// imageMimeTypeFor guard catches the common catastrophic form (an HTML
// challenge or login page in place of the image), which must fail the
// analysis rather than become an "Unknown" claim about bytes that are
// not the image.

import {
  ANALYSIS_FETCH_TIMEOUT_MS,
  IMAGE_ACCEPT,
  imageMimeTypeFor,
  isPinnableResponse,
} from "../lib/image-accept";

// Ceiling on the fetched body. This path is the deliberate destination
// for images too large for the message channel (32 MiB), so the ceiling
// sits above that with margin — but it must exist: the body is read into
// worker memory, and an unbounded (or decompression-bombed) response
// would OOM the MV3 worker, killing every pending analysis with it. The
// check is enforced while streaming, on decoded bytes, so no more than
// the ceiling is ever held.
export const MAX_ANALYSIS_BODY_BYTES = 64 * 1024 * 1024;

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
    // See the module header: the host must not get to choose where this
    // CORS-exempt, credentialed request finally lands.
    redirect: "manual",
    signal: AbortSignal.timeout(ANALYSIS_FETCH_TIMEOUT_MS),
  });
  if (
    response.type === "opaqueredirect" ||
    (response.status >= 300 && response.status < 400)
  ) {
    throw new Error("image host answered with a redirect; refusing to follow");
  }
  if (!response.ok) {
    throw new Error(`image fetch failed: HTTP ${response.status}`);
  }

  const bytes = await readBodyBounded(response);
  const mimeType = imageMimeTypeFor(
    bytes,
    response.headers.get("content-type"),
  );

  return {
    bytes,
    mimeType,
    pinned: isPinnableResponse(response),
  };
}

/** Reads the response body, aborting as soon as it exceeds the ceiling —
 * Content-Length is checked first for the honest oversize case, but the
 * streaming check is the enforcement (the header can be absent, wrong, or
 * describe compressed bytes the decoder then expands). */
async function readBodyBounded(
  response: Response,
): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (declared > MAX_ANALYSIS_BODY_BYTES) {
    throw new Error(
      `image exceeds the ${MAX_ANALYSIS_BODY_BYTES}-byte analysis ceiling`,
    );
  }

  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_ANALYSIS_BODY_BYTES) {
      throw new Error(
        `image exceeds the ${MAX_ANALYSIS_BODY_BYTES}-byte analysis ceiling`,
      );
    }
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_ANALYSIS_BODY_BYTES) {
      await reader.cancel();
      throw new Error(
        `image exceeds the ${MAX_ANALYSIS_BODY_BYTES}-byte analysis ceiling`,
      );
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
