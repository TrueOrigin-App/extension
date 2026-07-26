// Configurable mock provider — the sole provider while the pipeline is
// validated (plan.md §6, Phase 1). Used by the core unit tests; not in the
// active registry, so it never ships in the built extension's pipeline.

import type { Finding, SignalProvider, SignalResult } from "../core/types";

export interface MockProviderOptions {
  id?: string;
  finding: Finding;
  /** Defaults to 1 (0 for a "none" finding), matching how cryptographic
   * results pin confidence — pass explicitly to model probabilistic ones. */
  confidence?: number;
  detail?: unknown;
}

export function createMockProvider(
  options: MockProviderOptions,
): SignalProvider {
  const id = options.id ?? "mock";
  const confidence = options.confidence ?? (options.finding === "none" ? 0 : 1);
  return {
    id,
    cost: "local",
    async analyze(): Promise<SignalResult> {
      return {
        providerId: id,
        finding: options.finding,
        confidence,
        detail: options.detail ?? { mock: true },
      };
    },
  };
}
