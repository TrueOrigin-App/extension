// @vitest-environment jsdom
//
// jsdom has no layout engine, so rects are mocked per image; what these
// tests pin is the lifecycle — keying, replacement, hiding, reaping,
// stale-URL dropping, host-rebuild re-adoption, and the popover's
// open/dismiss rules — not real geometry. The observer wiring in index.ts
// is real-browser soak territory (plan.md §6).
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VerdictId } from "../core/types";
import type { WireVerdict } from "../messaging/protocol";
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

function badgeElements(): HTMLButtonElement[] {
  return Array.from(
    host()?.shadowRoot?.querySelectorAll<HTMLButtonElement>("button.badge") ??
      [],
  );
}

function popoverElements(): HTMLDivElement[] {
  return Array.from(
    host()?.shadowRoot?.querySelectorAll<HTMLDivElement>(".popover") ?? [],
  );
}

function pointerDownOn(target: EventTarget): void {
  target.dispatchEvent(
    new Event("pointerdown", { bubbles: true, composed: true }),
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
      "AI — declared",
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
    const style = host()?.shadowRoot?.querySelector("style")?.textContent;
    expect(style).toContain(".evidence[hidden]");
  });

  it("pins the explicit direction reset (all:initial excludes direction)", () => {
    // Regression pin: the CSS "all" property excludes direction and
    // unicode-bidi by spec, so without an explicit reset an RTL host page
    // re-orders the overlay's English text (verified live). jsdom doesn't
    // cascade shadow stylesheets, so pin the stylesheet text.
    const image = makeImage("https://example.com/a.jpg");
    renderBadge(image, wire("unknown"), image.src);
    const style = host()?.shadowRoot?.querySelector("style")?.textContent;
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
    expect(popover?.getAttribute("aria-label")).toBe("AI — declared — details");
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
