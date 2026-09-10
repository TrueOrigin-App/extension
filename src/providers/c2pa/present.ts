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

/** How the popover names this check to the reader where a provider must be
 * named — today the failure line ("The … check failed"). "Content
 * Credentials" is the term the summaries below already use for C2PA at the
 * disclosure layer, so the name introduces no new vocabulary; the raw id
 * ("c2pa") is code, and never reaches the surface (roadmap chunk 4). */
export const C2PA_DISPLAY_NAME = "Content Credentials";

const SUMMARIES: Record<C2paDetail["reason"], string> = {
  // Mirrors the verdict-level "ai-declared" wording (labels.ts): the
  // reason also fires for a composite declaration on an ingredient
  // manifest, and the signer/generator facts may name a later editor —
  // so neither "created with AI" alone nor "the tool that made it" is
  // safe to claim here.
  "ai-source-type":
    "This image carries Content Credentials — a signed, tamper-evident " +
    "record — declaring that it was made with AI or contains " +
    "AI-generated material.",
  "trusted-capture":
    "This image carries Content Credentials signed by a capture device. " +
    "The signature is valid and the signer is on a recognized trust list.",
  "untrusted-capture":
    "This image claims to be a camera capture, but its signer is not on a " +
    "recognized trust list, so the claim can't be counted as evidence.",
  "invalid-manifest":
    "This image has Content Credentials attached, but they did not pass " +
    "verification, so they can't be used as evidence.",
  // The one Invalid state that still carries signal (owner decision,
  // 2026-08-04): the declaration's content checks pass, only the signing
  // certificate's validity window has lapsed — probabilistic, never
  // certain.
  "expired-ai-declaration":
    "This image carries a signed statement that it was made with AI or " +
    "contains AI-generated material, but the signing certificate has " +
    "since expired, so the statement can't be fully verified.",
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
 * like the C2paDetail this provider emits. SUMMARIES doubles as the reason
 * whitelist: the Record type forces it exhaustive over C2paDetail["reason"],
 * so a newly added reason cannot be silently rejected here — a
 * hand-maintained Set would drift without a compile error. */
function asC2paDetail(detail: unknown): C2paDetail | undefined {
  if (typeof detail !== "object" || detail === null) return undefined;
  const reason = (detail as { reason?: unknown }).reason;
  if (typeof reason !== "string" || !Object.hasOwn(SUMMARIES, reason)) {
    return undefined;
  }
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
