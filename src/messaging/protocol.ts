// Message protocol between the content script and the service worker
// (free-choice shape, recorded in DECISIONS.md — task 4).
//
// chrome.runtime.sendMessage JSON-serializes its payload, so raw bytes
// travel as base64 and provider failures travel with their errors reduced
// to strings. The image bytes and source URL cross an extension-internal
// channel only — they never leave the machine (plan.md §8, constraint 3).

import {
  VERDICT_IDS,
  type ProviderFailure,
  type SignalResult,
  type Verdict,
  type VerdictId,
} from "../core/types";

export const ANALYZE_MESSAGE_TYPE = "trueorigin:analyze";

/** Content script → service worker: analyze one image. */
export interface AnalyzeRequest {
  type: typeof ANALYZE_MESSAGE_TYPE;
  /** Raw media bytes, base64-encoded to survive JSON serialization. */
  bytesBase64: string;
  mimeType: string;
  /** Local use only (badging, future caching) — never transmitted. */
  sourceUrl: string;
}

export const ANALYZE_URL_MESSAGE_TYPE = "trueorigin:analyze-url";

/** Content script → service worker: fetch the image yourself, then analyze
 * it (task 5.5). Used when in-page byte acquisition failed (strict-CORS
 * hosts reject the page-context read even though the render displayed the
 * image) or when the bytes exceed what the JSON message channel carries.
 * The worker's host permissions make the fetch CORS-exempt. The only
 * network request this triggers goes to the image's own host — the URL is
 * never sent anywhere else (plan.md §8, constraint 3). */
export interface AnalyzeUrlRequest {
  type: typeof ANALYZE_URL_MESSAGE_TYPE;
  /** http(s) URL of the image to fetch and analyze. */
  url: string;
}

/** A ProviderFailure whose error survives JSON serialization. */
export interface WireProviderFailure {
  providerId: string;
  message: string;
}

/** A Verdict as it crosses the message channel. Identical to Verdict except
 * failures carry string messages instead of unknown thrown values. */
export interface WireVerdict {
  verdict: VerdictId;
  basis: SignalResult[];
  signals: SignalResult[];
  failures: WireProviderFailure[];
}

export type AnalyzeResponse =
  { ok: true; verdict: WireVerdict } | { ok: false; error: string };

/** Reply to an AnalyzeUrlRequest. Carries `pinned` because only the worker
 * saw the response headers: the content script's URL cache must apply the
 * same no-store retention rule to fallback verdicts as to its own fetches. */
export type AnalyzeUrlResponse =
  | { ok: true; verdict: WireVerdict; pinned: boolean }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isAnalyzeRequest(message: unknown): message is AnalyzeRequest {
  if (!isRecord(message)) return false;
  return (
    message["type"] === ANALYZE_MESSAGE_TYPE &&
    typeof message["bytesBase64"] === "string" &&
    typeof message["mimeType"] === "string" &&
    typeof message["sourceUrl"] === "string"
  );
}

export function isAnalyzeUrlRequest(
  message: unknown,
): message is AnalyzeUrlRequest {
  if (!isRecord(message)) return false;
  return (
    message["type"] === ANALYZE_URL_MESSAGE_TYPE &&
    typeof message["url"] === "string"
  );
}

/** Shape check for a verdict arriving off the wire. Deep enough to cover
 * every dereference the content script performs at badge-click time
 * (popover.ts iterates signals/failures and reads providerId/message);
 * signal detail stays `unknown` — presenters harden it themselves. */
export function isWireVerdict(value: unknown): value is WireVerdict {
  if (!isRecord(value)) return false;
  return (
    (VERDICT_IDS as readonly unknown[]).includes(value["verdict"]) &&
    Array.isArray(value["basis"]) &&
    Array.isArray(value["signals"]) &&
    value["signals"].every(
      (signal: unknown) =>
        isRecord(signal) && typeof signal["providerId"] === "string",
    ) &&
    Array.isArray(value["failures"]) &&
    value["failures"].every(
      (failure: unknown) =>
        isRecord(failure) &&
        typeof failure["providerId"] === "string" &&
        typeof failure["message"] === "string",
    )
  );
}

/** Guard for the worker's reply. The worker is extension code, but the
 * reply crosses a JSON channel that protocol drift or a future persisted
 * cache could corrupt — and the verdict it carries is retained per badge
 * and dereferenced at badge-click time, so a malformed reply must fail
 * the analysis (handled, logged) rather than throw in a click handler. */
export function isAnalyzeResponse(
  message: unknown,
): message is AnalyzeResponse {
  if (!isRecord(message)) return false;
  if (message["ok"] === true) return isWireVerdict(message["verdict"]);
  return message["ok"] === false && typeof message["error"] === "string";
}

export function isAnalyzeUrlResponse(
  message: unknown,
): message is AnalyzeUrlResponse {
  if (!isRecord(message)) return false;
  if (message["ok"] === true) {
    return (
      isWireVerdict(message["verdict"]) &&
      typeof message["pinned"] === "boolean"
    );
  }
  return message["ok"] === false && typeof message["error"] === "string";
}

// btoa takes a binary string, and building one via a single spread overflows
// the argument limit on large images — hence the chunked loop.
const CHUNK_SIZE = 0x8000;

export function encodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + CHUNK_SIZE),
    );
  }
  return btoa(binary);
}

export function decodeBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function failureMessage(failure: ProviderFailure): string {
  const { error } = failure;
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

export function toWireVerdict(verdict: Verdict): WireVerdict {
  return {
    verdict: verdict.verdict,
    basis: verdict.basis,
    signals: verdict.signals,
    failures: verdict.failures.map((failure) => ({
      providerId: failure.providerId,
      message: failureMessage(failure),
    })),
  };
}
