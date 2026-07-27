import { describe, expect, it } from "vitest";
import type { Verdict } from "../core/types";
import {
  ANALYZE_MESSAGE_TYPE,
  decodeBytes,
  encodeBytes,
  isAnalyzeRequest,
  toWireVerdict,
} from "./protocol";

describe("byte transport", () => {
  it("round-trips bytes through base64", () => {
    const bytes = new Uint8Array([0, 1, 2, 127, 128, 255, 42]);
    expect(decodeBytes(encodeBytes(bytes))).toEqual(bytes);
  });

  it("round-trips empty input", () => {
    expect(decodeBytes(encodeBytes(new Uint8Array(0)))).toEqual(
      new Uint8Array(0),
    );
  });

  it("round-trips buffers larger than the encoding chunk size", () => {
    const bytes = new Uint8Array(0x8000 * 2 + 17);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
    expect(decodeBytes(encodeBytes(bytes))).toEqual(bytes);
  });
});

describe("isAnalyzeRequest", () => {
  const valid = {
    type: ANALYZE_MESSAGE_TYPE,
    bytesBase64: "AA==",
    mimeType: "image/png",
    sourceUrl: "http://localhost/a.png",
  };

  it("accepts a well-formed request", () => {
    expect(isAnalyzeRequest(valid)).toBe(true);
  });

  it("rejects other message types and malformed shapes", () => {
    expect(isAnalyzeRequest(null)).toBe(false);
    expect(isAnalyzeRequest("trueorigin:analyze")).toBe(false);
    expect(isAnalyzeRequest({ ...valid, type: "other" })).toBe(false);
    expect(isAnalyzeRequest({ ...valid, bytesBase64: 7 })).toBe(false);
    expect(isAnalyzeRequest({ ...valid, mimeType: undefined })).toBe(false);
    expect(isAnalyzeRequest({ ...valid, sourceUrl: null })).toBe(false);
  });
});

describe("toWireVerdict", () => {
  it("preserves the verdict and reduces failure errors to strings", () => {
    const signal = {
      providerId: "c2pa",
      finding: "ai-declared" as const,
      confidence: 1,
      detail: { reason: "test" },
    };
    const verdict: Verdict = {
      verdict: "ai-declared",
      basis: [signal],
      signals: [signal],
      failures: [
        { providerId: "a", error: new Error("boom") },
        { providerId: "b", error: "plain string" },
        { providerId: "c", error: { odd: true } },
      ],
    };

    const wire = toWireVerdict(verdict);
    expect(wire.verdict).toBe("ai-declared");
    expect(wire.basis).toEqual([signal]);
    expect(wire.signals).toEqual([signal]);
    expect(wire.failures).toEqual([
      { providerId: "a", message: "boom" },
      { providerId: "b", message: "plain string" },
      { providerId: "c", message: "[object Object]" },
    ]);
    // The wire shape must survive the JSON serialization sendMessage applies.
    expect(JSON.parse(JSON.stringify(wire))).toEqual(wire);
  });
});
