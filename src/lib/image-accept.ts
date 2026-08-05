// Shared behavior of analysis fetches (task 5.1; shared home per the
// task-5.2 review): a verdict must describe the bytes the page displayed.
// Every byte-acquisition path — the content script's in-page fetch and the
// worker-side CORS fallback (task 5.5) — negotiates with the same Accept
// header the render used, applies the same not-the-rendered-image MIME
// guard (imageMimeTypeFor), bounds hangs with the same timeout, and
// applies the same pinnability rule to verdict retention.

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

/** Magic-byte detection for the image formats the analysis pipeline can
 * meet (the set the old URL-extension fallback covered, minus SVG, which
 * has no binary signature and is handled by content inspection below). */
function sniffedImageMimeType(bytes: Uint8Array): string | undefined {
  const matches = (signature: number[], offset = 0): boolean =>
    signature.every((byte, index) => bytes[offset + index] === byte);

  if (matches([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (matches([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (matches([0x47, 0x49, 0x46, 0x38])) return "image/gif"; // "GIF8"
  // "RIFF" <size> "WEBP"
  if (matches([0x52, 0x49, 0x46, 0x46]) && matches([0x57, 0x45, 0x42, 0x50], 8))
    return "image/webp";
  if (matches([0x49, 0x49, 0x2a, 0x00]) || matches([0x4d, 0x4d, 0x00, 0x2a]))
    return "image/tiff";
  // ISO-BMFF: <size> "ftyp" <brand>
  if (matches([0x66, 0x74, 0x79, 0x70], 4)) {
    const brand = String.fromCharCode(...bytes.subarray(8, 12));
    if (brand === "avif" || brand === "avis") return "image/avif";
  }

  // SVG: textual, so require the document to *start* as SVG/XML — an HTML
  // page (login interstitial, WAF challenge) starts "<!doctype html" or
  // "<html" and must not pass, even when it embeds inline <svg> icons.
  const head = new TextDecoder()
    .decode(bytes.subarray(0, 1024))
    .trimStart()
    .toLowerCase();
  if (
    head.startsWith("<svg") ||
    (head.startsWith("<?xml") && head.includes("<svg"))
  ) {
    return "image/svg+xml";
  }
  return undefined;
}

/**
 * The shared not-the-rendered-image guard: resolves the MIME type to
 * analyze under, throwing when the response cannot be the image the page
 * rendered. Every acquisition path fetched these bytes because an <img>
 * displayed them, so anything that is not an image — an HTML login page,
 * a JSON block notice — must fail the analysis rather than produce an
 * "Unknown" claim about bytes that are not the image.
 *
 * A declared image/* Content-Type is trusted as-is. No declaration (or
 * application/octet-stream, the "no idea" type) falls back to magic-byte
 * sniffing of the actual bytes — never to the URL's extension, which the
 * serving host does not control the body of.
 */
export function imageMimeTypeFor(
  bytes: Uint8Array,
  contentType: string | null | undefined,
): string {
  const declared = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (declared && declared !== "application/octet-stream") {
    if (declared.startsWith("image/")) return declared;
    throw new Error(`analysis fetch got ${declared}, not the rendered image`);
  }
  const sniffed = sniffedImageMimeType(bytes);
  if (sniffed) return sniffed;
  throw new Error(
    "could not determine image MIME type: response bytes are not a known image format",
  );
}
