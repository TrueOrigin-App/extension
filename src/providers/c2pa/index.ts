// The C2PA signal provider (plan.md §3, launch provider). Drives
// @contentauth/c2pa-wasm — part of the current c2pa-js monorepo and the
// engine under @contentauth/c2pa-web — directly on the calling thread,
// because an MV3 service worker cannot host the dedicated worker c2pa-web
// requires. See DECISIONS.md (task 3).
//
// Free tier privacy (plan.md §8, constraint 3): media bytes and page URLs
// never leave the machine — validation is local WASM. Network requests are
// limited to the cached global trust-list fetches and the disclosed
// remote-manifest fetches configured in settings.ts.

import initWasm, {
  WasmReader,
  loadSettings,
  type InitInput,
} from "@contentauth/c2pa-wasm";
import type {
  MediaInput,
  SignalProvider,
  SignalResult,
} from "../../core/types";
import { ByteBlob, installFileReaderSyncShim } from "./blob-shim";
import { mapManifestStore, type C2paDetail } from "./mapping";
import {
  DEFAULT_TRUST_CONFIG,
  buildSettingsJson,
  type TrustListConfig,
} from "./settings";

export const C2PA_PROVIDER_ID = "c2pa";

/** Must match the filename build.mjs copies into dist/. */
const WASM_FILENAME = "c2pa_bg.wasm";

export interface C2paProviderOptions {
  /** Where the WASM binary comes from. Defaults to the copy bundled with
   * the extension package, loaded via chrome.runtime.getURL (plan.md §8,
   * task 3). Tests pass raw bytes read from node_modules. */
  wasmSource?: () => InitInput | Promise<InitInput>;
  /** Trust list configuration. Defaults to the public Content Credentials
   * trust lists; tests pass local PEM/config text. */
  trust?: TrustListConfig;
}

// The WASM module and its settings are process-global in c2pa-wasm, so they
// are initialized once per worker lifetime and shared. The registry creates
// a single c2pa provider; if a second instance with different settings is
// ever created, the last one to initialize wins.
let wasmReady: Promise<void> | null = null;

function initWasmOnce(
  source: () => InitInput | Promise<InitInput>,
): Promise<void> {
  if (!wasmReady) {
    const pending = Promise.resolve(source())
      .then((input) => initWasm({ module_or_path: input }))
      .then(() => undefined);
    wasmReady = pending;
    pending.catch(() => {
      // Allow a later analyze() to retry (e.g. transient fetch failure).
      if (wasmReady === pending) wasmReady = null;
    });
  }
  return wasmReady;
}

function defaultWasmSource(): string {
  return chrome.runtime.getURL(WASM_FILENAME);
}

function thrownMessage(thrown: unknown): string {
  if (typeof thrown === "string") return thrown;
  if (thrown instanceof Error) return thrown.message;
  return String(thrown);
}

/** Maps read errors that mean "nothing usable here" (rather than "the check
 * broke") to an absence detail; returns undefined for genuine failures. */
function absenceDetail(thrown: unknown): C2paDetail | undefined {
  const message = thrownMessage(thrown);
  if (message.includes("JumbfNotFound")) {
    return { reason: "no-c2pa-metadata" };
  }
  if (message.includes("UnsupportedType")) {
    return { reason: "unsupported-format" };
  }
  // The asset references a remote manifest that could not be retrieved
  // (offline, 404, or CORS-blocked until broad host permissions land in
  // task 4/5). The check ran; the referenced provenance was unreachable —
  // that is an absence the popup can disclose, not a provider failure.
  if (message.includes("RemoteManifestFetch")) {
    return { reason: "remote-manifest-unavailable" };
  }
  return undefined;
}

export function createC2paProvider(
  options: C2paProviderOptions = {},
): SignalProvider {
  const wasmSource = options.wasmSource ?? defaultWasmSource;
  const trust = options.trust ?? DEFAULT_TRUST_CONFIG;

  // Initialization is lazy (the MV3 worker is event-driven; there is no
  // work to do until the first analysis request) and memoized. A failed
  // initialization is reported as a provider failure for that analysis and
  // retried on the next one — degrading to weaker verification instead
  // would silently change what verdicts mean.
  let ready: Promise<void> | null = null;

  function ensureReady(): Promise<void> {
    if (!ready) {
      const pending = (async () => {
        installFileReaderSyncShim();
        const [settingsJson] = await Promise.all([
          buildSettingsJson(trust),
          initWasmOnce(wasmSource),
        ]);
        loadSettings(settingsJson);
      })();
      ready = pending;
      pending.catch(() => {
        if (ready === pending) ready = null;
      });
    }
    return ready;
  }

  return {
    id: C2PA_PROVIDER_ID,
    cost: "local",
    async analyze(input: MediaInput): Promise<SignalResult> {
      await ensureReady();

      let reader: WasmReader;
      try {
        reader = await WasmReader.fromBlob(
          input.mimeType,
          // The WASM only uses size/slice/FileReaderSync on this object;
          // see blob-shim.ts.
          new ByteBlob(input.bytes) as unknown as Blob,
        );
      } catch (thrown) {
        const detail = absenceDetail(thrown);
        if (detail) {
          return {
            providerId: C2PA_PROVIDER_ID,
            finding: "none",
            confidence: 0,
            detail,
          };
        }
        throw new Error(`C2PA read failed: ${thrownMessage(thrown)}`);
      }

      try {
        const store = reader.manifestStore();
        const { finding, detail } = mapManifestStore(store);
        return {
          providerId: C2PA_PROVIDER_ID,
          finding,
          // Cryptographic findings pin to 1 (plan.md §3); "none" carries no
          // signal and pins to 0.
          confidence: finding === "none" ? 0 : 1,
          detail,
        };
      } finally {
        reader.free();
      }
    },
  };
}
