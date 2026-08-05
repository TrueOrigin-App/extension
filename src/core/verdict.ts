// Verdict mapper (plan.md §3): maps aggregate evidence to one of the four
// verdicts of §2, plus the supporting detail the popup shows.
//
// Conflicts across providers are resolved by finding precedence:
//
//   ai-declared > human-provenance > ai-indicated (above threshold) > unknown
//
// Rationale (from the §2 non-negotiable rules):
// - Cryptographic findings outrank probabilistic ones ("confidence is
//   asymmetric by design"), so "human-provenance" is not overturned by a
//   probabilistic AI signal — the conflicting signal still ships in
//   `signals` for the popup to surface.
// - Between the two cryptographic findings, "ai-declared" wins: a false
//   "Human — verified" is the worst failure the product can emit, and a
//   cryptographic AI declaration is exactly the disqualifying evidence §2
//   says that verdict must not survive.
// - No qualifying signal maps to "unknown". Never to "not AI" (§8,
//   constraint 1).

import type {
  AggregateEvidence,
  SignalResult,
  Verdict,
  VerdictId,
} from "./types";

/** Minimum confidence for a probabilistic "ai-indicated" signal to produce
 * an "ai-likely" verdict. Provisional until a real probabilistic provider
 * exists (Phase 4) — see DECISIONS.md. Below-threshold signals still appear
 * in `Verdict.signals`, just not in `basis`. */
export const AI_LIKELY_MIN_CONFIDENCE = 0.7;

/** The verdict class a single signal's evidence supports on its own —
 * what a UI surface should claim when rendering that one signal in
 * isolation (the popover's per-signal rings). Lives beside mapVerdict so
 * the finding→class mapping and its threshold rule stay in one module: a
 * below-threshold "ai-indicated" signal supports nothing beyond
 * "unknown" (the same AI_LIKELY_MIN_CONFIDENCE rule mapVerdict applies),
 * and "none" maps to "unknown", never to a "not AI" of any kind (§8,
 * constraint 1). */
export function verdictClassForSignal(
  signal: Pick<SignalResult, "finding" | "confidence">,
): VerdictId {
  switch (signal.finding) {
    case "ai-declared":
      return "ai-declared";
    case "human-provenance":
      return "human-verified";
    case "ai-indicated":
      return signal.confidence >= AI_LIKELY_MIN_CONFIDENCE
        ? "ai-likely"
        : "unknown";
    case "none":
      return "unknown";
  }
}

export function mapVerdict(evidence: AggregateEvidence): Verdict {
  const { signals, failures } = evidence;

  const byFinding = (finding: SignalResult["finding"]) =>
    signals.filter((signal) => signal.finding === finding);

  const declared = byFinding("ai-declared");
  if (declared.length > 0) {
    return { verdict: "ai-declared", basis: declared, signals, failures };
  }

  const human = byFinding("human-provenance");
  if (human.length > 0) {
    return { verdict: "human-verified", basis: human, signals, failures };
  }

  const indicated = byFinding("ai-indicated").filter(
    (signal) => signal.confidence >= AI_LIKELY_MIN_CONFIDENCE,
  );
  if (indicated.length > 0) {
    return { verdict: "ai-likely", basis: indicated, signals, failures };
  }

  return { verdict: "unknown", basis: [], signals, failures };
}
