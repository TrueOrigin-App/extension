// Plain-language presentation of a C2PA signal for the popover's "How do
// we know?" disclosure (task 5.3). Pure and dependency-free by design: this
// module is bundled into the content script, so it must never import the
// provider's WASM machinery — only types, which erase at compile time.
//
// All strings are PLACEHOLDER wording in the PRODUCT.md voice (calm,
// honest, jargon only inside the disclosure layer). Final copy is Phase 3
// brand work — do not refine casually.

import type { SignalResult } from "../../core/types";
import type { SignalFact, SignalPresentation } from "../presenters";
import type { C2paDetail } from "./mapping";

export const C2PA_PROVIDER_ID = "c2pa";

const REASONS: ReadonlySet<C2paDetail["reason"]> = new Set([
  "no-c2pa-metadata",
  "unsupported-format",
  "invalid-manifest",
  "ai-source-type",
  "trusted-capture",
  "untrusted-capture",
  "no-origin-declaration",
]);

const SUMMARIES: Record<C2paDetail["reason"], string> = {
  "ai-source-type":
    "This image carries Content Credentials — a signed, tamper-evident " +
    "record from the tool that made it — declaring that it was created " +
    "with AI.",
  "trusted-capture":
    "This image carries Content Credentials signed by a capture device. " +
    "The signature is valid and the signer is on a recognized trust list.",
  "untrusted-capture":
    "This image claims to be a camera capture, but its signer is not on a " +
    "recognized trust list, so the claim can't be counted as evidence.",
  "invalid-manifest":
    "This image has Content Credentials attached, but they did not pass " +
    "verification, so they can't be used as evidence.",
  "no-c2pa-metadata":
    "No Content Credentials are attached to this image. Most images on " +
    "the web don't carry any.",
  "no-origin-declaration":
    "This image has valid Content Credentials, but they don't state how " +
    "it was originally created.",
  "unsupported-format":
    "Content Credentials can't be read from this image's file format.",
};

/** Humanized digital source types (IPTC vocabulary stays internal). */
const SOURCE_TYPE_LABELS: Record<string, string> = {
  "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia":
    "Created with an AI model",
  "http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia":
    "Contains AI-generated material",
  "http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture":
    "Camera photograph",
  "http://cv.iptc.org/newscodes/digitalsourcetype/computationalCapture":
    "Computational capture (e.g. a phone camera)",
};

function sourceTypeLabel(uri: string): string {
  return SOURCE_TYPE_LABELS[uri] ?? uri;
}

/** The wire flattens detail to `unknown`; accept it only if it still looks
 * like the C2paDetail this provider emits. */
function asC2paDetail(detail: unknown): C2paDetail | undefined {
  if (typeof detail !== "object" || detail === null) return undefined;
  const reason = (detail as { reason?: unknown }).reason;
  if (typeof reason !== "string") return undefined;
  if (!REASONS.has(reason as C2paDetail["reason"])) return undefined;
  return detail as C2paDetail;
}

export function presentC2paSignal(signal: SignalResult): SignalPresentation {
  const detail = asC2paDetail(signal.detail);
  if (!detail) {
    return {
      summary: "This image was checked for Content Credentials.",
      facts: [],
    };
  }

  const facts: SignalFact[] = [];
  const isCapture =
    detail.reason === "trusted-capture" ||
    detail.reason === "untrusted-capture";

  if (typeof detail.signatureIssuer === "string") {
    facts.push({ label: "Signed by", value: detail.signatureIssuer });
  }
  if (typeof detail.claimGenerator === "string") {
    facts.push({
      label: isCapture ? "Captured with" : "Made with",
      value: detail.claimGenerator,
    });
  }
  if (Array.isArray(detail.aiSourceTypes) && detail.aiSourceTypes.length > 0) {
    facts.push({
      label: "Declares",
      value: detail.aiSourceTypes
        .filter((uri): uri is string => typeof uri === "string")
        .map(sourceTypeLabel)
        .join("; "),
    });
  }
  if (typeof detail.captureSourceType === "string") {
    facts.push({
      label: "Declares",
      value: sourceTypeLabel(detail.captureSourceType),
    });
  }
  if (detail.validationState === "Trusted") {
    facts.push({
      label: "Signature",
      value: "Valid — signer is on a recognized trust list",
    });
  } else if (detail.validationState === "Valid") {
    facts.push({
      label: "Signature",
      value: "Valid — signer is not on a recognized trust list",
    });
  } else if (
    Array.isArray(detail.validationFailures) &&
    detail.validationFailures.length > 0
  ) {
    facts.push({
      label: "Technical detail",
      value: detail.validationFailures
        .filter((code): code is string => typeof code === "string")
        .join(", "),
    });
  }
  if (typeof detail.title === "string") {
    facts.push({ label: "Title", value: detail.title });
  }

  return { summary: SUMMARIES[detail.reason], facts };
}
