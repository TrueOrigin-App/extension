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
  pages (viewport-based lazy scanning). Clicking a badge opens an anchored
  popover with the verdict, a human-readable explanation, and progressive
  disclosure ("How do we know?") — there is no separate browser-action popup.
- Distribution is the Chrome Web Store; the store listing and privacy write-up
  lead with local-only validation.
- Development reality: Phases 1–2 are complete (pipeline, real C2PA provider,
  viewport scanning, verdict caching, popover, CORS fallbacks), followed by a
  multi-day daily-driver soak on real sites; Phase 2 was declared complete
  2026-08-05 with all soak findings recorded in DECISIONS.md. Phase 3 (brand
  & polish) is the current work. A localhost test page (`test-page/`)
  exercises every reachable verdict end-to-end.
- **Real-world verdict mix (soak, confirmed 2026-08-05): almost everything is
  Unknown.** In ordinary browsing, C2PA-signed content is essentially absent;
  outside fixtures, badges overwhelmingly show the Unknown state. Unknown is
  the everyday face of the product, and Phase 3 work must design for that
  reality rather than for the rare positive verdict.
- Phase 3 docket carried from the soak (details in DECISIONS.md): badges can
  paint over page UI stacked above images (google.com's suggestions dropdown
  is the first real-site corpus entry); all user-facing verdict copy is
  placeholder awaiting the brand pass, and the "AI — likely" verdict line
  must honestly cover both of its evidence classes; a contextual "look this
  image up" popover link (deferred from the Lens decision) is a candidate.

## Capabilities and Constraints

- **Verdict taxonomy is locked** (plan.md §2): exactly four verdicts — *AI —
  declared*, *AI — likely*, *Human — verified*, *Unknown*. Non-negotiable
  rules: no signal → Unknown, never "Not AI" (no such verdict exists anywhere
  in code, copy, or UI); "Human — verified" requires cryptographic capture
  provenance and is never inferred from absence of AI signals; probabilistic
  verdicts are labeled as probabilistic; confidence is asymmetric by design.
  Presentation (wording, color, tone) is brand work; the rules are not.
- **"AI — likely" has two evidence classes** (owner decision 2026-08-04):
  future probabilistic detector signals, and the shipped mapping of expired,
  un-timestamped C2PA AI declarations — hash-verified bytes whose signing
  time is unprovable — to 0.9 confidence. Expired *capture* claims get no
  such forgiveness (§2 asymmetry, pinned by test). This aged-declaration
  class plausibly covers the largest population of real AI images carrying
  provenance.
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
  signal provider choice (an unsigned generator-metadata provider is
  owner-approved on the docket, not yet scheduled — Phase 4); video/audio
  support, Firefox/Safari ports, and in-house detection are explicit
  non-goals for now.

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

- Real C2PA fixtures at `src/providers/c2pa/fixtures/`: `ai_declared.png`
  (genuine OpenAI provenance, validates Trusted) and `ai_expired.png` (real
  GPT-4o-era OpenAI provenance with an expired, un-timestamped signing cert —
  exercises the "AI — likely" mapping end-to-end; stable by nature, the cert
  stays expired). A real capture-signed photo for "Human — verified" was not
  acquired during the soak (confirmed 2026-08-05) — that verdict still has no
  end-to-end fixture and is exercised only at the unit level.
- Local-only network posture is verified by tests (egress allowlist),
  documented per-request-type in DECISIONS.md, and held up through the
  daily-driver soak — this feeds the Phase 3 privacy write-up.
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

WCAG 2.2 AA is a hard floor for all extension UI — badges, popover, and any
future settings surface (confirmed 2026-07-26). Applied to this product, AA's
use-of-color criterion means verdict states must be distinguishable without
color alone; badges render over arbitrary host-page imagery, so contrast must
hold against unpredictable backgrounds.
