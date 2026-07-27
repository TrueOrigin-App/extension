# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Everyday, non-technical people browsing social media and news — designed for the
general public from day one (confirmed 2026-07-26). They have exactly one
question about content they encounter: **"Is this AI or not?"** They have never
heard of C2PA and never will; manifests, signatures, and trust lists must stay
invisible. Attention is glance-level, mid-scroll — the verdict must land without
being studied.

## Product Purpose

TrueOrigin is a Chrome extension (MV3) that answers "is this AI-generated?" for
images on the web by aggregating every available provenance and detection
signal — C2PA validation at launch; watermark detectors, classifier APIs, and
community signals over time — into a single plain-language verdict.

Success (confirmed): the free tier earns trust and distribution as the
**foundation for a paid tier**. Free C2PA validation is local and private; paid
API-backed signals arrive in Phase 4. Every surface should build the
credibility that conversion will later rest on — trust first, monetization
second.

## Positioning

A **meta-detector, not a C2PA viewer**. Neighboring tools (Digimarc's
extension, contentcredentials.org/verify) are built around a single standard
and expose its machinery to an audience that doesn't exist. TrueOrigin's claim
a neighbor could not truthfully copy: **epistemic honesty**. Most detector
products overclaim, and that is exactly why people distrust them. TrueOrigin
says "Unknown" when it doesn't know — that restraint *is* the brand.

## Operating Context

- Verdicts appear as badge overlays on images in arbitrary third-party web
  pages (viewport-based lazy scanning), with a popup detail view offering a
  human-readable explanation and progressive disclosure ("How do we know?").
- Distribution is the Chrome Web Store; the store listing and privacy write-up
  lead with local-only validation.
- Development reality: Phase 1 (pipeline) and the first content-script/badge
  slice are built; Phase 2 (usable extension) is in progress per plan.md §6–§8.
  A localhost test page (`test-page/`) exercises badges end-to-end.
- A multi-day daily-driver soak on real sites is planned before Phase 2 is
  declared complete.

## Capabilities and Constraints

- **Verdict taxonomy is locked** (plan.md §2): exactly four verdicts — *AI —
  declared*, *AI — likely*, *Human — verified*, *Unknown*. Non-negotiable
  rules: no signal → Unknown, never "Not AI" (no such verdict exists anywhere
  in code, copy, or UI); "Human — verified" requires cryptographic capture
  provenance and is never inferred from absence of AI signals; probabilistic
  verdicts are labeled as probabilistic; confidence is asymmetric by design.
  Presentation (wording, color, tone) is brand work; the rules are not.
- **Free-tier privacy:** media bytes and page URLs never leave the machine.
  Validation runs locally (WASM in the MV3 service worker). Trust-infrastructure
  fetches (trust lists, revocation) are permitted, disclosed in DECISIONS.md,
  and enforced by an egress-allowlist test. No telemetry.
- **Provider architecture:** adding a signal provider requires zero changes
  outside the providers layer (enforced by test). Paid providers will be thin
  clients to `api.trueorigin.app` — no proprietary logic in this repo.
- **Public repo, Apache 2.0.** No secrets, keys, or paid-tier logic ever.
  Openness is a trust asset: "audit the free tier yourself."
- **MV3 constraints:** badge overlays must not break host-page layout and must
  be removable; broad host access is unavoidable but every other permission
  stays minimal (permission adds require an owner ask).
- **Verdict wording shown to users is brand territory** — finalized in Phase 3,
  never changed casually.
- Undecided (recorded, not invented): paid-tier pricing and packaging; second
  signal provider choice (Phase 4); video/audio support, Firefox/Safari ports,
  and in-house detection are explicit non-goals for now.

## Brand Commitments

- **Name:** TrueOrigin — one word, capital T, capital O. Trademark/store
  diligence done July 2026; `trueorigin.app` to be registered. Apache 2.0
  grants no trademark rights — forks can't use the name.
- **Voice and personality:** friendly, calm, honest; approachable and light
  (carryover confirmed in plan.md §6 Phase 3).
- **Binding anti-references:** no alarmist fake-detector UX, no enterprise
  dashboard density, no crypto-trust aesthetics. Generic trust-tool styling is
  a named failure mode.
- No logo or visual identity exists yet; the visual world is future work.

## Evidence on Hand

- Real C2PA fixtures at `src/providers/c2pa/fixtures/`, including
  `ai_declared.png` carrying genuine OpenAI provenance. A real capture-signed
  photo for "Human — verified" is planned during the soak — that verdict
  currently has no end-to-end fixture.
- Local-only network posture is verified by tests (egress allowlist) and
  documented per-request-type in DECISIONS.md — this feeds the Phase 3 privacy
  write-up.
- **Absences future work must not fabricate:** no users, testimonials, case
  studies, press, benchmarks, install counts, or pricing. Do not invent them.

## Product Principles

1. **Never claim more than the evidence supports.** "Unknown" is the honest
   default, and that restraint is the differentiator.
2. **The verdict is the product; the machinery stays invisible.** No C2PA
   jargon at the surface — depth lives behind progressive disclosure.
3. **Calm over alarm.** False AI accusations against human creators are the
   failure mode this product exists to avoid; tone never escalates beyond the
   evidence.
4. **Privacy is a feature, not a footnote.** Local-only free tier, auditable
   public code — say so plainly wherever trust is being earned.
5. **Trust converts.** The free tier's credibility is the paid tier's
   foundation; nothing may spend trust to gain attention.

## Accessibility & Inclusion

WCAG 2.2 AA is a hard floor for all extension UI — badges, popup, and any
future settings surface (confirmed 2026-07-26). Applied to this product, AA's
use-of-color criterion means verdict states must be distinguishable without
color alone; badges render over arbitrary host-page imagery, so contrast must
hold against unpredictable backgrounds.
