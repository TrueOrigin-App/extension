// Pins the worker's onMessage wiring (review follow-up, 2026-08-04): both
// request arms must return `true` synchronously — that is what holds the
// message channel open for the async sendResponse; dropping it would make
// every reply resolve undefined on the content side, failing all analyses
// as "malformed worker reply" while the rest of the suite stays green —
// and must eventually answer with a well-formed reply. Unknown messages
// must be left alone (no `true`, no response) so other listeners can run.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ANALYZE_MESSAGE_TYPE,
  ANALYZE_URL_MESSAGE_TYPE,
  encodeBytes,
  isAnalyzeResponse,
  isAnalyzeUrlResponse,
} from "../messaging/protocol";

type OnMessageListener = (
  message: unknown,
  sender: unknown,
  sendResponse: (reply?: unknown) => void,
) => boolean | undefined;

let listener: OnMessageListener;

beforeAll(async () => {
  const listeners: OnMessageListener[] = [];
  vi.stubGlobal("chrome", {
    runtime: {
      onMessage: {
        addListener: (fn: OnMessageListener) => listeners.push(fn),
      },
      onInstalled: { addListener: () => undefined },
    },
  });
  await import("./index");
  expect(listeners).toHaveLength(1);
  listener = listeners[0]!;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Dispatches a message and captures the synchronous return plus the
 * eventual async reply. */
function dispatch(message: unknown): {
  returned: boolean | undefined;
  reply: Promise<unknown>;
} {
  let resolveReply: (reply: unknown) => void;
  const reply = new Promise<unknown>((resolve) => {
    resolveReply = resolve;
  });
  const returned = listener(message, {}, (value?: unknown) =>
    resolveReply(value),
  );
  return { returned, reply };
}

describe("background onMessage wiring", () => {
  it("holds the channel open and answers the inline-analyze arm", async () => {
    // Real pipeline, no WASM available in this environment: the provider
    // failure must be isolated into an ok:true verdict, not break the
    // channel contract.
    const { returned, reply } = dispatch({
      type: ANALYZE_MESSAGE_TYPE,
      bytesBase64: encodeBytes(new Uint8Array([1, 2, 3])),
      mimeType: "image/png",
      sourceUrl: "https://cdn.example/pic.png",
    });

    expect(returned).toBe(true);
    expect(isAnalyzeResponse(await reply)).toBe(true);
  });

  it("holds the channel open and answers the analyze-url arm", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network unreachable");
      }),
    );

    const { returned, reply } = dispatch({
      type: ANALYZE_URL_MESSAGE_TYPE,
      url: "https://cdn.example/pic.png",
    });

    expect(returned).toBe(true);
    const result = await reply;
    expect(isAnalyzeUrlResponse(result)).toBe(true);
    expect(result).toMatchObject({ ok: false });
  });

  it("ignores unknown messages without claiming the channel", () => {
    const sendResponse = vi.fn();
    const returned = listener({ type: "unrelated" }, {}, sendResponse);

    expect(returned).toBeUndefined();
    expect(sendResponse).not.toHaveBeenCalled();
  });
});
