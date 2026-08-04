import { describe, expect, it } from "vitest";
import type { MediaInput, Verdict } from "../core/types";
import { contentHashKey, createVerdictCache } from "./verdict-cache";

function input(overrides: Partial<MediaInput> = {}): MediaInput {
  return {
    bytes: new Uint8Array([1, 2, 3, 4]),
    mimeType: "image/png",
    sourceUrl: "https://example.test/a.png",
    ...overrides,
  };
}

function verdict(failures: Verdict["failures"] = []): Verdict {
  return { verdict: "unknown", basis: [], signals: [], failures };
}

describe("contentHashKey", () => {
  it("keys on bytes and MIME type, not on sourceUrl", async () => {
    const base = await contentHashKey(input());
    expect(
      await contentHashKey(input({ sourceUrl: "https://other.test/" })),
    ).toBe(base);
    expect(await contentHashKey(input({ sourceUrl: undefined }))).toBe(base);
    expect(
      await contentHashKey(input({ bytes: new Uint8Array([9, 9, 9]) })),
    ).not.toBe(base);
    expect(await contentHashKey(input({ mimeType: "image/jpeg" }))).not.toBe(
      base,
    );
  });
});

// Coalescing, rejection, and eviction behavior is the primitive's and is
// covered in coalescing-lru.test.ts; what this layer owns is the key shape
// (above) and the retention wiring (below).
describe("createVerdictCache", () => {
  it("does not retain verdicts carrying provider failures", async () => {
    const cache = createVerdictCache();
    const key = await contentHashKey(input());
    const failed = verdict([{ providerId: "c2pa", error: new Error("init") }]);

    expect(await cache.getOrRun(key, async () => failed)).toBe(failed);
    expect(cache.size).toBe(0);

    // The transient condition cleared; the retry result is cached.
    const clean = verdict();
    expect(await cache.getOrRun(key, async () => clean)).toBe(clean);
    expect(cache.size).toBe(1);
  });
});
