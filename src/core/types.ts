// Shared types for the signal pipeline (plan.md §3).
//
// SignalProvider and SignalResult are the locked interface shapes from
// plan.md §3 — changing them requires asking first (§8). MediaInput and the
// verdict types are free-choice shapes recorded in DECISIONS.md.

/** Media handed to providers for analysis. Free tier: these bytes and any
 * URL never leave the machine (plan.md §8, constraint 3). */
export interface MediaInput {
  bytes: Uint8Array;
  mimeType: string;
  /** Where the media was loaded from, when known. Local use only (caching,
   * popup display) — never transmitted. */
  sourceUrl?: string;
}

export const FINDINGS = [
  "ai-declared",
  "ai-indicated",
  "human-provenance",
  "none",
] as const;

/** What a single provider concluded. The crypto/probabilistic split is
 * encoded here: "ai-declared" and "human-provenance" are cryptographic
 * claims; "ai-indicated" is probabilistic; "none" is no usable signal. */
export type Finding = (typeof FINDINGS)[number];

export interface SignalProvider {
  id: string;
  cost: "local" | "api"; // maps to free/paid boundary
  analyze(input: MediaInput): Promise<SignalResult>;
}

export interface SignalResult {
  providerId: string;
  finding: Finding;
  confidence: number; // 0–1; cryptographic results pin to 1
  detail: unknown; // provider-specific, surfaced in popup
}

/** The four verdicts of plan.md §2. This list is the entire taxonomy: there
 * is no "not AI" verdict and none may be added (§8, constraint 1) — absence
 * of signals is always "unknown". */
export const VERDICT_IDS = [
  "ai-declared",
  "ai-likely",
  "human-verified",
  "unknown",
] as const;

export type VerdictId = (typeof VERDICT_IDS)[number];

/** A provider that failed to produce a usable SignalResult. Failures are
 * isolated (one bad provider never sinks the pipeline) and carried through
 * to the verdict so the UI can be honest about what wasn't checked. */
export interface ProviderFailure {
  providerId: string;
  error: unknown;
}

/** Output of the aggregator: every usable signal plus every failure. */
export interface AggregateEvidence {
  signals: SignalResult[];
  failures: ProviderFailure[];
}

/** Output of the verdict mapper: one verdict plus the supporting detail the
 * popup needs for progressive disclosure ("How do we know?"). */
export interface Verdict {
  verdict: VerdictId;
  /** The signals that determined the verdict. Empty for "unknown". */
  basis: SignalResult[];
  /** Every signal collected, including conflicting or below-threshold ones. */
  signals: SignalResult[];
  /** Providers that errored or returned malformed results. */
  failures: ProviderFailure[];
}
