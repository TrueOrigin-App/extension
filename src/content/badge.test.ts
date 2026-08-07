// @vitest-environment jsdom
//
// jsdom has no layout engine, so rects are mocked per image; what these
// tests pin is the lifecycle — keying, replacement, hiding, reaping,
// stale-URL dropping, host-rebuild re-adoption, and the popover's
// open/dismiss rules — not real geometry. The observer wiring in index.ts
// is real-browser soak territory (plan.md §6).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VerdictId } from "../core/types";
import type { WireVerdict } from "../messaging/protocol";
import {
  clearPending,
  markPending,
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

function wire(verdict: VerdictId): WireVerdict {
  return { verdict, basis: [], signals: [], failures: [] };
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

// The overlay's shadow root is closed (host.shadowRoot is null by design —
// the leak-resistance test below pins that), so tests capture the root at
// creation by wrapping attachShadow.
let overlayRoot: ShadowRoot | null = null;
const attachShadow = Element.prototype.attachShadow;

beforeEach(() => {
  overlayRoot = null;
  vi.spyOn(Element.prototype, "attachShadow").mockImplementation(function (
    this: Element,
    init: ShadowRootInit,
  ): ShadowRoot {
    overlayRoot = attachShadow.call(this, init);
    return overlayRoot;
  });
});

function badgeElements(): HTMLButtonElement[] {
  return Array.from(
    overlayRoot?.querySelectorAll<HTMLButtonElement>("button.badge") ?? [],
  );
}

function popoverElements(): HTMLDivElement[] {
  return Array.from(
    overlayRoot?.querySelectorAll<HTMLDivElement>(".popover") ?? [],
  );
}

function pointerDownOn(target: EventTarget): void {
  target.dispatchEvent(
    new Event("pointerdown", { bubbles: true, composed: true }),
  );
}

// The intent sensor asks document.elementsFromPoint what sits under the
// pointer (jsdom has no hit tester, so the stack is scripted per test).
// movePointer stands in for real cursor movement: the dispatch target is
// whatever the page would hit-test first — the image, or a page overlay
// covering it — while the scripted stack is what the engine would report
// beneath the point. Multi-pointer tests script hitStacks per coordinate
// instead, since the sensor tracks hover and touch points separately and
// re-probes each at its own position.
let hitStacks: (x: number, y: number) => Element[];

beforeEach(() => {
  hitStacks = () => [];
  document.elementsFromPoint = vi.fn((x: number, y: number) => hitStacks(x, y));
});

function movePointer(
  over: Element[],
  target: EventTarget = document.body,
): void {
  hitStacks = () => over;
  target.dispatchEvent(
    new MouseEvent("pointermove", { bubbles: true, clientX: 40, clientY: 40 }),
  );
}

/** Raw pointer-event dispatch for the sensor's per-pointer-type paths.
 * jsdom's PointerEvent support is incomplete, so pointerType rides on a
 * MouseEvent the same way animationName does elsewhere in this file. */
function dispatchPointer(
  type: string,
  init: {
    x?: number;
    y?: number;
    pointerType?: string;
    relatedTarget?: Element;
  } = {},
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    clientX: init.x ?? 40,
    clientY: init.y ?? 40,
    relatedTarget: init.relatedTarget ?? null,
  });
  if (init.pointerType) Object.assign(event, { pointerType: init.pointerType });
  document.body.dispatchEvent(event);
}

function pointerExitsWindow(): void {
  document.body.dispatchEvent(new MouseEvent("pointerout", { bubbles: true }));
}

afterEach(() => {
  removeAllBadges();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, "elementsFromPoint");
});

describe("renderBadge", () => {
  it("renders one badge per image and replaces rather than stacks", () => {
    const image = makeImage("https://example.com/a.jpg");
    renderBadge(image, wire("ai-declared"), image.src);
    renderBadge(image, wire("unknown"), image.src);

    const badges = badgeElements();
    expect(badges).toHaveLength(1);
    expect(badges[0]?.dataset["verdict"]).toBe("unknown");
    expect(badges[0]?.textContent).toBe("Unknown");
  });

  it("positions the badge over the image's top-left corner", () => {
    const image = makeImage("https://example.com/a.jpg");
    renderBadge(image, wire("ai-declared"), image.src);

    const badge = badgeElements()[0];
    expect(badge?.style.left).toBe("18px");
    expect(badge?.style.top).toBe("28px");
  });

  it("hides a badge over a collapsed (hidden) image until it shows again", () => {
    const image = makeImage("https://example.com/a.jpg", COLLAPSED);
    renderBadge(image, wire("human-verified"), image.src);
    expect(badgeElements()[0]?.style.display).toBe("none");

    vi.spyOn(image, "getBoundingClientRect").mockReturnValue(asRect(RECT));
    syncBadges();
    expect(badgeElements()[0]?.style.display).toBe("");
  });

  it("renders the badge as a button wired for the popover", () => {
    const image = makeImage("https://example.com/a.jpg");
    renderBadge(image, wire("ai-declared"), image.src);

    const badge = badgeElements()[0];
    expect(badge?.type).toBe("button");
    expect(badge?.getAttribute("aria-haspopup")).toBe("dialog");
    expect(badge?.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps the overlay unreadable by page script (closed shadow root)", () => {
    // The analysis may have acquired bytes the page itself cannot read
    // (the worker's credentialed CORS-exempt fallback); an open root
    // would hand the verdict and provenance details to page script via
    // host.shadowRoot.
    const image = makeImage("https://example.com/a.jpg");
    renderBadge(image, wire("ai-declared"), image.src);

    expect(overlayRoot?.mode).toBe("closed");
    expect(host()?.shadowRoot).toBeNull();
  });
});

describe("popover", () => {
  it("opens on badge click and closes on a second click", () => {
    const image = makeImage("https://example.com/a.jpg");
    renderBadge(image, wire("ai-declared"), image.src);
    const badge = badgeElements()[0]!;

    badge.click();
    const popover = popoverElements()[0];
    expect(popover?.getAttribute("role")).toBe("dialog");
    expect(popover?.querySelector(".headline")?.textContent).toBe(
      "Made with AI",
    );
    expect(badge.getAttribute("aria-expanded")).toBe("true");
    // Inserted right after the badge, so tab order flows into the panel.
    expect(badge.nextElementSibling).toBe(popover);

    badge.click();
    expect(popoverElements()).toHaveLength(0);
    expect(badge.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps the [hidden] collapse effective under the evidence grid", () => {
    // Regression pin: .evidence sets display: grid, which would override
    // the UA's [hidden] { display: none } — without an explicit
    // .evidence[hidden] rule the disclosure could never visually collapse
    // (jsdom asserts the attribute, not computed display, so only the
    // stylesheet text can pin this here).
    const image = makeImage("https://example.com/a.jpg");
    renderBadge(image, wire("unknown"), image.src);
    const style = overlayRoot?.querySelector("style")?.textContent;
    expect(style).toContain(".evidence[hidden]");
  });

  it("pins the explicit direction reset (all:initial excludes direction)", () => {
    // Regression pin: the CSS "all" property excludes direction and
    // unicode-bidi by spec, so without an explicit reset an RTL host page
    // re-orders the overlay's English text (verified live). jsdom doesn't
    // cascade shadow stylesheets, so pin the stylesheet text.
    const image = makeImage("https://example.com/a.jpg");
    renderBadge(image, wire("unknown"), image.src);
    const style = overlayRoot?.querySelector("style")?.textContent;
    expect(style).toContain("direction: ltr");
  });

  it("describes badge and popover with the image's alt text when present", () => {
    const image = makeImage("https://example.com/a.jpg");
    image.alt = "Sunset over hills";
    renderBadge(image, wire("ai-declared"), image.src);
    const badge = badgeElements()[0]!;
    // Alt rides as the accessible description: the name stays the short
    // visible label (page alt can be paragraph-length, and the name is
    // what voice-control users must speak).
    expect(badge.getAttribute("aria-label")).toBeNull();
    expect(badge.getAttribute("aria-description")).toBe("Sunset over hills");

    badge.click();
    const popover = popoverElements()[0];
    expect(popover?.getAttribute("aria-label")).toBe("Made with AI — details");
    expect(popover?.getAttribute("aria-description")).toBe("Sunset over hills");
  });

  it("marks the overlay as English for assistive tech", () => {
    const image = makeImage("https://example.com/a.jpg");
    renderBadge(image, wire("ai-declared"), image.src);
    expect(host()?.getAttribute("lang")).toBe("en");
  });

  it("keeps at most one popover open, switching to the last badge clicked", () => {
    const first = makeImage("https://example.com/a.jpg");
    const second = makeImage("https://example.com/b.jpg");
    renderBadge(first, wire("ai-declared"), first.src);
    renderBadge(second, wire("unknown"), second.src);

    badgeElements()[0]!.click();
    badgeElements()[1]!.click();

    const popovers = popoverElements();
    expect(popovers).toHaveLength(1);
    expect(popovers[0]?.querySelector(".headline")?.textContent).toBe(
      "Unknown",
    );
    expect(badgeElements()[0]?.getAttribute("aria-expanded")).toBe("false");
  });

  it("closes on Escape from inside the overlay, consumed, refocusing the badge", () => {
    const image = makeImage("https://example.com/a.jpg");
    renderBadge(image, wire("ai-declared"), image.src);
    const badge = badgeElements()[0]!;
    const focus = vi.spyOn(badge, "focus");

    badge.click();
    const escape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      composed: true,
      cancelable: true,
    });
    popoverElements()[0]!.dispatchEvent(escape);

    expect(popoverElements()).toHaveLength(0);
    expect(badge.getAttribute("aria-expanded")).toBe("false");
    expect(focus).toHaveBeenCalledTimes(1);
    // Plain focus() — Escape is keyboard navigation, so scrolling the
    // badge into view keeps the focus indicator visible (contrast with
    // the preventScroll pointer-dismiss rescue below).
    expect(focus).toHaveBeenCalledWith();
    // Consumed: native Escape defaults (<dialog> cancel, fullscreen exit)
    // must not also fire — one keypress dismisses exactly one layer.
    expect(escape.defaultPrevented).toBe(true);
  });

  it("leaves an Escape aimed at page UI to the page", () => {
    const image = makeImage("https://example.com/a.jpg");
    renderBadge(image, wire("ai-declared"), image.src);
    badgeElements()[0]!.click();

    // Focus/origin outside the overlay: the page owns this keypress.
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(popoverElements()).toHaveLength(1);

    // Mid-IME-composition Escape cancels the composition, nothing else.
    popoverElements()[0]!.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        composed: true,
        isComposing: true,
      }),
    );
    expect(popoverElements()).toHaveLength(1);
  });

  it("closes on pointerdown outside, stays open on pointerdown inside", () => {
    const image = makeImage("https://example.com/a.jpg");
    renderBadge(image, wire("ai-declared"), image.src);
    badgeElements()[0]!.click();

    pointerDownOn(popoverElements()[0]!);
    expect(popoverElements()).toHaveLength(1);

    pointerDownOn(document.body);
    expect(popoverElements()).toHaveLength(0);
  });

  it("does not treat a main-scrollbar drag as an outside click", () => {
    const image = makeImage("https://example.com/a.jpg");
    renderBadge(image, wire("ai-declared"), image.src);
    badgeElements()[0]!.click();

    // Chrome dispatches main-scrollbar drags as pointerdown on the root
    // element, at coordinates outside its client box (the gutter).
    vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(
      800,
    );
    vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(
      600,
    );
    document.documentElement.dispatchEvent(
      new MouseEvent("pointerdown", {
        bubbles: true,
        clientX: 810,
        clientY: 100,
      }),
    );
    expect(popoverElements()).toHaveLength(1);

    // A genuine click on the page background still closes.
    document.documentElement.dispatchEvent(
      new MouseEvent("pointerdown", {
        bubbles: true,
        clientX: 400,
        clientY: 100,
      }),
    );
    expect(popoverElements()).toHaveLength(0);
  });

  it("does not treat an overlay-scrollbar drag as an outside click", () => {
    const image = makeImage("https://example.com/a.jpg");
    renderBadge(image, wire("ai-declared"), image.src);
    badgeElements()[0]!.click();

    // Overlay scrollbars (macOS default) take no layout space: clientWidth
    // equals innerWidth and the thumb floats inside the client box along
    // the window edge (verified live — the gutter test alone never fires).
    vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(
      window.innerWidth,
    );
    vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(
      600,
    );
    vi.spyOn(document.documentElement, "scrollHeight", "get").mockReturnValue(
      2000,
    );
    document.documentElement.dispatchEvent(
      new MouseEvent("pointerdown", {
        bubbles: true,
        clientX: window.innerWidth - 8,
        clientY: 300,
      }),
    );
    expect(popoverElements()).toHaveLength(1);

    // Away from the edge band, a root-targeted click still closes.
    document.documentElement.dispatchEvent(
      new MouseEvent("pointerdown", {
        bubbles: true,
        clientX: 500,
        clientY: 300,
      }),
    );
    expect(popoverElements()).toHaveLength(0);
  });

  it("closes when focus moves into an iframe", () => {
    const image = makeImage("https://example.com/a.jpg");
    renderBadge(image, wire("ai-declared"), image.src);
    badgeElements()[0]!.click();

    // Cross-document iframes swallow pointer and key events; the window
    // blur their focus causes is the only dismiss signal that crosses.
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    vi.spyOn(document, "activeElement", "get").mockReturnValue(iframe);
    window.dispatchEvent(new Event("blur"));

    expect(popoverElements()).toHaveLength(0);
  });

  it("returns focus to the badge when a close removes a focused panel", () => {
    const image = makeImage("https://example.com/a.jpg");
    renderBadge(image, wire("ai-declared"), image.src);
    const badge = badgeElements()[0]!;
    badge.click();
    popoverElements()[0]!
      .querySelector<HTMLButtonElement>(".disclosure")!
      .focus();
    const focus = vi.spyOn(badge, "focus");

    pointerDownOn(document.body);

    expect(popoverElements()).toHaveLength(0);
    // Without the rescue, focus silently falls to <body> and the next Tab
    // restarts from the top of the page.
    expect(focus).toHaveBeenCalledTimes(1);
    // …but a pointer dismiss must not move the page: without
    // preventScroll, dismissing after scrolling away yanked the viewport
    // back to the badge (task-5.5 soak finding). Escape keeps the plain
    // scrolling focus() — that path is deliberate keyboard navigation.
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("keeps overlay interaction events from reaching page handlers", () => {
    const image = makeImage("https://example.com/a.jpg");
    renderBadge(image, wire("ai-declared"), image.src);
    const badge = badgeElements()[0]!;
    const seen = vi.fn();
    document.addEventListener("click", seen);
    document.addEventListener("pointerdown", seen);
    try {
      badge.dispatchEvent(
        new MouseEvent("click", { bubbles: true, composed: true }),
      );
      badge.dispatchEvent(
        new Event("pointerdown", { bubbles: true, composed: true }),
      );
      // A page-level outside-click or hotkey handler must never see
      // interactions with the overlay.
      expect(seen).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("click", seen);
      document.removeEventListener("pointerdown", seen);
    }
  });

  it("consumes wheel events over the panel instead of scrolling the page", () => {
    // overscroll-behavior only engages where scrollable overflow exists
    // (verified live: the page scrolled under the open dialog), so the
    // panel consumes wheel unconditionally and routes the delta itself.
    const image = makeImage("https://example.com/a.jpg");
    renderBadge(image, wire("ai-declared"), image.src);
    badgeElements()[0]!.click();

    const wheel = new WheelEvent("wheel", {
      bubbles: true,
      composed: true,
      cancelable: true,
      deltaY: 120,
    });
    popoverElements()[0]!.querySelector(".explain")!.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(true);
  });

  it("lets Ctrl+wheel (browser zoom, pinch) through the panel", () => {
    // Chrome dispatches trackpad pinch as wheel with ctrlKey set, and
    // Ctrl+scroll is zoom on every platform. Consuming those would
    // silently block zoom whenever the pointer rests on an open panel.
    const image = makeImage("https://example.com/a.jpg");
    renderBadge(image, wire("ai-declared"), image.src);
    badgeElements()[0]!.click();

    const zoom = new WheelEvent("wheel", {
      bubbles: true,
      composed: true,
      cancelable: true,
      deltaY: 120,
      ctrlKey: true,
    });
    popoverElements()[0]!.querySelector(".explain")!.dispatchEvent(zoom);
    expect(zoom.defaultPrevented).toBe(false);
  });

  it("closes when its image's badge is removed", () => {
    const image = makeImage("https://example.com/a.jpg");
    renderBadge(image, wire("ai-declared"), image.src);
    badgeElements()[0]!.click();

    removeBadgeFor(image);
    expect(popoverElements()).toHaveLength(0);
  });

  it("closes via sync when its image goes stale, survives other churn", () => {
    const kept = makeImage("https://example.com/a.jpg");
    const churned = makeImage("https://example.com/b.jpg");
    renderBadge(kept, wire("ai-declared"), kept.src);
    renderBadge(churned, wire("unknown"), churned.src);
    badgeElements()[0]!.click();

    churned.src = "https://example.com/c.jpg";
    syncBadges();
    expect(popoverElements()).toHaveLength(1);

    kept.src = "https://example.com/d.jpg";
    syncBadges();
    expect(popoverElements()).toHaveLength(0);
  });

  it("closes via sync when its image's rect collapses", () => {
    const image = makeImage("https://example.com/a.jpg");
    renderBadge(image, wire("ai-declared"), image.src);
    badgeElements()[0]!.click();

    vi.spyOn(image, "getBoundingClientRect").mockReturnValue(asRect(COLLAPSED));
    syncBadges();
    expect(popoverElements()).toHaveLength(0);
  });

  it("refreshes an open popover when its badge re-renders", () => {
    const image = makeImage("https://example.com/a.jpg");
    renderBadge(image, wire("ai-declared"), image.src);
    badgeElements()[0]!.click();

    renderBadge(image, wire("unknown"), image.src);

    const popover = popoverElements()[0];
    expect(popover?.querySelector(".headline")?.textContent).toBe("Unknown");
    expect(popover?.getAttribute("aria-label")).toBe("Unknown — details");
  });

  it("keeps the panel's content on a same-verdict re-render", () => {
    const image = makeImage("https://example.com/a.jpg");
    const verdict = wire("ai-declared");
    renderBadge(image, verdict, image.src);
    badgeElements()[0]!.click();
    const disclosure =
      popoverElements()[0]!.querySelector<HTMLButtonElement>(".disclosure")!;
    disclosure.click();
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");

    // Position churn re-renders with the identical cached verdict object;
    // rebuilding then would reset disclosure state and detach focus.
    renderBadge(image, verdict, image.src);

    expect(
      popoverElements()[0]
        ?.querySelector(".disclosure")
        ?.getAttribute("aria-expanded"),
    ).toBe("true");
  });

  it("closes the popover when a re-render finds the image collapsed", () => {
    const image = makeImage("https://example.com/a.jpg");
    renderBadge(image, wire("ai-declared"), image.src);
    badgeElements()[0]!.click();

    // A cached verdict can resolve in the same frame a carousel hides the
    // slide — before any sync pass sees the collapsed rect.
    vi.spyOn(image, "getBoundingClientRect").mockReturnValue(asRect(COLLAPSED));
    renderBadge(image, wire("unknown"), image.src);

    expect(popoverElements()).toHaveLength(0);
  });

  it("is re-adopted after its badge when the host is rebuilt", () => {
    const image = makeImage("https://example.com/a.jpg");
    renderBadge(image, wire("ai-declared"), image.src);
    badgeElements()[0]!.click();

    host()?.remove();
    syncBadges();

    const badge = badgeElements()[0];
    const popover = popoverElements()[0];
    expect(popover?.isConnected).toBe(true);
    expect(badge?.nextElementSibling).toBe(popover);
  });
});

describe("syncBadges", () => {
  it("removes the badge of an image that left the document and reports it", () => {
    const removedImage = makeImage("https://example.com/a.jpg");
    const keptImage = makeImage("https://example.com/b.jpg");
    renderBadge(removedImage, wire("ai-declared"), removedImage.src);
    renderBadge(keptImage, wire("ai-declared"), keptImage.src);

    removedImage.remove();
    const onImageRemoved = vi.fn();
    syncBadges(onImageRemoved);

    expect(badgeElements()).toHaveLength(1);
    expect(onImageRemoved).toHaveBeenCalledTimes(1);
    expect(onImageRemoved).toHaveBeenCalledWith(removedImage);
  });

  it("drops a badge whose image no longer displays its URL and reports it stale", () => {
    const image = makeImage("https://example.com/a.jpg");
    renderBadge(image, wire("human-verified"), image.src);

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
    renderBadge(image, wire("ai-declared"), image.src);

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
    renderBadge(first, wire("ai-declared"), first.src);
    renderBadge(second, wire("unknown"), second.src);

    removeBadgeFor(first);

    const badges = badgeElements();
    expect(badges).toHaveLength(1);
    expect(badges[0]?.dataset["verdict"]).toBe("unknown");

    // A fresh render after removal must attach a fresh badge — a
    // lingering map entry would resurrect the detached element instead.
    renderBadge(first, wire("ai-declared"), first.src);
    expect(badgeElements()).toHaveLength(2);
  });

  it("removeAllBadges removes the overlay host itself", () => {
    const image = makeImage("https://example.com/a.jpg");
    renderBadge(image, wire("ai-declared"), image.src);

    removeAllBadges();
    expect(host()).toBeNull();
  });
});

// Owner decision 2026-08-05 (DECISIONS.md, Phase 3 ask round): Unknown
// badges render on intent only; strong verdicts assert unprompted.
// Pointer intent arrives through the shared document-level sensor
// (elementsFromPoint hit stacks), not listeners on the image — pages that
// cover their images with overlays starve the image of pointer events
// entirely (the Instagram field bug, 2026-08-06).
describe("intent-gated presence", () => {
  it("hides Unknown badges until the pointer is over the image, then re-hides", () => {
    vi.useFakeTimers();
    const image = makeImage("https://example.com/a.jpg");
    renderBadge(image, wire("unknown"), image.src);
    const badge = badgeElements()[0]!;
    expect(badge.dataset["presence"]).toBe("hidden");

    movePointer([image]);
    expect(badge.dataset["presence"]).toBe("shown");

    movePointer([]);
    vi.runAllTimers();
    expect(badge.dataset["presence"]).toBe("hidden");
    vi.useRealTimers();
  });

  it("reveals through a page overlay covering the image (Instagram field bug)", () => {
    // Instagram stacks a click-capture div over every feed slide: all
    // pointer events target the overlay and the image never fires a
    // boundary event. The sensor must reveal from the hit stack — which
    // includes covered elements — not from the event's target.
    const image = makeImage("https://example.com/covered.jpg");
    const overlay = document.createElement("div");
    document.body.append(overlay);
    renderBadge(image, wire("unknown"), image.src);
    const badge = badgeElements()[0]!;

    movePointer([overlay, image], overlay);
    expect(badge.dataset["presence"]).toBe("shown");
  });

  it("does not reveal an image absent from the hit stack (clipped carousel slide)", () => {
    // The off-screen neighbor of a carousel's visible slide is connected
    // and full-size but clipped away; the engine's hit stack excludes it,
    // so pointer traffic elsewhere must not reveal its badge.
    const visible = makeImage("https://example.com/visible.jpg");
    const clipped = makeImage("https://example.com/clipped.jpg");
    renderBadge(visible, wire("unknown"), visible.src);
    renderBadge(clipped, wire("unknown"), clipped.src);

    movePointer([visible]);
    expect(badgeElements()[0]?.dataset["presence"]).toBe("shown");
    expect(badgeElements()[1]?.dataset["presence"]).toBe("hidden");
  });

  it("never gates strong verdicts", () => {
    const image = makeImage("https://example.com/b.jpg");
    renderBadge(image, wire("ai-declared"), image.src);
    expect(badgeElements()[0]?.dataset["presence"]).toBeUndefined();
  });

  it("reveals when keyboard focus reaches the badge", () => {
    const image = makeImage("https://example.com/c.jpg");
    renderBadge(image, wire("unknown"), image.src);
    const badge = badgeElements()[0]!;
    badge.dispatchEvent(new Event("focusin"));
    expect(badge.dataset["presence"]).toBe("shown");
  });

  it("holds the reveal while the badge's popover is open", () => {
    vi.useFakeTimers();
    const image = makeImage("https://example.com/d.jpg");
    renderBadge(image, wire("unknown"), image.src);
    const badge = badgeElements()[0]!;
    movePointer([image]);
    badge.click();
    movePointer([]);
    vi.runAllTimers();
    expect(badge.dataset["presence"]).toBe("shown");
    vi.useRealTimers();
  });

  it("re-gates when a re-analysis lands back on Unknown", () => {
    const image = makeImage("https://example.com/e.jpg");
    renderBadge(image, wire("unknown"), image.src);
    renderBadge(image, wire("ai-declared"), image.src);
    const badge = badgeElements()[0]!;
    expect(badge.dataset["presence"]).toBeUndefined();
    renderBadge(image, wire("unknown"), image.src);
    expect(badge.dataset["presence"]).toBe("hidden");
  });

  it("keeps an in-place downgrade to Unknown visible while its popover is open", () => {
    // Gate creation honors the same holds as the hide timer: hiding here
    // would strand a visible dialog on an invisible aria-expanded button.
    const image = makeImage("https://example.com/f.jpg");
    renderBadge(image, wire("ai-declared"), image.src);
    badgeElements()[0]!.click();
    renderBadge(image, wire("unknown"), image.src);
    expect(badgeElements()[0]?.dataset["presence"]).toBe("shown");
    expect(popoverElements()).toHaveLength(1);
  });

  it("holds the reveal under a pointer resting on the image, not just the badge", () => {
    // A hide scheduled by a popover close (or the pending handoff) fires
    // while the pointer sits mid-image with no further movement: the
    // fire-time guard re-checks the hit stack at the pointer's last
    // position, which scrolling and layout cannot invalidate (viewport
    // coordinates).
    vi.useFakeTimers();
    const image = makeImage("https://example.com/rest.jpg");
    markPending(image);
    movePointer([image]);
    renderBadge(image, wire("unknown"), image.src);
    const badge = badgeElements()[0]!;
    expect(badge.dataset["presence"]).toBe("shown");

    // Open and light-dismiss the popover: the close schedules a hide
    // that lands under the stationary pointer.
    badge.click();
    pointerDownOn(document.body);
    vi.runAllTimers();
    expect(badge.dataset["presence"]).toBe("shown");

    // The pointer finally moves off: the ordinary hide applies.
    movePointer([]);
    vi.runAllTimers();
    expect(badge.dataset["presence"]).toBe("hidden");
    vi.useRealTimers();
  });

  it("hides revealed badges when the pointer leaves the window", () => {
    vi.useFakeTimers();
    const image = makeImage("https://example.com/exit.jpg");
    renderBadge(image, wire("unknown"), image.src);
    movePointer([image]);
    expect(badgeElements()[0]?.dataset["presence"]).toBe("shown");

    pointerExitsWindow();
    vi.runAllTimers();
    expect(badgeElements()[0]?.dataset["presence"]).toBe("hidden");
    vi.useRealTimers();
  });

  it("removeAllBadges tears down the window-level intent sensor", () => {
    const image = makeImage("https://example.com/gone.jpg");
    renderBadge(image, wire("unknown"), image.src);
    const badge = badgeElements()[0]!;
    removeAllBadges();
    // The sensor listens on the window (§8: the overlay must be
    // removable); without the teardown it would keep hit-testing and
    // firing reveals against detached badges for the page's lifetime.
    movePointer([image]);
    expect(badge.dataset["presence"]).toBe("hidden");
  });

  it("keeps a touch tap's reveal past the lift, until the next tap lands elsewhere", () => {
    // A tap's trailing pointerout (relatedTarget null on touch lift) must
    // not clear the touch point: the badge would hide 200ms after every
    // tap — before the second tap that opens the popover, touch's only
    // path in. The point is sticky past lift, like Chrome's post-tap
    // :hover that held the old per-image gate.
    vi.useFakeTimers();
    const image = makeImage("https://example.com/tapped.jpg");
    renderBadge(image, wire("unknown"), image.src);
    const badge = badgeElements()[0]!;
    hitStacks = (x) => (x === 40 ? [image] : []);

    dispatchPointer("pointerdown", { x: 40, y: 40, pointerType: "touch" });
    expect(badge.dataset["presence"]).toBe("shown");
    dispatchPointer("pointerout", { pointerType: "touch" });
    vi.runAllTimers();
    expect(badge.dataset["presence"]).toBe("shown");

    // Intent moves on: the next tap lands elsewhere and the reveal fades.
    dispatchPointer("pointerdown", { x: 300, y: 300, pointerType: "touch" });
    dispatchPointer("pointerout", { pointerType: "touch" });
    vi.runAllTimers();
    expect(badge.dataset["presence"]).toBe("hidden");
    vi.useRealTimers();
  });

  it("keeps a mouse-held reveal when an unrelated touch taps elsewhere", () => {
    // Hover and touch points are tracked separately: with a single shared
    // slot, the tap's pointerdown overwrites — and its lift nulls — the
    // state holding the mouse reveal, hiding the badge under a
    // stationary cursor with no boundary event left to re-reveal it.
    vi.useFakeTimers();
    const image = makeImage("https://example.com/mouse-held.jpg");
    renderBadge(image, wire("unknown"), image.src);
    const badge = badgeElements()[0]!;
    hitStacks = (x) => (x === 40 ? [image] : []);

    dispatchPointer("pointermove", { x: 40, y: 40 });
    expect(badge.dataset["presence"]).toBe("shown");
    dispatchPointer("pointerdown", { x: 300, y: 300, pointerType: "touch" });
    dispatchPointer("pointerout", { pointerType: "touch" });
    vi.runAllTimers();
    expect(badge.dataset["presence"]).toBe("shown");
    vi.useRealTimers();
  });

  it("lets go of the touch point when the touch becomes a scroll (pointercancel)", () => {
    vi.useFakeTimers();
    const image = makeImage("https://example.com/flicked.jpg");
    renderBadge(image, wire("unknown"), image.src);
    const badge = badgeElements()[0]!;
    hitStacks = (x) => (x === 40 ? [image] : []);

    dispatchPointer("pointerdown", { x: 40, y: 40, pointerType: "touch" });
    expect(badge.dataset["presence"]).toBe("shown");
    // The flick turns into a scroll: no tap intent, no sticky point.
    dispatchPointer("pointercancel", { pointerType: "touch" });
    dispatchPointer("pointerout", { pointerType: "touch" });
    vi.runAllTimers();
    expect(badge.dataset["presence"]).toBe("hidden");
    vi.useRealTimers();
  });

  it("hides the reveal when the pointer crosses into an iframe", () => {
    // Entering a cross-document iframe fires pointerout with the iframe
    // as relatedTarget — and then no further pointer events reach this
    // document. Without treating that as "pointer gone", the reveal sits
    // pinned open for as long as the reader works inside the frame.
    vi.useFakeTimers();
    const image = makeImage("https://example.com/by-iframe.jpg");
    renderBadge(image, wire("unknown"), image.src);
    const badge = badgeElements()[0]!;
    movePointer([image]);
    expect(badge.dataset["presence"]).toBe("shown");

    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    dispatchPointer("pointerout", { relatedTarget: iframe });
    vi.runAllTimers();
    expect(badge.dataset["presence"]).toBe("hidden");
    vi.useRealTimers();
  });

  it("shows a fresh Unknown badge under a resting cursor (:hover fallback)", () => {
    // Page loads with the cursor already on the image and the verdict
    // lands before any pointer event: the event-fed points know nothing,
    // and the browser's own hover chain is the only truth available.
    const image = makeImage("https://example.com/resting.jpg");
    vi.spyOn(image, "matches").mockImplementation(
      (selector) => selector === ":hover",
    );
    renderBadge(image, wire("unknown"), image.src);
    expect(badgeElements()[0]?.dataset["presence"]).toBe("shown");
  });

  it("forgets the pointer when the last gated entry goes (no stale reveal)", () => {
    // Sensor teardown must clear the tracked points: movement while no
    // sensor listens is untracked, and a later gate consulting a stale
    // point would reveal a badge — unprompted — for whatever image an
    // infinite-scroll feed later places under it.
    const image = makeImage("https://example.com/reaped.jpg");
    renderBadge(image, wire("unknown"), image.src);
    movePointer([image]);
    expect(badgeElements()[0]?.dataset["presence"]).toBe("shown");

    removeBadgeFor(image);
    const next = makeImage("https://example.com/newly-under-point.jpg");
    hitStacks = () => [next];
    renderBadge(next, wire("unknown"), next.src);
    expect(badgeElements()[0]?.dataset["presence"]).toBe("hidden");
  });

  it("does not reveal images beneath the overlay's own pixels (open panel)", () => {
    // Pointer traffic over the open popover hit-tests the stack beneath
    // it; revealing those badges would strobe the panel's surroundings
    // while the reader merely moves down the text. A stack topped by the
    // overlay host (the retargeted shadow-tree hit) reads as empty.
    vi.useFakeTimers();
    const image = makeImage("https://example.com/open-panel.jpg");
    renderBadge(image, wire("unknown"), image.src);
    movePointer([image]);
    badgeElements()[0]!.click();
    const beneath = makeImage("https://example.com/beneath-panel.jpg");
    renderBadge(beneath, wire("unknown"), beneath.src);
    expect(badgeElements()[1]?.dataset["presence"]).toBe("hidden");

    movePointer([host()!, beneath]);
    vi.runAllTimers();
    expect(badgeElements()[1]?.dataset["presence"]).toBe("hidden");
    // The panel's own image stays held by the open popover.
    expect(badgeElements()[0]?.dataset["presence"]).toBe("shown");
    vi.useRealTimers();
  });

  it("reveals only the topmost image of a stacked pair (buried placeholder)", () => {
    // elementsFromPoint includes images fully covered by other images
    // (LQIP placeholders, crossfading carousel frames); the reader is
    // looking at the topmost one, and revealing both would pile two
    // chips on the same anchor.
    const top = makeImage("https://example.com/final.jpg");
    const buried = makeImage("https://example.com/placeholder.jpg");
    renderBadge(top, wire("unknown"), top.src);
    renderBadge(buried, wire("unknown"), buried.src);

    movePointer([top, buried]);
    expect(badgeElements()[0]?.dataset["presence"]).toBe("shown");
    expect(badgeElements()[1]?.dataset["presence"]).toBe("hidden");
  });

  it("hands the reveal past an opacity-hidden frame to the visible image beneath", () => {
    // A crossfade that parks its settled-out frame at opacity: 0 above
    // the active one: the ghost still hit-tests (opacity does not affect
    // hit testing), but the reader is looking at the frame beneath it.
    // checkVisibility is the engine's own opacity walk; this jsdom does
    // not implement it (the sensor's ?. guard degrades to topmost-wins),
    // so both answers are scripted by assignment rather than spyOn.
    const ghost = makeImage("https://example.com/settled-out.jpg");
    const active = makeImage("https://example.com/active-frame.jpg");
    renderBadge(ghost, wire("unknown"), ghost.src);
    renderBadge(active, wire("unknown"), active.src);
    ghost.checkVisibility = () => false;
    active.checkVisibility = () => true;

    movePointer([ghost, active]);
    expect(badgeElements()[0]?.dataset["presence"]).toBe("hidden");
    expect(badgeElements()[1]?.dataset["presence"]).toBe("shown");
  });

  it("reveals a landing Unknown under the pointer with no pending chip (held path)", () => {
    // Kills a mutation the suite previously masked: with the pointer on
    // the image and no chip ever visible, only syncIntentGate's
    // reader-engagement check can show the badge — the reveal-continuity
    // block needs a visible chip and cannot fire here.
    const other = makeImage("https://example.com/keeps-sensor.jpg");
    markPending(other);
    const image = makeImage("https://example.com/no-chip.jpg");
    movePointer([image]);
    renderBadge(image, wire("unknown"), image.src);
    expect(badgeElements()[0]?.dataset["presence"]).toBe("shown");
  });

  it("keeps a chip-watched verdict revealed when it lands just after the pointer left", () => {
    // The complementary mutation: pointer moved off during the hide
    // grace, chip still visible, verdict lands — only renderBadge's
    // reveal-continuity block can carry the reveal (the engagement check
    // is false), and it must hand off into the ordinary grace hide
    // rather than blinking out or sticking forever.
    vi.useFakeTimers();
    const image = makeImage("https://example.com/grace-window.jpg");
    markPending(image);
    movePointer([image]);
    movePointer([]);
    renderBadge(image, wire("unknown"), image.src);
    const badge = badgeElements()[0]!;
    expect(badge.dataset["presence"]).toBe("shown");

    vi.runAllTimers();
    expect(badge.dataset["presence"]).toBe("hidden");
    vi.useRealTimers();
  });
});

// Finish-review fix 2: the intent-gated in-flight indicator — a tracing
// ring revealed while analysis runs, handed off to the verdict badge.
describe("pending indicator", () => {
  it("shows a checking chip on intent while analysis runs, and hands off", () => {
    const image = makeImage("https://example.com/slow.jpg");
    markPending(image);
    // No host yet: the chip (and the whole overlay) exists only on intent.
    expect(overlayRoot?.querySelector(".badge.pending") ?? null).toBeNull();

    movePointer([image]);
    const chip = overlayRoot?.querySelector(".badge.pending");
    expect(chip?.getAttribute("role")).toBe("status");
    expect(chip?.querySelector(".ring")?.getAttribute("data-ring")).toBe(
      "checking",
    );

    renderBadge(image, wire("unknown"), image.src);
    expect(overlayRoot?.querySelector(".badge.pending")).toBeNull();
    // Continuity: the verdict landed under the reader's pointer, so the
    // gated Unknown badge takes over already revealed.
    expect(badgeElements()[0]?.dataset["presence"]).toBe("shown");
  });

  it("reveals the chip through a page overlay covering the image", () => {
    // Same overlay-proof channel as the Unknown gate (Instagram bug).
    const image = makeImage("https://example.com/covered-slow.jpg");
    const overlay = document.createElement("div");
    document.body.append(overlay);
    markPending(image);
    movePointer([overlay, image], overlay);
    expect(overlayRoot?.querySelector(".badge.pending")).not.toBeNull();
  });

  it("clears silently when analysis fails without a verdict", () => {
    const image = makeImage("https://example.com/broken.jpg");
    markPending(image);
    movePointer([image]);
    expect(overlayRoot?.querySelector(".badge.pending")).not.toBeNull();
    clearPending(image);
    expect(overlayRoot?.querySelector(".badge.pending")).toBeNull();
  });

  it("joins the sync pass: chips reposition and reap like badges", () => {
    const image = makeImage("https://example.com/slow.jpg");
    markPending(image);
    movePointer([image]);
    const chip = overlayRoot?.querySelector<HTMLElement>(".badge.pending");
    expect(chip?.style.left).toBe("18px");

    // Layout shifted under the chip (an ad loaded above): the sync pass
    // must move it — a stationary pointer fires no further intent event.
    vi.spyOn(image, "getBoundingClientRect").mockReturnValue(
      asRect({ ...RECT, left: 50 }),
    );
    syncBadges();
    expect(chip?.style.left).toBe("58px");

    // A virtualized feed removed the image: no pointerleave ever fires on
    // a detached element, so the sync pass takes the chip off screen.
    image.remove();
    syncBadges();
    expect(overlayRoot?.querySelector(".badge.pending")).toBeNull();
  });

  it("announces the in-flight check through the persistent live region", () => {
    // The chip itself enters the DOM fully formed (aria-label only), so
    // its own role=status can never announce; the persistent offscreen
    // region takes the text instead.
    const image = makeImage("https://example.com/slow.jpg");
    markPending(image);
    movePointer([image]);
    const region = overlayRoot?.querySelector('[role="status"]:not(.badge)');
    expect(region?.textContent).toBe("Checking this image…");
    clearPending(image);
    expect(region?.textContent).toBe("");
  });
});

// The Evidence Ring's honest bands (ring.ts): closed for cryptographic
// verdicts, visibly open for probabilistic, barely started for unknown —
// never a continuous confidence mapping.
describe("evidence ring", () => {
  function arcBand(badge: HTMLButtonElement): string | null | undefined {
    return badge.querySelector(".ring-arc")?.getAttribute("stroke-dasharray");
  }

  it("draws the honest band and class glyph for each verdict", () => {
    const image = makeImage("https://example.com/a.jpg");
    renderBadge(image, wire("ai-likely"), image.src);
    const badge = badgeElements()[0]!;
    expect(arcBand(badge)).toBe("85 100");
    expect(badge.querySelector(".ring")?.getAttribute("data-ring")).toBe(
      "ai-likely",
    );

    renderBadge(image, wire("human-verified"), image.src);
    expect(arcBand(badge)).toBe("100 100");

    renderBadge(image, wire("unknown"), image.src);
    expect(arcBand(badge)).toBe("15 100");
  });

  it("keeps the ring SVG out of the accessible name", () => {
    const image = makeImage("https://example.com/b.jpg");
    renderBadge(image, wire("ai-declared"), image.src);
    const badge = badgeElements()[0]!;
    expect(badge.querySelector(".ring")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
    expect(badge.textContent).toBe("Made with AI");
  });

  it("drops the sweep class when its animation ends (host-rebuild replay guard)", () => {
    // DOM re-insertion restarts CSS animations: .enter left in place
    // would replay every badge's draw-on each time a host rebuild
    // re-adopts the overlay.
    const image = makeImage("https://example.com/c.jpg");
    renderBadge(image, wire("ai-declared"), image.src);
    const badge = badgeElements()[0]!;
    expect(badge.classList.contains("enter")).toBe(true);

    const end = new Event("animationend", { bubbles: true });
    Object.assign(end, { animationName: "trueorigin-sweep" });
    badge.dispatchEvent(end);
    expect(badge.classList.contains("enter")).toBe(false);
  });
});
