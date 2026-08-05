import { describe, expect, it } from "vitest";
import type { Finding, SignalResult } from "./types";
import { VERDICT_IDS } from "./types";
import {
  AI_LIKELY_MIN_CONFIDENCE,
  mapVerdict,
  verdictClassForSignal,
} from "./verdict";

function signal(
  finding: Finding,
  confidence = finding === "none" ? 0 : 1,
  providerId = "test",
): SignalResult {
  return { providerId, finding, confidence, detail: null };
}

describe("the verdict taxonomy (plan.md §2)", () => {
  it("has exactly the four verdicts", () => {
    expect([...VERDICT_IDS].sort()).toEqual([
      "ai-declared",
      "ai-likely",
      "human-verified",
      "unknown",
    ]);
  });

  // §8 constraint 1: no "Not AI" verdict anywhere, even as an internal
  // enum value.
  it('contains no "not AI" verdict in any spelling', () => {
    for (const id of VERDICT_IDS) {
      expect(id).not.toMatch(/not.?ai/i);
    }
  });
});

describe("mapVerdict", () => {
  it("maps no signals at all to unknown — the honest default", () => {
    const verdict = mapVerdict({ signals: [], failures: [] });

    expect(verdict.verdict).toBe("unknown");
    expect(verdict.basis).toEqual([]);
  });

  it('maps only "none" findings to unknown, never anything stronger', () => {
    const verdict = mapVerdict({
      signals: [signal("none"), signal("none", 0, "other")],
      failures: [],
    });

    expect(verdict.verdict).toBe("unknown");
  });

  it("maps provider failures to unknown — an error is not evidence", () => {
    const verdict = mapVerdict({
      signals: [],
      failures: [{ providerId: "broken", error: new Error("boom") }],
    });

    expect(verdict.verdict).toBe("unknown");
    expect(verdict.failures.map((f) => f.providerId)).toEqual(["broken"]);
  });

  it('maps a cryptographic AI declaration to "ai-declared"', () => {
    const declared = signal("ai-declared");
    const verdict = mapVerdict({ signals: [declared], failures: [] });

    expect(verdict.verdict).toBe("ai-declared");
    expect(verdict.basis).toEqual([declared]);
  });

  it('maps cryptographic capture provenance to "human-verified"', () => {
    const human = signal("human-provenance");
    const verdict = mapVerdict({ signals: [human], failures: [] });

    expect(verdict.verdict).toBe("human-verified");
    expect(verdict.basis).toEqual([human]);
  });

  it('maps an above-threshold probabilistic signal to "ai-likely"', () => {
    const indicated = signal("ai-indicated", AI_LIKELY_MIN_CONFIDENCE);
    const verdict = mapVerdict({ signals: [indicated], failures: [] });

    expect(verdict.verdict).toBe("ai-likely");
    expect(verdict.basis).toEqual([indicated]);
  });

  it("maps a below-threshold probabilistic signal to unknown, keeping the signal visible", () => {
    const weak = signal("ai-indicated", AI_LIKELY_MIN_CONFIDENCE - 0.01);
    const verdict = mapVerdict({ signals: [weak], failures: [] });

    expect(verdict.verdict).toBe("unknown");
    expect(verdict.basis).toEqual([]);
    // The weak signal still ships to the popup — honesty includes showing
    // inconclusive evidence, it just never hardens into a verdict.
    expect(verdict.signals).toEqual([weak]);
  });

  describe("conflict resolution across providers", () => {
    it("an AI declaration disqualifies human-verified", () => {
      const verdict = mapVerdict({
        signals: [
          signal("human-provenance", 1, "capture"),
          signal("ai-declared", 1, "c2pa"),
        ],
        failures: [],
      });

      expect(verdict.verdict).toBe("ai-declared");
    });

    it("cryptographic human provenance outranks a probabilistic AI signal", () => {
      const human = signal("human-provenance", 1, "c2pa");
      const classifier = signal("ai-indicated", 0.95, "classifier");
      const verdict = mapVerdict({
        signals: [human, classifier],
        failures: [],
      });

      expect(verdict.verdict).toBe("human-verified");
      expect(verdict.basis).toEqual([human]);
      // The conflicting signal is preserved for the popup.
      expect(verdict.signals).toContain(classifier);
    });

    it("a cryptographic AI declaration outranks a probabilistic AI signal", () => {
      const verdict = mapVerdict({
        signals: [
          signal("ai-indicated", 0.95, "classifier"),
          signal("ai-declared", 1, "c2pa"),
        ],
        failures: [],
      });

      expect(verdict.verdict).toBe("ai-declared");
    });

    it("all qualifying signals of the winning finding form the basis", () => {
      const strongA = signal("ai-indicated", 0.9, "a");
      const strongB = signal("ai-indicated", 0.8, "b");
      const weak = signal("ai-indicated", 0.2, "c");
      const verdict = mapVerdict({
        signals: [strongA, weak, strongB],
        failures: [],
      });

      expect(verdict.verdict).toBe("ai-likely");
      expect(verdict.basis).toEqual([strongA, strongB]);
    });
  });
});

// Single-signal classing for UI surfaces (the popover's per-signal
// rings): must never claim more than mapVerdict would grant the same
// signal — the taxonomy mapping lives here, next to the mapper.
describe("verdictClassForSignal", () => {
  it("maps each finding to the class its evidence supports alone", () => {
    expect(verdictClassForSignal(signal("ai-declared"))).toBe("ai-declared");
    expect(verdictClassForSignal(signal("human-provenance"))).toBe(
      "human-verified",
    );
    expect(verdictClassForSignal(signal("ai-indicated", 0.9))).toBe(
      "ai-likely",
    );
    expect(verdictClassForSignal(signal("none"))).toBe("unknown");
  });

  it("applies mapVerdict's threshold to probabilistic signals", () => {
    expect(
      verdictClassForSignal(signal("ai-indicated", AI_LIKELY_MIN_CONFIDENCE)),
    ).toBe("ai-likely");
    expect(
      verdictClassForSignal(
        signal("ai-indicated", AI_LIKELY_MIN_CONFIDENCE - 0.01),
      ),
    ).toBe("unknown");
  });
});
