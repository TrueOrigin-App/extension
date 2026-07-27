// Service worker entry point: hosts the WASM validator and the signal
// pipeline (plan.md §4). The C2PA provider initializes lazily on the first
// analysis, so nothing heavy happens at worker startup.

import { runPipeline } from "../core/pipeline";
import type { MediaInput, Verdict } from "../core/types";
import {
  decodeBytes,
  isAnalyzeRequest,
  toWireVerdict,
  type AnalyzeResponse,
} from "../messaging/protocol";
import { activeProviders } from "../providers";

/** Runs one piece of media through the active provider set. */
export function analyzeMedia(input: MediaInput): Promise<Verdict> {
  return runPipeline(activeProviders, input);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isAnalyzeRequest(message)) return;

  void (async (): Promise<AnalyzeResponse> => {
    try {
      const verdict = await analyzeMedia({
        bytes: decodeBytes(message.bytesBase64),
        mimeType: message.mimeType,
        sourceUrl: message.sourceUrl,
      });
      return { ok: true, verdict: toWireVerdict(verdict) };
    } catch (thrown) {
      // The pipeline isolates provider failures, so reaching here means the
      // request itself was unusable (e.g. undecodable bytes).
      const error = thrown instanceof Error ? thrown.message : String(thrown);
      return { ok: false, error };
    }
  })().then(sendResponse);

  // Keep the message channel open for the async response. Chrome extends
  // the worker's lifetime while the channel is pending, which covers the
  // lazy WASM initialization on the first analysis.
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  // No setup required yet.
});
