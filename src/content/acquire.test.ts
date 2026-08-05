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
import {
  acquireAndAnalyze,
  forgetAcquisitionFailure,
  resetAcquisitionMemory,
} from "./acquire";

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
  resetAcquisitionMemory();
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
    // Rung 1 must stay uncredentialed (include would fail the common
    // ACAO:* cache read); rung 2 always hits the network, where the
    // render sent cookies, so it mirrors them (owner decision,
    // 2026-08-04).
    expect(mock.mock.calls.map(([, init]) => init?.credentials)).toEqual([
      undefined,
      "include",
    ]);
    // Both rungs share one deadline: per-rung timeouts stacked into a
    // ~90 s worst-case hold on an analysis slot (review finding).
    const signals = mock.mock.calls.map(([, init]) => init?.signal);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[1]).toBe(signals[0]);
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

  it("does not fall back on HTTP errors the worker cannot cure", async () => {
    // Only Origin-conditioned refusals (401/403) escalate; a second,
    // credentialed request cannot change a 404 or 5xx, and re-hitting a
    // 429 would amplify the limit it just signalled.
    for (const status of [404, 429, 500]) {
      // Each iteration reuses the URL; the failure memory (tested in its
      // own block) would otherwise fail-fast every status after the first.
      resetAcquisitionMemory();
      const mock = stubFetch(async () => imageResponse({ status }));
      const sendMessage = stubWorker({});

      await expect(acquireAndAnalyze(URL_UNDER_TEST)).rejects.toThrow(
        new RegExp(`HTTP ${status}`),
      );
      expect(mock).toHaveBeenCalledTimes(1);
      expect(sendMessage).not.toHaveBeenCalled();
    }
  });

  it("falls back when the in-page response is not an image", async () => {
    // A session-gated host may serve the cookieless in-page analysis
    // fetch a challenge page it would not serve the worker's
    // cookie-bearing request — and analyzing HTML into an "Unknown"
    // badge is the failure mode the shared guard exists to stop.
    stubFetch(async () =>
      imageResponse({
        headers: { "content-type": "text/html;charset=utf-8" },
      }),
    );
    const sendMessage = stubWorker({
      byUrl: { ok: true, verdict: wireVerdict(), pinned: true },
    });

    const entry = await acquireAndAnalyze(URL_UNDER_TEST);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]![0]).toEqual({
      type: ANALYZE_URL_MESSAGE_TYPE,
      url: URL_UNDER_TEST,
    });
    expect(entry.pinned).toBe(true);
  });

  it("falls back when the message channel refuses the inline payload", async () => {
    stubFetch(async () => imageResponse());
    const sendMessage = vi.fn(async (message: { type: string }) => {
      if (message.type === ANALYZE_MESSAGE_TYPE) {
        throw new Error("Message length exceeded maximum allowed length");
      }
      return { ok: true, verdict: wireVerdict(), pinned: true };
    });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });

    const entry = await acquireAndAnalyze(URL_UNDER_TEST);

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[1]![0]).toEqual({
      type: ANALYZE_URL_MESSAGE_TYPE,
      url: URL_UNDER_TEST,
    });
    expect(entry.pinned).toBe(true);
  });

  it("surfaces a channel refusal for URLs the worker cannot fetch", async () => {
    stubFetch(async () => imageResponse());
    const sendMessage = vi.fn(async () => {
      throw new Error("Message length exceeded maximum allowed length");
    });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });

    await expect(
      acquireAndAnalyze("data:image/png;base64,AA=="),
    ).rejects.toThrow(/analysis message failed/);
    expect(sendMessage).toHaveBeenCalledTimes(1);
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

describe("per-page-view acquisition memory", () => {
  it("goes worker-first for a URL proven CORS-blocked", async () => {
    const mock = stubFetch(async () => {
      throw corsTypeError();
    });
    const sendMessage = stubWorker({
      byUrl: { ok: true, verdict: wireVerdict(), pinned: false },
    });

    await acquireAndAnalyze(URL_UNDER_TEST);
    expect(mock).toHaveBeenCalledTimes(2);

    // Second attempt: no in-page fetches at all, straight to the worker.
    await acquireAndAnalyze(URL_UNDER_TEST);
    expect(mock).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it("extends the skip to origin siblings after enough distinct proofs", async () => {
    const mock = stubFetch(async () => {
      throw corsTypeError();
    });
    stubWorker({
      byUrl: { ok: true, verdict: wireVerdict(), pinned: false },
    });

    await acquireAndAnalyze("https://cdn.example/a.png");
    await acquireAndAnalyze("https://cdn.example/b.png");
    const fetchesSoFar = mock.mock.calls.length;

    // Third URL, same origin, never seen: skips the in-page rungs.
    await acquireAndAnalyze("https://cdn.example/c.png");
    expect(mock).toHaveBeenCalledTimes(fetchesSoFar);

    // Different origin: unaffected by the hint.
    await acquireAndAnalyze("https://other.example/d.png");
    expect(mock.mock.calls.length).toBeGreaterThan(fetchesSoFar);
  });

  it("does not record a CORS proof when the worker leg also failed", async () => {
    // Both paths failing looks like offline as much as strict CORS —
    // nothing is proven, so the next attempt runs the full ladder.
    const mock = stubFetch(async () => {
      throw corsTypeError();
    });
    stubWorker({ byUrl: { ok: false, error: "network down" } });

    await expect(acquireAndAnalyze(URL_UNDER_TEST)).rejects.toThrow();
    forgetAcquisitionFailure(URL_UNDER_TEST);

    await expect(acquireAndAnalyze(URL_UNDER_TEST)).rejects.toThrow();
    // Four in-page fetches: the full two-rung ladder ran both times.
    expect(mock).toHaveBeenCalledTimes(4);
  });

  it("fails fast on a URL that failed acquisition moments ago", async () => {
    const mock = stubFetch(async () => imageResponse({ status: 404 }));
    stubWorker({});

    await expect(acquireAndAnalyze(URL_UNDER_TEST)).rejects.toThrow(/HTTP 404/);
    expect(mock).toHaveBeenCalledTimes(1);

    await expect(acquireAndAnalyze(URL_UNDER_TEST)).rejects.toThrow(
      /moments ago.*HTTP 404/,
    );
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("remembers a worker-leg refusal and fails fast on the retry", async () => {
    stubFetch(async () => {
      throw corsTypeError();
    });
    const sendMessage = stubWorker({
      byUrl: { ok: false, error: "image host answered with a redirect" },
    });

    await expect(acquireAndAnalyze(URL_UNDER_TEST)).rejects.toThrow(/redirect/);

    await expect(acquireAndAnalyze(URL_UNDER_TEST)).rejects.toThrow(
      /moments ago/,
    );
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("does not remember timeouts", async () => {
    // A stall is origin slowness; the retry budget exists to heal it.
    const mock = stubFetch(async () => {
      throw new DOMException("timed out", "TimeoutError");
    });
    stubWorker({});

    await expect(acquireAndAnalyze(URL_UNDER_TEST)).rejects.toThrow(
      /timed out/,
    );
    await expect(acquireAndAnalyze(URL_UNDER_TEST)).rejects.toThrow(
      /timed out/,
    );
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("forgets a remembered failure on identity invalidation", async () => {
    const mock = stubFetch(async () => imageResponse({ status: 404 }));
    stubWorker({});

    await expect(acquireAndAnalyze(URL_UNDER_TEST)).rejects.toThrow(/HTTP 404/);
    forgetAcquisitionFailure(URL_UNDER_TEST);

    await expect(acquireAndAnalyze(URL_UNDER_TEST)).rejects.toThrow(/HTTP 404/);
    expect(mock).toHaveBeenCalledTimes(2);
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
