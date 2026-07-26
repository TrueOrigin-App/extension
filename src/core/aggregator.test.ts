import { describe, expect, it } from "vitest";
import { createMockProvider } from "../providers/mock";
import { aggregate } from "./aggregator";
import type { MediaInput, SignalProvider } from "./types";

const input: MediaInput = {
  bytes: new Uint8Array([0xff, 0xd8, 0xff]),
  mimeType: "image/jpeg",
};

describe("aggregate", () => {
  it("collects a SignalResult from every provider", async () => {
    const evidence = await aggregate(
      [
        createMockProvider({ id: "a", finding: "none" }),
        createMockProvider({ id: "b", finding: "ai-declared" }),
      ],
      input,
    );

    expect(evidence.signals.map((s) => s.providerId)).toEqual(["a", "b"]);
    expect(evidence.failures).toEqual([]);
  });

  it("passes the media input through to providers", async () => {
    const seen: MediaInput[] = [];
    const spy: SignalProvider = {
      id: "spy",
      cost: "local",
      async analyze(media) {
        seen.push(media);
        return {
          providerId: "spy",
          finding: "none",
          confidence: 0,
          detail: null,
        };
      },
    };

    await aggregate([spy], input);

    expect(seen).toEqual([input]);
  });

  it("records a throwing provider as a failure without sinking the others", async () => {
    const boom = new Error("boom");
    const failing: SignalProvider = {
      id: "failing",
      cost: "local",
      async analyze() {
        throw boom;
      },
    };

    const evidence = await aggregate(
      [failing, createMockProvider({ id: "ok", finding: "human-provenance" })],
      input,
    );

    expect(evidence.signals.map((s) => s.providerId)).toEqual(["ok"]);
    expect(evidence.failures).toEqual([{ providerId: "failing", error: boom }]);
  });

  it("rejects a result with a finding outside the taxonomy", async () => {
    const rogue: SignalProvider = {
      id: "rogue",
      cost: "local",
      async analyze() {
        // A buggy provider inventing a finding (e.g. a "not-ai" claim) must
        // not reach the verdict mapper.
        return {
          providerId: "rogue",
          finding: "not-ai" as never,
          confidence: 1,
          detail: null,
        };
      },
    };

    const evidence = await aggregate([rogue], input);

    expect(evidence.signals).toEqual([]);
    expect(evidence.failures).toHaveLength(1);
    expect(String(evidence.failures[0]!.error)).toContain("not-ai");
  });

  it.each([[Number.NaN], [-0.1], [1.1], [Number.POSITIVE_INFINITY]])(
    "rejects a result with confidence %s",
    async (confidence) => {
      const evidence = await aggregate(
        [
          createMockProvider({
            id: "bad",
            finding: "ai-indicated",
            confidence,
          }),
        ],
        input,
      );

      expect(evidence.signals).toEqual([]);
      expect(evidence.failures.map((f) => f.providerId)).toEqual(["bad"]);
    },
  );

  it("returns empty evidence for an empty provider list", async () => {
    const evidence = await aggregate([], input);

    expect(evidence).toEqual({ signals: [], failures: [] });
  });
});
