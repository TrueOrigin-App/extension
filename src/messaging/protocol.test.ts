import { describe, expect, it } from "vitest";
import type { Verdict } from "../core/types";
import {
  ANALYZE_MESSAGE_TYPE,
  ANALYZE_URL_MESSAGE_TYPE,
  decodeBytes,
  encodeBytes,
  isAnalyzeRequest,
  isAnalyzeResponse,
  isAnalyzeUrlRequest,
  isAnalyzeUrlResponse,
  isWireVerdict,
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

describe("isAnalyzeUrlRequest", () => {
  const valid = {
    type: ANALYZE_URL_MESSAGE_TYPE,
    url: "https://cdn.example/pic.png",
  };

  it("accepts a well-formed request", () => {
    expect(isAnalyzeUrlRequest(valid)).toBe(true);
  });

  it("rejects other message types and malformed shapes", () => {
    expect(isAnalyzeUrlRequest(null)).toBe(false);
    expect(isAnalyzeUrlRequest({ type: ANALYZE_MESSAGE_TYPE })).toBe(false);
    expect(isAnalyzeUrlRequest({ ...valid, type: "other" })).toBe(false);
    expect(isAnalyzeUrlRequest({ ...valid, url: 7 })).toBe(false);
    expect(isAnalyzeUrlRequest({ type: ANALYZE_URL_MESSAGE_TYPE })).toBe(false);
  });
});

describe("isAnalyzeUrlResponse", () => {
  const verdict = {
    verdict: "unknown",
    basis: [],
    signals: [{ providerId: "c2pa", finding: "none", confidence: 0 }],
    failures: [],
  };

  it("accepts both reply arms", () => {
    expect(isAnalyzeUrlResponse({ ok: true, verdict, pinned: true })).toBe(
      true,
    );
    expect(isAnalyzeUrlResponse({ ok: true, verdict, pinned: false })).toBe(
      true,
    );
    expect(isAnalyzeUrlResponse({ ok: false, error: "boom" })).toBe(true);
  });

  it("rejects replies missing the pinned flag or a usable verdict", () => {
    expect(isAnalyzeUrlResponse(undefined)).toBe(false);
    expect(isAnalyzeUrlResponse({ ok: true, verdict })).toBe(false);
    expect(isAnalyzeUrlResponse({ ok: true, verdict, pinned: "yes" })).toBe(
      false,
    );
    expect(
      isAnalyzeUrlResponse({ ok: true, verdict: null, pinned: true }),
    ).toBe(false);
    expect(isAnalyzeUrlResponse({ ok: false })).toBe(false);
  });
});

describe("isAnalyzeResponse", () => {
  const verdict = {
    verdict: "unknown",
    basis: [],
    signals: [{ providerId: "c2pa", finding: "none", confidence: 0 }],
    failures: [{ providerId: "c2pa", message: "trust fetch 503" }],
  };

  it("accepts both reply arms", () => {
    expect(isAnalyzeResponse({ ok: true, verdict })).toBe(true);
    expect(isAnalyzeResponse({ ok: false, error: "boom" })).toBe(true);
  });

  it("rejects malformed replies rather than letting them badge", () => {
    expect(isAnalyzeResponse(undefined)).toBe(false);
    expect(isAnalyzeResponse({ ok: true })).toBe(false);
    expect(isAnalyzeResponse({ ok: true, verdict: null })).toBe(false);
    expect(isAnalyzeResponse({ ok: false })).toBe(false);
  });

  it("checks every wire-verdict field the popover dereferences", () => {
    expect(isWireVerdict(verdict)).toBe(true);
    expect(isWireVerdict({ ...verdict, verdict: "not-ai" })).toBe(false);
    expect(isWireVerdict({ ...verdict, signals: undefined })).toBe(false);
    expect(isWireVerdict({ ...verdict, signals: [{}] })).toBe(false);
    expect(isWireVerdict({ ...verdict, failures: [{ providerId: "x" }] })).toBe(
      false,
    );
  });

  it("rejects signals whose finding or confidence would throw at click time", () => {
    // Badge click keys each signal's ring off finding + confidence
    // (verdictClassForSignal → ringStateForVerdict): an out-of-union
    // finding falls through both switches and buildRing throws inside
    // the click handler — so it must fail the analysis here instead.
    const signal = { providerId: "c2pa", finding: "none", confidence: 0 };
    expect(
      isWireVerdict({ ...verdict, signals: [{ providerId: "c2pa" }] }),
    ).toBe(false);
    expect(
      isWireVerdict({ ...verdict, signals: [{ ...signal, finding: "nope" }] }),
    ).toBe(false);
    expect(
      isWireVerdict({
        ...verdict,
        signals: [{ ...signal, confidence: "high" }],
      }),
    ).toBe(false);
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
