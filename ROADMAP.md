# TrueOrigin — Roadmap

The working task queue. **One chunk = one session = one PR.** This file
gives a fresh session everything it needs to pick up a chunk: scope, the
DECISIONS.md entries that carry the context, decisions the owner has
already made, and the asks the session must still open with.

How to work the queue:

- Read plan.md first (CLAUDE.md required reading), then the chunk's
  listed context entries in DECISIONS.md.
- Take the topmost **queued** chunk unless the owner directs otherwise.
- Update the chunk's status line (`queued` → `in progress`) when you
  start; on completion, **prune the chunk**: delete its whole block and
  leave a one-liner in the Done list at the bottom (`N. Title — PR #N`),
  as part of the chunk's PR. Git history and DECISIONS.md keep the full
  record; this file stays a queue, not an archive. Prune resolved
  Parked/Dropped entries the same way.
- Record decisions in DECISIONS.md as usual — this file holds the queue,
  never the reasoning.
- Ordering rules (owner, 2026-08-05): chunks 7–10 (public-facing docs and
  store launch) stay last; **no Phase 4 work is planned or scheduled
  here** — do not add Phase 4 chunks without an owner ask.

---

## 2. Iframe scanning — queued

**Goal:** scan images inside iframes (`all_frames: true`).

- Owner is open to this in principle (2026-08-05), but it changes
  content-script injection scope, so the session still opens with the
  formal §8 ask: concrete manifest diff, per-frame cost posture
  (about:blank/sandboxed frames, `match_origin_as_fallback`), and how
  per-frame scheduler instances share the worker.
- Add a test-page iframe fixture (same-origin and cross-origin via the
  localhost/127.0.0.1 host split the strict-CORS tier already uses).
- **Context:** DECISIONS.md 2026-07-26 (task 5.1 — `all_frames` is part
  of its known-open trio; scheduler design), test-page serve.mjs notes
  in the 5.5 entries.

## 3. Badge occlusion by page overlays — queued

**Goal:** resolve the remaining z-index-overlay problem (badges paint
over page UI stacked above images; Google's search-suggestions dropdown
is corpus entry #1).

- Session opens with the owner ask between the two surviving candidates:
  a cover heuristic built against real sites, vs. in-DOM sibling
  injection (construction-correct but carries the recorded DOM-safety
  risks). The 28px chip already shrank the collision surface; that did
  not resolve the question.
- **Context:** DECISIONS.md 2026-08-03 (5.3 deferred finding — why every
  hit-test heuristic misfires on stretched-link cards), 2026-08-04
  (Google dropdown report + the three candidates), 2026-08-05 (Phase 3
  rebuild "docket effects").

## 4. Popover polish (small PR) — queued

**Goal:** the two surviving 5.3 deferred findings.

- Presenter display-name registry: failure lines still print raw
  provider ids (`labels.ts` `failureLine`); add a display-name field in
  the presenters layer (the constraint-4-clean fix).
- Keyboard-accessible scrolling of an overflowing evidence list: the
  overlay has no focusable scroll region today; fix must keep the AA
  floor (visible focus indicator).
- Also: delete the stale labels.ts comment claiming per-image
  disclosure of the remote-manifest fetch "is Phase 3 work" — that
  disclosure was dropped 2026-08-05 (roadmap round).
- New user-facing strings are §8 wording territory — owner ask.
- **Context:** DECISIONS.md 2026-08-03 (5.3 polish, "Recorded, not
  fixed" list), 2026-08-05 (wording pass — labels are finalized;
  edits are an owner ask; roadmap round — the disclosure drop).

## 5. Generator-metadata provider, part 1 (PNG) — queued

**Goal:** the owner-approved second local provider, scoped to PNG text
chunks: Stable Diffusion / A1111 `parameters`, ComfyUI
`prompt`/`workflow` → `ai-indicated` → "Likely AI". Presenter entry,
fixtures, tests; runs in the worker on already-acquired bytes, no new
permissions, no network.

- Session opens with the recorded design asks: confidence value
  (provisionally 0.7–0.8, below the expired-declaration 0.9), how
  conservative the marker list is, whether below-threshold markers
  surface in the popover evidence list, and — if hand-rolled PNG chunk
  parsing is not preferred — the new-runtime-dependency ask.
- Constraint 4 is the whole point: zero changes outside the providers
  layer (the Phase 1 exit-criterion test proves it).
- Owner decision (2026-08-05): this lands **before any Phase 4 work**.
  Note plan.md §6 frames the first non-C2PA provider as Phase 4 paid
  territory — this one is local and free; plan.md amendment is the
  owner's (see Parked).
- **Context:** DECISIONS.md 2026-08-04 ("Future task (owner-approved):
  unsigned generator-metadata provider" — the authoritative scope).

## 6. Generator-metadata provider, part 2 (IPTC/XMP) — queued

**Goal:** extend the provider to non-PNG markers: IPTC credits ("Made
with Google AI" — Gemini class) and unsigned XMP
`Iptc4xmpExt:DigitalSourceType` values in the AI set; JPEG APP-segment
parsing; fixtures for Gemini-class output.

- Same design constraints and asks as part 1; confidence may differ per
  marker class (a bare credit string is weaker than a full SD
  parameters block — the 2026-08-04 entry flags this).
- **Context:** same entry as chunk 5, plus part 1's recorded decisions.

## 7. README — queued

**Goal:** public-repo landing page: what TrueOrigin is, the verdict
taxonomy (presentation follows the finalized labels), local-only
validation as the trust story, load-unpacked instructions, license.
Written before store copy so the listing can reuse it.

- User-facing verdict wording is finalized (2026-08-05) — reuse it
  verbatim; new framing copy is §8 owner-ask territory.

## 8. Privacy write-up — queued

**Goal:** the free-tier privacy document (feeds the store listing).
Source material is already recorded: the constraint-3 network findings
across DECISIONS.md (trust-list/conformance fetches, the remote-manifest
reference fetch, the worker fallback fetch policy, the live network-panel
verification passes).

- Owner decision (2026-08-05): the write-up **keeps** the
  remote-manifest-fetch sentence; the per-image popover disclosure is
  dropped (see DECISIONS.md same date).
- Where the document lives (README section vs. separate file) is a free
  choice; record it.

## 9. Store listing + screenshots — queued

**Goal:** Chrome Web Store copy (leads with local-only validation and
the "Unknown is honest" story — PRODUCT.md carries the positioning) and
screenshots (fixture page + real sites).

- Listing copy is brand/wording territory: structured owner asks, per §8.

## 10. Chrome Web Store publication — queued

**Goal:** developer account (owner action), packaging (`dist/` zip,
manifest version, icons/promo images — check what's missing), submission,
and the review-feedback loop.

---

## Parked (not chunked — do not schedule without an owner ask)

- **"Human — verified" fixture:** owner (2026-08-05): not coming for a
  while. The verdict stays unit-tested only; unreachable end-to-end with
  self-signed material by design.
- **CSS-animation badge re-anchoring gap** (5.1 known-open): no real-site
  report yet; folds into whichever field-bug chunk hits it.
- **`ai_declared.png` cert-expiry CI tripwire:** fires on its own
  schedule; when it does, update the Trusted/ai-declared test
  expectations (product behavior already handled — see 2026-08-04
  expired-declaration entry).
- **plan.md drift amendments** (Google Lens entries in §5/§8; §6 Phase 4
  framing of the first non-C2PA provider): plan.md is owner-authored —
  owner edits, no PR from a session.
- **Branch protection on `main`:** owner setting; verified still off
  2026-08-05.
- **Domain registration** (`trueorigin.app`, `.ca`): owner action
  (plan.md §7).
- **Phase 4** (watermark/classifier provider, payment/tier
  infrastructure): explicitly not planned yet (owner, 2026-08-05).

## Dropped (decided, recorded — do not resurrect without an owner ask)

- **Popover "look this image up" Lens link** — no API routes through
  Chrome's built-in Lens item; the only buildable form is the strictly
  weaker `uploadbyurl` link. Dropped 2026-08-05; see DECISIONS.md.
- **Per-image popover disclosure of the remote-manifest fetch** —
  dropped 2026-08-05 in favor of the privacy write-up sentence; see
  DECISIONS.md.

## Done

1. Instagram field bug (intent gate blind under page overlays; Reddit
   shadow-DOM item retired) — PR #12

(Completed chunks land here as one-liners — `N. Title — PR #N`.)
