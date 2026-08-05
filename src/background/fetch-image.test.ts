// Pins the worker-side CORS-fallback fetch (task 5.5): request shape
// (single fetch, exact URL, pinned Accept header, credentials, refused
// redirects), the non-http(s) refusal, the body-size ceiling, and the
// guards that keep a wrong representation from being analyzed. This is
// the background-level counterpart of the provider egress suite: the only
// network request the handler may make is the one the content script
// named — and only that URL, never a redirect target of the host's
// choosing.

import { afterEach, describe, expect, it, vi } from "vitest";
import { IMAGE_ACCEPT } from "../lib/image-accept";
import { fetchImageForAnalysis, MAX_ANALYSIS_BODY_BYTES } from "./fetch-image";

// Full PNG signature: the no-Content-Type path resolves by magic-byte
// sniffing, so fixture bytes must actually look like their format.
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const HTML_BYTES = new TextEncoder().encode("<!DOCTYPE html><html></html>");

function imageResponse(init?: {
  status?: number;
  headers?: Record<string, string>;
  url?: string;
  bytes?: Uint8Array;
}): Response {
  const response = new Response((init?.bytes ?? PNG_BYTES).slice(), {
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
    expect(init?.redirect).toBe("manual");
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

  it("sniffs the MIME type from magic bytes when Content-Type is absent", async () => {
    stubFetch(async () =>
      imageResponse({ headers: {}, url: "https://cdn.example/photo.jpg" }),
    );

    const fetched = await fetchImageForAnalysis(
      "https://cdn.example/photo.jpg",
    );
    // The bytes are a PNG; the .jpg URL extension is never consulted.
    expect(fetched.mimeType).toBe("image/png");
  });

  it("rejects an HTML body served with no Content-Type from an image-named URL", async () => {
    // The review's bypass route: the old URL-extension fallback typed
    // this challenge page image/jpeg and analyzed it into an "Unknown"
    // badge about a login page.
    stubFetch(async () =>
      imageResponse({
        headers: {},
        bytes: HTML_BYTES,
        url: "https://cdn.example/photo.jpg",
      }),
    );

    await expect(
      fetchImageForAnalysis("https://cdn.example/photo.jpg"),
    ).rejects.toThrow(/MIME type/);
  });

  it("rejects non-image substitutes regardless of their declared type", async () => {
    for (const contentType of [
      "application/json",
      "application/xhtml+xml",
      "application/xml",
    ]) {
      stubFetch(async () =>
        imageResponse({ headers: { "content-type": contentType } }),
      );
      await expect(
        fetchImageForAnalysis("https://cdn.example/pic.png"),
      ).rejects.toThrow(/not the rendered image/);
    }
  });

  it("refuses to follow redirects", async () => {
    // redirect: "manual" surfaces a redirect as an opaque response in
    // Chrome; a raw 3xx covers environments that pass it through. Either
    // way the credentialed, CORS-exempt request must not be steered to a
    // host the page named indirectly.
    const opaque = imageResponse();
    Object.defineProperty(opaque, "type", { value: "opaqueredirect" });
    stubFetch(async () => opaque);
    await expect(
      fetchImageForAnalysis("https://cdn.example/pic.png"),
    ).rejects.toThrow(/redirect/);

    stubFetch(async () =>
      imageResponse({ status: 302, headers: { location: "http://intranet/" } }),
    );
    await expect(
      fetchImageForAnalysis("https://cdn.example/pic.png"),
    ).rejects.toThrow(/redirect/);
  });

  it("rejects a body whose declared Content-Length exceeds the ceiling without reading it", async () => {
    stubFetch(async () =>
      imageResponse({
        headers: {
          "content-type": "image/png",
          "content-length": String(MAX_ANALYSIS_BODY_BYTES + 1),
        },
      }),
    );

    await expect(
      fetchImageForAnalysis("https://cdn.example/huge.png"),
    ).rejects.toThrow(/ceiling/);
  });

  it("aborts mid-stream when the body exceeds the ceiling", async () => {
    // The streaming check is the enforcement: no Content-Length here, as
    // with chunked or decompressed bodies, and never more than the
    // ceiling held in memory.
    const chunk = 16 * 1024 * 1024;
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls > 8) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(chunk));
      },
    });
    stubFetch(
      async () =>
        new Response(body, {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
    );

    await expect(
      fetchImageForAnalysis("https://cdn.example/bomb.png"),
    ).rejects.toThrow(/ceiling/);
    // Cancelled at the first over-ceiling chunk, not drained to the end.
    expect(pulls).toBeLessThanOrEqual(6);
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
