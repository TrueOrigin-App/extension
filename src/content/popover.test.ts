// @vitest-environment jsdom
//
// Pins the popover's content contract: headline + explanation for every
// verdict, the collapsed-by-default disclosure, per-signal evidence via the
// providers-layer presenters, honest degraded-check and failure lines
// (naming checks by their presenters-layer display name), the generic
// fallback that keeps the popover provider-agnostic (plan.md §8,
// constraint 4), and the evidence region's keyboard reachability — a tab
// stop exactly while it overflows (roadmap chunk 4).
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SignalResult, VerdictId } from "../core/types";
import type { WireVerdict } from "../messaging/protocol";
import { buildPopoverContent } from "./popover";
import { VERDICT_EXPLANATIONS, VERDICT_LABELS } from "./labels";

function c2paSignal(detail: unknown): SignalResult {
  return { providerId: "c2pa", finding: "ai-declared", confidence: 1, detail };
}

function render(verdict: WireVerdict): HTMLDivElement {
  const container = document.createElement("div");
  container.append(buildPopoverContent(verdict));
  return container;
}

function make(
  verdict: VerdictId,
  signals: SignalResult[] = [],
  failures: WireVerdict["failures"] = [],
): WireVerdict {
  return { verdict, basis: signals, signals, failures };
}

/** jsdom has no layout: overflow is whatever the test says it is. */
function setScrollMetrics(
  element: HTMLElement,
  metrics: { scrollHeight: number; clientHeight: number },
): void {
  for (const [name, value] of Object.entries(metrics)) {
    Object.defineProperty(element, name, { value, configurable: true });
  }
}

const OVERFLOWING = { scrollHeight: 400, clientHeight: 160 };
const FITTING = { scrollHeight: 120, clientHeight: 160 };

/** A ResizeObserver stand-in that hands the test its callback, so the
 * live-resize follow-up path can be driven by hand. */
function stubResizeObserver(): {
  callbacks: Array<() => void>;
  observe: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
} {
  const callbacks: Array<() => void> = [];
  const observe = vi.fn();
  const disconnect = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        callbacks.push(callback);
      }
      observe = observe;
      disconnect = disconnect;
      unobserve = vi.fn();
    },
  );
  return { callbacks, observe, disconnect };
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function factValue(container: HTMLElement, label: string): string | undefined {
  const terms = Array.from(container.querySelectorAll(".facts dt"));
  const term = terms.find((dt) => dt.textContent === label);
  return term?.nextElementSibling?.textContent ?? undefined;
}

describe("buildPopoverContent", () => {
  it.each(["ai-declared", "ai-likely", "human-verified", "unknown"] as const)(
    "shows the %s headline and its plain-language explanation",
    (verdict) => {
      const container = render(make(verdict));
      expect(container.querySelector(".headline")?.textContent).toBe(
        VERDICT_LABELS[verdict],
      );
      expect(container.querySelector(".explain")?.textContent).toBe(
        VERDICT_EXPLANATIONS[verdict],
      );
    },
  );

  it("collapses the evidence behind the disclosure and toggles it", () => {
    const container = render(make("unknown"));
    const disclosure =
      container.querySelector<HTMLButtonElement>(".disclosure")!;
    const evidence = container.querySelector<HTMLDivElement>(".evidence")!;

    expect(disclosure.textContent).toBe("How do we know?");
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(disclosure.getAttribute("aria-controls")).toBe(evidence.id);
    expect(evidence.hidden).toBe(true);

    disclosure.click();
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    expect(evidence.hidden).toBe(false);

    disclosure.click();
    expect(evidence.hidden).toBe(true);
  });

  it("renders C2PA evidence through the provider's presenter", () => {
    const container = render(
      make("ai-declared", [
        c2paSignal({
          reason: "ai-source-type",
          validationState: "Trusted",
          aiSourceTypes: [
            "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia",
          ],
          signatureIssuer: "OpenAI OpCo, LLC",
          claimGenerator: "OpenAI Media Service API",
        }),
      ]),
    );

    expect(container.querySelector(".summary")?.textContent).toContain(
      "Content Credentials",
    );
    expect(factValue(container, "Signed by")).toBe("OpenAI OpCo, LLC");
    expect(factValue(container, "Made with")).toBe("OpenAI Media Service API");
    expect(factValue(container, "Declares")).toBe("Created with an AI model");
    expect(factValue(container, "Signature")).toBe(
      "Valid — signer is on a recognized trust list",
    );
  });

  it("presents signals from unknown providers generically (constraint 4)", () => {
    const signal: SignalResult = {
      providerId: "future-watermark",
      finding: "ai-indicated",
      confidence: 0.83,
      detail: { anything: true },
    };
    const container = render(make("ai-likely", [signal]));

    expect(container.querySelector(".summary")?.textContent).toBe(
      'Signal from provider "future-watermark".',
    );
    expect(factValue(container, "Finding")).toBe("ai-indicated");
    expect(factValue(container, "Confidence")).toBe("83%");
  });

  it("marks degraded verdicts and lists each failure", () => {
    const container = render(
      make("unknown", [], [{ providerId: "c2pa", message: "trust fetch 503" }]),
    );

    expect(container.querySelector(".notice")?.textContent).toContain(
      "incomplete",
    );
    // The check is named by its presenters-layer display name, not the
    // wire id; the message stays the provider's own words.
    expect(container.querySelector(".failure")?.textContent).toBe(
      'The "Content Credentials" check failed: trust fetch 503',
    );
  });

  it("names failures from providers without a presenter by their raw id", () => {
    const container = render(
      make(
        "unknown",
        [],
        [{ providerId: "future-watermark", message: "timeout" }],
      ),
    );
    expect(container.querySelector(".failure")?.textContent).toBe(
      'The "future-watermark" check failed: timeout',
    );
  });

  it("shows no degraded notice on a failure-free verdict", () => {
    const container = render(make("unknown"));
    expect(container.querySelector(".notice")).toBeNull();
  });

  it("always states the local-check privacy note", () => {
    const container = render(make("ai-declared"));
    expect(container.querySelector(".privacy")?.textContent).toBe(
      "The image itself never left your machine — the check ran on this " +
        "device.",
    );
  });

  it("draws the verdict's ring in the headline row", () => {
    const container = render(make("ai-likely"));
    const ring = container.querySelector(".verdict .ring");
    expect(ring?.getAttribute("data-ring")).toBe("ai-likely");
    expect(container.querySelector(".verdict .headline")?.textContent).toBe(
      VERDICT_LABELS["ai-likely"],
    );
  });

  it("gives every signal its own ring keyed by that signal's finding", () => {
    const signals: SignalResult[] = [
      c2paSignal({}),
      { providerId: "mock", finding: "none", confidence: 0, detail: {} },
    ];
    const container = render(make("ai-declared", signals));
    const rings = Array.from(container.querySelectorAll(".signal .ring")).map(
      (ring) => ring.getAttribute("data-ring"),
    );
    expect(rings).toEqual(["ai-declared", "unknown"]);
  });

  it("caps a below-threshold probabilistic signal's ring at unknown", () => {
    // The ring must not claim more than mapVerdict grants the signal: a
    // sub-threshold ai-indicated signal is excluded from any verdict
    // basis (AI_LIKELY_MIN_CONFIDENCE), so drawing it the near-closed
    // "Likely AI" band would be a visual claim exceeding the evidence.
    const weak: SignalResult = {
      providerId: "future-watermark",
      finding: "ai-indicated",
      confidence: 0.4,
      detail: {},
    };
    const container = render(make("unknown", [weak]));
    expect(
      container.querySelector(".signal .ring")?.getAttribute("data-ring"),
    ).toBe("unknown");
  });

  describe("evidence region keyboard reachability", () => {
    it("names the region by the disclosure and takes a tab stop only while it overflows", () => {
      const container = render(make("unknown"));
      const disclosure =
        container.querySelector<HTMLButtonElement>(".disclosure")!;
      const evidence = container.querySelector<HTMLDivElement>(".evidence")!;

      // A landmark a keyboard user can identify, named by the button that
      // revealed it — no second string.
      expect(evidence.getAttribute("role")).toBe("region");
      expect(disclosure.id).not.toBe("");
      expect(evidence.getAttribute("aria-labelledby")).toBe(disclosure.id);
      expect(evidence.hasAttribute("tabindex")).toBe(false);

      setScrollMetrics(evidence, OVERFLOWING);
      disclosure.click();
      expect(evidence.getAttribute("tabindex")).toBe("0");

      // Collapsing clears the stop; the next expand re-reads overflow.
      disclosure.click();
      expect(evidence.hasAttribute("tabindex")).toBe(false);

      setScrollMetrics(evidence, FITTING);
      disclosure.click();
      expect(evidence.hasAttribute("tabindex")).toBe(false);
    });

    it("tracks overflow changes while expanded through a ResizeObserver", () => {
      const observer = stubResizeObserver();
      const container = render(make("unknown"));
      const disclosure =
        container.querySelector<HTMLButtonElement>(".disclosure")!;
      const evidence = container.querySelector<HTMLDivElement>(".evidence")!;
      expect(observer.callbacks).toHaveLength(1);
      const resized = observer.callbacks[0]!;

      setScrollMetrics(evidence, FITTING);
      disclosure.click();
      expect(observer.observe).toHaveBeenCalledWith(evidence);
      expect(evidence.hasAttribute("tabindex")).toBe(false);

      // The viewport shrinks (70vh cap) and the region starts scrolling.
      setScrollMetrics(evidence, OVERFLOWING);
      resized();
      expect(evidence.getAttribute("tabindex")).toBe("0");

      setScrollMetrics(evidence, FITTING);
      resized();
      expect(evidence.hasAttribute("tabindex")).toBe(false);

      disclosure.click();
      expect(observer.disconnect).toHaveBeenCalled();
    });

    it("keeps a focused region focusable when its overflow disappears", () => {
      const observer = stubResizeObserver();
      const container = render(make("unknown"));
      document.body.append(container);
      const disclosure =
        container.querySelector<HTMLButtonElement>(".disclosure")!;
      const evidence = container.querySelector<HTMLDivElement>(".evidence")!;
      const resized = observer.callbacks[0]!;

      setScrollMetrics(evidence, OVERFLOWING);
      disclosure.click();
      evidence.focus();
      expect(document.activeElement).toBe(evidence);

      // Dropping the tabindex here would eject focus to the document.
      setScrollMetrics(evidence, FITTING);
      resized();
      expect(evidence.getAttribute("tabindex")).toBe("0");
      expect(document.activeElement).toBe(evidence);

      // Once focus has moved on, the stop goes with the overflow.
      evidence.blur();
      resized();
      expect(evidence.hasAttribute("tabindex")).toBe(false);
    });
  });
});
