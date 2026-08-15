// Paint-aware cover detection (roadmap chunk 3; owner-selected candidate,
// DECISIONS.md 2026-08-15). The overlay paints above every page stacking
// context, so page UI stacked above an image — a suggestions dropdown
// (google.com, corpus entry #1), a modal, a sticky bar — used to get our
// chip painted on top of it. The recorded rejection of plain hit-test
// heuristics stands (task 5.3 deferred finding): "something above the
// image" misfires on stretched-link cards, where a transparent interaction
// overlay legitimately covers every image and a badge matters most. The
// discriminator this module adds is *paint*: a stretched link or
// click-capture div is invisible — no background, no backdrop filter, no
// replaced content — while occluding UI paints pixels. "Covered" therefore
// means: an element stacked above the image at this point actually paints
// there.
//
// Known limits, recorded so the next field bug is a lookup:
// - An overlay with pointer-events: none never enters a hit stack, so an
//   opaque but pointer-transparent panel is invisible to this check (the
//   mirror of the parked pointer-events:none *image* limit).
// - Text paints but is not detected: a bare positioned text run with no
//   painted box anywhere above it keeps the chip visible under its glyphs
//   — the pre-existing behavior everywhere, and real occluders (Google's
//   dropdown included) carry an opaque container box that is detected.
// - Ancestors of the image never count as covers (their backgrounds paint
//   beneath it), which also means clip-based occlusion — an image scrolled
//   out of an inner scroller, probe point resolving to the bare container
//   — stays out of scope unless some non-ancestor content paints there.
// - Effective opacity multiplies only the candidate's own opacity;
//   an ancestor at fractional opacity is not walked (checkVisibility
//   catches the zero case). Over-counting is the accepted direction.

/** Below this effective alpha an element is treated as see-through: hover
 * scrims and dim layers (typically 0.3–0.6) must not hide a chip the
 * reader can still see the image behind. Real occluders are solid or
 * near-solid; glass panels at lower alpha are caught by their backdrop
 * filter instead. */
const OPAQUE_ALPHA = 0.9;

/** Replaced/embedded content paints regardless of background — an <img>
 * above the badged image (a carousel's next slide, a settled crossfade
 * frame) is a real cover. Inline <svg> is deliberately absent: its box is
 * routinely far larger than its painted shapes (icon overlays), so it
 * falls through to the background checks instead. */
const REPLACED_TAGS = new Set([
  "IMG",
  "VIDEO",
  "CANVAS",
  "IFRAME",
  "EMBED",
  "OBJECT",
]);

/** Alpha of a computed background-color. Computed values serialize as
 * rgb()/rgba() (the keyword `transparent` computes to rgba(0, 0, 0, 0));
 * an unrecognized serialization (color(), oklch() — authored wide-gamut
 * color) is far more likely a painted surface than transparency, so it
 * counts as opaque. An empty string (jsdom's unset default) is no paint. */
function backgroundAlpha(color: string): number {
  if (!color || color === "transparent") return 0;
  const match = /^rgba?\((.+)\)$/.exec(color);
  if (!match || match[1] === undefined) return 1;
  // Legacy comma form carries alpha as the 4th component; the modern
  // space-separated form carries it after a slash. No alpha term = 1.
  const body = match[1];
  const slashParts = body.split("/");
  const alphaTerm =
    slashParts.length === 2 ? slashParts[1] : body.split(",")[3];
  if (alphaTerm === undefined) return 1;
  const alpha = parseFloat(alphaTerm);
  return Number.isFinite(alpha) ? alpha : 1;
}

function hasBackdropFilter(style: CSSStyleDeclaration): boolean {
  const value =
    style.backdropFilter ||
    (style as { webkitBackdropFilter?: string }).webkitBackdropFilter;
  return typeof value === "string" && value !== "" && value !== "none";
}

/** Whether an element visibly paints its own box: replaced content, a
 * background image (gradients included — scrims mean to be seen), a
 * backdrop filter (visibly alters what is beneath at any fill alpha), or
 * a background color whose alpha — times the element's own opacity —
 * clears the threshold. checkVisibility is the engine's opacity walk for
 * the zero case up the ancestor chain; absent API degrades to "paints". */
function paints(element: Element): boolean {
  if (
    element.checkVisibility?.({
      opacityProperty: true,
      checkOpacity: true,
    }) === false
  ) {
    return false;
  }
  const style = getComputedStyle(element);
  const ownOpacity = parseFloat(style.opacity);
  const factor = Number.isFinite(ownOpacity) ? ownOpacity : 1;
  const alpha =
    REPLACED_TAGS.has(element.tagName) ||
    (style.backgroundImage && style.backgroundImage !== "none") ||
    hasBackdropFilter(style)
      ? 1
      : backgroundAlpha(style.backgroundColor);
  return alpha * factor >= OPAQUE_ALPHA;
}

/**
 * Walks a hit stack (top → bottom, as elementsFromPoint reports it) and
 * answers whether the image is occluded at that point by page UI that
 * actually paints. Our own overlay host retargets shadow-tree hits and is
 * skipped wherever it appears. Reaching the image — or any ancestor of it
 * — ends the search uncovered: everything deeper paints beneath the
 * image. The ancestor stop matters twice over: a pointer-events:none
 * image never enters a hit stack, so its opaque card parent would
 * otherwise read as a cover over every such image; and the page's own
 * body/html backgrounds terminate every stack without counting.
 */
export function isOpaqueCoverAt(
  stack: readonly Element[],
  image: HTMLImageElement,
  overlayHost: Element | null,
): boolean {
  for (const element of stack) {
    if (element === overlayHost) continue;
    if (element === image || element.contains(image)) return false;
    if (paints(element)) return true;
  }
  return false;
}
