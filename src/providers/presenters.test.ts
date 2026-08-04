// Pins the presenter registry contract (task 5.3): each provider's signal
// is explained by its own presenter, and providers without one fall back to
// the generic presentation — so adding a provider never requires popover
// changes (plan.md §8, constraint 4).
import { describe, expect, it } from "vitest";
import type { SignalResult } from "../core/types";
import type { C2paDetail } from "./c2pa/mapping";
import { presentSignal } from "./presenters";

function c2pa(detail: Partial<C2paDetail> & { reason: C2paDetail["reason"] }) {
  return presentSignal({
    providerId: "c2pa",
    finding: "none",
    confidence: 0,
    detail,
  });
}

function fact(
  presentation: ReturnType<typeof presentSignal>,
  label: string,
): string | undefined {
  return presentation.facts.find((f) => f.label === label)?.value;
}

describe("c2pa presenter", () => {
  it("explains a trusted capture with capture-flavored facts", () => {
    const presentation = c2pa({
      reason: "trusted-capture",
      validationState: "Trusted",
      captureSourceType:
        "http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture",
      signatureIssuer: "Leica Camera AG",
      claimGenerator: "Leica M11-P",
    });

    expect(presentation.summary).toContain("capture device");
    expect(fact(presentation, "Signed by")).toBe("Leica Camera AG");
    expect(fact(presentation, "Captured with")).toBe("Leica M11-P");
    expect(fact(presentation, "Declares")).toBe("Camera photograph");
    expect(fact(presentation, "Signature")).toBe(
      "Valid — signer is on a recognized trust list",
    );
  });

  it("explains an untrusted capture as unverifiable, not as human", () => {
    const presentation = c2pa({
      reason: "untrusted-capture",
      validationState: "Valid",
      captureSourceType:
        "http://cv.iptc.org/newscodes/digitalsourcetype/computationalCapture",
    });

    expect(presentation.summary).toContain("not on a recognized trust list");
    expect(fact(presentation, "Signature")).toBe(
      "Valid — signer is not on a recognized trust list",
    );
  });

  it("surfaces verification failure codes as technical detail", () => {
    const presentation = c2pa({
      reason: "invalid-manifest",
      validationState: "Invalid",
      validationFailures: ["assertion.dataHash.mismatch"],
    });

    expect(presentation.summary).toContain("did not pass verification");
    expect(fact(presentation, "Technical detail")).toBe(
      "assertion.dataHash.mismatch",
    );
  });

  it("explains absence reasons in plain language", () => {
    expect(c2pa({ reason: "no-c2pa-metadata" }).summary).toContain(
      "No Content Credentials",
    );
    expect(c2pa({ reason: "no-origin-declaration" }).summary).toContain(
      "don't state how",
    );
    expect(c2pa({ reason: "unsupported-format" }).summary).toContain(
      "file format",
    );
  });

  it("maps composite AI material to its own wording", () => {
    const presentation = c2pa({
      reason: "ai-source-type",
      aiSourceTypes: [
        "http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia",
      ],
    });
    expect(fact(presentation, "Declares")).toBe(
      "Contains AI-generated material",
    );
  });

  it("degrades gracefully when the detail is not C2paDetail-shaped", () => {
    const presentation = presentSignal({
      providerId: "c2pa",
      finding: "none",
      confidence: 0,
      detail: "garbage",
    });
    expect(presentation.summary).toContain("Content Credentials");
    expect(presentation.facts).toEqual([]);
  });
});

describe("generic fallback", () => {
  it("presents unknown providers factually, with no popover changes needed", () => {
    const signal: SignalResult = {
      providerId: "community-signals",
      finding: "ai-indicated",
      confidence: 0.62,
      detail: { votes: 12 },
    };
    const presentation = presentSignal(signal);

    expect(presentation.summary).toBe(
      'Signal from provider "community-signals".',
    );
    expect(fact(presentation, "Finding")).toBe("ai-indicated");
    expect(fact(presentation, "Confidence")).toBe("62%");
  });
});
