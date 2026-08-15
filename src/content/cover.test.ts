// @vitest-environment jsdom
//
// jsdom computes no real styles (and its cssstyle backend misses modern
// properties entirely), so every test scripts computed styles through one
// getComputedStyle spy. The stubs mirror the browser's computed
// serializations — backgroundColor "rgba(0, 0, 0, 0)" for unset,
// backgroundImage "none" — because serialized strings are exactly what
// the predicate consumes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isOpaqueCoverAt } from "./cover";

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

  it("counts a background image (gradient) as paint", () => {
    const image = img();
    const scrim = el("div", {
      backgroundImage: "linear-gradient(rgb(0, 0, 0), rgba(0, 0, 0, 0))",
    });
    expect(isOpaqueCoverAt([scrim, image], image, null)).toBe(true);
  });

  it("counts a backdrop filter as paint (glass panels)", () => {
    const image = img();
    const glass = el("div", {
      backgroundColor: "rgba(255, 255, 255, 0.4)",
      backdropFilter: "blur(10px)",
    });
    expect(isOpaqueCoverAt([glass, image], image, null)).toBe(true);
  });

  it("counts replaced content as paint, unless opacity-hidden", () => {
    // A carousel's next slide stacked above ours is a real cover; a
    // settled-out crossfade frame at effective opacity 0 is not
    // (checkVisibility is the engine's own ancestor-opacity walk, absent
    // in this jsdom and scripted by assignment as elsewhere in the
    // suite).
    const image = img();
    const slide = img();
    expect(isOpaqueCoverAt([slide, image], image, null)).toBe(true);
    slide.checkVisibility = () => false;
    expect(isOpaqueCoverAt([slide, image], image, null)).toBe(false);
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
