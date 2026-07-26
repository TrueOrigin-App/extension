import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TRUST_CACHE_TTL_MS, cachedFetchText } from "./trust-cache";

const URL_A = "https://example.test/anchors.pem";

/** Minimal in-memory CacheStorage standing in for the service worker's. */
function fakeCaches() {
  const store = new Map<string, Response>();
  return {
    store,
    caches: {
      open: async () => ({
        match: async (url: string) => {
          const hit = store.get(url);
          return hit ? hit.clone() : undefined;
        },
        put: async (url: string, response: Response) => {
          store.set(url, response);
        },
      }),
    },
  };
}

function okResponse(body: string): Response {
  return new Response(body, { status: 200, statusText: "OK" });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("cachedFetchText", () => {
  it("falls back to a plain fetch when the Cache API is unavailable", async () => {
    const fetchMock = vi.fn(async () => okResponse("pem-1"));
    vi.stubGlobal("fetch", fetchMock);
    expect(await cachedFetchText(URL_A, 1000)).toBe("pem-1");
    expect(await cachedFetchText(URL_A, 1000)).toBe("pem-1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("serves a fresh cached entry without touching the network", async () => {
    const { caches } = fakeCaches();
    vi.stubGlobal("caches", caches);
    const fetchMock = vi.fn(async () => okResponse("pem-1"));
    vi.stubGlobal("fetch", fetchMock);

    expect(await cachedFetchText(URL_A, 1000)).toBe("pem-1");
    vi.advanceTimersByTime(TRUST_CACHE_TTL_MS / 2);
    expect(await cachedFetchText(URL_A, 1000)).toBe("pem-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refetches once the entry goes stale", async () => {
    const { caches } = fakeCaches();
    vi.stubGlobal("caches", caches);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okResponse("pem-1"))
      .mockResolvedValueOnce(okResponse("pem-2"));
    vi.stubGlobal("fetch", fetchMock);

    expect(await cachedFetchText(URL_A, 1000)).toBe("pem-1");
    vi.advanceTimersByTime(TRUST_CACHE_TTL_MS + 1);
    expect(await cachedFetchText(URL_A, 1000)).toBe("pem-2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("serves a stale entry when the refetch fails", async () => {
    const { caches } = fakeCaches();
    vi.stubGlobal("caches", caches);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okResponse("pem-1"))
      .mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);

    expect(await cachedFetchText(URL_A, 1000)).toBe("pem-1");
    vi.advanceTimersByTime(TRUST_CACHE_TTL_MS + 1);
    expect(await cachedFetchText(URL_A, 1000)).toBe("pem-1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws when the fetch fails and nothing is cached", async () => {
    const { caches } = fakeCaches();
    vi.stubGlobal("caches", caches);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
    );
    await expect(cachedFetchText(URL_A, 1000)).rejects.toThrow(
      "Failed to fetch",
    );
  });

  it("enforces the response size cap", async () => {
    vi.stubGlobal("fetch", async () => okResponse("x".repeat(11)));
    await expect(cachedFetchText(URL_A, 10)).rejects.toThrow(/exceeds/);
  });
});
