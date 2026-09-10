import type { VerdictId } from "../core/types";

/** Finalized badge wording (Phase 3 brand pass, owner-approved
 * 2026-08-05 — DECISIONS.md). Presentation of the plan.md §2 taxonomy,
 * never its rules: "Likely AI" leads with the hedge (probabilistic by
 * §2), "Verified photo" names exactly the signed-capture evidence class,
 * and "Unknown" stays the brand's own word — the restraint is the
 * product. Do not change casually; wording edits are an §8 owner ask.
 * The Record type keeps the mapping exhaustive over the locked
 * taxonomy. */
export const VERDICT_LABELS: Record<VerdictId, string> = {
  "ai-declared": "Made with AI",
  "ai-likely": "Likely AI",
  "human-verified": "Verified photo",
  unknown: "Unknown",
};

/** Finalized popover explanations (Phase 3 brand pass, owner-approved
 * 2026-08-05), one plain-language sentence per verdict in the PRODUCT.md
 * voice: calm, honest, no jargon at the surface. The §2 rules bind the
 * content: "unknown" must never read as "not AI", and "ai-likely" must
 * read as probabilistic. */
export const VERDICT_EXPLANATIONS: Record<VerdictId, string> = {
  // Covers both whole-image AI and composites (an AI declaration on any
  // ingredient of the validated chain) without overstating either — and
  // without attributing the statement to "the maker", since it may come
  // from an ingredient's tool.
  "ai-declared":
    "This image carries a signed statement that it was made with AI or " +
    "contains AI-generated material.",
  // "Signs point to" covers both evidence classes honestly (2026-08-04
  // decision, Phase 3 wording note): future probabilistic detector
  // signals AND an expired, un-timestamped AI declaration — a signed
  // statement whose timing can't be proven is a strong sign, not proof.
  // The class-specific story lives in the disclosure summary.
  "ai-likely":
    "Signs point to this image being AI-made, but the evidence falls " +
    "short of proof. This is an estimate, not a certainty.",
  "human-verified":
    "A signed record from a real camera shows this image was captured " +
    "with it, with no edits recorded since.",
  // "usable" carries the §2 definition (Unknown = no *usable* signals):
  // three of the four C2PA reasons mapping here found credentials that
  // simply weren't usable as evidence, so "was found" alone would
  // contradict the disclosure right beneath it. "Origin information"
  // rather than "provenance" — no jargon at the surface.
  unknown:
    "We couldn't find any usable origin information for this image. " +
    "Most images carry none — so this says nothing either way.",
};

/** Accessible name of the intent-revealed in-flight indicator (a status,
 * not a control). Finalized with the Phase 3 pass. */
export const CHECKING_LABEL = "Checking this image…";

/** Remaining popover strings — kept verbatim by the Phase 3 pass
 * (owner-approved 2026-08-05). */
export const POPOVER_STRINGS = {
  /** The progressive-disclosure toggle (plan.md §4). */
  disclosureLabel: "How do we know?",
  /** Accessible name of the popover dialog. The image's alt text is not
   * part of the name — it rides along as `aria-description` (badge.ts),
   * keeping names short for voice-control users. */
  dialogLabel: (verdictLabel: string): string => `${verdictLabel} — details`,
  /** Shown when the verdict carries provider failures: the check ran but
   * degraded, and honesty requires saying so (DECISIONS.md, task 5.2
   * deferred finding). */
  degradedNotice:
    "Note: part of this check didn't finish, so this result may be " +
    "incomplete.",
  /** One line per provider failure inside the disclosure. `checkName` is
   * the check's reader-facing name from the presenters registry
   * (providers/presenters.ts — "Content Credentials", not "c2pa"); the
   * message is the provider's own error text. */
  failureLine: (checkName: string, message: string): string =>
    `The "${checkName}" check failed: ${message}`,
  /** Free-tier privacy, stated where trust is earned (PRODUCT.md
   * principle 4). Worded to stay true in every case: image bytes never
   * leave and validation is local WASM, but an asset referencing remote
   * provenance does trigger a fetch of that reference — disclosed in
   * DECISIONS.md and in the privacy write-up (roadmap chunk 8); per-image
   * disclosure of it was dropped by owner decision, 2026-08-05 — so this
   * line claims only what always holds. */
  privacyNote:
    "The image itself never left your machine — the check ran on this " +
    "device.",
} as const;
