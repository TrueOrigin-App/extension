// @vitest-environment jsdom
//
// Pins the popover's content contract: headline + explanation for every
// verdict, the collapsed-by-default disclosure, per-signal evidence via the
// providers-layer presenters, honest degraded-check and failure lines, and
// the generic fallback that keeps the popover provider-agnostic (plan.md
// §8, constraint 4).
import { describe, expect, it } from "vitest";
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
    expect(container.querySelector(".failure")?.textContent).toBe(
      'The "c2pa" check failed: trust fetch 503',
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
});
