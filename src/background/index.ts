// Service worker entry point: hosts the WASM validator and the signal
// pipeline (plan.md §4). The C2PA provider initializes lazily on the first
// analysis, so nothing heavy happens at worker startup.

import { runPipeline } from "../core/pipeline";
import type { MediaInput, Verdict } from "../core/types";
import {
  decodeBytes,
  isAnalyzeRequest,
  isAnalyzeUrlRequest,
  toWireVerdict,
  type AnalyzeResponse,
  type AnalyzeUrlResponse,
} from "../messaging/protocol";
import { activeProviders } from "../providers";
import { fetchImageForAnalysis } from "./fetch-image";
import { contentHashKey, createVerdictCache } from "./verdict-cache";

// Content-hash-keyed verdict cache (task 5.2): repeated analyses of the
// same bytes — other tabs, page reloads, URL aliases — skip the WASM run
// for the worker's lifetime. The URL-keyed layer lives in the content
// script; retention policy and key shape are in verdict-cache.ts.
const verdictCache = createVerdictCache();

/** Runs one piece of media through the active provider set, serving
 * repeated content from the worker-lifetime verdict cache. Concurrent
 * requests for the same bytes share one pipeline run. */
export async function analyzeMedia(input: MediaInput): Promise<Verdict> {
  const key = await contentHashKey(input);
  return verdictCache.getOrRun(key, () => runPipeline(activeProviders, input));
}

function errorMessage(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (isAnalyzeRequest(message)) {
    void (async (): Promise<AnalyzeResponse> => {
      try {
        const verdict = await analyzeMedia({
          bytes: decodeBytes(message.bytesBase64),
          mimeType: message.mimeType,
          sourceUrl: message.sourceUrl,
        });
        return { ok: true, verdict: toWireVerdict(verdict) };
      } catch (thrown) {
        // The pipeline isolates provider failures, so reaching here means
        // the request itself was unusable (e.g. undecodable bytes).
        return { ok: false, error: errorMessage(thrown) };
      }
    })().then(sendResponse);

    // Keep the message channel open for the async response. Chrome extends
    // the worker's lifetime while the channel is pending, which covers the
    // lazy WASM initialization on the first analysis.
    return true;
  }

  if (isAnalyzeUrlRequest(message)) {
    // CORS fallback (task 5.5): acquire the bytes here, where host
    // permissions apply, then run the same pipeline. Fetch policy and the
    // constraint-3 story live in fetch-image.ts.
    void (async (): Promise<AnalyzeUrlResponse> => {
      try {
        const { bytes, mimeType, pinned } = await fetchImageForAnalysis(
          message.url,
        );
        const verdict = await analyzeMedia({
          bytes,
          mimeType,
          sourceUrl: message.url,
        });
        return { ok: true, verdict: toWireVerdict(verdict), pinned };
      } catch (thrown) {
        return { ok: false, error: errorMessage(thrown) };
      }
    })().then(sendResponse);

    return true;
  }

  return;
});

chrome.runtime.onInstalled.addListener(() => {
  // No setup required yet.
});
