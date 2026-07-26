// Service worker entry point: hosts the WASM validator and the signal
// pipeline (plan.md §4). The C2PA provider initializes lazily on the first
// analysis, so nothing heavy happens at worker startup.

import { runPipeline } from "../core/pipeline";
import type { MediaInput, Verdict } from "../core/types";
import { activeProviders } from "../providers";

/** Runs one piece of media through the active provider set. The content
 * script's message-passing protocol (task 4) will call this; until then it
 * is the single seam the worker exposes. */
export function analyzeMedia(input: MediaInput): Promise<Verdict> {
  return runPipeline(activeProviders, input);
}

chrome.runtime.onInstalled.addListener(() => {
  // No setup required yet.
});
