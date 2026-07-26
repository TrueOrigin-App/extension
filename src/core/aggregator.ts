// Aggregator (plan.md §3): runs every provider against the input and
// collects their SignalResults. Conflict resolution between findings lives
// in the verdict mapper; this layer's job is collection and isolation —
// a provider that throws or returns a malformed result becomes a recorded
// failure, never a crash and never a signal.

import {
  FINDINGS,
  type AggregateEvidence,
  type MediaInput,
  type ProviderFailure,
  type SignalProvider,
  type SignalResult,
} from "./types";

/** Returns a description of what is wrong with the result, or null if it is
 * usable. A buggy provider must not be able to corrupt the taxonomy. */
function validateResult(result: SignalResult): string | null {
  if (!(FINDINGS as readonly string[]).includes(result.finding)) {
    return `unknown finding "${String(result.finding)}"`;
  }
  if (
    typeof result.confidence !== "number" ||
    !Number.isFinite(result.confidence) ||
    result.confidence < 0 ||
    result.confidence > 1
  ) {
    return `confidence must be a number in [0, 1], got ${String(result.confidence)}`;
  }
  return null;
}

export async function aggregate(
  providers: SignalProvider[],
  input: MediaInput,
): Promise<AggregateEvidence> {
  const settled = await Promise.allSettled(
    providers.map((provider) => provider.analyze(input)),
  );

  const signals: SignalResult[] = [];
  const failures: ProviderFailure[] = [];

  settled.forEach((outcome, i) => {
    const provider = providers[i]!;
    if (outcome.status === "rejected") {
      failures.push({ providerId: provider.id, error: outcome.reason });
      return;
    }
    const problem = validateResult(outcome.value);
    if (problem !== null) {
      failures.push({
        providerId: provider.id,
        error: new Error(`malformed SignalResult: ${problem}`),
      });
      return;
    }
    signals.push(outcome.value);
  });

  return { signals, failures };
}
