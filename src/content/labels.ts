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
