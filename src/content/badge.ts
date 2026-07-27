// Badge overlay rendering (plan.md §4). Free-choice technique recorded in
// DECISIONS.md (task 4), subject to two constraints from §8: must not break
// host-page layout, must be removable.
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

/** Renders one verdict badge over the top-left corner of an image. */
export function renderBadge(image: HTMLImageElement, verdict: VerdictId): void {
  const root = ensureHost();
  const rect = image.getBoundingClientRect();

  const badge = document.createElement("div");
  badge.className = "badge";
  badge.dataset["verdict"] = verdict;
  badge.textContent = VERDICT_LABELS[verdict];
  badge.style.left = `${rect.left + window.scrollX + 8}px`;
  badge.style.top = `${rect.top + window.scrollY + 8}px`;

  root.append(badge);
}

/** Removes every badge and the overlay host itself. */
export function removeAllBadges(): void {
  shadowRoot?.host.remove();
  shadowRoot = null;
}
