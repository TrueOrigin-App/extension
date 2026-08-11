// Badge overlay rendering (plan.md §4). Free-choice technique recorded in
// DECISIONS.md (task 4; positioning lifecycle extended in task 5.1;
// interactive popover added in task 5.3), subject to two constraints from
// §8: must not break host-page layout, must be removable.
//
// All badges live inside one absolutely-positioned zero-size host element
// appended to <html> — the host page's own DOM is never restructured — and
// a shadow root isolates badge styles from page CSS in both directions.
// Removing the single host removes every badge.
//
// Since task 5.3 a badge is a real <button>: clicking it opens the popover
// (verdict, explanation, "How do we know?" disclosure — content built in
// popover.ts). The badge's own pixels therefore capture clicks that would
// previously have fallen through to the page; everything else stays
// pointer-events: none.

import type { WireVerdict } from "../messaging/protocol";
import { buildPopoverContent } from "./popover";
import { CHECKING_LABEL, POPOVER_STRINGS, VERDICT_LABELS } from "./labels";
import { buildRing, ringStateForChecking, ringStateForVerdict } from "./ring";

const HOST_ID = "trueorigin-badge-host";

// Direction contract (Impeccable new-work §5) — injected as the shadow
// root's first node so it ships in the built overlay and survives into
// every page the extension badges.
const DIRECTION_CONTRACT = `
TrueOrigin overlay — direction contract (seed af6230f8)
THESIS: Confidence drawn as geometry — the ring closes only when the
evidence does; refuses the trust-tool shield/checkmark and the anonymous
gray pill.
OWN-WORLD: Dark-glass chip and panel; rounded-cap evidence ring, one hue
per verdict class; authored spark/lens/query glyphs; ui-rounded system
type; sweep-on motion.
STORY: Mid-scroll, a glance says how much is actually known; a click opens
the note; "How do we know?" shows each signal as its own ring. Unknown
stays honest — an open arc, shown on intent.
FIRST VIEWPORT: 28px chip at the image's top-left corner, ring + glyph;
hover grows the labeled pill; the popover is a glass card — headline ring,
verdict, one sentence, disclosure, privacy line.
FORM: Evidence Ring — activity-ring/complication grammar; grounded
candidate 6, round 4; seed af6230f8.
FINISH: unreviewed and undocumented is unfinished; this build ends with
the finish review, the verdict, and DESIGN.md
`;

// Discrete interaction events from inside the overlay retarget to the host
// and would otherwise bubble on into page document/window handlers —
// outside-click closers, hotkey handlers — making the page react to
// interactions with our UI (or dismiss its own). Stopped at the host
// boundary instead, in the bubble phase, so the overlay's own inner
// listeners have already run. Pointer/mouse *move* streams are left
// flowing: pages track those continuously, and a badge-sized dead zone
// would be its own breakage. Page listeners registered capture-phase on
// window fire before anything here can run — out of reach by design.
const CONTAINED_EVENT_TYPES = [
  "pointerdown",
  "pointerup",
  "pointercancel",
  "mousedown",
  "mouseup",
  "click",
  "auxclick",
  "dblclick",
  "contextmenu",
  "touchstart",
  "touchend",
  "touchcancel",
  "keydown",
  "keyup",
  "keypress",
  "wheel",
] as const;

// Evidence Ring presentation (Phase 3 visual world — DECISIONS.md,
// 2026-08-05; surface brief at .impeccable/surfaces/src-content-badge-ts.md).
// Dark-glass chip and panel, one functional hue per verdict class (never
// color alone: band + glyph carry the state), ui-rounded-first system type
// so no web font ever loads into a host page (ui-rounded is Safari-only —
// on Chrome the plain system face is the committed voice, owner decision
// in DESIGN.md and DECISIONS.md, 2026-08-05). Verdict hues hold ≥3:1
// non-text contrast against the chip's worst-case (white-page) backdrop;
// the focus ring pairs a light outline with a dark halo so it reads over
// arbitrary imagery.
const BADGE_STYLE = `
  /* The shadow boundary stops page selectors but not inheritance: page
     rules matching the host div (html, div, *) compute on it and inherit
     into the tree — letter-spacing, text-transform, and the rest.
     "all: initial" on both roots cuts that off; every property the
     overlay needs is re-declared after it, and descendants inherit from
     these reset roots. "all" excludes direction/unicode-bidi by spec
     (verified live: an RTL page re-ordered the popover text through the
     reset), so direction is reset explicitly — the overlay's strings are
     English until localization work. */
  .badge {
    all: initial;
    direction: ltr;
    position: absolute;
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    height: 28px;
    margin: 0;
    padding: 2px;
    border: 0;
    border-radius: 999px;
    background: rgba(15, 16, 20, 0.92);
    color: #f5f6f7;
    font:
      600 12px/1 ui-rounded,
      -apple-system, system-ui, sans-serif;
    white-space: nowrap;
    box-shadow:
      0 1px 4px rgba(0, 0, 0, 0.35),
      inset 0 0 0 0.5px rgba(255, 255, 255, 0.22);
    pointer-events: auto;
    cursor: pointer;
    user-select: none;
    transition:
      opacity 0.25s ease,
      background-color 0.2s ease,
      transform 0.12s ease;
  }
  /* No resting backdrop-filter on chips: strong-verdict badges are
     always visible, and a live blur readback per chip per scrolled
     frame drops frames on image-heavy pages. The glass moment happens
     up close — hover, focus, open panel — one badge at a time; the
     resting chip grounds itself with higher alpha instead. */
  .badge:hover,
  .badge:focus-visible,
  .badge[aria-expanded="true"] {
    backdrop-filter: blur(10px) saturate(140%);
    -webkit-backdrop-filter: blur(10px) saturate(140%);
  }
  .badge:hover {
    background: rgba(30, 32, 40, 0.88);
  }
  .badge:focus-visible {
    outline: 2px solid #f5f6f7;
    outline-offset: 1px;
    box-shadow:
      0 0 0 5px rgba(15, 16, 20, 0.9),
      inset 0 0 0 0.5px rgba(255, 255, 255, 0.22);
  }
  /* Press feedback in the complication grammar: the chip settles under
     the finger. */
  .badge:active {
    background: rgba(10, 10, 14, 0.9);
    transform: scale(0.96);
  }
  /* In-flight indicator (reviewer fix 2): the same chip anatomy, but a
     status rather than a control — glyph-less neutral arc tracing around
     while providers run. Revealed on intent only, like Unknown. */
  .badge.pending {
    pointer-events: none;
    cursor: default;
  }
  .badge.pending .ring {
    animation: trueorigin-spin 1.1s linear infinite;
  }
  @keyframes trueorigin-spin {
    to {
      transform: rotate(360deg);
    }
  }
  /* Intent-gated presence (owner decision 2026-08-05): Unknown badges sit
     hidden until the reader shows interest in the image; strong verdicts
     never carry this state. Hidden ≠ removed — the button stays in the
     tab order and reveals itself on focus. */
  .badge[data-presence="hidden"] {
    opacity: 0;
    pointer-events: none;
  }
  .badge .ring {
    width: 24px;
    height: 24px;
    display: block;
    flex: none;
  }
  /* The verdict label lives collapsed inside the chip and the pill grows
     around it on hover/focus — the chip is the glance, the word is the
     confirmation. */
  .badge .label {
    display: inline-block;
    max-width: 0;
    margin: 0;
    opacity: 0;
    overflow: hidden;
    letter-spacing: 0.01em;
    transition:
      max-width 0.28s cubic-bezier(0.22, 1, 0.36, 1),
      margin 0.28s cubic-bezier(0.22, 1, 0.36, 1),
      opacity 0.18s ease;
  }
  .badge:hover .label,
  .badge:focus-visible .label,
  .badge[aria-expanded="true"] .label {
    max-width: 180px;
    margin: 0 9px 0 6px;
    opacity: 1;
  }
  /* Ring geometry is built in ring.ts (pathLength 100, honest bands);
     hues key on data-ring so state color lives in exactly one place. */
  .ring-track {
    fill: none;
    stroke: rgba(245, 246, 247, 0.16);
    stroke-width: 2.4;
  }
  .ring-arc {
    fill: none;
    stroke: var(--hue);
    stroke-width: 2.4;
    stroke-linecap: round;
  }
  .glyph-fill {
    fill: var(--hue);
    stroke: none;
  }
  .glyph-stroke {
    fill: none;
    stroke: var(--hue);
    stroke-width: 2;
    stroke-linecap: round;
  }
  [data-ring="ai-declared"] {
    --hue: #b48bff;
  }
  [data-ring="ai-likely"] {
    --hue: #ffb340;
  }
  [data-ring="human-verified"] {
    --hue: #3ad0ae;
  }
  [data-ring="unknown"] {
    --hue: #aab3bd;
  }
  [data-ring="checking"] {
    --hue: #aab3bd;
  }
  /* The one authored motion moment: the arc sweeps to its honest band and
     settles. Travel distance equals the band (set inline by ring.ts), so
     every state draws on over the same beat. */
  @keyframes trueorigin-sweep {
    from {
      stroke-dashoffset: var(--sweep);
    }
    to {
      stroke-dashoffset: 0;
    }
  }
  .badge.enter .ring-arc,
  .popover .verdict .ring-arc {
    animation: trueorigin-sweep 0.64s cubic-bezier(0.22, 1, 0.36, 1);
  }
  /* Flex column so the evidence region scrolls first (reviewer fix 1):
     the verdict, disclosure, and the privacy line — the trust claim the
     contract puts on the card — stay visible at every reasonable height,
     and no line ever half-clips at an invisible scroll edge. The panel
     itself stays a scroll container as the fallback layer: when even the
     flex-none stack outgrows the height cap (short viewports, degraded
     notice), the whole panel scrolls — nothing ever paints past the card
     unreachably — and wheel input over any region is consumed here
     instead of chaining to the page under an open dialog. */
  .popover {
    all: initial;
    direction: ltr;
    display: flex;
    flex-direction: column;
    position: absolute;
    z-index: 1;
    box-sizing: border-box;
    width: min(300px, calc(100vw - 24px));
    max-height: min(340px, 70vh);
    padding: 14px;
    border-radius: 14px;
    background: rgba(17, 18, 23, 0.92);
    color: #f5f6f7;
    font:
      400 13px/1.5 ui-rounded,
      -apple-system, system-ui, sans-serif;
    box-shadow:
      0 8px 28px rgba(0, 0, 0, 0.4),
      inset 0 0 0 0.5px rgba(255, 255, 255, 0.18);
    backdrop-filter: blur(16px) saturate(140%);
    -webkit-backdrop-filter: blur(16px) saturate(140%);
    overflow-y: auto;
    overscroll-behavior: contain;
    pointer-events: auto;
    animation: trueorigin-pop 0.22s cubic-bezier(0.22, 1, 0.36, 1);
  }
  @keyframes trueorigin-pop {
    from {
      opacity: 0;
      transform: translateY(-4px) scale(0.98);
    }
  }
  .popover > * {
    flex: none;
  }
  .popover > .evidence {
    flex: 0 1 auto;
    /* A floor, not 0: in the borderline band the flex algorithm would
       squeeze an expanded evidence region into a useless sliver — the
       disclosure would appear to do nothing. Below the floor the whole
       panel scrolls instead (the .popover fallback above). */
    min-height: 64px;
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  /* macOS overlay scrollbars are invisible until scrolled — the cue the
     truncation finding demands must always be visible. Chrome-only
     surface, so the webkit pseudos are the mechanism; setting the
     standard scrollbar-width property would disable them. Thumb alpha
     0.38 clears the 3:1 non-text floor (WCAG 1.4.11) against the
     panel's worst-case (white-page) backdrop — 0.3 measured 2.58:1. */
  .popover::-webkit-scrollbar,
  .popover > .evidence::-webkit-scrollbar {
    width: 8px;
  }
  .popover::-webkit-scrollbar-thumb,
  .popover > .evidence::-webkit-scrollbar-thumb {
    border: 2px solid transparent;
    border-radius: 999px;
    background: rgba(245, 246, 247, 0.38);
    background-clip: content-box;
  }
  .popover::-webkit-scrollbar-track,
  .popover > .evidence::-webkit-scrollbar-track {
    background: transparent;
  }
  /* The panel's own scrollbar (whole-panel fallback) runs the full
     padding-box height, which puts the thumb's extremes inside the
     14px corner arcs — floating past the glass. Insetting the track
     by the corner radius bounds the thumb's travel to the straight
     edge. The evidence scroller needs no inset: it sits 14px inside
     the panel, nowhere near the corners. */
  .popover::-webkit-scrollbar-track {
    margin: 14px 0;
  }
  .verdict {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .verdict .ring {
    width: 34px;
    height: 34px;
    flex: none;
  }
  .headline {
    margin: 0;
    font-size: 15px;
    font-weight: 700;
  }
  .explain {
    margin: 8px 0 0;
    color: #c9ced6;
  }
  .notice {
    margin: 8px 0 0;
    color: #eec98f;
  }
  .disclosure {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    min-height: 24px;
    margin: 10px 0 0;
    padding: 0;
    border: 0;
    background: none;
    color: #f5f6f7;
    font:
      600 13px/1.5 ui-rounded,
      -apple-system, system-ui, sans-serif;
    cursor: pointer;
  }
  /* Drawn chevron (no glyph-font arrows): a stroked corner that rotates
     from "closed" to "open". The corner's visual mass sits ~1.75px off
     the box center toward its point (stroke midlines at 2.5px of the
     3.5px half-box, x sqrt(2)/2), so a counter-translate re-centers the
     glyph on the label's centerline in each rotation; both states keep
     matching translate()+rotate() lists so the toggle interpolates as
     one transform move. */
  .disclosure::before {
    content: "";
    box-sizing: border-box;
    width: 7px;
    height: 7px;
    border-right: 2px solid currentColor;
    border-bottom: 2px solid currentColor;
    transform: translate(-1.75px, 0) rotate(-45deg);
    transition: transform 0.2s ease;
  }
  .disclosure[aria-expanded="true"]::before {
    transform: translate(0, -1.75px) rotate(45deg);
  }
  .disclosure:focus-visible {
    outline: 2px solid #f5f6f7;
    outline-offset: 2px;
  }
  .signal {
    display: grid;
    grid-template-columns: 16px 1fr;
    gap: 4px 8px;
    align-items: start;
  }
  .signal .ring {
    grid-row: 1 / span 2;
    width: 16px;
    height: 16px;
    margin-top: 2px;
  }
  @media (prefers-reduced-motion: reduce) {
    .badge,
    .badge .label {
      transition: none;
    }
    .badge.enter .ring-arc,
    .popover .verdict .ring-arc {
      animation: none;
    }
    /* The static glyph-less 25-arc still reads as "checking" and stays
       distinct from Unknown's 15-trace + query glyph. */
    .badge.pending .ring {
      animation: none;
    }
    .popover {
      animation: none;
    }
    .disclosure::before {
      transition: none;
    }
  }
  .evidence {
    display: grid;
    gap: 10px;
    margin-top: 8px;
    padding-top: 10px;
    border-top: 1px solid rgba(245, 246, 247, 0.16);
  }
  /* display: grid above would defeat the UA's [hidden] rule — without
     this, the disclosure could never visually collapse. */
  .evidence[hidden] {
    display: none;
  }
  .summary {
    margin: 0;
    color: #c9ced6;
  }
  .facts {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 2px 10px;
    margin: 6px 0 0;
  }
  .facts dt {
    color: #aab3bd;
  }
  .facts dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .failure {
    margin: 0;
    color: #eec98f;
    overflow-wrap: anywhere;
  }
  .privacy {
    margin: 10px 0 0;
    font-size: 11px;
    color: #aab3bd;
  }
`;

let shadowRoot: ShadowRoot | null = null;

// Persistent offscreen live region for the pending chip. A live region
// only announces mutations made while it is already in the accessibility
// tree — the chip itself enters the DOM fully formed (aria-label only,
// aria-hidden ring), so it can never speak. This region takes the text
// instead: set on reveal, cleared when the last chip goes.
let statusRegion: HTMLDivElement | null = null;

// One badge per image, so a re-analysis (src swap) replaces rather than
// stacks. Each entry remembers the URL its verdict describes — the
// invalidation key syncBadges checks against the image's live source — and
// the full verdict, which is what the popover renders. Entries are dropped
// by removeBadgeFor/syncBadges when the image goes away or stops
// displaying that URL.
type BadgeEntry = {
  element: HTMLButtonElement;
  url: string;
  verdict: WireVerdict;
  /** The collapsed-until-hover verdict word inside the pill. */
  label: HTMLSpanElement;
  /** The chip's ring SVG; swapped only when the verdict changes. */
  ring: SVGElement;
  /** Present only while the badge is intent-gated (Unknown): tears down
   * the image/badge listeners that reveal and hide it. */
  gate: { controller: AbortController; hideTimer: number | null } | null;
};
const badges = new Map<HTMLImageElement, BadgeEntry>();

// At most one popover is open at a time; opening another closes it. The
// AbortController tears down the light-dismiss listeners.
interface OpenPopover {
  image: HTMLImageElement;
  element: HTMLDivElement;
  dismiss: AbortController;
}
let openPopover: OpenPopover | null = null;

function ensureHost(): ShadowRoot {
  if (shadowRoot?.host.isConnected) return shadowRoot;

  const host = document.createElement("div");
  host.id = HOST_ID;
  // Overlay strings are English regardless of the page's language; without
  // this, screen readers pronounce them with the host page's rules
  // (WCAG 3.1.2). Localization is future work.
  host.setAttribute("lang", "en");
  // Zero-footprint anchor at the document origin: badges inside it are
  // positioned in document coordinates and scroll with the page.
  host.style.cssText =
    "position: absolute; top: 0; left: 0; width: 0; height: 0; " +
    "z-index: 2147483647; pointer-events: none;";
  // The host itself is 0×0 and pointer-events: none, so every contained
  // event here originated on the badge or popover inside the shadow tree.
  for (const type of CONTAINED_EVENT_TYPES) {
    host.addEventListener(type, (event) => event.stopPropagation());
  }

  // Closed: the analysis may have acquired bytes the page itself cannot
  // read (the worker's credentialed CORS-exempt fallback), so the verdict
  // and its provenance details must not be readable by page script via
  // host.shadowRoot. This module keeps the only reference.
  shadowRoot = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = BADGE_STYLE;
  shadowRoot.append(document.createComment(DIRECTION_CONTRACT), style);
  // Visually hidden, never display:none (a none'd live region is not
  // announced). Lives in the shadow root so removeAllBadges takes it too.
  statusRegion = document.createElement("div");
  statusRegion.setAttribute("role", "status");
  statusRegion.style.cssText =
    "position: absolute; width: 1px; height: 1px; overflow: hidden; " +
    "clip-path: inset(50%); white-space: nowrap;";
  shadowRoot.append(statusRegion);
  // If the page tore out the previous host, every live badge is still
  // parented to its detached shadow root — adopt them, or they would keep
  // updating invisibly forever. The open popover rides along, keeping its
  // place right after its badge (tab order).
  for (const { element } of badges.values()) {
    shadowRoot.append(element);
  }
  for (const entry of pending.values()) {
    if (entry.element) shadowRoot.append(entry.element);
  }
  if (openPopover) {
    const entry = badges.get(openPopover.image);
    if (entry) entry.element.after(openPopover.element);
    else closePopover();
  }

  document.documentElement.append(host);
  return shadowRoot;
}

/** A collapsed rect means the image is hidden or not laid out
 * (display:none, an emptied carousel slide). One definition, three
 * enforcement sites: positionAt hides the badge, and syncBadges/renderBadge
 * close an open popover — a badge or panel floating over nothing is a
 * claim about nothing. */
function isCollapsed(rect: DOMRect): boolean {
  return rect.width < 1 || rect.height < 1;
}

function positionAt(
  badge: HTMLElement,
  rect: DOMRect,
  scrollX: number,
  scrollY: number,
): void {
  if (isCollapsed(rect)) {
    badge.style.display = "none";
    return;
  }
  badge.style.display = "";
  badge.style.left = `${rect.left + scrollX + 8}px`;
  badge.style.top = `${rect.top + scrollY + 8}px`;
}

/** Every layout read popover placement needs, gathered by the caller —
 * syncBadges collects these in its read phase so placement stays a pure
 * write and never forces a mid-sync reflow. */
interface PopoverPlacement {
  rect: DOMRect;
  scrollX: number;
  scrollY: number;
  popoverWidth: number;
  popoverHeight: number;
  badgeHeight: number;
  viewportWidth: number;
  viewportHeight: number;
}

/** Write-only popover placement: below the badge, clamped inside the
 * viewport horizontally — and flipped above the badge when the space
 * below is short and above fits (a panel opening entirely below the fold
 * reads as a dead click). When neither side fits, below wins: the panel
 * itself is height-capped and scrolls.
 *
 * The side is decided once, at the panel's first placement, and held for
 * its open lifetime (data-side): re-deciding on every sync tick would
 * teleport an open panel across its badge the moment scrolling crosses
 * the fits-below threshold, yanking the text out from under the reader —
 * scrolling a locked panel toward the fold just scrolls it away, like
 * any page content. */
function placePopover(popover: HTMLDivElement, place: PopoverPlacement): void {
  const {
    rect,
    scrollX,
    scrollY,
    popoverWidth,
    popoverHeight,
    badgeHeight,
    viewportWidth,
    viewportHeight,
  } = place;
  const ideal = rect.left + scrollX + 8;
  const maxLeft = scrollX + viewportWidth - popoverWidth - 8;
  popover.style.left = `${Math.max(scrollX + 8, Math.min(ideal, maxLeft))}px`;
  const belowTop = rect.top + 8 + badgeHeight + 6;
  const aboveTop = rect.top + 8 - 6 - popoverHeight;
  let side = popover.dataset["side"];
  if (side !== "below" && side !== "above") {
    const fitsBelow = belowTop + popoverHeight <= viewportHeight - 8;
    const fitsAbove = aboveTop >= 8;
    side = fitsBelow || !fitsAbove ? "below" : "above";
    popover.dataset["side"] = side;
  }
  const top = side === "below" ? belowTop : aboveTop;
  popover.style.top = `${top + scrollY}px`;
}

/** The viewport box every placement decision measures against. In
 * standards mode that is the root element's client box; in quirks mode
 * the root's client box tracks the *content* (clientHeight of an html
 * element holding 800px of text is ~800, not the frame height), and
 * <body> carries the viewport instead. Doctype-less documents are quirks
 * mode — rare at top level, routine among the srcdoc/document.write ad
 * frames all_frames now injects into, where the content-box reading made
 * every below-the-fold popover open into invisible space (PR #13 review,
 * finding 5). */
function viewportBox(): { width: number; height: number } {
  const root =
    document.compatMode === "BackCompat"
      ? (document.body ?? document.documentElement)
      : document.documentElement;
  return { width: root.clientWidth, height: root.clientHeight };
}

/** Measure-then-place for the open and re-render paths, where the panel
 * was just (re)built and a synchronous measure is unavoidable — cold
 * paths; the per-frame sync path instead reads ahead in syncBadges. */
function measureAndPlacePopover(
  entry: BadgeEntry,
  popover: HTMLDivElement,
  rect: DOMRect,
  scrollX: number,
  scrollY: number,
): void {
  const viewport = viewportBox();
  placePopover(popover, {
    rect,
    scrollX,
    scrollY,
    popoverWidth: popover.offsetWidth,
    popoverHeight: popover.offsetHeight,
    badgeHeight: entry.element.offsetHeight,
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
  });
}

/** The image's alt text, when it has one — the only page-provided handle
 * that can tell "which image is this about?" to a keyboard or screen-reader
 * user, whose badge buttons otherwise all read alike (the overlay host
 * lives at the end of the tab order, far from the images). It rides as the
 * accessible *description*, not part of the name: page-authored alt can be
 * paragraph-length, and a bloated name is what voice-control users must
 * speak to activate the control. */
function syncAltDescription(element: Element, image: HTMLImageElement): void {
  const alt = image.getAttribute("alt")?.trim() ?? "";
  if (alt) element.setAttribute("aria-description", alt);
  else element.removeAttribute("aria-description");
}

function closePopover(refocusBadge = false): void {
  if (!openPopover) return;
  const { image, element, dismiss } = openPopover;
  // If keyboard focus is inside the departing panel, removal would drop it
  // to <body> and the next Tab would restart from the top of the page —
  // hand it back to the badge instead, on every close path. (In Chrome the
  // document-level activeElement is the retargeted host; the shadow root
  // holds the real one.)
  const active = shadowRoot?.activeElement ?? document.activeElement;
  const hadFocus = active !== null && element.contains(active);
  openPopover = null;
  dismiss.abort();
  element.remove();
  const entry = badges.get(image);
  if (entry) {
    entry.element.setAttribute("aria-expanded", "false");
    // Escape (refocusBadge) is deliberate keyboard navigation: plain
    // focus() may scroll the badge into view, keeping the focus indicator
    // visible. Every other close path rescues focus only so it does not
    // drop to <body>, and must not move the page: an outside click after
    // scrolling away used to yank the viewport back to the badge
    // (task-5.5 soak finding).
    if (refocusBadge) entry.element.focus();
    else if (hadFocus) entry.element.focus({ preventScroll: true });
    // An intent-gated (Unknown) badge held its reveal while the panel was
    // open; once closed, it fades unless the reader is still on it.
    if (entry.gate) scheduleIntentHide(image, entry);
  }
}

/** Elements that host a child browsing context: pointer and key events
 * inside one never reach this document, so each is a dismiss/handoff
 * boundary. all_frames runs sibling instances not just in <iframe> but in
 * frameset <frame>, <object>, and <embed> child documents, whose host
 * elements are different interfaces — an instanceof against the iframe
 * interface alone misses them (PR #13 review, finding 10). */
function hostsChildContext(node: unknown): boolean {
  return (
    node instanceof HTMLIFrameElement ||
    node instanceof HTMLFrameElement ||
    node instanceof HTMLObjectElement ||
    node instanceof HTMLEmbedElement
  );
}

/** Width of the edge band treated as an overlay scrollbar. Chrome's
 * overlay thumb is ~15px at its hover width; 17 adds slack. */
const OVERLAY_SCROLLBAR_BAND_PX = 17;

/** True when a pointerdown is a main-scrollbar drag rather than an outside
 * click. Chrome dispatches these as pointerdown targeting the root
 * element; treating them as outside clicks would close the popover on the
 * one scroll method that would otherwise bring it into view.
 *
 * Two scrollbar realities (both verified live): classic scrollbars occupy
 * a gutter outside the root's client box; overlay scrollbars (the macOS
 * default) take no layout space at all — the thumb floats inside the
 * client box along the window edge, detected here by edge proximity while
 * the document actually scrolls on that axis. A rare genuine root-targeted
 * click inside that band merely leaves the popover open. Inner-scroller
 * scrollbars still read as outside interaction — closing there is
 * ordinary light dismiss. */
function isRootScrollbarPointerdown(event: PointerEvent): boolean {
  const root = document.documentElement;
  // In quirks mode the viewport-establishing element is <body> (see
  // viewportBox), and it is also what a root-area click can target there;
  // the viewport reads below must come from the same element, or the
  // scrollHeight comparison is content-vs-content and permanently false
  // (PR #13 review, finding 5).
  const quirks = document.compatMode === "BackCompat";
  if (event.target !== root && !(quirks && event.target === document.body)) {
    return false;
  }
  const viewport = viewportBox();
  const rtl = getComputedStyle(root).direction === "rtl";
  const gutter = window.innerWidth - viewport.width;
  if (gutter > 0) {
    return (
      (rtl ? event.clientX < gutter : event.clientX >= viewport.width) ||
      event.clientY >= viewport.height
    );
  }
  const scroller = document.scrollingElement ?? root;
  const nearVerticalEdge = rtl
    ? event.clientX <= OVERLAY_SCROLLBAR_BAND_PX
    : event.clientX >= window.innerWidth - OVERLAY_SCROLLBAR_BAND_PX;
  return (
    (scroller.scrollHeight > viewport.height && nearVerticalEdge) ||
    (scroller.scrollWidth > viewport.width &&
      event.clientY >= window.innerHeight - OVERLAY_SCROLLBAR_BAND_PX)
  );
}

function openPopoverFor(image: HTMLImageElement): void {
  const entry = badges.get(image);
  if (!entry) return;
  closePopover();

  const element = document.createElement("div");
  element.className = "popover";
  element.setAttribute("role", "dialog");
  element.setAttribute(
    "aria-label",
    POPOVER_STRINGS.dialogLabel(VERDICT_LABELS[entry.verdict.verdict]),
  );
  syncAltDescription(element, image);
  element.append(buildPopoverContent(entry.verdict));
  // Entrance motion plays once per element: re-insertion during a host
  // rebuild restarts CSS animations, and an adopted panel must not
  // re-pop (nor its headline arc re-sweep) mid-read. A rebuilt content
  // fragment brings fresh arc elements, so a verdict change still sweeps.
  element.addEventListener("animationend", (event) => {
    if (event.animationName === "trueorigin-pop") {
      element.style.animation = "none";
    } else if (
      event.animationName === "trueorigin-sweep" &&
      event.target instanceof SVGElement
    ) {
      event.target.style.animation = "none";
    }
  });
  // Wheel over the open panel must never scroll the page beneath it.
  // CSS alone cannot guarantee that: overscroll-behavior engages only
  // where scrollable overflow exists, so a panel whose evidence region
  // absorbed the excess has no containment layer under the pointer at
  // all. Consume the event unconditionally and route the delta to the
  // innermost scrollable region under the pointer, the panel itself
  // included. (A non-passive listener's preventDefault is binding for
  // real wheel input; automation scroll gestures drive the viewport at
  // the compositor level and bypass wheel dispatch entirely, so they
  // can neither exercise nor falsify this path — 2026-08-05 soak.)
  element.addEventListener(
    "wheel",
    (event) => {
      // Ctrl+wheel is browser zoom, not scrolling — Chrome also
      // synthesizes it (ctrlKey set) for trackpad pinch. Containment
      // must never eat the reader's zoom (WCAG 1.4.4/1.4.10 territory):
      // let the default action through untouched.
      if (event.ctrlKey) return;
      event.preventDefault();
      for (const node of event.composedPath()) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.scrollHeight > node.clientHeight) {
          node.scrollTop += event.deltaY;
          break;
        }
        if (node === element) break;
      }
    },
    { passive: false },
  );
  // Inserted right after its badge so keyboard focus flows badge → panel.
  entry.element.after(element);
  entry.element.setAttribute("aria-expanded", "true");

  const dismiss = new AbortController();
  openPopover = { image, element, dismiss };

  // Light dismiss. Capture phase, because host pages routinely stop
  // propagation at their own roots.
  document.addEventListener(
    "pointerdown",
    (event) => {
      // The shadow root is closed, so composedPath() seen from a
      // document-level listener stops at the host — the panel and badge
      // themselves are not in the visible path. The host is an exact
      // stand-in: it is 0×0 with pointer-events: none, so any event
      // routed through it originated on overlay pixels. (A pointerdown on
      // a *different* image's badge also passes; openPopoverFor closes
      // this panel when that badge's click opens its own.)
      const overlayHost = shadowRoot?.host;
      if (overlayHost && event.composedPath().includes(overlayHost)) return;
      if (isRootScrollbarPointerdown(event)) return;
      closePopover();
    },
    { capture: true, signal: dismiss.signal },
  );
  // Escape is scoped to the overlay: while the user is working in page UI
  // (an input's autocomplete, an IME composition, a page dialog) the key
  // belongs to the page, and the popover waits for light dismiss. From
  // inside the overlay it is consumed fully — preventDefault stops native
  // defaults (<dialog> cancel, fullscreen exit) and
  // stopImmediatePropagation stops other document-level handlers — so one
  // keypress dismisses exactly one layer. Page listeners capturing on
  // window have already fired by now; that is out of reach from here.
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Escape" || event.isComposing) return;
      const host = shadowRoot?.host;
      if (!host || !event.composedPath().includes(host)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      closePopover(true);
    },
    { capture: true, signal: dismiss.signal },
  );
  // Cross-document frames swallow pointer and key events, so neither
  // listener above can ever fire while the user interacts with one — the
  // panel would just hang open. Focus entering a child context blurs this
  // window; that is the one signal that does cross the boundary. And when
  // this instance IS the child (all_frames), every interaction outside
  // the frame blurs this window with no in-document event at all — the
  // activeElement here is the badge's retargeted shadow host, never a
  // frame element, so without the child-frame arm nothing would ever
  // close (PR #13 review, finding 2). Closing unconditionally on blur in
  // a child frame also means switching applications dismisses an
  // in-frame popover; accepted — indistinguishable from departure with
  // the signals that cross a frame boundary (DECISIONS.md).
  window.addEventListener(
    "blur",
    () => {
      if (
        window.self !== window.top ||
        hostsChildContext(document.activeElement)
      ) {
        closePopover();
      }
    },
    { signal: dismiss.signal },
  );

  measureAndPlacePopover(
    entry,
    element,
    image.getBoundingClientRect(),
    window.scrollX,
    window.scrollY,
  );
}

function togglePopover(image: HTMLImageElement): void {
  if (openPopover?.image === image) {
    closePopover();
  } else {
    openPopoverFor(image);
  }
}

/** Hover-out grace before an intent-revealed Unknown badge fades: long
 * enough to travel image → badge, short enough to feel responsive. */
const INTENT_HIDE_DELAY_MS = 200;

/** Restarts the sweep-on animation, replaying the arc's draw to its honest
 * band: on first paint, on a verdict change, and on every intent reveal. */
function playSweep(element: HTMLButtonElement): void {
  element.classList.remove("enter");
  // Forcing style resolution restarts the animation when the class returns.
  void element.offsetWidth;
  element.classList.add("enter");
}

function cancelHide(entry: BadgeEntry): void {
  if (entry.gate?.hideTimer != null) {
    clearTimeout(entry.gate.hideTimer);
    entry.gate.hideTimer = null;
  }
}

function revealIntentBadge(entry: BadgeEntry): void {
  cancelHide(entry);
  if (entry.element.dataset["presence"] !== "hidden") return;
  entry.element.dataset["presence"] = "shown";
  playSweep(entry.element);
}

/** The one "never hide under the reader" predicate, shared by gate
 * creation (initial presence) and the hide timer's fire-time guard so the
 * two sites can never drift apart: an open popover for this image, hover
 * or keyboard focus on the badge itself, or the pointer on the image. */
function readerEngaged(image: HTMLImageElement, entry: BadgeEntry): boolean {
  return (
    openPopover?.image === image ||
    entry.element.matches(":hover, :focus-within") ||
    isImageUnderPointer(image)
  );
}

function scheduleIntentHide(image: HTMLImageElement, entry: BadgeEntry): void {
  if (!entry.gate) return;
  cancelHide(entry);
  entry.gate.hideTimer = window.setTimeout(() => {
    if (!entry.gate) return;
    entry.gate.hideTimer = null;
    // Never hide under the reader. Without the fire-time re-check, a hide
    // scheduled by a verdict handoff or a popover close fires under a
    // stationary pointer, and no boundary event is left to re-reveal.
    if (readerEngaged(image, entry)) return;
    entry.element.dataset["presence"] = "hidden";
  }, INTENT_HIDE_DELAY_MS);
}

/** Applies the presence model (owner decision, 2026-08-05): strong
 * verdicts assert themselves unprompted; Unknown sits hidden until the
 * reader shows intent — the pointer over the image, or focus reaching the
 * badge. Pointer intent is sensed by the shared window-level sensor
 * (see syncIntentSensor), never by listeners on the image: pages that
 * stack a click-capture overlay over their images (Instagram's feed is
 * the recorded field case, 2026-08-06) starve the image of pointer
 * events entirely, and a gate keyed on them can never reveal. Only the
 * badge's own listeners live here — the overlay paints above any page
 * layer, so its events are trustworthy. */
function syncIntentGate(image: HTMLImageElement, entry: BadgeEntry): void {
  if (entry.verdict.verdict !== "unknown") {
    if (entry.gate) {
      cancelHide(entry);
      entry.gate.controller.abort();
      entry.gate = null;
      syncIntentSensor();
    }
    delete entry.element.dataset["presence"];
    return;
  }
  if (entry.gate) return; // Already gated; keep the current visibility.
  const controller = new AbortController();
  entry.gate = { controller, hideTimer: null };
  // Initial presence honors the same holds as the hide timer (the shared
  // readerEngaged predicate): an in-place re-render can land on Unknown
  // while this badge's popover is open or the reader is on it, and hiding
  // then would strand a visible dialog on an invisible button — or vanish
  // the badge under the cursor with no boundary event left to re-reveal.
  entry.element.dataset["presence"] = readerEngaged(image, entry)
    ? "shown"
    : "hidden";
  const { signal } = controller;
  const hide = (): void => scheduleIntentHide(image, entry);
  entry.element.addEventListener("pointerenter", () => cancelHide(entry), {
    signal,
  });
  entry.element.addEventListener("pointerleave", hide, { signal });
  entry.element.addEventListener("focusin", () => revealIntentBadge(entry), {
    signal,
  });
  entry.element.addEventListener("focusout", hide, { signal });
  syncIntentSensor();
}

// In-flight indicators (finish-review fix 2): while an image's analysis
// runs, reader intent reveals a glyph-less tracing ring — the same chip
// anatomy as a badge, but a status, not a control. Listeners live for the
// whole analysis; the chip exists only while revealed. Unprompted
// pre-verdict chips on every image would betray the product's restraint
// (PRODUCT.md; owner decision 2026-08-05), so this obeys the same intent
// gate as Unknown.
interface PendingEntry {
  element: HTMLDivElement | null;
  hideTimer: number | null;
}
const pending = new Map<HTMLImageElement, PendingEntry>();

// ---------------------------------------------------------------------------
// Shared intent sensor (task: Instagram field bug, 2026-08-06; reworked in
// the PR #12 review fix wave, same date). One window-level capture-phase
// pointer listener set serves every intent-gated entry — gated Unknown
// badges and pending chips alike — in place of per-image
// pointerenter/move/leave listeners. Listening on the image breaks
// wherever a page stacks its own overlay above the image (Instagram
// covers every feed slide with a click-capture div): hit testing routes
// all pointer events to the overlay, the image never fires a boundary
// event, and a gate keyed on image events can never reveal. The sensor
// asks the engine's hit tester instead: elementsFromPoint reports the
// full stack under the point, covered elements included, so a page
// overlay cannot blind it. Its known limits, so the next field bug is a
// lookup and not a re-diagnosis: an image with pointer-events: none (its
// own or inherited) is skipped by hit testing entirely and can only ever
// reveal via keyboard focus (ROADMAP parked item), and a shadow-tree hit
// retargets to its host, so a gated image inside a shadow root would
// never match — moot while discovery is light-DOM-only, but the coupling
// binds whoever adds shadow discovery. Window capture, not document:
// window-capture listeners fire before everything else (the containment
// note atop this file), so nothing short of an earlier
// stopImmediatePropagation on window itself can starve the sensor. No
// throttling: Chrome already aligns pointermove dispatch to the frame
// rate.

let intentSensor: AbortController | null = null;

/** Last known pointer positions in viewport coordinates — the space
 * scrolling does not move, so a stationary pointer's point stays valid
 * across layout and scroll until the pointer next moves or leaves.
 *
 * Hovering pointers (mouse, pen) and touch are tracked separately: in a
 * single shared slot, an unrelated touch tap would clobber — and on lift,
 * null — the point holding a mouse reveal (PR #12 review). The touch
 * point is sticky past lift, mirroring Chrome's sticky post-tap :hover
 * (the guard the old per-image gate leaned on): clearing it on the tap's
 * trailing pointerout would hide the badge 200ms after every tap, before
 * the second tap that opens the popover — touch's only path in. It
 * clears when the touch becomes a scroll or gesture (pointercancel),
 * when a pointer crosses into an iframe, and on the next touch landing
 * elsewhere. */
let hoverPoint: { x: number; y: number } | null = null;
let touchPoint: { x: number; y: number } | null = null;

function hitStackAt(x: number, y: number): Element[] {
  // Absent only in non-browser test environments (jsdom).
  const stack = document.elementsFromPoint?.(x, y) ?? [];
  // A point on the overlay's own visible pixels is interaction with our
  // UI, not intent about whatever page content sits beneath: reading an
  // open panel must not strobe reveals across the images under its
  // footprint. The host tops a stack exactly then — it is 0×0 and
  // pointer-events: none itself, so it only appears when a shadow-tree
  // hit (a shown badge, the panel) retargeted to it. The panel's own
  // image stays held by the openPopover guard, and a badge under the
  // pointer holds through its :hover guard.
  if (stack[0] === shadowRoot?.host) return [];
  return stack;
}

/** True unless the image is invisible by opacity — its own computed
 * opacity 0 or an ancestor's (group opacity multiplies down the tree, so
 * the engine's own walk does the checking). Both option spellings cover
 * Chromes on either side of the spec rename; a browser without the API
 * degrades to "visible", i.e. plain topmost-wins. Only opacity needs
 * asking about: every other way to be invisible at a point —
 * display:none, visibility:hidden, clip, transform, pointer-events:none —
 * already excludes an element from hit-test stacks. */
function imageVisiblyPresent(image: HTMLImageElement): boolean {
  return (
    image.checkVisibility?.({ opacityProperty: true, checkOpacity: true }) ??
    true
  );
}

/** The image the pointer at this stack's point visually rests on: the
 * topmost image the reader can actually see. elementsFromPoint reports
 * buried elements too — that is what defeats page overlays — but it also
 * includes images fully covered by other images (LQIP placeholders under
 * their final image) and opacity-0 ones (a crossfade's settled-out frame
 * left stacked above the active frame), and a reader hovering the stack
 * is looking at neither; revealing them would pile chips on the same
 * +8/+8 anchor, or hand the reveal to an image nobody can see. Non-image
 * elements above an image (the overlay case) are ignored; a visible
 * image above wins, as :hover would have said; an opacity-hidden image
 * above loses to the visible one beneath it. Single-image stacks — the
 * overwhelmingly common case — return immediately and never pay a style
 * read; when every image in the stack is opacity-hidden the topmost
 * still wins (:hover's answer, and with no visible twin there is nothing
 * to mis-attribute). */
function topImageAt(stack: Element[]): HTMLImageElement | null {
  const images: HTMLImageElement[] = [];
  for (const element of stack) {
    if (element instanceof HTMLImageElement) images.push(element);
  }
  if (images.length <= 1) return images[0] ?? null;
  return images.find(imageVisiblyPresent) ?? images[0] ?? null;
}

/** True when a pointer's last known position rests on the image — page
 * overlays above it notwithstanding. The overlay-blind replacement for
 * image.matches(":hover"), which follows the hovered element's ancestor
 * chain and never includes a covered image.
 *
 * While no hover data exists at all (page loaded under a resting cursor,
 * sensor freshly installed), the event-fed points cannot answer, and the
 * browser's own hover chain — event-independent, maintained before any
 * listener of ours ran — is the only truth available: the fallback
 * restores the reveal the pre-sensor code gave that case. A covered
 * image never enters the hover chain, but for it the fallback merely
 * returns the same false the missing data would. */
function isImageUnderPointer(image: HTMLImageElement): boolean {
  if (
    hoverPoint !== null &&
    topImageAt(hitStackAt(hoverPoint.x, hoverPoint.y)) === image
  ) {
    return true;
  }
  if (
    touchPoint !== null &&
    topImageAt(hitStackAt(touchPoint.x, touchPoint.y)) === image
  ) {
    return true;
  }
  return hoverPoint === null && image.matches(":hover");
}

function sensorNeeded(): boolean {
  if (pending.size > 0) return true;
  for (const entry of badges.values()) {
    if (entry.gate) return true;
  }
  return false;
}

/** Applies one hit stack to every intent-gated entry. An empty stack
 * means "the pointer rests on nothing of interest" — it left the
 * document, crossed into an iframe, or sits on our own overlay — and
 * schedules the grace hide everywhere; the fire-time readerEngaged guard
 * re-checks before anything actually hides, so a badge held by another
 * pointer, the open popover, or badge hover survives. */
function processPointerAt(stack: Element[]): void {
  const topImage = topImageAt(stack);
  for (const [image, entry] of badges) {
    if (!entry.gate) continue;
    if (image === topImage) {
      revealIntentBadge(entry);
    } else if (entry.element.dataset["presence"] === "shown") {
      scheduleIntentHide(image, entry);
    }
  }
  for (const [image, entry] of pending) {
    if (image === topImage) {
      revealPendingChip(image, entry);
    } else if (entry.element) {
      schedulePendingHide(entry);
    }
  }
}

/** Installs the window-level sensor while any intent-gated entry
 * exists, and removes it when the last one goes (§8: the overlay must be
 * removable — nothing of ours may keep firing on a page with no badges).
 * Called at every gate and pending-entry transition. */
function syncIntentSensor(): void {
  if (sensorNeeded() === (intentSensor !== null)) return;
  if (intentSensor) {
    intentSensor.abort();
    intentSensor = null;
    // Real teardown — the last gated entry is gone (renderBadge's
    // pending→Unknown handoff never bounces through here; see
    // dropPending). Movement while no sensor listens is untracked, so a
    // point kept across the gap goes stale, and a later gate consulting
    // it would reveal a badge no reader asked about (PR #12 review). The
    // points die with the listeners that fed them.
    hoverPoint = null;
    touchPoint = null;
    return;
  }
  intentSensor = new AbortController();
  const { signal } = intentSensor;
  const onPointer = (event: PointerEvent): void => {
    const point = { x: event.clientX, y: event.clientY };
    if (event.pointerType === "touch") touchPoint = point;
    else hoverPoint = point;
    processPointerAt(hitStackAt(point.x, point.y));
  };
  window.addEventListener("pointermove", onPointer, { capture: true, signal });
  // Taps and clicks are intent too, and touch input can produce no
  // pointermove at all before the tap lands.
  window.addEventListener("pointerdown", onPointer, { capture: true, signal });
  window.addEventListener(
    "pointerout",
    (event) => {
      // Two "the pointer is gone" shapes. relatedTarget null: it left the
      // document (window edge, device lift). relatedTarget a child-context
      // element (iframe, frameset frame, object/embed): it crossed into a
      // child document that swallows every further pointer event (the
      // same blindness the popover's dismiss handles via window blur) —
      // without this branch, the last reveal would sit pinned open for as
      // long as the reader works inside the frame. A touch lift keeps its
      // sticky point (see the state note above); a touch crossing into a
      // child document does not.
      const intoFrame = hostsChildContext(event.relatedTarget);
      if (event.relatedTarget !== null && !intoFrame) return;
      if (event.pointerType === "touch") {
        if (!intoFrame) return;
        touchPoint = null;
      } else {
        hoverPoint = null;
      }
      processPointerAt([]);
    },
    { capture: true, signal },
  );
  window.addEventListener(
    "pointercancel",
    (event) => {
      // A cancelled touch became a scroll or gesture — tap intent it was
      // not, and Chrome does not hold sticky hover for it either.
      if (event.pointerType === "touch") touchPoint = null;
      else hoverPoint = null;
      processPointerAt([]);
    },
    { capture: true, signal },
  );
}

function anyPendingChipVisible(): boolean {
  for (const entry of pending.values()) {
    if (entry.element) return true;
  }
  return false;
}

/** Removes a pending entry's chip from screen (the entry itself lives
 * until clearPending). Clears the live region once no chip remains. */
function removePendingChip(entry: PendingEntry): void {
  if (!entry.element) return;
  entry.element.remove();
  entry.element = null;
  if (statusRegion && !anyPendingChipVisible()) statusRegion.textContent = "";
}

function revealPendingChip(image: HTMLImageElement, entry: PendingEntry): void {
  if (entry.hideTimer != null) {
    clearTimeout(entry.hideTimer);
    entry.hideTimer = null;
  }
  const rect = image.getBoundingClientRect();
  if (isCollapsed(rect)) return;
  // ensureHost even when the chip already exists: a page that tore out
  // the host would otherwise leave it stranded in the detached shadow
  // root (the rebuild's adoption loop re-parents it).
  const root = ensureHost();
  if (!entry.element) {
    const chip = document.createElement("div");
    chip.className = "badge pending";
    chip.setAttribute("role", "status");
    chip.setAttribute("aria-label", CHECKING_LABEL);
    chip.append(buildRing(ringStateForChecking(), "ring"));
    entry.element = chip;
    root.append(chip);
    if (statusRegion) statusRegion.textContent = CHECKING_LABEL;
  }
  positionAt(entry.element, rect, window.scrollX, window.scrollY);
}

function schedulePendingHide(entry: PendingEntry): void {
  if (entry.hideTimer != null) clearTimeout(entry.hideTimer);
  entry.hideTimer = window.setTimeout(() => {
    entry.hideTimer = null;
    removePendingChip(entry);
  }, INTENT_HIDE_DELAY_MS);
}

/** Starts the intent-gated in-flight indicator for an image whose
 * analysis just began. No-op when the image already shows a verdict.
 * Pointer intent arrives through the shared window-level sensor — the
 * same overlay-proof channel the Unknown gate uses. */
export function markPending(image: HTMLImageElement): void {
  if (pending.has(image) || badges.has(image)) return;
  pending.set(image, { element: null, hideTimer: null });
  syncIntentSensor();
}

/** Removes a pending entry without settling sensor accounting — that is
 * the caller's job. renderBadge needs exactly this: a syncing clear
 * would tear the sensor down and reinstall it whenever the resolving
 * image was the only gated entry (every first verdict on a page), and
 * the transient uninstall would wipe the pointer state the
 * pending→Unknown reveal handoff reads moments later. Returns true when
 * the chip was visibly on screen. */
function dropPending(image: HTMLImageElement): boolean {
  const entry = pending.get(image);
  if (!entry) return false;
  pending.delete(image);
  if (entry.hideTimer != null) clearTimeout(entry.hideTimer);
  const wasVisible = entry.element !== null;
  removePendingChip(entry);
  return wasVisible;
}

/** Ends the in-flight indicator. Returns true when its chip was visibly
 * on screen — renderBadge uses that to keep an Unknown verdict's reveal
 * continuous instead of blinking out under a stationary pointer. */
export function clearPending(image: HTMLImageElement): boolean {
  const wasVisible = dropPending(image);
  syncIntentSensor();
  return wasVisible;
}

/**
 * Renders (or updates) the verdict badge over an image's top-left corner.
 * `url` is the source the verdict describes; syncBadges drops the badge as
 * soon as the image's live source no longer matches it. The full verdict is
 * retained per badge — it is what the popover shows when the badge is
 * clicked.
 */
export function renderBadge(
  image: HTMLImageElement,
  verdict: WireVerdict,
  url: string,
): void {
  const root = ensureHost();
  const pendingWasVisible = dropPending(image);

  let entry = badges.get(image);
  const previousVerdict = entry?.verdict;
  if (!entry) {
    const element = document.createElement("button");
    element.type = "button";
    element.className = "badge";
    element.setAttribute("aria-haspopup", "dialog");
    element.setAttribute("aria-expanded", "false");
    // Containment at the host boundary (ensureHost) keeps this and every
    // other overlay event from the page's own handlers.
    element.addEventListener("click", () => togglePopover(image));
    // The sweep class comes off once its animation finishes: DOM
    // re-insertion restarts CSS animations, so .enter left in place
    // would replay every badge's draw-on each time a host rebuild
    // re-adopts the overlay ("sweep on first paint and on a verdict
    // change — never on positional re-renders").
    element.addEventListener("animationend", (event) => {
      if (event.animationName === "trueorigin-sweep") {
        element.classList.remove("enter");
      }
    });
    const label = document.createElement("span");
    label.className = "label";
    const ring = buildRing(ringStateForVerdict(verdict.verdict), "ring");
    element.append(ring, label);
    entry = { element, url, verdict, label, ring, gate: null };
    badges.set(image, entry);
    root.append(element);
  } else {
    entry.url = url;
    entry.verdict = verdict;
    if (previousVerdict && previousVerdict.verdict !== verdict.verdict) {
      const ring = buildRing(ringStateForVerdict(verdict.verdict), "ring");
      entry.ring.replaceWith(ring);
      entry.ring = ring;
    }
  }
  entry.element.dataset["verdict"] = verdict.verdict;
  // The verdict word is the visible label and the accessible name (the
  // ring SVG is aria-hidden); alt text rides as the description.
  entry.label.textContent = VERDICT_LABELS[verdict.verdict];
  syncAltDescription(entry.element, image);
  syncIntentGate(image, entry);
  // dropPending above left sensor accounting to this pass, and
  // syncIntentGate re-synced only on a gate transition — settle the
  // pending-entry change too (a strong verdict resolving the last
  // pending image must still uninstall the sensor).
  syncIntentSensor();
  // Reveal continuity: a verdict landing while the reader watches the
  // tracing chip must not blink out — the gated badge takes over shown.
  if (pendingWasVisible && entry.element.dataset["presence"] === "hidden") {
    revealIntentBadge(entry);
    scheduleIntentHide(image, entry);
  }
  // Sweep on first paint and on a verdict change — never on positional
  // re-renders. Intent-hidden badges sweep at reveal instead.
  if (
    entry.element.dataset["presence"] !== "hidden" &&
    (!previousVerdict || previousVerdict.verdict !== verdict.verdict)
  ) {
    playSweep(entry.element);
  }

  const rect = image.getBoundingClientRect();
  const { scrollX, scrollY } = window;
  positionAt(entry.element, rect, scrollX, scrollY);

  // A re-render while this image's popover is open must not leave stale
  // detail on screen.
  if (openPopover?.image === image) {
    if (isCollapsed(rect)) {
      // Same rule the sync pass enforces: the badge just hid, and placing
      // the panel against a zeroed rect would teleport it to the document
      // origin, floating over unrelated content until the next sync.
      closePopover();
    } else {
      openPopover.element.setAttribute(
        "aria-label",
        POPOVER_STRINGS.dialogLabel(VERDICT_LABELS[verdict.verdict]),
      );
      syncAltDescription(openPopover.element, image);
      // Rebuild only on an actual verdict change: a same-verdict re-render
      // (cached verdict, alt/position churn) must not detach focus from
      // the panel or reset its disclosure state.
      if (verdict !== previousVerdict) {
        openPopover.element.replaceChildren(buildPopoverContent(verdict));
      }
      measureAndPlacePopover(
        entry,
        openPopover.element,
        rect,
        scrollX,
        scrollY,
      );
    }
  }
}

/** Removes the badge for one image, if it has one — and the popover, when
 * it was this image's. */
export function removeBadgeFor(image: HTMLImageElement): void {
  clearPending(image);
  if (openPopover?.image === image) closePopover();
  const entry = badges.get(image);
  if (entry) {
    if (entry.gate) {
      cancelHide(entry);
      entry.gate.controller.abort();
    }
    entry.element.remove();
  }
  badges.delete(image);
  syncIntentSensor();
}

/**
 * Re-anchors every badge to its image's current layout position, removing
 * badges whose image has left the document or no longer displays the URL
 * the badge's verdict describes. Called by the content script on
 * layout-affecting events (resize, scroll, mutations, subresource loads).
 * The open popover moves with its badge and closes with it; a popover over
 * a hidden (collapsed-rect) image closes rather than floating over nothing.
 * Visible pending chips ride the same pass: layout shifts move and
 * collapse them like badges, and a chip whose image left the document is
 * taken off screen here rather than floating over reflowed content until
 * its analysis settles.
 *
 * All layout reads complete before the first style write: interleaving
 * them forces a synchronous layout flush per badge instead of one.
 *
 * @param onImageRemoved lets the caller forget a removed image so a later
 * re-insertion is scanned fresh.
 * @param onImageStale lets the caller re-queue an image whose displayed
 * source changed out from under its badge (responsive srcset
 * re-selection, <picture> source changes); the badge is already removed
 * when it fires — a badge for the wrong bytes is a false claim.
 */
export function syncBadges(
  onImageRemoved?: (image: HTMLImageElement) => void,
  onImageStale?: (image: HTMLImageElement) => void,
): void {
  if (badges.size === 0 && !anyPendingChipVisible()) return;
  // A page removing the host is itself a DOM mutation, so sync runs right
  // after — rebuilding here (which re-adopts the badges) restores the
  // overlay on the next layout event instead of the next fresh verdict.
  ensureHost();

  const removed: HTMLImageElement[] = [];
  const stale: HTMLImageElement[] = [];
  const moves: Array<[HTMLElement, DOMRect]> = [];
  let popoverMove: {
    rect: DOMRect;
    width: number;
    height: number;
    badgeHeight: number;
  } | null = null;
  for (const [image, { element, url }] of badges) {
    if (!image.isConnected) {
      removed.push(image);
    } else if ((image.currentSrc || image.src) !== url) {
      stale.push(image);
    } else {
      const rect = image.getBoundingClientRect();
      moves.push([element, rect]);
      if (openPopover?.image === image) {
        popoverMove = {
          rect,
          width: openPopover.element.offsetWidth,
          height: openPopover.element.offsetHeight,
          badgeHeight: element.offsetHeight,
        };
      }
    }
  }
  const pendingMoves: Array<[HTMLElement, DOMRect]> = [];
  const pendingGone: PendingEntry[] = [];
  for (const [image, entry] of pending) {
    if (!entry.element) continue;
    if (image.isConnected) {
      pendingMoves.push([entry.element, image.getBoundingClientRect()]);
    } else {
      pendingGone.push(entry);
    }
  }
  const { scrollX, scrollY } = window;
  // Still the read phase: after the writes below, these reads would force
  // a synchronous reflow on every popover-open sync.
  const { width: viewportWidth, height: viewportHeight } = viewportBox();

  for (const [element, rect] of moves) {
    positionAt(element, rect, scrollX, scrollY);
  }
  // positionAt hides a chip whose image collapsed, same rule as badges.
  for (const [element, rect] of pendingMoves) {
    positionAt(element, rect, scrollX, scrollY);
  }
  for (const entry of pendingGone) {
    removePendingChip(entry);
  }
  if (openPopover && popoverMove) {
    if (isCollapsed(popoverMove.rect)) {
      closePopover();
    } else {
      placePopover(openPopover.element, {
        rect: popoverMove.rect,
        scrollX,
        scrollY,
        popoverWidth: popoverMove.width,
        popoverHeight: popoverMove.height,
        badgeHeight: popoverMove.badgeHeight,
        viewportWidth,
        viewportHeight,
      });
    }
  }
  for (const image of removed) {
    removeBadgeFor(image);
    onImageRemoved?.(image);
  }
  for (const image of stale) {
    removeBadgeFor(image);
    onImageStale?.(image);
  }
}

/** Removes every badge, pending indicator, the open popover, and the
 * overlay host itself. */
export function removeAllBadges(): void {
  for (const image of Array.from(pending.keys())) clearPending(image);
  closePopover();
  // Tear down every intent gate — its hide timers and badge-element
  // listeners — so nothing keeps firing against detached badges, and a
  // later re-enable never stacks a second listener generation (§8: the
  // overlay must be removable).
  for (const entry of badges.values()) {
    if (entry.gate) {
      cancelHide(entry);
      entry.gate.controller.abort();
      entry.gate = null;
    }
  }
  shadowRoot?.host.remove();
  shadowRoot = null;
  statusRegion = null;
  badges.clear();
  // With no gated entries left, this removes the window-level sensor —
  // and the sensor teardown clears the tracked pointer points with it.
  syncIntentSensor();
}
