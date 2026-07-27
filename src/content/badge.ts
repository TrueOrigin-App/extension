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
// stacks. Entries are dropped by removeBadgeFor/syncBadges when the image
// goes away.
const badges = new Map<HTMLImageElement, HTMLDivElement>();

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

  document.documentElement.append(host);
  return shadowRoot;
}

function position(badge: HTMLDivElement, image: HTMLImageElement): void {
  const rect = image.getBoundingClientRect();
  // A collapsed rect means the image is hidden or not laid out (display:none,
  // an emptied carousel slide) — a badge floating over nothing is a claim
  // about nothing, so hide it until the image shows again.
  if (rect.width < 1 || rect.height < 1) {
    badge.style.display = "none";
    return;
  }
  badge.style.display = "";
  badge.style.left = `${rect.left + window.scrollX + 8}px`;
  badge.style.top = `${rect.top + window.scrollY + 8}px`;
}

/** Renders (or updates) the verdict badge over an image's top-left corner. */
export function renderBadge(image: HTMLImageElement, verdict: VerdictId): void {
  const root = ensureHost();

  let badge = badges.get(image);
  if (!badge) {
    badge = document.createElement("div");
    badge.className = "badge";
    badges.set(image, badge);
    root.append(badge);
  }
  badge.dataset["verdict"] = verdict;
  badge.textContent = VERDICT_LABELS[verdict];
  position(badge, image);
}

/** Removes the badge for one image, if it has one. */
export function removeBadgeFor(image: HTMLImageElement): void {
  badges.get(image)?.remove();
  badges.delete(image);
}

/**
 * Re-anchors every badge to its image's current layout position, removing
 * badges whose image has left the document. Called by the content script on
 * layout-affecting events (resize, mutations, subresource loads).
 *
 * @param onImageRemoved lets the caller forget a removed image so a later
 * re-insertion is scanned fresh.
 */
export function syncBadges(
  onImageRemoved?: (image: HTMLImageElement) => void,
): void {
  for (const [image, badge] of badges) {
    if (image.isConnected) {
      position(badge, image);
    } else {
      badge.remove();
      badges.delete(image);
      onImageRemoved?.(image);
    }
  }
}

/** Removes every badge and the overlay host itself. */
export function removeAllBadges(): void {
  shadowRoot?.host.remove();
  shadowRoot = null;
  badges.clear();
}
