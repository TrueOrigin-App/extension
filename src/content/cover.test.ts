// @vitest-environment jsdom
//
// jsdom computes no real styles (and its cssstyle backend misses modern
// properties entirely), so every test scripts computed styles through one
// getComputedStyle spy. The stubs mirror the browser's computed
// serializations — backgroundColor "rgba(0, 0, 0, 0)" for unset,
// backgroundImage "none" — because serialized strings are exactly what
// the predicate consumes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flattenShadowStack, isOpaqueCoverAt } from "./cover";

type StyleStub = Partial<{
  backgroundColor: string;
  backgroundImage: string;
  backdropFilter: string;
  webkitBackdropFilter: string;
  opacity: string;
}>;

const styles = new Map<Element, StyleStub>();

function el(tag: string, style: StyleStub = {}): HTMLElement {
  const element = document.createElement(tag);
  document.body.append(element);
  styles.set(element, style);
  return element;
}

function img(): HTMLImageElement {
  return el("img") as HTMLImageElement;
}

/** An image with a decodable frame — jsdom reports naturalWidth 0 for
 * every image, which the paint predicate reads as "no frame yet". */
function contentImg(width = 800, height = 600): HTMLImageElement {
  const image = img();
  Object.defineProperty(image, "naturalWidth", { value: width });
  Object.defineProperty(image, "naturalHeight", { value: height });
  return image;
}

beforeEach(() => {
  vi.spyOn(window, "getComputedStyle").mockImplementation(
    (target) =>
      ({
        backgroundColor: "rgba(0, 0, 0, 0)",
        backgroundImage: "none",
        backdropFilter: "none",
        opacity: "1",
        ...styles.get(target as Element),
      }) as CSSStyleDeclaration,
  );
});

afterEach(() => {
  styles.clear();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("isOpaqueCoverAt", () => {
  it("treats a transparent stretched-link overlay as no cover", () => {
    // The recorded misfire class (task 5.3): a card's whole-surface <a>
    // hit-tests above the image but paints nothing.
    const image = img();
    const link = el("a");
    expect(isOpaqueCoverAt([link, image], image, null)).toBe(false);
  });

  it("detects an opaque panel above the image", () => {
    const image = img();
    const panel = el("div", { backgroundColor: "rgb(255, 255, 255)" });
    expect(isOpaqueCoverAt([panel, image], image, null)).toBe(true);
  });

  it("detects the opaque container of a transparent hit target (dropdown row)", () => {
    // The Google shape: the probe hits a suggestion row (transparent),
    // but the dropdown container beneath it — still above the image —
    // carries the paint.
    const image = img();
    const container = el("div", { backgroundColor: "rgb(255, 255, 255)" });
    const row = document.createElement("div");
    container.append(row);
    styles.set(row, {});
    expect(isOpaqueCoverAt([row, container, image], image, null)).toBe(true);
  });

  it("lets a semi-transparent scrim through", () => {
    // Hover dims and gradient scrims sit well under the threshold; the
    // reader still sees the image, so the chip stays.
    const image = img();
    const scrim = el("div", { backgroundColor: "rgba(0, 0, 0, 0.5)" });
    expect(isOpaqueCoverAt([scrim, image], image, null)).toBe(false);
  });

  it("applies the alpha threshold at 0.9, comma and slash serializations alike", () => {
    const image = img();
    const nearlySolid = el("div", {
      backgroundColor: "rgba(20, 20, 20, 0.9)",
    });
    const modernHalf = el("div", {
      backgroundColor: "rgb(20 20 20 / 0.5)",
    });
    expect(isOpaqueCoverAt([nearlySolid, image], image, null)).toBe(true);
    expect(isOpaqueCoverAt([modernHalf, image], image, null)).toBe(false);
  });

  it("multiplies the element's own opacity into its paint alpha", () => {
    const image = img();
    const fading = el("div", {
      backgroundColor: "rgb(255, 255, 255)",
      opacity: "0.5",
    });
    const landed = el("div", {
      backgroundColor: "rgb(255, 255, 255)",
      opacity: "0.95",
    });
    expect(isOpaqueCoverAt([fading, image], image, null)).toBe(false);
    expect(isOpaqueCoverAt([landed, image], image, null)).toBe(true);
  });

  it("counts a gradient as paint only when every stop is opaque", () => {
    // Alpha interpolates linearly between stops, so the minimum stop
    // alpha floors the gradient everywhere it paints: a solid panel
    // gradient covers, while the ubiquitous caption-legibility gradient
    // (opaque at one edge, transparent at the other) guarantees nothing
    // at the probe point and must not hide the chip — the stretched-link
    // misfire class, re-admitted through gradients otherwise.
    const image = img();
    const panel = el("div", {
      backgroundImage: "linear-gradient(rgb(0, 0, 0), rgb(20, 20, 20))",
    });
    const caption = el("div", {
      backgroundImage:
        "linear-gradient(to top, rgba(0, 0, 0, 0.7), rgba(0, 0, 0, 0))",
    });
    expect(isOpaqueCoverAt([panel, image], image, null)).toBe(true);
    expect(isOpaqueCoverAt([caption, image], image, null)).toBe(false);
  });

  it("counts a url() background as paint (pixels unknowable)", () => {
    const image = img();
    const textured = el("div", {
      backgroundImage: 'url("https://example.com/texture.png")',
    });
    expect(isOpaqueCoverAt([textured, image], image, null)).toBe(true);
  });

  it("counts an obscuring backdrop blur as paint, not color nudges", () => {
    // Real glass panels blur at 10–16px and genuinely obscure the image;
    // a backdrop filter never makes its element opaque, so compositing
    // hints (blur(0px)) and color nudges (saturate) fall through to the
    // background checks instead of hiding chips beneath them forever.
    const image = img();
    const glass = el("div", {
      backgroundColor: "rgba(255, 255, 255, 0.4)",
      backdropFilter: "blur(10px)",
    });
    const tint = el("div", { backdropFilter: "saturate(1.05)" });
    const hint = el("div", {
      backgroundColor: "rgba(0, 0, 0, 0.4)",
      backdropFilter: "blur(0px)",
    });
    expect(isOpaqueCoverAt([glass, image], image, null)).toBe(true);
    expect(isOpaqueCoverAt([tint, image], image, null)).toBe(false);
    expect(isOpaqueCoverAt([hint, image], image, null)).toBe(false);
  });

  it("counts replaced content as paint, unless opacity-hidden", () => {
    // A carousel's next slide stacked above ours is a real cover; a
    // settled-out crossfade frame at effective opacity 0 is not
    // (checkVisibility is the engine's own ancestor-opacity walk, absent
    // in this jsdom and scripted by assignment as elsewhere in the
    // suite).
    const image = img();
    const slide = contentImg();
    expect(isOpaqueCoverAt([slide, image], image, null)).toBe(true);
    slide.checkVisibility = () => false;
    expect(isOpaqueCoverAt([slide, image], image, null)).toBe(false);
  });

  it("lets broken and 1×1 spacer images through (click shields)", () => {
    // The classic anti-save shield: a transparent 1×1 spacer stretched
    // over the photo. Its box covers everything and paints nothing.
    const image = img();
    const spacer = contentImg(1, 1);
    const broken = contentImg(0, 0);
    expect(isOpaqueCoverAt([spacer, image], image, null)).toBe(false);
    expect(isOpaqueCoverAt([broken, image], image, null)).toBe(false);
  });

  it("matches replaced tags case-insensitively (XHTML documents)", () => {
    // In application/xhtml+xml documents HTML tag names stay lowercase.
    const image = img();
    const slide = contentImg();
    Object.defineProperty(slide, "tagName", { value: "img" });
    expect(isOpaqueCoverAt([slide, image], image, null)).toBe(true);
  });

  it("composites translucent layers down the stack", () => {
    // No single layer clears the threshold, but stacked translucency can
    // read solid: source-over accumulation is what the compositor paints.
    const image = img();
    const card = el("div", { backgroundColor: "rgba(20, 20, 20, 0.7)" });
    const scrim = el("div", { backgroundColor: "rgba(0, 0, 0, 0.7)" });
    const dimA = el("div", { backgroundColor: "rgba(0, 0, 0, 0.5)" });
    const dimB = el("div", { backgroundColor: "rgba(0, 0, 0, 0.5)" });
    // 0.7 + 0.3 × 0.7 = 0.91 — visually solid, covered.
    expect(isOpaqueCoverAt([card, scrim, image], image, null)).toBe(true);
    // 0.5 + 0.5 × 0.5 = 0.75 — the reader still sees the image.
    expect(isOpaqueCoverAt([dimA, dimB, image], image, null)).toBe(false);
  });

  it("reads slash alpha in modern color functions", () => {
    // Tailwind v4's opacity system computes to oklab()/oklch() with a
    // slash alpha (number or percentage); a half-alpha scrim in any
    // notation must not read as opaque paint.
    const image = img();
    const scrim = el("div", { backgroundColor: "oklab(0 0 0 / 0.5)" });
    const percent = el("div", { backgroundColor: "oklab(0 0 0 / 50%)" });
    const solid = el("div", { backgroundColor: "oklab(0.2 0 0)" });
    expect(isOpaqueCoverAt([scrim, image], image, null)).toBe(false);
    expect(isOpaqueCoverAt([percent, image], image, null)).toBe(false);
    expect(isOpaqueCoverAt([solid, image], image, null)).toBe(true);
  });

  it("treats an unrecognized color serialization as paint", () => {
    // Authored wide-gamut colors (oklch, color()) reach the computed
    // value unconverted; an authored color is a painted surface.
    const image = img();
    const panel = el("div", { backgroundColor: "oklch(0.2 0.02 240)" });
    expect(isOpaqueCoverAt([panel, image], image, null)).toBe(true);
  });

  it("stops uncovered at the image and at any ancestor of it", () => {
    // Ancestor backgrounds paint beneath the image — and for a
    // pointer-events:none image (absent from every hit stack), the
    // opaque card parent must not read as a cover.
    const card = el("div", { backgroundColor: "rgb(255, 255, 255)" });
    const image = document.createElement("img");
    card.append(image);
    expect(isOpaqueCoverAt([image, card], image, null)).toBe(false);
    expect(isOpaqueCoverAt([card], image, null)).toBe(false);
  });

  it("skips the overlay's own host wherever it appears", () => {
    const image = img();
    const host = el("div", { backgroundColor: "rgb(0, 0, 0)" });
    expect(isOpaqueCoverAt([host, image], image, host)).toBe(false);
    expect(isOpaqueCoverAt([host, image], image, null)).toBe(true);
  });

  it("answers uncovered for an empty stack (offscreen probe)", () => {
    expect(isOpaqueCoverAt([], img(), null)).toBe(false);
  });
});

describe("flattenShadowStack", () => {
  it("pierces open shadow roots to find the real occluder", () => {
    // document.elementsFromPoint retargets shadow-tree hits to their
    // host: an unstyled <app-modal> whose dialog paints from a
    // shadow-tree div must still read as a cover.
    const image = img();
    const host = el("div");
    const shadow = host.attachShadow({ mode: "open" });
    const panel = document.createElement("div");
    shadow.append(panel);
    styles.set(panel, { backgroundColor: "rgb(20, 20, 20)" });
    shadow.elementsFromPoint = () => [panel];
    const stack = flattenShadowStack([host, image], 0, 0);
    expect(isOpaqueCoverAt(stack, image, null)).toBe(true);
  });

  it("stops at a slotted image only after its host's shadow occluders", () => {
    // A web component slots the badged image beneath a shadow-tree veil:
    // the document stack holds only the host (which light-contains the
    // image), and the light-tree ancestor stop must not fire before the
    // real occluder is tested.
    const host = el("div");
    const image = document.createElement("img");
    host.append(image);
    const shadow = host.attachShadow({ mode: "open" });
    const veil = document.createElement("div");
    shadow.append(veil);
    styles.set(veil, { backgroundColor: "rgb(20, 20, 20)" });
    shadow.elementsFromPoint = () => [veil, image];
    expect(isOpaqueCoverAt(flattenShadowStack([host], 0, 0), image, null)).toBe(
      true,
    );
    // With the veil see-through, the slotted image ends the walk
    // uncovered — before the host's light-tree containment can.
    styles.set(veil, {});
    expect(isOpaqueCoverAt(flattenShadowStack([host], 0, 0), image, null)).toBe(
      false,
    );
  });

  it("leaves stacks without open shadow roots untouched", () => {
    const image = img();
    const panel = el("div", { backgroundColor: "rgb(255, 255, 255)" });
    expect(flattenShadowStack([panel, image], 0, 0)).toEqual([panel, image]);
  });
});
