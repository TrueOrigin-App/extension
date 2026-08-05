---
name: TrueOrigin
description: Dark-glass Evidence Ring overlay — confidence drawn as geometry over anyone's page.
colors:
  chip-glass: "rgba(15, 16, 20, 0.92)"
  chip-glass-hover: "rgba(30, 32, 40, 0.88)"
  chip-glass-active: "rgba(10, 10, 14, 0.9)"
  panel-glass: "rgba(17, 18, 23, 0.92)"
  declared-violet: "#b48bff"
  likely-amber: "#ffb340"
  verified-teal: "#3ad0ae"
  unknown-gray: "#aab3bd"
  notice-sand: "#eec98f"
  glass-white: "#f5f6f7"
  dim-white: "#c9ced6"
  track-frost: "rgba(245, 246, 247, 0.16)"
typography:
  headline:
    fontFamily: "ui-rounded, -apple-system, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 700
    lineHeight: 1.5
  body:
    fontFamily: "ui-rounded, -apple-system, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "ui-rounded, -apple-system, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "0.01em"
  footnote:
    fontFamily: "ui-rounded, -apple-system, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  pill: "999px"
  panel: "14px"
spacing:
  hairpad: "2px"
  anchor-gap: "6px"
  inset: "8px"
  group: "10px"
  panel-pad: "14px"
components:
  badge-chip:
    backgroundColor: "{colors.chip-glass}"
    textColor: "{colors.glass-white}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "{spacing.hairpad}"
    height: "28px"
  badge-chip-hover:
    backgroundColor: "{colors.chip-glass-hover}"
  badge-chip-active:
    backgroundColor: "{colors.chip-glass-active}"
  popover:
    backgroundColor: "{colors.panel-glass}"
    textColor: "{colors.glass-white}"
    typography: "{typography.body}"
    rounded: "{rounded.panel}"
    padding: "{spacing.panel-pad}"
    width: "min(300px, calc(100vw - 24px))"
  ring-chip:
    size: "24px"
  ring-headline:
    size: "34px"
  ring-signal:
    size: "16px"
---

# Design System: TrueOrigin

## Overview

**Creative North Star: "The Evidence Ring"**

TrueOrigin's overlay lives on other people's pages, so it dresses like a
complication on a watch face: a small dark-glass chip that grounds itself
against any imagery and never asks the host page for help. Its whole
personality is one idea drawn as geometry — the ring closes only when the
evidence does. Cryptographic verdicts close the circle; probabilistic
verdicts leave the gap plainly visible; Unknown is an arc that has barely
begun. Confidence is shape, not rhetoric.

The register is calm, contemporary, and quiet by default. The everyday face
of the product is Unknown, and the system is designed for that reality:
Unknown and in-flight states appear only when the reader shows intent, while
strong verdicts assert themselves unprompted. Nothing escalates beyond the
evidence — the palette contains no red, no shields, no checkmark theater.
The build rejects (as binding anti-references) alarmist fake-detector UX,
enterprise dashboard density, and crypto-trust aesthetics; the anonymous
gray trust-pill is a named failure mode.

Chosen 2026-08-05 through the seeded direction flow (seed af6230f8,
owner-selected); the direction contract ships inside the built overlay as
the shadow root's first node (`DIRECTION_CONTRACT` in
`src/content/badge.ts`).

**Key Characteristics:**

- Activity-ring / watch-complication grammar, born at 28px badge scale
- Dark translucent glass, self-grounded over arbitrary host imagery
- One functional hue per verdict class; state never carried by color alone
- Discrete honest ring bands — geometry never fakes precision
- System type only (`ui-rounded` first); zero web fonts touch host pages.
  On Chrome, the shipping target, that means the plain system face — an
  owner-committed decision (2026-08-05), not a caveat; roundness is
  carried by geometry, and Safari resolves `ui-rounded` for free
- One authored motion moment: the arc sweeping to its honest band
- Guest posture: the host page's content always outranks our chrome

## Colors

A neutral dark-glass ground carrying exactly one functional hue per verdict
class; every hue is redundant with a band and a glyph.

### Primary

- **Declared Violet** (`{colors.declared-violet}`): the *AI — declared*
  verdict hue — a soft violet for the closed ring and spark glyph. Signed,
  certain, and still calm.
- **Likely Amber** (`{colors.likely-amber}`): the *AI — likely* verdict
  hue — warm amber, deliberately not red, on the visibly-open ring. It reads
  as "probably", never as alarm.
- **Verified Teal** (`{colors.verified-teal}`): the *Human — verified*
  verdict hue — a mint-leaning teal on the closed ring with the lens glyph.
- **Unknown Gray** (`{colors.unknown-gray}`): the *Unknown* and *checking*
  hue — a cool gray that keeps the honest default visually unassertive. The
  same value doubles as the muted text tone (privacy line, fact labels).

### Neutral

- **Chip Glass** (`{colors.chip-glass}`): the badge chip's dark translucent
  ground. At rest it grounds itself on alpha alone — no resting backdrop
  blur (2026-08-05 perf decision: a live blur readback per chip per
  scrolled frame drops frames on image-heavy pages); the glass moment
  arrives up close, on hover/focus/open. Hover lightens to
  `{colors.chip-glass-hover}`; press settles to
  `{colors.chip-glass-active}`.
- **Panel Glass** (`{colors.panel-glass}`): the popover's slightly denser
  glass, same material family.
- **Glass White** (`{colors.glass-white}`): primary text on glass, and the
  focus-outline color.
- **Dim White** (`{colors.dim-white}`): secondary text — explanations and
  evidence summaries.
- **Track Frost** (`{colors.track-frost}`): the ring's unfilled track and
  the evidence divider hairline — the same value, one quiet frost.
- **Notice Sand** (`{colors.notice-sand}`): the only status tint outside the
  verdict hues — degraded-check notices and provider-failure lines. Muted
  sand, not warning red.

### Named Rules

**The One Hue Per Verdict Rule.** Each of the four locked verdicts owns
exactly one hue, assigned in exactly one place: the stylesheet keys `--hue`
on the ring's `data-ring` attribute. Components never hard-code a verdict
color; glyph fills, glyph strokes, and arcs all inherit `var(--hue)`.

**The Never-Color-Alone Rule.** Hue is the third encoding, never the first.
Ring band and center glyph carry the verdict class color-independently
(WCAG 1.4.1); a grayscale screenshot of any state must still read correctly.

**The No-Alarm Rule.** There is no red in this system. The strongest status
color is Likely Amber; even failure lines render in Notice Sand. Calm over
alarm is a product principle, enforced chromatically.

## Typography

**Display Font:** none — this system has no display scale by design
**Body Font:** `ui-rounded` (with `-apple-system, system-ui, sans-serif` fallbacks)
**Label/Mono Font:** same stack, weight 600

**Character:** One rounded-first system stack for everything, at
complication sizes. Friendly geometry without a licensed face — and,
deliberately, zero web-font loads into host pages (a privacy and
guest-posture commitment, not a shortcut).

**The Chrome face is the committed voice (owner decision, 2026-08-05).**
`ui-rounded` resolves only in Safari; no Chromium version supports it, so
in Chrome — the extension's only shipping target — every surface renders
the plain system face (SF/Segoe/Roboto), and that face is what this
system commits to, not a degraded fallback. Bundling a rounded web font
was considered and rejected: Chrome ignores `@font-face` declared inside
shadow roots (probe-verified 2026-08-05 against a document-level
control), so any bundled face would have to be registered in each host
page's own document — observable by the page, ~40–80KB on every page
visited, and a breach of the zero-web-fonts and single-footprint
commitments above. The rounded personality lives in geometry instead:
the pill, the rings, the round caps, the drawn glyphs. `ui-rounded`
stays first in the stack because unknown family names cost nothing and
Safari support arrives for free if the surface ever runs there.

### Hierarchy

- **Headline** (700, 15px, 1.5): the verdict name in the popover's headline
  row, beside its 34px ring.
- **Body** (400, 13px, 1.5): popover prose — the one honest explanation
  sentence, evidence summaries, notices.
- **Label** (600, 12px, 1, 0.01em): the badge pill's verdict word, collapsed
  until hover/focus grows the pill around it. The disclosure toggle uses the
  same 600 weight at body size (13px/1.5).
- **Footnote** (400, 11px, 1.5): the privacy line only, in Unknown Gray.

### Named Rules

**The Complication Scale Rule.** The type ramp spans 11–15px, period. There
is no hero size; the geometry (34px headline ring vs 24px chip ring vs 16px
signal ring) carries the hierarchy that display type would in another world.

## Layout

The overlay owns no layout on the page — every badge lives inside a single
zero-size, `pointer-events: none` host element appended to `<html>`, with a
closed shadow root isolating styles in both directions; removing that one
host removes everything. Badges position absolutely in document coordinates
and scroll with the page.

- **Badge anchor:** the image's top-left corner, inset 8px on both axes.
- **Popover placement:** 8px in from the image's left edge, 6px below the
  badge; clamped inside the viewport with an 8px margin; flips above the
  badge when below is short and above fits. When neither fits, below wins
  and the panel scrolls internally. The side is decided at first placement
  and held for the panel's open lifetime (`data-side`) — re-deciding per
  scroll tick would teleport an open panel across its badge mid-read.
- **Popover envelope:** width `min(300px, calc(100vw - 24px))`, max-height
  `min(340px, 70vh)`. The panel is a flex column in which only the evidence
  region scrolls — verdict, disclosure toggle, and privacy line stay visible
  at every height.
- **Spacing rhythm:** 2px chip padding; 6px badge-to-popover gap; 8px
  anchor insets, viewport margins, and paragraph stacks; 10px group gaps
  (headline row, evidence grid, section margins); 14px panel padding.
- **Internal grids:** signal rows are `16px 1fr` two-column grids (ring
  spans both rows); fact lists are `max-content 1fr` definition grids with
  `2px 10px` gaps and `overflow-wrap: anywhere` on values.

**The Reset Root Rule.** Both top-level overlay elements (`.badge`,
`.popover`) open with `all: initial; direction: ltr` and re-declare
everything they need — page inheritance (letter-spacing, text-transform,
RTL direction) must never leak into the overlay, and `all` does not reset
`direction` by spec.

## Elevation & Depth

Depth is material, not drama: a two-layer glass system rendered with
translucency, backdrop blur, a hairline inner edge, and one soft ambient
shadow each. The chip rests on translucency alone (shadow
`0 1px 4px rgba(0, 0, 0, 0.35)`) and turns to true glass up close —
`blur(10px) saturate(140%)` on hover/focus/open only (2026-08-05 perf
decision: resting blur on every chip drops frames on image-heavy pages);
the popover is denser glass one step up, always live
(`blur(16px) saturate(140%)`, shadow
`0 8px 28px rgba(0, 0, 0, 0.4)`). Both carry a 0.5px white inset hairline
(0.22 alpha on the chip, 0.18 on the panel) that catches the surface edge
the way a complication bezel does.

### Shadow Vocabulary

- **Chip ambient** (`box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35), inset 0 0 0
  0.5px rgba(255, 255, 255, 0.22)`): the badge at rest.
- **Panel ambient** (`box-shadow: 0 8px 28px rgba(0, 0, 0, 0.4), inset 0 0
  0 0.5px rgba(255, 255, 255, 0.18)`): the popover.
- **Focus halo** (`outline: 2px solid #f5f6f7; outline-offset: 1px;
  box-shadow: 0 0 0 5px rgba(15, 16, 20, 0.9), …`): a light outline paired
  with a dark halo so keyboard focus reads over arbitrary imagery, light or
  dark.

### Named Rules

**The Self-Grounded Rule.** The overlay renders over unpredictable host
imagery, so every surface carries its own contrast: dark glass ground,
light text, hairline edge, dual-layer focus ring. Verdict hues hold ≥3:1
non-text contrast against the chip's worst case. Never assume the host
page's background, and never ship a host-theme-dependent variant.

## Shapes

Everything is round: the chip is a full pill (999px radius), the panel a
14px-radius card, and every drawn line — ring arcs, glyph strokes, the
disclosure chevron — uses round caps. The signature silhouette is the
rounded-cap arc over a faint circular track, always starting at 12 o'clock.

Iconography is authored, not borrowed: three center glyphs drawn as SVG in
`src/content/ring.ts` on a 24-box with stroke-width 2 and round caps —
**spark** (filled four-point star, both AI classes), **lens** (stroked iris
+ filled pupil, signed capture), **query** (stroked hook + filled dot,
Unknown). The popover's disclosure chevron is likewise a stroked, rotating
CSS corner — no glyph fonts, no emoji, no icon packages.

**The Drawn Line Rule.** Any mark in this system is either type in the
system stack or a line someone drew: stroke-width 2–2.4, round caps, sized
to the 24 viewBox. New glyphs join that stroke system or they don't ship.

## Components

All user-facing strings quoted below ("How do we know?", the verdict labels
and explanations, the privacy line) are the finalized brand copy in
`src/content/labels.ts` (owner-approved 2026-08-05: **Made with AI /
Likely AI / Verified photo / Unknown**). Wording edits are an §8 owner
ask — never changed casually.

### Evidence Ring (signature)

One module (`src/content/ring.ts`) builds every ring — badge chip, popover
headline, per-signal miniature — so the geometry stays a single system.

- **Geometry:** 24-unit viewBox, radius-10 circle, stroke-width 2.4,
  `pathLength="100"` so dash geometry speaks in band percentages, rotated
  −90° to start at 12 o'clock, round caps, over a Track Frost track.
- **Honest bands (the load-bearing rule):** `closed` = 100 (cryptographic:
  *AI — declared*, *Human — verified*), `open` = 85 (probabilistic:
  *AI — likely*, the gap plainly visible), `trace` = 15 (*Unknown*, barely
  begun). `checking` = 25 is presentation, not evidence — it spins
  (1.1s linear) and never claims a fill.
- **Hue keying:** the `data-ring` attribute on the SVG selects `--hue` in
  the stylesheet; arc, glyph fill, and glyph stroke all use it.
- **Sizes:** 24px in the chip, 34px in the popover headline, 16px per
  signal row.
- **Accessibility:** the SVG is `aria-hidden`; the accessible name lives on
  the containing control or text.
- **Motion:** the one authored moment — `trueorigin-sweep`, 0.64s
  `cubic-bezier(0.22, 1, 0.36, 1)`, dashoffset travel set inline to equal
  the band, so every state draws on over the same beat and settles at its
  honest fill. Plays on first paint, verdict change, intent reveal, and
  popover open; never on positional re-renders; disabled under
  `prefers-reduced-motion` (static states stay distinct: checking's
  glyph-less 25-arc vs Unknown's 15-trace + query glyph).

### Badge (chip → pill)

A real `<button>` (28px tall, 2px padding, full pill) holding the 24px ring;
the verdict word sits collapsed inside and the pill grows around it on
hover/focus/open (`max-width` 0 → 180px over 0.28s
`cubic-bezier(0.22, 1, 0.36, 1)`, margins `0 9px 0 6px`). The chip is the
glance; the word is the confirmation.

- **States:** hover lightens the glass; press settles it
  (`scale(0.96)`, 0.12s) — the chip gives under the finger, in the
  complication grammar; `:focus-visible` shows the dual-layer focus halo.
- **Presence (intent gating, owner decision 2026-08-05):** strong verdicts
  assert unprompted. Unknown badges mount with `data-presence="hidden"`
  (opacity 0, no pointer events, still in the tab order) and reveal on
  reader intent — pointer entering or moving on the image, or focus reaching
  the badge — then fade after a 200ms grace unless hovered, focused, or
  holding an open popover. The sweep plays at reveal.
- **Accessibility:** the verdict word is both visible label and accessible
  name; the image's alt text rides as `aria-description`, never as name;
  `aria-haspopup="dialog"` / `aria-expanded` reflect the popover.

### Pending chip (status)

The same chip anatomy while checks run, but a status, not a control:
`role="status"`, glyph-less neutral `checking` ring spinning at 1.1s linear,
`pointer-events: none`. Obeys the same intent gate as Unknown — an
unprompted pre-verdict flash on every image would betray the product's
restraint.

### Popover (glass card)

A `role="dialog"` panel in Panel Glass, opened by badge click, one at a
time, entering with a 0.22s settle (`trueorigin-pop`: fade + 4px rise +
scale from 0.98). Fixed content order, top to bottom:

1. **Headline row:** the verdict's 34px ring re-sweeping beside its name.
2. **Explanation:** one honest sentence in Dim White.
3. **Degraded notice** (only when providers failed), in Notice Sand.
4. **Disclosure toggle** — "How do we know?".
5. **Evidence region** (collapsed by default): the only part that scrolls,
   with an always-visible 8px scrollbar (content-box thumb at
   `rgba(245, 246, 247, 0.38)` — clears 3:1 against the panel's
   worst-case backdrop) so truncation is never invisible; separated
   by a Track Frost hairline; per-signal rows and failure lines inside.
   When the whole panel scrolls instead (the short-viewport fallback),
   its scrollbar track is inset by the 14px corner radius so the thumb
   travels only the straight edge — it never rides the corner arcs.
6. **Privacy line** (Footnote, Unknown Gray): the trust claim stays visible
   at every panel height — it never scrolls away.
- **Dismissal:** light dismiss on outside pointerdown (scrollbar drags
  exempt), Escape scoped to the overlay, close on focus entering an iframe;
  focus returns to the badge, without scrolling except on deliberate
  Escape.

### Disclosure

A borderless text button (600, 13px, Glass White, ≥24px hit height) whose
chevron is a drawn 7px stroked corner rotating −45°→45° (0.2s) between
closed and open; `aria-expanded`/`aria-controls` wired to the evidence
region.

### Signal row

One provider's finding as its own 16px ring plus summary — aggregation
literally drawn as geometry. A future provider arrives as one more ring
with zero new grammar. Facts render as a `max-content 1fr` definition grid
with Unknown Gray terms.

## Do's and Don'ts

### Do:

- **Do** render ring fill as discrete honest bands only — closed 100 /
  open 85 / trace 15, plus the non-evidence checking 25.
- **Do** pair every hue with a band and a glyph; verify each state reads in
  grayscale.
- **Do** key all state color through `data-ring` → `--hue` in one
  stylesheet block; never hard-code a verdict hue in a component.
- **Do** keep Unknown and checking behind the intent gate (reveal on
  hover/focus, 200ms hide grace) and let strong verdicts assert unprompted.
- **Do** open every top-level overlay element with
  `all: initial; direction: ltr` and re-declare what it needs.
- **Do** keep the privacy line outside any scroll region — trust claims
  stay visible at every panel height.
- **Do** use `cubic-bezier(0.22, 1, 0.36, 1)` for authored motion and honor
  `prefers-reduced-motion` with distinct static states.
- **Do** draw new glyphs in the ring's stroke system (24-box, stroke 2,
  round caps) with the spark/lens/query set as reference.

### Don't:

- **Don't** map confidence to continuous arc fill, percentages, meters, or
  scores — partial fill must never fake precision the evidence lacks
  (plan.md §2; the taxonomy's four verdicts are locked).
- **Don't** introduce red, badges of alarm, shields, or checkmark
  iconography — the anti-references (alarmist detector UX, enterprise
  density, crypto-trust gloss) are binding.
- **Don't** load web fonts, icon fonts, or any remote asset into host
  pages; type is the `ui-rounded`-first system stack, icons are authored
  SVG.
- **Don't** ship host-theme-dependent styling — the dark-glass surfaces are
  self-grounded in both themes; there is deliberately no light panel
  variant.
- **Don't** let overlay chrome take pointer events beyond its own pixels,
  or restructure the host page's DOM; the single zero-size host must remain
  the only footprint and removing it must remove everything.
- **Don't** grow the badge chip past its 28px complication scale or add a
  display type size; hierarchy comes from ring size, not type scale.
