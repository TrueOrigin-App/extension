// Paint-aware cover detection (roadmap chunk 3; owner-selected candidate,
// DECISIONS.md 2026-08-15; paint semantics tightened in the PR #14 review
// fixes, same date). The overlay paints above every page stacking
// context, so page UI stacked above an image — a suggestions dropdown
// (google.com, corpus entry #1), a modal, a sticky bar — used to get our
// chip painted on top of it. The recorded rejection of plain hit-test
// heuristics stands (task 5.3 deferred finding): "something above the
// image" misfires on stretched-link cards, where a transparent interaction
// overlay legitimately covers every image and a badge matters most. The
// discriminator this module adds is *paint*: a stretched link or
// click-capture div is invisible — no background, no backdrop filter, no
// replaced content — while occluding UI paints pixels. "Covered" therefore
// means: elements stacked above the image at this point actually paint
// there, alone or composited.
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
// - Replaced content is opaque by assumption: a full-size *transparent*
//   image, video frame, or canvas used as a click shield reads as a cover
//   (the 0×0/1×1 spacer-img carve-out below catches the classic shield;
//   pixel readback for the rest is not worth its cost).
// - A url() background-image is opaque by assumption (its pixels are
//   unknowable without loading them): a background-image-based
//   transparent shield or small no-repeat sprite reads as a cover.
// - Closed shadow roots cannot be pierced: an occluder painted inside one
//   reads as its (usually unstyled) host — the pre-fix behavior, now
//   scoped to closed roots only.
// - A backdrop-filter counts as obscuring only via a strong blur; a
//   backdrop brightness(0)/contrast(0) that blacks the image out is not
//   detected (no field sighting; revisit on corpus evidence).

/** Below this effective alpha the stack above the image is treated as
 * see-through: hover scrims and dim layers (typically 0.3–0.6) must not
 * hide a chip the reader can still see the image behind. Real occluders
 * are solid or near-solid; glass panels at lower alpha are caught by
 * their backdrop blur instead. */
const OPAQUE_ALPHA = 0.9;

/** Replaced/embedded content paints regardless of background — an <img>
 * above the badged image (a carousel's next slide, a settled crossfade
 * frame) is a real cover. Inline <svg> is deliberately absent: its box is
 * routinely far larger than its painted shapes (icon overlays), so it
 * falls through to the background checks instead (recorded decision,
 * DECISIONS.md 2026-08-15). */
const REPLACED_TAGS = new Set([
  "IMG",
  "VIDEO",
  "CANVAS",
  "IFRAME",
  "EMBED",
  "OBJECT",
]);

/** Blur radius at and above which a backdrop-filter is treated as
 * obscuring what lies beneath. Real glass panels run blur(10–16px);
 * compositing hints (blur(0px)) and color nudges (saturate, slight
 * brightness) leave the image plainly recognizable and must not hide
 * its chip forever. */
const BACKDROP_BLUR_OBSCURES_PX = 8;

/** True unless the element is invisible by opacity — its own computed
 * opacity 0 or an ancestor's (group opacity multiplies down the tree, so
 * the engine's own walk does the checking). Both option spellings cover
 * Chromes on either side of the spec rename; a browser without the API
 * degrades to "visible". Shared by the cover predicate and the intent
 * sensor (badge.ts) so the compat quirk lives in exactly one place. */
export function opacityVisible(element: Element): boolean {
  return (
    element.checkVisibility?.({ opacityProperty: true, checkOpacity: true }) ??
    true
  );
}

/** Alpha of a computed CSS color, whatever function it arrived in.
 * Computed values carry alpha either as the legacy 4th comma component
 * (rgba/hsla) or after a slash — the form every modern function shares
 * (rgb(), oklab(), oklch(), lab(), color(), hwb() …), with number or
 * percentage terms. `transparent` computes to rgba(0, 0, 0, 0) but is
 * handled for scripted styles. A serialization with no recognizable
 * alpha term counts as opaque — an authored color is a painted surface —
 * and an empty string (jsdom's unset default) is no paint. */
function colorAlpha(color: string): number {
  if (!color || color === "transparent") return 0;
  const match = /^([a-z-]+)\((.+)\)$/i.exec(color);
  if (!match || match[2] === undefined) return 1;
  const body = match[2];
  const slashParts = body.split("/");
  const alphaTerm =
    slashParts.length === 2
      ? slashParts[1]
      : /^(?:rgba?|hsla?)$/i.test(match[1] ?? "")
        ? body.split(",")[3]
        : undefined;
  if (alphaTerm === undefined) return 1;
  const term = alphaTerm.trim();
  const alpha = parseFloat(term);
  if (!Number.isFinite(alpha)) return 1;
  return term.endsWith("%") ? alpha / 100 : alpha;
}

/** Guaranteed paint alpha of a background-image at any point it covers.
 * url() content is unknowable without its pixels and counts as opaque
 * (recorded limit). Gradients carry their colors in the serialization,
 * and alpha interpolates linearly between stops, so the minimum stop
 * alpha is a floor on the gradient's alpha everywhere it paints — which
 * is the honest answer for caption-legibility gradients (opaque at one
 * edge, fully transparent at the other): they guarantee nothing at the
 * probe point and must not hide the chip, while a gradient whose every
 * stop is opaque paints opaque everywhere. Unparseable → opaque, same
 * rationale as colors. */
function backgroundImageAlpha(backgroundImage: string): number {
  if (!backgroundImage || backgroundImage === "none") return 0;
  if (backgroundImage.includes("url(")) return 1;
  const colors = backgroundImage.match(
    /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^()]*\)/gi,
  );
  if (!colors) return 1;
  let min = 1;
  for (const color of colors) {
    min = Math.min(min, colorAlpha(color));
  }
  return min;
}

/** Whether a backdrop-filter genuinely obscures the backdrop. A backdrop
 * filter *transforms* what is beneath — it never makes the element
 * opaque — so only a strong blur counts; anything else falls through to
 * the background checks. */
function backdropObscures(style: CSSStyleDeclaration): boolean {
  const value =
    style.backdropFilter ||
    (style as { webkitBackdropFilter?: string }).webkitBackdropFilter;
  if (typeof value !== "string" || value === "" || value === "none") {
    return false;
  }
  let maxBlur = 0;
  for (const blur of value.matchAll(/blur\(\s*([\d.]+)px\s*\)/g)) {
    maxBlur = Math.max(maxBlur, parseFloat(blur[1] ?? "0"));
  }
  return maxBlur >= BACKDROP_BLUR_OBSCURES_PX;
}

/** Replaced content paints its box regardless of background — except an
 * <img> with no decodable frame (broken, still loading) or a 1×1 spacer
 * stretched over the content, the classic transparent click-shield: both
 * paint nothing worth yielding to and fall through to the background
 * checks. tagName is uppercased for XHTML documents, where HTML tag
 * names stay lowercase. */
function replacedPaints(element: Element): boolean {
  if (!REPLACED_TAGS.has(element.tagName.toUpperCase())) return false;
  if (element instanceof HTMLImageElement) {
    const { naturalWidth, naturalHeight } = element;
    if (naturalWidth === 0 || naturalHeight === 0) return false;
    if (naturalWidth === 1 && naturalHeight === 1) return false;
  }
  return true;
}

/** The effective alpha an element's own box contributes at a point it
 * covers: replaced content and obscuring glass count as full-alpha
 * surfaces; otherwise the stronger of its background color and its
 * background image's guaranteed alpha — everything multiplied by the
 * element's own opacity. checkVisibility is the engine's opacity walk
 * for the zero case up the ancestor chain; absent API degrades to
 * "paints". */
function paintAlpha(element: Element): number {
  if (!opacityVisible(element)) return 0;
  const style = getComputedStyle(element);
  const ownOpacity = parseFloat(style.opacity);
  const factor = Number.isFinite(ownOpacity) ? ownOpacity : 1;
  if (replacedPaints(element) || backdropObscures(style)) return factor;
  const alpha = Math.max(
    colorAlpha(style.backgroundColor),
    backgroundImageAlpha(style.backgroundImage),
  );
  return alpha * factor;
}

/** Expands shadow hosts in a document-level hit stack into the shadow
 * elements actually painting at the point. document.elementsFromPoint
 * retargets every shadow-tree hit to its host, so an unstyled host
 * wrapping an opaque shadow-tree panel would otherwise read as "paints
 * nothing" — the modal-over-image class on web-component pages. Each
 * open host is replaced by its own shadow stack at the point, filtered
 * to the host's subtree (a shadow root's elementsFromPoint can report
 * outside elements too), recursively, with the host kept after its
 * content: the host's own box still paints, and when it slots the badged
 * image the inner stack holds the image itself, so the walk's stop fires
 * on the real flat-tree geometry instead of the light tree. Closed
 * shadow roots cannot be pierced (recorded limit); absent API (jsdom)
 * leaves the stack untouched. */
export function flattenShadowStack(
  stack: readonly Element[],
  x: number,
  y: number,
  seen: Set<ShadowRoot> = new Set(),
): Element[] {
  const flat: Element[] = [];
  for (const element of stack) {
    const root = element.shadowRoot;
    if (
      root &&
      !seen.has(root) &&
      typeof root.elementsFromPoint === "function"
    ) {
      seen.add(root);
      const inner = root
        .elementsFromPoint(x, y)
        .filter(
          (candidate) =>
            candidate !== element &&
            (root.contains(candidate) || element.contains(candidate)),
        );
      flat.push(...flattenShadowStack(inner, x, y, seen), element);
    } else {
      flat.push(element);
    }
  }
  return flat;
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
 *
 * Layers composite on the way down: translucent UI stacked on translucent
 * UI can be visually solid even though no single layer clears the
 * threshold (a half-alpha scrim under a 0.7-alpha card). Source-over
 * accumulation is the same math the compositor runs.
 */
export function isOpaqueCoverAt(
  stack: readonly Element[],
  image: HTMLImageElement,
  overlayHost: Element | null,
): boolean {
  let accumulated = 0;
  for (const element of stack) {
    if (element === overlayHost) continue;
    if (element === image || element.contains(image)) return false;
    accumulated += (1 - accumulated) * paintAlpha(element);
    if (accumulated >= OPAQUE_ALPHA) return true;
  }
  return false;
}
