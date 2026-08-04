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
import { POPOVER_STRINGS, VERDICT_LABELS } from "./labels";

const HOST_ID = "trueorigin-badge-host";

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

// Deliberately plain, neutral presentation for every verdict state —
// placeholder until Phase 3 brand work, like the wording in labels.ts.
// Colors hold WCAG AA contrast on the solid panel; the focus ring pairs a
// light outline with a dark halo so it reads over arbitrary page imagery.
const BADGE_STYLE = `
  /* The shadow boundary stops page selectors but not inheritance: page
     rules matching the host div (html, div, *) compute on it and inherit
     into the tree — direction, letter-spacing, text-transform, and the
     rest. "all: initial" on both roots cuts that off; every property the
     overlay needs is re-declared after it, and descendants inherit from
     these reset roots. */
  .badge {
    all: initial;
    position: absolute;
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    min-height: 24px;
    margin: 0;
    padding: 3px 10px;
    border: 0;
    border-radius: 999px;
    background: rgba(28, 32, 38, 0.92);
    color: #f5f6f7;
    font:
      500 12px/1.4 system-ui,
      sans-serif;
    white-space: nowrap;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
    pointer-events: auto;
    cursor: pointer;
    user-select: none;
  }
  .badge:hover {
    background: rgba(48, 54, 62, 0.95);
  }
  .badge:focus-visible {
    outline: 2px solid #f5f6f7;
    outline-offset: 1px;
    box-shadow: 0 0 0 5px rgba(28, 32, 38, 0.9);
  }
  .popover {
    all: initial;
    display: block;
    position: absolute;
    z-index: 1;
    box-sizing: border-box;
    width: min(300px, calc(100vw - 24px));
    max-height: min(340px, 70vh);
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 14px;
    border-radius: 10px;
    background: rgb(28, 32, 38);
    color: #f5f6f7;
    font:
      400 13px/1.5 system-ui,
      sans-serif;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
    pointer-events: auto;
  }
  .headline {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
  }
  .explain {
    margin: 6px 0 0;
    color: #c9ced6;
  }
  .notice {
    margin: 8px 0 0;
    color: #eec98f;
  }
  .disclosure {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 24px;
    margin: 10px 0 0;
    padding: 0;
    border: 0;
    background: none;
    color: #f5f6f7;
    font:
      500 13px/1.5 system-ui,
      sans-serif;
    cursor: pointer;
  }
  .disclosure::before {
    content: "▸" / "";
  }
  .disclosure[aria-expanded="true"]::before {
    content: "▾" / "";
  }
  .disclosure:focus-visible {
    outline: 2px solid #f5f6f7;
    outline-offset: 2px;
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

  shadowRoot = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = BADGE_STYLE;
  shadowRoot.append(style);
  // If the page tore out the previous host, every live badge is still
  // parented to its detached shadow root — adopt them, or they would keep
  // updating invisibly forever. The open popover rides along, keeping its
  // place right after its badge (tab order).
  for (const { element } of badges.values()) {
    shadowRoot.append(element);
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
  badgeHeight: number;
  viewportWidth: number;
}

/** Write-only popover placement: below the badge, clamped so the panel
 * stays inside the viewport horizontally. */
function placePopover(popover: HTMLDivElement, place: PopoverPlacement): void {
  const { rect, scrollX, scrollY, popoverWidth, badgeHeight, viewportWidth } =
    place;
  const ideal = rect.left + scrollX + 8;
  const maxLeft = scrollX + viewportWidth - popoverWidth - 8;
  popover.style.left = `${Math.max(scrollX + 8, Math.min(ideal, maxLeft))}px`;
  popover.style.top = `${rect.top + scrollY + 8 + badgeHeight + 6}px`;
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
  placePopover(popover, {
    rect,
    scrollX,
    scrollY,
    popoverWidth: popover.offsetWidth,
    badgeHeight: entry.element.offsetHeight,
    viewportWidth: document.documentElement.clientWidth,
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
    if (refocusBadge || hadFocus) entry.element.focus();
  }
}

/** True when a pointerdown sits in the root scrollbar gutter — outside the
 * root element's client box. Chrome dispatches main-scrollbar drags as
 * pointerdown targeting the root element; treating them as outside clicks
 * would close the popover on the one scroll method that would otherwise
 * bring it into view. (Inner-scroller scrollbars still read as outside
 * interaction — closing there is ordinary light dismiss.) */
function isRootScrollbarPointerdown(event: PointerEvent): boolean {
  const root = document.documentElement;
  if (event.target !== root || root.clientWidth === 0) return false;
  const onVerticalScrollbar =
    getComputedStyle(root).direction === "rtl"
      ? event.clientX < window.innerWidth - root.clientWidth
      : event.clientX >= root.clientWidth;
  return onVerticalScrollbar || event.clientY >= root.clientHeight;
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
      const path = event.composedPath();
      if (path.includes(element) || path.includes(entry.element)) return;
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
  // Cross-document iframes swallow pointer and key events, so neither
  // listener above can ever fire while the user interacts with one — the
  // panel would just hang open. Focus entering an iframe blurs this
  // window; that is the one signal that does cross the boundary.
  window.addEventListener(
    "blur",
    () => {
      if (document.activeElement instanceof HTMLIFrameElement) closePopover();
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
    entry = { element, url, verdict };
    badges.set(image, entry);
    root.append(element);
  } else {
    entry.url = url;
    entry.verdict = verdict;
  }
  entry.element.dataset["verdict"] = verdict.verdict;
  // The visible label is the accessible name; alt text is the description.
  entry.element.textContent = VERDICT_LABELS[verdict.verdict];
  syncAltDescription(entry.element, image);

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
  if (openPopover?.image === image) closePopover();
  badges.get(image)?.element.remove();
  badges.delete(image);
}

/**
 * Re-anchors every badge to its image's current layout position, removing
 * badges whose image has left the document or no longer displays the URL
 * the badge's verdict describes. Called by the content script on
 * layout-affecting events (resize, scroll, mutations, subresource loads).
 * The open popover moves with its badge and closes with it; a popover over
 * a hidden (collapsed-rect) image closes rather than floating over nothing.
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
  if (badges.size === 0) return;
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
          badgeHeight: element.offsetHeight,
        };
      }
    }
  }
  const { scrollX, scrollY } = window;
  // Still the read phase: after the writes below, this read would force a
  // synchronous reflow on every popover-open sync.
  const viewportWidth = document.documentElement.clientWidth;

  for (const [element, rect] of moves) {
    positionAt(element, rect, scrollX, scrollY);
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
        badgeHeight: popoverMove.badgeHeight,
        viewportWidth,
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

/** Removes every badge, the open popover, and the overlay host itself. */
export function removeAllBadges(): void {
  closePopover();
  shadowRoot?.host.remove();
  shadowRoot = null;
  badges.clear();
}
