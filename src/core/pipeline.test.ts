import { describe, expect, it } from "vitest";
import { createMockProvider } from "../providers/mock";
import { runPipeline } from "./pipeline";
import type { MediaInput, SignalProvider } from "./types";

const input: MediaInput = {
  bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  mimeType: "image/png",
};

describe("runPipeline", () => {
  it("runs providers through aggregation to a verdict", async () => {
    const verdict = await runPipeline(
      [createMockProvider({ finding: "ai-declared" })],
      input,
    );

    expect(verdict.verdict).toBe("ai-declared");
    expect(verdict.signals).toHaveLength(1);
  });

  it("yields unknown when there are no providers at all", async () => {
    const verdict = await runPipeline([], input);

    expect(verdict.verdict).toBe("unknown");
  });
});

// Phase 1 exit criterion (plan.md §6): the pipeline is real only if adding a
// second provider requires zero changes outside the providers layer. This
// test is that proof: it introduces a provider the core has never seen —
// defined right here, not registered or special-cased anywhere — and the
// unchanged pipeline weighs its signals into the verdict.
describe("Phase 1 exit criterion: second provider plugs in with zero outside changes", () => {
  const secondProvider: SignalProvider = {
    id: "second-mock",
    cost: "api",
    async analyze() {
      return {
        providerId: "second-mock",
        finding: "ai-indicated",
        confidence: 0.9,
        detail: { note: "defined inline, unknown to src/core" },
      };
    },
  };

  it("the new provider's signal is collected and weighed", async () => {
    const verdict = await runPipeline(
      [
        createMockProvider({ id: "first-mock", finding: "none" }),
        secondProvider,
      ],
      input,
    );

    // The first provider found nothing; the verdict comes entirely from the
    // provider the pipeline had never seen before.
    expect(verdict.verdict).toBe("ai-likely");
    expect(verdict.basis.map((s) => s.providerId)).toEqual(["second-mock"]);
    expect(verdict.signals.map((s) => s.providerId)).toEqual([
      "first-mock",
      "second-mock",
    ]);
  });

  it("conflict resolution needs no knowledge of the new provider either", async () => {
    const verdict = await runPipeline(
      [
        createMockProvider({ id: "first-mock", finding: "human-provenance" }),
        secondProvider,
      ],
      input,
    );

    // Cryptographic provenance outranks the newcomer's probabilistic signal,
    // which is still preserved for the popup.
    expect(verdict.verdict).toBe("human-verified");
    expect(verdict.signals.map((s) => s.providerId)).toEqual([
      "first-mock",
      "second-mock",
    ]);
  });
});
