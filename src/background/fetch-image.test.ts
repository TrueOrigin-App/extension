// Pins the worker-side CORS-fallback fetch (task 5.5): request shape
// (single fetch, exact URL, pinned Accept header, credentials), the
// non-http(s) refusal, and the guards that keep a wrong representation
// from being analyzed. This is the background-level counterpart of the
// provider egress suite: the only network request the handler may make is
// the one the content script named.

import { afterEach, describe, expect, it, vi } from "vitest";
import { IMAGE_ACCEPT } from "../lib/image-accept";
import { fetchImageForAnalysis } from "./fetch-image";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

function imageResponse(init?: {
  status?: number;
  headers?: Record<string, string>;
  url?: string;
}): Response {
  const response = new Response(PNG_BYTES.slice(), {
    status: init?.status ?? 200,
    headers: init?.headers ?? { "content-type": "image/png" },
  });
  if (init?.url) {
    Object.defineProperty(response, "url", { value: init.url });
  }
  return response;
}

function stubFetch(
  implementation: (url: string, init?: RequestInit) => Promise<Response>,
) {
  const mock = vi.fn(implementation);
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchImageForAnalysis", () => {
  it("fetches exactly the requested URL once, with the analysis request shape", async () => {
    const mock = stubFetch(async () => imageResponse());

    const fetched = await fetchImageForAnalysis("https://cdn.example/pic.png");

    expect(mock).toHaveBeenCalledTimes(1);
    const [url, init] = mock.mock.calls[0]!;
    expect(url).toBe("https://cdn.example/pic.png");
    // The pinned Accept header keeps Vary: Accept CDNs serving the same
    // representation the render got; credentials mirror the render
    // request; the timeout bounds how long the message channel (and the
    // worker's lifetime extension) can be held open.
    expect(init?.headers).toEqual({ accept: IMAGE_ACCEPT });
    expect(init?.credentials).toBe("include");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(fetched.bytes).toEqual(PNG_BYTES);
    expect(fetched.mimeType).toBe("image/png");
    expect(fetched.pinned).toBe(true);
  });

  it("refuses non-http(s) URLs without fetching", async () => {
    const mock = stubFetch(async () => imageResponse());

    for (const url of [
      "file:///etc/passwd",
      "chrome-extension://abc/x.png",
      "data:image/png;base64,AA==",
    ]) {
      await expect(fetchImageForAnalysis(url)).rejects.toThrow(/non-http/);
    }
    expect(mock).not.toHaveBeenCalled();
  });

  it("rejects HTTP errors", async () => {
    stubFetch(async () => imageResponse({ status: 403 }));

    await expect(
      fetchImageForAnalysis("https://cdn.example/pic.png"),
    ).rejects.toThrow(/HTTP 403/);
  });

  it("rejects text responses instead of analyzing a page that is not the image", async () => {
    stubFetch(async () =>
      imageResponse({ headers: { "content-type": "text/html;charset=utf-8" } }),
    );

    await expect(
      fetchImageForAnalysis("https://cdn.example/pic.png"),
    ).rejects.toThrow(/not the rendered image/);
  });

  it("falls back to URL-extension MIME detection when Content-Type is absent", async () => {
    stubFetch(async () =>
      imageResponse({ headers: {}, url: "https://cdn.example/photo.jpg" }),
    );

    const fetched = await fetchImageForAnalysis(
      "https://cdn.example/photo.jpg",
    );
    expect(fetched.mimeType).toBe("image/jpeg");
  });

  it("rejects when no MIME type is determinable", async () => {
    stubFetch(async () =>
      imageResponse({ headers: {}, url: "https://cdn.example/photo" }),
    );

    await expect(
      fetchImageForAnalysis("https://cdn.example/photo"),
    ).rejects.toThrow(/MIME type/);
  });

  it("reports no-store responses as unpinnable", async () => {
    stubFetch(async () =>
      imageResponse({
        headers: { "content-type": "image/png", "cache-control": "no-store" },
      }),
    );

    const fetched = await fetchImageForAnalysis("https://cdn.example/live.png");
    expect(fetched.pinned).toBe(false);
  });
});
