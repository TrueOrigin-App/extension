import { describe, expect, it, vi } from "vitest";
import type { MediaInput, Verdict } from "../core/types";
import { VerdictCache, contentHashKey } from "./verdict-cache";

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

describe("VerdictCache", () => {
  it("analyzes identical bytes once, across different source URLs", async () => {
    const cache = new VerdictCache();
    const run = vi.fn(async () => verdict());

    const first = await cache.analyze(input(), run);
    const second = await cache.analyze(
      input({ sourceUrl: "https://mirror.test/same-bytes.png" }),
      run,
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("analyzes different bytes separately", async () => {
    const cache = new VerdictCache();
    const run = vi.fn(async () => verdict());

    await cache.analyze(input(), run);
    await cache.analyze(input({ bytes: new Uint8Array([5, 6]) }), run);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does not cache verdicts carrying provider failures", async () => {
    const cache = new VerdictCache();
    const failed = verdict([{ providerId: "c2pa", error: new Error("init") }]);
    const run = vi
      .fn<(input: MediaInput) => Promise<Verdict>>()
      .mockResolvedValueOnce(failed)
      .mockResolvedValueOnce(verdict());

    expect(await cache.analyze(input(), run)).toBe(failed);
    expect(cache.size).toBe(0);

    // The transient condition cleared; the retry result is cached.
    expect((await cache.analyze(input(), run)).failures).toEqual([]);
    expect(run).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(1);
  });

  it("does not cache rejections", async () => {
    const cache = new VerdictCache();
    const run = vi
      .fn<(input: MediaInput) => Promise<Verdict>>()
      .mockRejectedValueOnce(new Error("undecodable"))
      .mockResolvedValueOnce(verdict());

    await expect(cache.analyze(input(), run)).rejects.toThrow("undecodable");
    expect(await cache.analyze(input(), run)).toEqual(verdict());
    expect(run).toHaveBeenCalledTimes(2);
  });
});
