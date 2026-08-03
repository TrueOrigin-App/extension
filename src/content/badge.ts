// Badge overlay rendering (plan.md §4). Free-choice technique recorded in
// DECISIONS.md (task 4; positioning lifecycle extended in task 5.1), subject
// to two constraints from §8: must not break host-page layout, must be
// removable.
//
// All badges live inside one absolutely-positioned zero-size host element
// appended to <html> — the host page's own DOM is never restructured — and
// a shadow root isolates badge styles from page CSS in both directions.
// Removing the single host removes every badge.

import type { VerdictId } from "../core/types";
import { VERDICT_LABELS } from "./labels";

const HOST_ID = "trueorigin-badge-host";

// Deliberately plain, neutral presentation for every verdict state —
// placeholder until Phase 3 brand work, like the wording in labels.ts.
const BADGE_STYLE = `
  .badge {
    position: absolute;
    box-sizing: border-box;
    padding: 3px 10px;
    border-radius: 999px;
    background: rgba(28, 32, 38, 0.92);
    color: #f5f6f7;
    font:
      500 12px/1.4 system-ui,
      sans-serif;
    white-space: nowrap;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
  }
`;

let shadowRoot: ShadowRoot | null = null;

// One badge per image, so a re-analysis (src swap) replaces rather than
// stacks. Each entry remembers the URL its verdict describes — the
// invalidation key syncBadges checks against the image's live source.
// Entries are dropped by removeBadgeFor/syncBadges when the image goes
// away or stops displaying that URL.
type BadgeEntry = { element: HTMLDivElement; url: string };
const badges = new Map<HTMLImageElement, BadgeEntry>();

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
  // updating invisibly forever.
  for (const { element } of badges.values()) {
    shadowRoot.append(element);
  }

  document.documentElement.append(host);
  return shadowRoot;
}

function positionAt(
  badge: HTMLDivElement,
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

/**
 * Renders (or updates) the verdict badge over an image's top-left corner.
 * `url` is the source the verdict describes; syncBadges drops the badge as
 * soon as the image's live source no longer matches it.
 */
export function renderBadge(
  image: HTMLImageElement,
  verdict: VerdictId,
  url: string,
): void {
  const root = ensureHost();

  let entry = badges.get(image);
  if (!entry) {
    const element = document.createElement("div");
    element.className = "badge";
    entry = { element, url };
    badges.set(image, entry);
    root.append(element);
  } else {
    entry.url = url;
  }
  entry.element.dataset["verdict"] = verdict;
  entry.element.textContent = VERDICT_LABELS[verdict];
  positionAt(
    entry.element,
    image.getBoundingClientRect(),
    window.scrollX,
    window.scrollY,
  );
}

/** Removes the badge for one image, if it has one. */
export function removeBadgeFor(image: HTMLImageElement): void {
  badges.get(image)?.element.remove();
  badges.delete(image);
}

/**
 * Re-anchors every badge to its image's current layout position, removing
 * badges whose image has left the document or no longer displays the URL
 * the badge's verdict describes. Called by the content script on
 * layout-affecting events (resize, scroll, mutations, subresource loads).
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
  const moves: Array<[HTMLDivElement, DOMRect]> = [];
  for (const [image, { element, url }] of badges) {
    if (!image.isConnected) {
      removed.push(image);
    } else if ((image.currentSrc || image.src) !== url) {
      stale.push(image);
    } else {
      moves.push([element, image.getBoundingClientRect()]);
    }
  }
  const { scrollX, scrollY } = window;

  for (const [element, rect] of moves) {
    positionAt(element, rect, scrollX, scrollY);
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

/** Removes every badge and the overlay host itself. */
export function removeAllBadges(): void {
  shadowRoot?.host.remove();
  shadowRoot = null;
  badges.clear();
}
