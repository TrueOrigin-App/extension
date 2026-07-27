# TrueOrigin — Plan

**One-liner:** A Chrome extension that answers the only question people actually have about content they see online — *is this AI-generated?* — by aggregating every provenance and detection signal available, and never claiming more than the evidence supports.

---

## 1. Product Thesis

TrueOrigin is a **meta-detector**, not a C2PA viewer.

Existing tools (Digimarc's extension, contentcredentials.org/verify) are built around a single standard and expose its machinery: manifests, signatures, trust lists. That framing serves people who already understand C2PA — a vanishingly small audience. Normal people have exactly one question: **"Is this AI or not?"** The behind-the-scenes is irrelevant to them and should stay invisible.

TrueOrigin's job is to:

1. Collect every available signal about a piece of content (C2PA today; watermark detectors, classifier APIs, community signals over time).
2. Weigh them into a single verdict.
3. Communicate that verdict in plain language, at a glance, without alarmism.

As the detection ecosystem grows, TrueOrigin grows with it — new tools become new signal providers plugged into an existing pipeline, not rewrites.

**Positioning:** friendly, calm, honest. The anti-references stand: no alarmist fake-detector UX, no enterprise dashboard density, no crypto-trust aesthetics. The core differentiator is epistemic honesty — most detector products overclaim, and that is exactly why people distrust them. TrueOrigin says "unknown" when it doesn't know, and that restraint *is* the brand.

---

## 2. Verdict Taxonomy

This is simultaneously an architectural contract and the entire product surface. The states below are locked at the engineering level; their *presentation* (badge wording, colors, tone) is brand work handled later via the Impeccable workflow.

| Verdict | Meaning | Evidence required | Confidence |
|---|---|---|---|
| **AI — declared** | Content cryptographically declares AI generation | Valid C2PA manifest with AI-generation assertion | High (cryptographic) |
| **AI — likely** | Detection signals suggest AI origin | Classifier / watermark signals above threshold | Explicitly probabilistic |
| **Human — verified** | Signed capture provenance with intact edit chain | Valid C2PA manifest from signed capture device, no disqualifying edits | High (cryptographic) |
| **Unknown** | No usable signals | Absence of evidence | The honest default |

### Non-negotiable rules

- **No signal → Unknown. Never → "Not AI."** Absence of provenance proves nothing: most human content carries no metadata, and stripping C2PA data is trivial. A false "not AI" verdict on stripped Midjourney output destroys the product's credibility.
- **"Human — verified" is a stronger claim than "not AI"** and is reserved for actual cryptographic capture provenance. It is never inferred from the absence of AI signals.
- **Probabilistic verdicts are labeled as probabilistic.** "AI — likely" never masquerades as certainty. False AI accusations against human artists are the alarmist failure mode this product exists to avoid.
- **Confidence is asymmetric by design.** Positive cryptographic declarations can be confident; inferences from absence cannot.

---

## 3. Architecture

Three layers, structured from day one as if there were many signal providers — even while there is only one.

```
┌─────────────────────────────────────────────┐
│  Signal Providers (common interface)         │
│  • C2PA validator (launch — local, free)     │
│  • [future] Watermark detectors              │
│  • [future] Classifier APIs (paid tier)      │
│  • [future] Community signals (paid tier)    │
├─────────────────────────────────────────────┤
│  Aggregator                                  │
│  Collects SignalResults, resolves conflicts, │
│  applies confidence weighting                │
├─────────────────────────────────────────────┤
│  Verdict Mapper                              │
│  Maps aggregate evidence → one of the four   │
│  verdicts + supporting detail for the popup  │
└─────────────────────────────────────────────┘
```

### Signal provider interface (sketch)

```ts
interface SignalProvider {
  id: string;
  cost: "local" | "api";            // maps to free/paid boundary
  analyze(input: MediaInput): Promise<SignalResult>;
}

interface SignalResult {
  providerId: string;
  finding: "ai-declared" | "ai-indicated" | "human-provenance" | "none";
  confidence: number;               // 0–1; cryptographic results pin to 1
  detail: unknown;                  // provider-specific, surfaced in popup
}
```

New detection tools are implemented as providers. The aggregator and verdict mapper do not change when providers are added.

### Launch provider: C2PA

- Built on the **current c2pa-js monorepo** (restructured June 2026). The old `c2pa` package / repo is deprecated (`c2pa-js-legacy`) — this is the dependency the Digimarc fork was chained to, and a key reason the fork was abandoned. Do not reintroduce it.
- Validation runs **locally** (WASM). No media bytes leave the machine for the free tier — this is a trust feature worth stating in the store listing.

---

## 4. Extension Implementation (MV3)

**Components**

- **Content script:** viewport-based lazy scanning via IntersectionObserver. Only images entering the viewport are queued for analysis; no full-page sweeps. Badge overlay rendering on analyzed media.
- **Service worker:** hosts the WASM validator and the signal pipeline; receives analysis requests from the content script via message passing.
- **Popup / detail view:** verdict + human-readable explanation; progressive disclosure for the curious ("How do we know?") without burying the verdict.

**Known friction points (budget annoyance here)**

1. **Image byte acquisition.** Getting raw bytes of third-party images for local validation: CORS, non-permissive headers, choosing between service-worker fetch (host permissions) vs. in-page extraction. The old Digimarc source (MIT) is legitimate reference material for how they solved this — read it, don't fork it.
2. **WASM in an MV3 service worker.** Loading quirks, worker lifetime limits (relevant for large media). Well-trodden by now but expect friction.
3. **Scan scheduling.** Debounce viewport churn; cache verdicts per URL/content-hash so scrolling doesn't re-analyze.

**Permissions posture:** minimum viable. Broad host access is unavoidable for the core promise (media appears everywhere), but everything else stays lean — consistent with the trust positioning.

---

## 5. Free / Paid Boundary

The boundary falls naturally along the signal-cost line — no artificial gating:

| Tier | Signals | Rationale |
|---|---|---|
| **Free** | C2PA validation (local), "Open in Google Lens" right-click | Zero marginal cost; local = private |
| **Paid (future)** | Classifier APIs (e.g., Cloud Vision Web Detection), LLM-summarized community signals | Per-call API costs |

The **Google Lens right-click** feature (context menu → constructed Lens URL) is nearly free to build and gives free-tier users a manual escalation path when the verdict is Unknown.

---

## 6. Roadmap

### Phase 1 — Vertical slice
Goal: validate the *architecture*, not just the SDK.
- Signal provider interface + aggregator + verdict mapper, with C2PA as the sole provider.
- One content script; validate one image on one page; render one badge.
- Exit criteria: pipeline is real — adding a mock second provider requires zero changes outside the providers folder (enforce with a unit test).

### Phase 2 — Usable extension
- Viewport lazy scanning, verdict caching, all four badge states.
- Popup with verdict + explanation.
- Google Lens right-click.
- Handle the byte-acquisition edge cases (CORS fallbacks).
- **Cadence note:** Phases 1–2 are buildable in one focused day with an agent. "Built" ≠ "done": follow the build with several days of daily-driver usage (real sites, real scrolling) to surface CORS failures, scan-scheduling feel, and badge edge cases before declaring Phase 2 complete.

### Phase 3 — Brand & polish
- **PRODUCT.md is generated via Impeccable — never hand-write it.** From the project root: `npx impeccable install`, then `/impeccable init` inside Claude Code. This plan is the source material when answering the interview.
  - **Timing: init runs twice.** First pass on day one (after Phase 1 scaffolding exists), so brand context is standing input while the agent builds Phase 2 UI. Second pass (re-interview) after several days of real-world usage, once the product's rough edges are known — that pass is the authoritative one for this phase's polish work.
  - Expected carryover from the previous product: friendly / approachable / light personality; anti-references (alarmist detector UX, enterprise dashboards, crypto-trust aesthetics).
  - Expected change: identity shifts from "C2PA viewer with a nice UI" to "the honest answer to 'is this AI?'"
  - Note: Impeccable is on skill v4 (July 2026). v4 changed what PRODUCT.md holds and retired the brand-vs-product register field — starting fresh here means a v4-native file, but don't apply v3-era assumptions about its contents. Commands run through the single `/impeccable` skill; v4 also infers the job type (blank slate / redesign / addition / refinement) from how you describe the surface, so lean conversational rather than command-sequencing. `/impeccable doctor` checks for drift between project files and installed version.
- Then refine: describe what needs work and let v4 route it (the v3-era `critique → clarify → typeset/delight → polish → document` sequence still maps, but v4 prefers you describe the surface over picking commands). Expect the direction-selection step to deal challenger design directions — useful here, since generic trust-tool aesthetics are exactly the failure mode.
- Badge/popup wording finalized as brand work — presentation of the taxonomy, never its rules.
- Store listing, screenshots, privacy write-up (lead with local-only validation).

### Phase 4 — Second signal & tiers
- First non-C2PA provider (watermark detection or classifier API).
- Payment/tier infrastructure only when a paid signal actually exists.

### Explicit non-goals (for now)
- Video/audio verdicts (image-first; media support follows provider maturity).
- Firefox/Safari ports.
- Building any detection/classification in-house — TrueOrigin aggregates; it does not compete with detection labs.

---

## 7. Name & Assets

- **Name:** TrueOrigin (one word, capital T, capital O).
- Diligence done (July 2026): Chrome Web Store clear; CIPO virtually clear; USPTO hits defunct; nearest name-neighbor is a lab-grown diamond brand (unrelated class). Nearest category-neighbor is a small Vietnamese product-authentication app — low practical risk, noted for awareness.
- **Action:** register `trueorigin.app` (and `.ca`) promptly.

### Repo & licensing
- **Public repo** under the GitHub org `trueorigin-app` (bare name taken; avoid `-labs` suffix — existing "True Origin Labs" collision).
- **License: Apache 2.0** (patent grant; no trademark grant — forks can't use the TrueOrigin name). `LICENSE` + `NOTICE` at repo root.
- **Open-core boundary:** this repo contains the extension only. All proprietary value — classifier orchestration, prompt templates, community-signal logic, billing — lives in a separate **private** server repo from birth. The extension's paid-tier code is only ever a thin client: send image reference to `api.trueorigin.app`, receive a `SignalResult`. The provider interface (§3) is the enforcement mechanism — a paid provider is just a provider whose `analyze()` calls the API.
- Openness is a trust asset: "audit the free tier yourself" is part of the privacy story (§8 constraint 3, Phase 3 write-up).

---

## 8. For Coding Agents

This plan is standing context, not a one-shot spec. Work in scoped tasks; keep diffs reviewable.

### Hard constraints (never reinterpret, never soften)
1. The verdict taxonomy in §2, including all four non-negotiable rules. In particular: absence of signals maps to **Unknown** — there is no "Not AI" verdict anywhere in code, copy, or UI. Do not add one, even as an internal enum value.
2. Use the **current c2pa-js monorepo** packages (`@contentauth/c2pa-web` and its dependencies). Never install or import the deprecated `c2pa` npm package / `c2pa-js-legacy`.
3. Free-tier privacy: **media bytes and page URLs never leave the machine.** Trust-infrastructure requests (trust list fetches, revocation checks, CAWG identity validation) are permitted and expected — do **not** disable trust verification to satisfy this constraint. Document each such request type in DECISIONS.md; prefer cached/global fetches over per-content lookups where the SDK allows. No telemetry or analytics calls without explicit instruction. During the build, verify actual network behavior in the network panel while validating a test image, and record findings — this feeds the Phase 3 privacy write-up.
4. Adding a signal provider must require zero changes outside the providers layer. If a task seems to require breaking this, stop and ask.
5. PRODUCT.md belongs to Impeccable. Do not create or edit it by hand.
6. **This repo is public (Apache 2.0).** Never add proprietary paid-tier logic here — no classifier orchestration, prompt templates, API keys, or billing code, even as stubs or TODOs. Paid providers are thin API clients only (see §7 open-core boundary). Secrets never enter the repo in any form.

### Agent may decide freely (record choices in DECISIONS.md)
- Bundler/toolchain, test framework, directory layout, TS config, lint/format setup.
- Internal naming, message-passing shape between content script and service worker, caching implementation.
- Badge DOM/overlay technique — subject to: must not break host-page layout, must be removable.

### Ask before deciding
- Anything that adds a permission to the manifest.
- Any new runtime dependency beyond the C2PA SDK and dev tooling.
- Any change to the `SignalProvider` / `SignalResult` interface shape (§3) — proposing improvements is welcome; silently drifting is not.
- Anything that touches how verdicts are worded to users (brand territory, Phase 3).

### Task order for the initial build
1. Scaffold repo: MV3 manifest (minimal permissions), TypeScript, chosen bundler, test runner. Create DECISIONS.md, LICENSE (Apache 2.0), and NOTICE.
2. Implement `SignalProvider` interface, aggregator, verdict mapper, with a **mock provider** and unit tests — including the test that a second mock provider plugs in with zero outside changes (§6 Phase 1 exit criterion).
3. Implement the real C2PA provider (`@contentauth/c2pa-web`, WASM in service worker). **WASM loading: bundle the `.wasm` binary inside the extension package and load it via `chrome.runtime.getURL()`** — do not use the README's CDN-fetch default (runtime network dependency) or the `/inline` base64 variant (bundle bloat, no compileStreaming) unless the bundled approach proves unworkable in the MV3 worker, in which case fall back to `/inline` and record why in DECISIONS.md.
4. Content script: single-image validation on a test page → one badge. **Checkpoint: human review before proceeding.**
5. Phase 2 items in §6, one task per session, in this order:
   1. Broad host access — opens with the §8 ask covering both `content_scripts` matches and `host_permissions`, with the optional-host-permissions alternative explicitly evaluated (owner directive, task 4) — then viewport lazy scanning and scan scheduling.
   2. Verdict caching per URL/content-hash (also collapses the render+analyze double-fetch observed at the task-4 checkpoint).
   3. Popup: verdict + explanation, progressive disclosure. The first `/impeccable init` pass (Phase 3 timing note) runs before this task so brand context is standing input.
   4. Google Lens right-click (needs a `contextMenus` permission ask).
   5. Byte-acquisition edge cases (CORS fallbacks) — last, informed by daily-driver usage.

   During the daily-driver soak (§6 cadence note): acquire a real capture-signed photo from a trust-listed device (Leica/Sony/Pixel or a published Content Credentials sample) so "Human — verified" gets an end-to-end fixture like `ai_declared.png` — that verdict cannot be exercised with self-signed material by design.
