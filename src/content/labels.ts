import type { VerdictId } from "../core/types";

/** Placeholder badge wording: the plan.md §2 engineering labels, verbatim,
 * owner-approved for the task-4 checkpoint. Final user-facing wording is
 * Phase 3 brand work (Impeccable) — do not refine these here. The
 * Record type keeps the mapping exhaustive over the locked taxonomy. */
export const VERDICT_LABELS: Record<VerdictId, string> = {
  "ai-declared": "AI — declared",
  "ai-likely": "AI — likely",
  "human-verified": "Human — verified",
  unknown: "Unknown",
};

/** Placeholder popover explanations (task 5.3), one plain-language sentence
 * per verdict, written in the PRODUCT.md voice: calm, honest, no jargon at
 * the surface. Owner-approved as placeholders; Phase 3 finalizes. The §2
 * rules bind the content: "unknown" must never read as "not AI", and
 * "ai-likely" must read as probabilistic. */
export const VERDICT_EXPLANATIONS: Record<VerdictId, string> = {
  // Covers both whole-image AI and composites (an AI declaration on any
  // ingredient of the validated chain) without overstating either — and
  // without attributing the statement to "the maker", since it may come
  // from an ingredient's tool.
  "ai-declared":
    "This image carries a signed statement that it was made with AI or " +
    "contains AI-generated material.",
  "ai-likely":
    "Detection signals suggest this image may be AI-made. This is an " +
    "estimate, not a certainty.",
  "human-verified":
    "A signed record from a real camera shows this image was captured " +
    "with it, with no edits recorded since.",
  // "usable" carries the §2 definition (Unknown = no *usable* signals):
  // three of the four C2PA reasons mapping here found credentials that
  // simply weren't usable as evidence, so "was found" alone would
  // contradict the disclosure right beneath it.
  unknown:
    "No usable provenance information was found for this image. Most " +
    "images carry none, so this says nothing either way.",
};

/** Remaining popover strings, same placeholder status as above. */
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
  /** One line per provider failure inside the disclosure. */
  failureLine: (providerId: string, message: string): string =>
    `The "${providerId}" check failed: ${message}`,
  /** Free-tier privacy, stated where trust is earned (PRODUCT.md
   * principle 4). Worded to stay true in every case: image bytes never
   * leave and validation is local WASM, but an asset referencing remote
   * provenance does trigger a fetch of that reference (disclosed in
   * DECISIONS.md; per-image disclosure of it is Phase 3 work) — so this
   * line claims only what always holds. */
  privacyNote:
    "The image itself never left your machine — the check ran on this " +
    "device.",
} as const;
