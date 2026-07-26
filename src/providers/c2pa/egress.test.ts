// Egress allowlist test (plan.md §8, constraint 3, enforced as a test).
//
// Runs the real WASM validator across the whole fixture suite with the
// provider in its production configuration (DEFAULT_TRUST_CONFIG, remote
// manifests enabled) and fetch instrumented. The only URLs that may ever be
// requested are (a) the trust-bundle URLs from DEFAULT_TRUST_CONFIG, at
// initialization, and (b) the manifest URL embedded in the asset under
// test. Any other egress — from our code or from inside the SDK — throws at
// fetch time and fails the suite. This is the regression guard for "media
// bytes and page URLs never leave the machine".

import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { MediaInput, SignalProvider } from "../../core/types";
import type { C2paDetail } from "./mapping";
import { DEFAULT_TRUST_CONFIG } from "./settings";
import { createC2paProvider } from "./index";

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

function urlsOf(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).filter((v) =>
    v.startsWith("http"),
  );
}

/** Every URL the provider is allowed to request at initialization. Derived
 * from the shipped config so a config change updates the allowlist — and a
 * new egress path does not. */
const TRUST_URLS = [
  ...urlsOf(DEFAULT_TRUST_CONFIG.trustAnchors),
  ...urlsOf(DEFAULT_TRUST_CONFIG.trustConfig),
  ...urlsOf(DEFAULT_TRUST_CONFIG.allowedList),
];

/** The remote manifest URL embedded in fixtures/cloud.jpg (XMP
 * dcterms:provenance). */
const CLOUD_MANIFEST_URL =
  "https://cai-manifests.adobe.com/manifests/adobe-urn-uuid-5f37e182-3687-462e-a7fb-573462780391";

let provider: SignalProvider;
let trustBundlePem: string;
let storeCfg: string;
let cloudManifestBytes: Uint8Array<ArrayBuffer>;

/** Every request of the whole session, in order. */
const sessionLog: string[] = [];
/** Requests since the last drain — used for per-asset assertions. */
let recentLog: string[] = [];

function drainRecent(): string[] {
  const drained = recentLog;
  recentLog = [];
  return drained;
}

function respond(
  body: string | Uint8Array<ArrayBuffer>,
  url: string,
): Response {
  const response = new Response(body, { status: 200 });
  // Node-constructed Responses carry url: ""; the WASM's HTTP layer parses
  // the URL, and a real fetch would carry it.
  Object.defineProperty(response, "url", { value: url });
  return response;
}

beforeAll(async () => {
  const wasmBytes = await readFile(WASM_PATH);
  trustBundlePem = await readFile(
    fixturePath("test_cert_root_bundle.pem"),
    "utf8",
  );
  storeCfg = await readFile(fixturePath("store.cfg"), "utf8");
  cloudManifestBytes = new Uint8Array(
    await readFile(fixturePath("cloud_manifest.c2pa")),
  );

  provider = createC2paProvider({
    wasmSource: () => new Uint8Array(wasmBytes),
    // Deliberately NOT overridden: this test runs the shipped trust config
    // so the trust-list egress is exercised and accounted for.
  });

  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = String(
      typeof input === "string" ? input : "url" in input ? input.url : input,
    );
    sessionLog.push(url);
    recentLog.push(url);
    if (TRUST_URLS.includes(url)) {
      // Serve local stand-ins: PEM where PEM is required, the EKU config
      // for the trust store. Content only needs to be structurally valid.
      return respond(url.endsWith(".cfg") ? storeCfg : trustBundlePem, url);
    }
    if (url === CLOUD_MANIFEST_URL) {
      return respond(cloudManifestBytes, url);
    }
    throw new Error(`egress outside the allowlist: ${url}`);
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("egress allowlist", () => {
  it("initialization requests exactly the trust-bundle URLs", async () => {
    // First analysis triggers provider init; no_manifest.jpg itself
    // requires no network.
    const result = await provider.analyze(
      await fixtureInput("no_manifest.jpg"),
    );
    expect((result.detail as C2paDetail).reason).toBe("no-c2pa-metadata");
    expect(drainRecent().sort()).toEqual([...TRUST_URLS].sort());
  });

  it("validating an embedded manifest makes no requests", async () => {
    const result = await provider.analyze(await fixtureInput("C.jpg"));
    // Trusted proves the URL-served trust config was actually applied, not
    // just fetched.
    expect((result.detail as C2paDetail).validationState).toBe("Trusted");
    expect(drainRecent()).toEqual([]);
  });

  it("validating a tampered asset makes no requests", async () => {
    const input = await fixtureInput("C.jpg");
    input.bytes[input.bytes.length - 1000]! ^= 0xff;
    const result = await provider.analyze(input);
    expect((result.detail as C2paDetail).reason).toBe("invalid-manifest");
    expect(drainRecent()).toEqual([]);
  });

  it("an asset without metadata makes no requests", async () => {
    await provider.analyze(await fixtureInput("no_manifest.jpg"));
    expect(drainRecent()).toEqual([]);
  });

  it("undetectable bytes make no requests", async () => {
    await provider.analyze({
      bytes: new Uint8Array([1, 2, 3, 4]),
      mimeType: "text/plain",
    });
    expect(drainRecent()).toEqual([]);
  });

  it("a remote-manifest asset requests exactly its embedded URL", async () => {
    const result = await provider.analyze(await fixtureInput("cloud.jpg"));
    expect((result.detail as C2paDetail).reason).toBe("no-origin-declaration");
    expect(drainRecent()).toEqual([CLOUD_MANIFEST_URL]);
  });

  it("the whole session stayed inside the allowlist", () => {
    const allowed = new Set([...TRUST_URLS, CLOUD_MANIFEST_URL]);
    const offenders = sessionLog.filter((url) => !allowed.has(url));
    expect(offenders).toEqual([]);
    // And the suite actually exercised both allowed egress categories —
    // guard against this test passing vacuously.
    expect(sessionLog.length).toBeGreaterThanOrEqual(TRUST_URLS.length + 1);
  });
});
