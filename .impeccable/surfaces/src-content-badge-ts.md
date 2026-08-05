---
version: 1
slug: "src-content-badge-ts"
primary_target: "src/content/badge.ts"
related_targets: ["src/content/popover.ts","src/content/labels.ts","src/content/index.ts"]
---

# Surface: in-page overlay (badge + popover)

## Scope and mode

The content-script overlay TrueOrigin injects on arbitrary third-party pages:
the per-image verdict badge and its anchored popover. **Operate** — a glance
mid-scroll, occasionally a tap for detail. The host page's content always
outranks our chrome.

## Audience, job, task

Non-technical people mid-scroll; the job is "is this AI or not?" answered in
under a second, over other people's content. Popover on badge click for the
explanation and "How do we know?" progressive disclosure.

## Chosen direction (2026-08-05, seed key af6230f8, owner-selected)

**Evidence Ring** — activity-ring / watch-complication grammar, contemporary,
no costume, born at badge scale. Confidence drawn as geometry: the ring closes
only when the evidence does.

- Badge: small dark-glass chip holding a rounded-cap ring + center glyph.
  Closed ring = cryptographic verdicts (AI — declared, Human — verified);
  visibly-open ring = AI — likely (probabilistic); faint barely-started arc =
  Unknown. While checks run, the ring traces (indeterminate).
- Ring fill renders **discrete honest bands only** — never continuous
  percentages; partial fill must not fake quantitative precision.
- Popover: same dark-glass material; verdict line, one honest sentence,
  "How do we know?" expands to per-signal detail. Each signal provider is its
  own ring/arc — aggregation is literally the geometry; future providers add
  rings with zero grammar changes.
- Never color alone (AA): center glyph carries the verdict class; contrast
  self-grounded against arbitrary imagery via the chip, both themes.
- Material: dark translucent glass chip, self-grounded like a complication on
  any watch face. Faces: `ui-rounded`-first system stack — zero web fonts on
  host pages. Motion: sweep-on draw, settle on verdict; reduced-motion safe.
- Memorable moment: the ring sweeping shut as a verdict lands — and staying
  honestly open when it can't.

## Behavior commitments (owner, 2026-08-05)

- Unknown badges render on intent only (hover/interaction); strong verdicts
  assert unprompted.
- Personality lives in the badge itself (geometry, motion), not only the
  popover.

## Constraints

- Verdict taxonomy §2 locked; wording is brand work, rules are not.
- Must not break host-page layout; removable; WCAG 2.2 AA floor.
- No fabricated precision, no alarmist devices, no enterprise density, no
  crypto-trust gloss.

## Unresolved

- Exact ring hues per verdict class and glyph set (build decides, AA-checked).
- Popover light-theme variant (world commits to dark glass; verify legibility
  over dark host pages at build).
- Badge stacking over page UI (Phase 3 docket: cover heuristic vs page-DOM
  sibling injection — decided during rebuild).
