// Pins the byte-acquisition ladder (task 5.5): in-page force-cache →
// no-cache → worker-side fetch, the oversized-transport route, and the
// no-completed-check policy. fetch and chrome.runtime.sendMessage are
// stubbed; the assertions are about which rung ran and what crossed the
// message channel.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ANALYZE_MESSAGE_TYPE,
  ANALYZE_URL_MESSAGE_TYPE,
  decodeBytes,
  type AnalyzeResponse,
  type AnalyzeUrlResponse,
  type WireVerdict,
} from "../messaging/protocol";
import { acquireAndAnalyze } from "./acquire";

const URL_UNDER_TEST = "https://cdn.example/pic.png";
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
// Must exceed acquire.ts's MAX_INLINE_TRANSPORT_BYTES (32 MiB).
const OVERSIZED = 32 * 1024 * 1024 + 1;

function wireVerdict(overrides?: Partial<WireVerdict>): WireVerdict {
  const signal = {
    providerId: "c2pa",
    finding: "none" as const,
    confidence: 0,
    detail: null,
  };
  return {
    verdict: "unknown",
    basis: [],
    signals: [signal],
    failures: [],
    ...overrides,
  };
}

function imageResponse(init?: {
  status?: number;
  headers?: Record<string, string>;
  bytes?: Uint8Array;
}): Response {
  const response = new Response((init?.bytes ?? PNG_BYTES).slice(), {
    status: init?.status ?? 200,
    headers: init?.headers ?? { "content-type": "image/png" },
  });
  Object.defineProperty(response, "url", { value: URL_UNDER_TEST });
  return response;
}

function stubFetch(
  implementation: (url: string, init?: RequestInit) => Promise<Response>,
) {
  const mock = vi.fn(implementation);
  vi.stubGlobal("fetch", mock);
  return mock;
}

/** Stubs chrome.runtime.sendMessage with per-message-type replies. */
function stubWorker(replies: {
  inline?: AnalyzeResponse | unknown;
  byUrl?: AnalyzeUrlResponse | unknown;
}) {
  const sendMessage = vi.fn(async (message: { type: string }) => {
    if (message.type === ANALYZE_MESSAGE_TYPE) return replies.inline;
    if (message.type === ANALYZE_URL_MESSAGE_TYPE) return replies.byUrl;
    throw new Error(`unexpected message type: ${message.type}`);
  });
  vi.stubGlobal("chrome", { runtime: { sendMessage } });
  return sendMessage;
}

function corsTypeError(): TypeError {
  return new TypeError("Failed to fetch");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("in-page path", () => {
  it("ships the fetched bytes inline and reports the response pinnable", async () => {
    stubFetch(async () => imageResponse());
    const sendMessage = stubWorker({
      inline: { ok: true, verdict: wireVerdict() },
    });

    const entry = await acquireAndAnalyze(URL_UNDER_TEST);

    expect(entry.pinned).toBe(true);
    expect(entry.verdict.verdict).toBe("unknown");
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const message = sendMessage.mock.calls[0]![0] as {
      type: string;
      bytesBase64: string;
      mimeType: string;
      sourceUrl: string;
    };
    expect(message.type).toBe(ANALYZE_MESSAGE_TYPE);
    expect(message.mimeType).toBe("image/png");
    expect(message.sourceUrl).toBe(URL_UNDER_TEST);
    expect(decodeBytes(message.bytesBase64)).toEqual(PNG_BYTES);
  });

  it("marks no-store responses unpinnable", async () => {
    stubFetch(async () =>
      imageResponse({
        headers: { "content-type": "image/png", "cache-control": "no-store" },
      }),
    );
    stubWorker({ inline: { ok: true, verdict: wireVerdict() } });

    const entry = await acquireAndAnalyze(URL_UNDER_TEST);
    expect(entry.pinned).toBe(false);
  });

  it("retries a force-cache TypeError with no-cache before falling back", async () => {
    // The task-5.2 CORS-unusable-cache-entry fix: an entry stored by the
    // no-cors render can be served to the cors-mode fetch as a
    // deterministic TypeError; revalidating recovers where the network
    // itself is fine.
    const mock = stubFetch(async (_url, init) => {
      if (init?.cache === "force-cache") throw corsTypeError();
      return imageResponse();
    });
    const sendMessage = stubWorker({
      inline: { ok: true, verdict: wireVerdict() },
    });

    await acquireAndAnalyze(URL_UNDER_TEST);

    expect(mock.mock.calls.map(([, init]) => init?.cache)).toEqual([
      "force-cache",
      "no-cache",
    ]);
    expect(sendMessage.mock.calls[0]![0]).toMatchObject({
      type: ANALYZE_MESSAGE_TYPE,
    });
  });
});

describe("worker-side fallback", () => {
  it("falls back when both in-page fetches hit the CORS layer", async () => {
    const mock = stubFetch(async () => {
      throw corsTypeError();
    });
    const sendMessage = stubWorker({
      byUrl: { ok: true, verdict: wireVerdict(), pinned: false },
    });

    const entry = await acquireAndAnalyze(URL_UNDER_TEST);

    expect(mock).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]![0]).toEqual({
      type: ANALYZE_URL_MESSAGE_TYPE,
      url: URL_UNDER_TEST,
    });
    // The worker saw the response headers; its pinnability ruling is the
    // one the URL cache must honor.
    expect(entry.pinned).toBe(false);
  });

  it("falls back on an HTTP error without a no-cache retry", async () => {
    // e.g. hosts that 403 Origin-carrying requests they would serve bare:
    // the worker's fetch is exempt from that class of refusal.
    const mock = stubFetch(async () => imageResponse({ status: 403 }));
    const sendMessage = stubWorker({
      byUrl: { ok: true, verdict: wireVerdict(), pinned: true },
    });

    const entry = await acquireAndAnalyze(URL_UNDER_TEST);

    expect(mock).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]![0]).toMatchObject({
      type: ANALYZE_URL_MESSAGE_TYPE,
    });
    expect(entry.pinned).toBe(true);
  });

  it("routes oversized bytes through the worker fetch instead of the message channel", async () => {
    stubFetch(async () => imageResponse({ bytes: new Uint8Array(OVERSIZED) }));
    const sendMessage = stubWorker({
      byUrl: { ok: true, verdict: wireVerdict(), pinned: true },
    });

    await acquireAndAnalyze(URL_UNDER_TEST);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]![0]).toEqual({
      type: ANALYZE_URL_MESSAGE_TYPE,
      url: URL_UNDER_TEST,
    });
  });

  it("does not fall back on a timeout", async () => {
    // A 30 s stall is origin slowness; the worker would pay the same 30 s
    // for the same likely outcome. The retry budget re-attempts later.
    const mock = stubFetch(async () => {
      throw new DOMException("timed out", "TimeoutError");
    });
    const sendMessage = stubWorker({});

    await expect(acquireAndAnalyze(URL_UNDER_TEST)).rejects.toThrow(
      /timed out/,
    );
    expect(mock).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("does not fall back for non-http(s) URLs", async () => {
    stubFetch(async () => {
      throw corsTypeError();
    });
    const sendMessage = stubWorker({});

    await expect(
      acquireAndAnalyze("data:image/png;base64,AA=="),
    ).rejects.toThrow();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("rejects a malformed fallback reply", async () => {
    stubFetch(async () => {
      throw corsTypeError();
    });
    stubWorker({ byUrl: { ok: true, verdict: wireVerdict(), pinned: "yes" } });

    await expect(acquireAndAnalyze(URL_UNDER_TEST)).rejects.toThrow(
      /malformed worker reply/,
    );
  });

  it("propagates a fallback error reply", async () => {
    stubFetch(async () => {
      throw corsTypeError();
    });
    stubWorker({ byUrl: { ok: false, error: "HTTP 404" } });

    await expect(acquireAndAnalyze(URL_UNDER_TEST)).rejects.toThrow(/HTTP 404/);
  });
});

describe("no-completed-check policy", () => {
  const incomplete = wireVerdict({
    signals: [],
    failures: [{ providerId: "c2pa", message: "wasm init failed" }],
  });

  it("rejects a verdict in which no check completed (inline path)", async () => {
    stubFetch(async () => imageResponse());
    stubWorker({ inline: { ok: true, verdict: incomplete } });

    await expect(acquireAndAnalyze(URL_UNDER_TEST)).rejects.toThrow(
      /no check finished.*wasm init failed/,
    );
  });

  it("rejects a verdict in which no check completed (fallback path)", async () => {
    stubFetch(async () => {
      throw corsTypeError();
    });
    stubWorker({ byUrl: { ok: true, verdict: incomplete, pinned: true } });

    await expect(acquireAndAnalyze(URL_UNDER_TEST)).rejects.toThrow(
      /no check finished/,
    );
  });

  it("accepts a degraded verdict that still rests on a completed check", async () => {
    // Multi-provider future: one provider finished, another failed. The
    // verdict renders; the popover disclosure is what makes it honest.
    stubFetch(async () => imageResponse());
    stubWorker({
      inline: {
        ok: true,
        verdict: wireVerdict({
          failures: [{ providerId: "other", message: "boom" }],
        }),
      },
    });

    const entry = await acquireAndAnalyze(URL_UNDER_TEST);
    expect(entry.verdict.failures).toHaveLength(1);
  });
});
