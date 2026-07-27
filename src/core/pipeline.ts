// The full signal pipeline (plan.md §3): providers → aggregator → verdict.
// Providers are passed in, not imported — core never depends on the
// providers layer, which is what keeps "add a provider" a providers-only
// change (§8, constraint 4). The service worker wires the two together.

import { aggregate } from "./aggregator";
import type { MediaInput, SignalProvider, Verdict } from "./types";
import { mapVerdict } from "./verdict";

export async function runPipeline(
  providers: SignalProvider[],
  input: MediaInput,
): Promise<Verdict> {
  return mapVerdict(await aggregate(providers, input));
}
