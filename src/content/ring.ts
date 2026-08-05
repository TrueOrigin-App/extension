// Evidence Ring construction (Phase 3 visual world — DECISIONS.md,
// 2026-08-05). One module builds every ring the overlay shows — the badge
// chip, the popover headline, and the per-signal miniatures — so the
// geometry stays a single system: rounded-cap arc over a faint track, with
// an authored center glyph naming the verdict class.
//
// The arc renders discrete honest bands only: closed for cryptographic
// verdicts, visibly open for probabilistic ones, barely started for
// unknown. There is deliberately no continuous confidence-to-arc mapping —
// partial fill must never fake precision the evidence does not have
// (plan.md §2 confidence asymmetry; surface brief for badge.ts).
//
// Color never carries the state alone (WCAG 1.4.1): the band and the glyph
// are the color-independent signals, and hues are assigned in badge.ts's
// stylesheet, keyed by data-ring on the <svg>.

import type { VerdictId } from "../core/types";

const SVG_NS = "http://www.w3.org/2000/svg";

/** The three honest bands, as percentages of a pathLength-100 circle —
 * plus the checking arc, which is presentation, not evidence: it spins
 * (badge.ts) and never claims a fill. */
const BANDS = {
  /** Cryptographic evidence: the ring is closed. */
  closed: 100,
  /** Probabilistic evidence: nearly closed, the gap plainly visible. */
  open: 85,
  /** No usable evidence: an arc that has barely begun. */
  trace: 15,
  /** Checks in flight: a short arc that traces around, indeterminate. */
  checking: 25,
} as const;

type Band = keyof typeof BANDS;
type Glyph = "spark" | "lens" | "query" | "none";

/** One ring appearance: geometry (band + glyph) plus the hue key the
 * stylesheet colors by. `hue` matches VerdictId (or "checking") so CSS can
 * key on it. */
export interface RingState {
  band: Band;
  glyph: Glyph;
  hue: VerdictId | "checking";
}

/** The in-flight ring: glyph-less, neutral, spun by the stylesheet while
 * providers run. Shown only on reader intent (owner decision 2026-08-05 —
 * an unprompted pre-verdict flash on every image would betray the
 * product's restraint). */
export function ringStateForChecking(): RingState {
  return { band: "checking", glyph: "none", hue: "checking" };
}

export function ringStateForVerdict(verdict: VerdictId): RingState {
  switch (verdict) {
    case "ai-declared":
      return { band: "closed", glyph: "spark", hue: "ai-declared" };
    case "ai-likely":
      return { band: "open", glyph: "spark", hue: "ai-likely" };
    case "human-verified":
      return { band: "closed", glyph: "lens", hue: "human-verified" };
    case "unknown":
      return { band: "trace", glyph: "query", hue: "unknown" };
  }
}

// (Per-signal rings are keyed by core's verdictClassForSignal — see
// popover.ts — so the finding→class mapping and its confidence threshold
// live in exactly one module, next to mapVerdict.)

function svgElement<K extends string>(name: K): SVGElement {
  return document.createElementNS(SVG_NS, name);
}

/** The center glyphs, one stroke system (stroke width 2 in the 24-box,
 * round caps), authored here rather than borrowed from a glyph font:
 * spark = AI classes, lens = signed capture, query = unknown. */
function appendGlyph(svg: SVGElement, glyph: Glyph): void {
  if (glyph === "none") return;
  if (glyph === "spark") {
    const path = svgElement("path");
    path.setAttribute(
      "d",
      "M12 6.4 L13.6 10.4 L17.6 12 L13.6 13.6 L12 17.6 L10.4 13.6 " +
        "L6.4 12 L10.4 10.4 Z",
    );
    path.setAttribute("class", "glyph glyph-fill");
    svg.append(path);
    return;
  }
  if (glyph === "lens") {
    const iris = svgElement("circle");
    iris.setAttribute("cx", "12");
    iris.setAttribute("cy", "12");
    iris.setAttribute("r", "3.7");
    iris.setAttribute("class", "glyph glyph-stroke");
    const pupil = svgElement("circle");
    pupil.setAttribute("cx", "12");
    pupil.setAttribute("cy", "12");
    pupil.setAttribute("r", "1.3");
    pupil.setAttribute("class", "glyph glyph-fill");
    svg.append(iris, pupil);
    return;
  }
  const hook = svgElement("path");
  hook.setAttribute(
    "d",
    "M9.7 10a2.5 2.5 0 1 1 3.4 2.34c-.62.24-1.02.6-1.02 1.28v.28",
  );
  hook.setAttribute("class", "glyph glyph-stroke");
  const dot = svgElement("circle");
  dot.setAttribute("cx", "12.1");
  dot.setAttribute("cy", "16.6");
  dot.setAttribute("r", "1.15");
  dot.setAttribute("class", "glyph glyph-fill");
  svg.append(hook, dot);
}

/**
 * Builds one Evidence Ring as an inline SVG. Size comes from CSS via
 * `className` (badge chip, popover headline, signal miniature); state
 * colors key on the `data-ring` attribute. Decorative by design — the
 * accessible name lives on the containing control/text, so the SVG is
 * hidden from the tree.
 */
export function buildRing(state: RingState, className: string): SVGElement {
  const svg = svgElement("svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", className);
  svg.setAttribute("data-ring", state.hue);
  svg.setAttribute("aria-hidden", "true");

  const track = svgElement("circle");
  track.setAttribute("cx", "12");
  track.setAttribute("cy", "12");
  track.setAttribute("r", "10");
  track.setAttribute("class", "ring-track");

  const arc = svgElement("circle");
  arc.setAttribute("cx", "12");
  arc.setAttribute("cy", "12");
  arc.setAttribute("r", "10");
  // pathLength normalizes the circumference to 100, so dash geometry and
  // the sweep animation in the stylesheet speak in band percentages.
  arc.setAttribute("pathLength", "100");
  arc.setAttribute("stroke-dasharray", `${BANDS[state.band]} 100`);
  // Start the arc at 12 o'clock; dashes otherwise begin at 3 o'clock.
  arc.setAttribute("transform", "rotate(-90 12 12)");
  arc.setAttribute("class", "ring-arc");
  // The sweep animation's travel distance equals the band, so every band
  // draws on over the same duration and settles at its honest fill.
  arc.style.setProperty("--sweep", `${BANDS[state.band]}px`);

  svg.append(track, arc);
  appendGlyph(svg, state.glyph);
  return svg;
}
