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
import { VERDICT_LABELS } from "./labels";

const HOST_ID = "trueorigin-badge-host";

// Deliberately plain, neutral presentation for every verdict state —
// placeholder until Phase 3 brand work, like the wording in labels.ts.
// Colors hold WCAG AA contrast on the solid panel; the focus ring pairs a
// light outline with a dark halo so it reads over arbitrary page imagery.
const BADGE_STYLE = `
  .badge {
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
  // Zero-footprint anchor at the document origin: badges inside it are
  // positioned in document coordinates and scroll with the page.
  host.style.cssText =
    "position: absolute; top: 0; left: 0; width: 0; height: 0; " +
    "z-index: 2147483647; pointer-events: none;";

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

function positionAt(
  badge: HTMLElement,
  rect: DOMRect,
  scrollX: number,
  scrollY: number,
): void {
  // A collapsed rect means the image is hidden or not laid out (display:none,
  // an emptied carousel slide) — a badge floating over nothing is a claim
  // about nothing, so hide it until the image shows again.
  if (rect.width < 1 || rect.height < 1) {
    badge.style.display = "none";
    return;
  }
  badge.style.display = "";
  badge.style.left = `${rect.left + scrollX + 8}px`;
  badge.style.top = `${rect.top + scrollY + 8}px`;
}

/** Write-only popover placement: below the badge, clamped so the panel
 * stays inside the viewport horizontally. Layout reads (widths, heights)
 * are the caller's job, keeping syncBadges to one read/write cycle. */
function placePopover(
  popover: HTMLDivElement,
  rect: DOMRect,
  scrollX: number,
  scrollY: number,
  popoverWidth: number,
  badgeHeight: number,
): void {
  const ideal = rect.left + scrollX + 8;
  const maxLeft =
    scrollX + document.documentElement.clientWidth - popoverWidth - 8;
  popover.style.left = `${Math.max(scrollX + 8, Math.min(ideal, maxLeft))}px`;
  popover.style.top = `${rect.top + scrollY + 8 + badgeHeight + 6}px`;
}

/** The image's alt text, when it has one — the only page-provided handle
 * that can tell "which image is this about?" to a keyboard or screen-reader
 * user, whose badge buttons otherwise all read alike (the overlay host
 * lives at the end of the tab order, far from the images). */
function altOf(image: HTMLImageElement): string {
  return image.getAttribute("alt")?.trim() ?? "";
}

function badgeLabel(verdict: WireVerdict, image: HTMLImageElement): string {
  const label = VERDICT_LABELS[verdict.verdict];
  const alt = altOf(image);
  return alt ? `${label} — ${alt}` : label;
}

function popoverLabel(verdict: WireVerdict, image: HTMLImageElement): string {
  const label = VERDICT_LABELS[verdict.verdict];
  const alt = altOf(image);
  return alt ? `${label} — details for “${alt}”` : `${label} — details`;
}

function closePopover(refocusBadge = false): void {
  if (!openPopover) return;
  const { image, element, dismiss } = openPopover;
  openPopover = null;
  dismiss.abort();
  element.remove();
  const entry = badges.get(image);
  if (entry) {
    entry.element.setAttribute("aria-expanded", "false");
    if (refocusBadge) entry.element.focus();
  }
}

function openPopoverFor(image: HTMLImageElement): void {
  const entry = badges.get(image);
  if (!entry) return;
  closePopover();

  const element = document.createElement("div");
  element.className = "popover";
  element.setAttribute("role", "dialog");
  element.setAttribute("aria-label", popoverLabel(entry.verdict, image));
  element.append(buildPopoverContent(entry.verdict));
  // Inserted right after its badge so keyboard focus flows badge → panel.
  entry.element.after(element);
  entry.element.setAttribute("aria-expanded", "true");

  const dismiss = new AbortController();
  openPopover = { image, element, dismiss };

  // Light dismiss. Capture phase, because host pages routinely stop
  // propagation at their own roots; Escape also returns focus to the badge
  // and is consumed so it doesn't additionally dismiss page UI.
  document.addEventListener(
    "pointerdown",
    (event) => {
      const path = event.composedPath();
      if (path.includes(element) || path.includes(entry.element)) return;
      closePopover();
    },
    { capture: true, signal: dismiss.signal },
  );
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      closePopover(true);
    },
    { capture: true, signal: dismiss.signal },
  );

  placePopover(
    element,
    image.getBoundingClientRect(),
    window.scrollX,
    window.scrollY,
    element.offsetWidth,
    entry.element.offsetHeight,
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
  if (!entry) {
    const element = document.createElement("button");
    element.type = "button";
    element.className = "badge";
    element.setAttribute("aria-haspopup", "dialog");
    element.setAttribute("aria-expanded", "false");
    element.addEventListener("click", (event) => {
      // The badge overlays host-page content (often inside a link); its
      // clicks are ours alone.
      event.stopPropagation();
      togglePopover(image);
    });
    entry = { element, url, verdict };
    badges.set(image, entry);
    root.append(element);
  } else {
    entry.url = url;
    entry.verdict = verdict;
  }
  entry.element.dataset["verdict"] = verdict.verdict;
  entry.element.textContent = VERDICT_LABELS[verdict.verdict];
  entry.element.setAttribute("aria-label", badgeLabel(verdict, image));

  const rect = image.getBoundingClientRect();
  const { scrollX, scrollY } = window;
  positionAt(entry.element, rect, scrollX, scrollY);

  // A re-render while this image's popover is open must not leave stale
  // detail on screen.
  if (openPopover?.image === image) {
    openPopover.element.setAttribute(
      "aria-label",
      popoverLabel(verdict, image),
    );
    openPopover.element.replaceChildren(buildPopoverContent(verdict));
    placePopover(
      openPopover.element,
      rect,
      scrollX,
      scrollY,
      openPopover.element.offsetWidth,
      entry.element.offsetHeight,
    );
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

  for (const [element, rect] of moves) {
    positionAt(element, rect, scrollX, scrollY);
  }
  if (openPopover && popoverMove) {
    if (popoverMove.rect.width < 1 || popoverMove.rect.height < 1) {
      closePopover();
    } else {
      placePopover(
        openPopover.element,
        popoverMove.rect,
        scrollX,
        scrollY,
        popoverMove.width,
        popoverMove.badgeHeight,
      );
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
