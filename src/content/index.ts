// Content script (task 4): validate the images on the page and badge each
// with its verdict. Deliberately one-shot — viewport lazy scanning, verdict
// caching, and dynamic-DOM handling are task 5 (plan.md §6, Phase 2).
//
// Byte acquisition happens here, in page context, with the page's own
// origin privileges: the localhost test page serves its images same-origin,
// so no host permissions are involved. Cross-origin acquisition strategies
// are task 5 territory (plan.md §4, friction point 1).

import {
  ANALYZE_MESSAGE_TYPE,
  encodeBytes,
  type AnalyzeRequest,
  type AnalyzeResponse,
} from "../messaging/protocol";
import { renderBadge } from "./badge";

const LOG_PREFIX = "[TrueOrigin]";

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
  if (!url) return;

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

  // Full evidence in the console for the task-4 checkpoint; the popup's
  // progressive disclosure (Phase 2) is the real home for this detail.
  console.info(LOG_PREFIX, url, result.verdict);
  renderBadge(image, result.verdict.verdict);
}

function main(): void {
  for (const image of Array.from(document.images)) {
    analyzeImage(image).catch((thrown: unknown) => {
      // No badge on failure: a badge is a claim about the image, and a
      // failed check supports none — not even "Unknown", which the mapper
      // reserves for checks that ran (plan.md §2).
      console.warn(LOG_PREFIX, "could not analyze", image.currentSrc, thrown);
    });
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", main, { once: true });
} else {
  main();
}
