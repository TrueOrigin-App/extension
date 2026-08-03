// @vitest-environment jsdom
//
// jsdom has no layout engine, so rects are mocked per image; what these
// tests pin is the lifecycle — keying, replacement, hiding, reaping,
// stale-URL dropping, host-rebuild re-adoption — not real geometry. The
// observer wiring in index.ts is real-browser soak territory (plan.md §6).
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  removeAllBadges,
  removeBadgeFor,
  renderBadge,
  syncBadges,
} from "./badge";

const RECT = { width: 100, height: 80, left: 10, top: 20 };
const COLLAPSED = { width: 0, height: 0, left: 0, top: 0 };

function asRect(rect: typeof RECT): DOMRect {
  return {
    ...rect,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    x: rect.left,
    y: rect.top,
    toJSON: () => rect,
  } as DOMRect;
}

function makeImage(src: string, rect: typeof RECT = RECT): HTMLImageElement {
  const image = document.createElement("img");
  image.src = src;
  document.body.append(image);
  vi.spyOn(image, "getBoundingClientRect").mockReturnValue(asRect(rect));
  return image;
}

function host(): HTMLElement | null {
  return document.getElementById("trueorigin-badge-host");
}

function badgeElements(): HTMLDivElement[] {
  return Array.from(
    host()?.shadowRoot?.querySelectorAll<HTMLDivElement>("div.badge") ?? [],
  );
}

afterEach(() => {
  removeAllBadges();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("renderBadge", () => {
  it("renders one badge per image and replaces rather than stacks", () => {
    const image = makeImage("https://example.com/a.jpg");
    renderBadge(image, "ai-declared", image.src);
    renderBadge(image, "unknown", image.src);

    const badges = badgeElements();
    expect(badges).toHaveLength(1);
    expect(badges[0]?.dataset["verdict"]).toBe("unknown");
    expect(badges[0]?.textContent).toBe("Unknown");
  });

  it("positions the badge over the image's top-left corner", () => {
    const image = makeImage("https://example.com/a.jpg");
    renderBadge(image, "ai-declared", image.src);

    const badge = badgeElements()[0];
    expect(badge?.style.left).toBe("18px");
    expect(badge?.style.top).toBe("28px");
  });

  it("hides a badge over a collapsed (hidden) image until it shows again", () => {
    const image = makeImage("https://example.com/a.jpg", COLLAPSED);
    renderBadge(image, "human-verified", image.src);
    expect(badgeElements()[0]?.style.display).toBe("none");

    vi.spyOn(image, "getBoundingClientRect").mockReturnValue(asRect(RECT));
    syncBadges();
    expect(badgeElements()[0]?.style.display).toBe("");
  });
});

describe("syncBadges", () => {
  it("removes the badge of an image that left the document and reports it", () => {
    const removedImage = makeImage("https://example.com/a.jpg");
    const keptImage = makeImage("https://example.com/b.jpg");
    renderBadge(removedImage, "ai-declared", removedImage.src);
    renderBadge(keptImage, "ai-declared", keptImage.src);

    removedImage.remove();
    const onImageRemoved = vi.fn();
    syncBadges(onImageRemoved);

    expect(badgeElements()).toHaveLength(1);
    expect(onImageRemoved).toHaveBeenCalledTimes(1);
    expect(onImageRemoved).toHaveBeenCalledWith(removedImage);
  });

  it("drops a badge whose image no longer displays its URL and reports it stale", () => {
    const image = makeImage("https://example.com/a.jpg");
    renderBadge(image, "human-verified", image.src);

    image.src = "https://example.com/b.jpg";
    const onImageRemoved = vi.fn();
    const onImageStale = vi.fn();
    syncBadges(onImageRemoved, onImageStale);

    expect(badgeElements()).toHaveLength(0);
    expect(onImageStale).toHaveBeenCalledTimes(1);
    expect(onImageStale).toHaveBeenCalledWith(image);
    expect(onImageRemoved).not.toHaveBeenCalled();
  });

  it("rebuilds a page-removed host and re-adopts live badges", () => {
    const image = makeImage("https://example.com/a.jpg");
    renderBadge(image, "ai-declared", image.src);

    host()?.remove();
    syncBadges();

    const badges = badgeElements();
    expect(badges).toHaveLength(1);
    expect(badges[0]?.isConnected).toBe(true);
    expect(badges[0]?.dataset["verdict"]).toBe("ai-declared");
  });
});

describe("removal", () => {
  it("removeBadgeFor removes only that image's badge", () => {
    const first = makeImage("https://example.com/a.jpg");
    const second = makeImage("https://example.com/b.jpg");
    renderBadge(first, "ai-declared", first.src);
    renderBadge(second, "unknown", second.src);

    removeBadgeFor(first);

    const badges = badgeElements();
    expect(badges).toHaveLength(1);
    expect(badges[0]?.dataset["verdict"]).toBe("unknown");

    // A fresh render after removal must attach a fresh badge — a
    // lingering map entry would resurrect the detached element instead.
    renderBadge(first, "ai-declared", first.src);
    expect(badgeElements()).toHaveLength(2);
  });

  it("removeAllBadges removes the overlay host itself", () => {
    const image = makeImage("https://example.com/a.jpg");
    renderBadge(image, "ai-declared", image.src);

    removeAllBadges();
    expect(host()).toBeNull();
  });
});
