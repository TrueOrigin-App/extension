// Integration tests: the real C2PA WASM validator driven exactly as the MV3
// service worker drives it (no worker, FileReaderSync shim, settings JSON).
// Global fetch is stubbed to throw, proving that validation with local trust
// config touches no network (plan.md §8, constraint 3).

import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runPipeline } from "../../core/pipeline";
import type { MediaInput, SignalProvider } from "../../core/types";
import type { C2paDetail } from "./mapping";
import { activeProviders } from "../index";
import { C2PA_PROVIDER_ID, createC2paProvider } from "./index";

const WASM_PATH = new URL(
  "../../../node_modules/@contentauth/c2pa-wasm/pkg/c2pa_bg.wasm",
  import.meta.url,
);

const fixturePath = (name: string) =>
  new URL(`./fixtures/${name}`, import.meta.url);

async function fixtureInput(
  name: string,
  mimeType = "image/jpeg",
): Promise<MediaInput> {
  return { bytes: new Uint8Array(await readFile(fixturePath(name))), mimeType };
}

let provider: SignalProvider;

beforeAll(async () => {
  const [anchors, storeCfg, wasmBytes] = await Promise.all([
    readFile(fixturePath("test_cert_root_bundle.pem"), "utf8"),
    readFile(fixturePath("store.cfg"), "utf8"),
    readFile(WASM_PATH),
  ]);
  provider = createC2paProvider({
    wasmSource: () => new Uint8Array(wasmBytes),
    trust: { trustAnchors: anchors, trustConfig: storeCfg },
  });
  // Everything the provider needs was handed to it as bytes/text above; any
  // fetch from here on is a privacy bug.
  vi.stubGlobal("fetch", () => {
    throw new Error("network access attempted during local validation");
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("c2pa provider (real WASM)", () => {
  it("is registered as the active local provider", () => {
    expect(activeProviders.map((p) => p.id)).toContain(C2PA_PROVIDER_ID);
    expect(provider.id).toBe(C2PA_PROVIDER_ID);
    expect(provider.cost).toBe("local");
  });

  it("validates a manifest to Trusted against the test anchors", async () => {
    const result = await provider.analyze(await fixtureInput("C.jpg"));
    expect(result.providerId).toBe(C2PA_PROVIDER_ID);
    // C.jpg's manifest declares neither AI nor capture, so the honest
    // finding is "none" — but the detail proves full trust validation ran.
    expect(result.finding).toBe("none");
    expect(result.confidence).toBe(0);
    const detail = result.detail as C2paDetail;
    expect(detail.reason).toBe("no-origin-declaration");
    expect(detail.validationState).toBe("Trusted");
    expect(detail.signatureIssuer).toBe("C2PA Test Signing Cert");
  }, 60_000);

  it("maps an image without C2PA metadata to none", async () => {
    const result = await provider.analyze(
      await fixtureInput("no_manifest.jpg"),
    );
    expect(result.finding).toBe("none");
    expect(result.confidence).toBe(0);
    expect((result.detail as C2paDetail).reason).toBe("no-c2pa-metadata");
  });

  it("maps a tampered asset to none with the failure recorded", async () => {
    const input = await fixtureInput("C.jpg");
    // Flip a byte in the image data (far from the manifest at the front) so
    // the manifest parses but the content hash no longer matches.
    input.bytes[input.bytes.length - 1000]! ^= 0xff;
    const result = await provider.analyze(input);
    expect(result.finding).toBe("none");
    const detail = result.detail as C2paDetail;
    expect(detail.reason).toBe("invalid-manifest");
    expect(detail.validationState).toBe("Invalid");
    expect(detail.validationFailures).toContain("assertion.dataHash.mismatch");
  });

  it("treats undetectable formats as absence of signal, not failure", async () => {
    const result = await provider.analyze({
      bytes: new Uint8Array([1, 2, 3, 4]),
      mimeType: "text/plain",
    });
    expect(result.finding).toBe("none");
    expect(["no-c2pa-metadata", "unsupported-format"]).toContain(
      (result.detail as C2paDetail).reason,
    );
  });

  it("produces an unknown verdict through the full pipeline", async () => {
    const verdict = await runPipeline([provider], await fixtureInput("C.jpg"));
    expect(verdict.verdict).toBe("unknown");
    expect(verdict.basis).toEqual([]);
    expect(verdict.signals).toHaveLength(1);
    expect(verdict.failures).toEqual([]);
  });
});
