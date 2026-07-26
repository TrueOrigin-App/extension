# DECISIONS

Free-choice decisions made under plan.md §8, newest at the bottom. Each entry
records what was decided, why, and what was rejected.

## 2026-07-26 — Task 1: repo scaffold

### Bundler: esbuild, driven by a small `build.mjs` script

- **What:** esbuild via its JS API (`build.mjs`), not a framework or plugin
  chain. One entry point per extension context; static files (manifest) copied
  into `dist/`.
- **Why:** MV3 needs precise per-entry control — the service worker builds as
  ESM today, and the content script (task 4) must build as an IIFE. A ~40-line
  script gives that control with no magic, which suits the "audit the free tier
  yourself" positioning (plan.md §7). Bundling the `.wasm` binary in task 3 is
  a plain file copy here.
- **Rejected:** Vite + CRXJS plugin (manifest-transform magic; plugin
  maintenance has been uncertain); WXT (whole-framework abstraction and
  lock-in for what is a small, auditable codebase); webpack (config weight for
  no benefit at this size).

### Test runner: Vitest

- **What:** Vitest, config in `vitest.config.ts`, tests colocated with source
  as `src/**/*.test.ts`.
- **Why:** TypeScript/ESM-native with zero transform config; fast; its API is
  the de-facto standard. The pipeline tests in task 2 are plain unit tests, so
  nothing extension-specific is needed from the runner.
- **Rejected:** Jest (ESM + TS friction, slower); `node:test` (weaker DX,
  no watch/UI conveniences, would still need a TS loader).

### Directory layout

- **What:**
  - `src/manifest.json` — the MV3 manifest, copied to `dist/` at build time
  - `src/background/` — service worker (pipeline host, WASM validator in task 3)
  - `src/core/` — aggregator, verdict mapper, shared types (task 2)
  - `src/providers/` — signal providers; this directory is the §8-constraint-4
    isolation boundary
  - `src/content/` — content script (task 4)
  - `src/popup/` — popup UI (Phase 2)
  - `dist/` — build output, git-ignored; `chrome://extensions` loads this
- **Why:** one directory per extension context mirrors how MV3 actually splits
  execution; keeping providers in their own top-level directory makes the
  "zero changes outside the providers layer" rule visible in diffs.
- **Rejected:** flat `src/` (isolation boundary invisible); `public/` dir for
  the manifest (only one static file so far — a dedicated dir adds nothing).

### TypeScript config

- **What:** `strict` plus `noUncheckedIndexedAccess`, target/lib ES2022,
  `moduleResolution: "bundler"`, `noEmit` (esbuild compiles, `tsc` only
  typechecks), `@types/chrome` for extension APIs.
- **Why:** strictest practical settings from day one are cheap now and
  expensive to retrofit. `bundler` resolution matches how esbuild resolves.
- **Note:** `lib` includes `DOM` globally for now; if DOM types leaking into
  service-worker code becomes a real hazard, split per-context tsconfigs when
  the content script lands (task 4).

### Lint/format: Prettier now, ESLint deferred

- **What:** Prettier with default settings (`.prettierrc.json` is `{}`).
  No ESLint yet.
- **Why:** formatting consistency matters from the first diff; there is not
  yet enough code for lint rules to earn their config. Revisit ESLint
  (typescript-eslint, flat config) around task 4 when real DOM/messaging code
  exists.
- **Rejected:** Biome (would replace Prettier too, but its lint story for
  chrome-extension globals needed more setup than this stage justifies).

### Manifest posture: zero permissions at scaffold

- **What:** the manifest declares only the module service worker — no
  `permissions`, `host_permissions`, or `content_scripts`. A unit test
  (`src/manifest.test.ts`) enforces this.
- **Why:** plan.md §8 requires asking before any permission is added. Nothing
  in the scaffold needs one. Content-script registration and host access will
  be proposed explicitly in task 4.

### NOTICE names Daniel Alyoshin as copyright holder

- **What:** `NOTICE` (Apache 2.0 companion file) credits Daniel Alyoshin,
  notes the trademark carve-out for the TrueOrigin name (plan.md §7).
- **Why:** the repo needs a concrete copyright holder; the sole committer is
  the obvious one. Trivial to change if ownership moves to an org entity.

## 2026-07-26 — Task 2: signal pipeline (interface, aggregator, verdict mapper)

### `MediaInput` shape

- **What:** `{ bytes: Uint8Array; mimeType: string; sourceUrl?: string }`
  (plan.md §3 references the type but leaves it undefined).
- **Why:** the C2PA SDK needs raw bytes plus a MIME type; `sourceUrl` exists
  for local uses only (verdict caching in task 5, popup display) and is
  documented as never leaving the machine (§8 constraint 3).
- **Rejected:** `Blob` (byte-acquisition strategy is task 4/5 territory —
  `Uint8Array` is the lower-level common denominator and structured-clones
  cleanly through message passing); an `element` reference (providers must
  run in the service worker, which has no DOM).

### Core layout and conflict resolution by finding precedence

- **What:** `src/core/types.ts` (shared types), `aggregator.ts` (collect),
  `verdict.ts` (map), `pipeline.ts` (compose). Cross-provider conflicts are
  resolved in the mapper by finding precedence:
  `ai-declared > human-provenance > ai-indicated (above threshold) > unknown`.
- **Why:** the findings already encode the cryptographic/probabilistic split,
  so precedence is principled, not score-juggling: crypto outranks
  probabilistic (§2 "confidence is asymmetric"), and between the two crypto
  findings an AI declaration wins because a false "Human — verified" is the
  worst emission possible and §2 defines that verdict as requiring "no
  disqualifying edits". Losing signals are preserved in `Verdict.signals`
  so the popup can surface conflicts honestly.
- **Rejected:** numeric confidence-weighted scoring across findings (invites
  a probabilistic signal to outvote a cryptographic one — exactly what §2
  forbids); resolving conflicts inside the aggregator (kept it a pure
  collect-and-isolate layer so the taxonomy rules live in one file).

### `Verdict` carries basis, all signals, and failures

- **What:** `{ verdict, basis, signals, failures }` — the winning signals,
  every signal collected (including below-threshold and conflicting ones),
  and per-provider failures.
- **Why:** §3 requires "verdict + supporting detail for the popup"; the
  progressive-disclosure popup (§4) needs the full evidence, and honest UI
  should be able to say "provider X errored" rather than silently claiming
  it checked everything.

### Provider failures are isolated, and malformed results are rejected

- **What:** the aggregator runs providers via `Promise.allSettled`; a throw
  or a malformed `SignalResult` (finding outside the taxonomy, confidence
  not a finite number in [0, 1]) becomes a `ProviderFailure`, never a signal
  and never a crash. Failures contribute nothing to the verdict — an error
  maps toward Unknown, never toward any claim.
- **Why:** one broken provider must not sink the pipeline or corrupt the
  taxonomy (a buggy provider inventing a "not-ai" finding is caught here).
- **Rejected:** clamping bad confidence values into range (silently
  laundering garbage into evidence); per-provider timeouts (real concern for
  WASM, but it belongs with scan scheduling in Phase 2).

### `AI_LIKELY_MIN_CONFIDENCE = 0.7`, provisional

- **What:** a single named threshold in `src/core/verdict.ts`; probabilistic
  signals at or above it yield "ai-likely", below it they remain visible in
  `Verdict.signals` but produce no verdict.
- **Why:** §2 requires "above threshold" without fixing a value, and no real
  probabilistic provider exists until Phase 4 — any number is a placeholder,
  so it is one constant, documented as provisional, revisited when a real
  classifier's operating characteristics are known. 0.7 errs toward Unknown,
  matching the false-accusation failure mode §2 warns about.

### Provider registry: `src/providers/index.ts` exports `activeProviders`

- **What:** the list of providers the extension runs lives inside the
  providers directory; core never imports from `src/providers/` — the
  pipeline takes providers as an argument, and the service worker will wire
  the two together (task 3+). The mock provider (`src/providers/mock.ts`) is
  a test fixture and stays out of the registry.
- **Why:** makes "adding a provider changes nothing outside `src/providers/`"
  (§8 constraint 4) structurally true: the implementation and its
  registration are both providers-layer files. The §6 Phase 1 exit-criterion
  test (`src/core/pipeline.test.ts`) proves the pipeline weighs a
  never-before-seen provider with zero core changes.

## 2026-07-26 — Task 3: C2PA provider (WASM in the service worker)

### Drive `@contentauth/c2pa-wasm` directly — no worker, no `c2pa-web` runtime

- **What:** the provider calls `WasmReader`/`loadSettings` from
  `@contentauth/c2pa-wasm` (the engine package of the current c2pa-js
  monorepo, and a direct dependency of `@contentauth/c2pa-web`) on the
  service-worker thread. `c2pa-web` remains the installed top-level
  dependency and the source of all TypeScript types
  (`ManifestStore`, `Action`, …), but its `createC2pa` entry point is not
  used at runtime.
- **Why:** `createC2pa` unconditionally spawns a dedicated Web Worker, and
  every path to one is closed in an MV3 service worker: the service-worker
  spec forbids nested workers (`new Worker` is unavailable); its inline
  fallback builds the worker from a `blob:`/`data:` URL, which MV3
  extension CSP blocks anyway (and `URL.createObjectURL` does not exist in
  service workers); and its `workerSrc` escape hatch validates the URL as
  `https:`-only, rejecting `chrome-extension://` URLs. The wasm-bindgen
  layer underneath has no worker requirement, and its README sanctions
  direct use. This keeps validation exactly where plan.md §4 wants it — in
  the service worker — with no new permissions.
- **Rejected:**
  - _Offscreen document hosting the SDK_ (Chrome's sanctioned workaround,
    Chrome 113+): requires the `offscreen` permission (must-ask, §8), adds a
    second execution context and message hop, and c2pa-web's blob-worker and
    `https:`-only `workerSrc` are still blocked in extension pages — it
    would need our own worker file regardless. Revisit if direct use breaks.
  - _Patching `c2pa-web`'s worker-URL validation at build time:_ fragile
    against upstream refactors.
  - The plan's named fallback (`/inline` import) does not address this:
    it inlines the WASM but spawns the same worker.
- **Upstream note:** `chrome-extension:` support for `workerSrc` would make
  `c2pa-web` viable in extension pages; worth filing/watching on c2pa-js.

### `FileReaderSync`/Blob shim (`src/providers/c2pa/blob-shim.ts`)

- **What:** the WASM reads assets via `new FileReaderSync()`,
  `blob.slice(start, end)`, and `readAsArrayBuffer(slice)` — sync APIs that
  exist only in dedicated/shared workers. Since the provider already holds
  the full bytes (`MediaInput.bytes`), it hands the WASM a byte-backed
  `ByteBlob` duck-type and installs a `FileReaderSync` polyfill when the
  global is missing (MV3 service worker, Node tests). The shim refuses to
  read anything that is not a `ByteBlob`.
- **Why:** gives the WASM the same synchronous random access the real APIs
  provide, with ~50 lines and no extra execution context. The same shim is
  what lets the integration tests run the real WASM in Node.
- **Risk & containment:** this depends on the binding's observed Blob usage
  (`size`/`slice`/`readAsArrayBuffer`). The integration tests
  (`c2pa-provider.test.ts`) run the real WASM on every `npm test`, so an SDK
  upgrade that touches more of the Blob surface fails loudly, not silently.

### WASM loading: bundled binary, `chrome.runtime.getURL`, lazy init

- **What:** `build.mjs` copies `c2pa_bg.wasm` (8.3 MB) from
  `@contentauth/c2pa-wasm` into `dist/`; the provider initializes it with
  `chrome.runtime.getURL("c2pa_bg.wasm")` (wasm-bindgen fetches +
  `instantiateStreaming`, with a built-in fallback if the MIME type is not
  `application/wasm`). Initialization is lazy (first `analyze()`) and
  memoized; a failed init surfaces as a `ProviderFailure` for that request
  and is retried on the next one.
- **Why:** exactly the loading strategy plan.md §8 (task 3) prescribes — no
  runtime CDN dependency, no base64 bloat. Lazy init keeps worker startup
  free of an 8 MB compile when no image is being analyzed. Failing loud
  (rather than degrading to weaker verification) keeps verdict semantics
  stable; the UI can honestly say "couldn't check".
- **Note:** the manifest now declares
  `content_security_policy.extension_pages` with `'wasm-unsafe-eval'` —
  a CSP source required for WASM instantiation, not a permission.
  The 8.3 MB binary dominates the extension package size; acceptable, and
  worth revisiting only if the store package limit ever becomes a concern.

### Trust configuration and network posture (§8 constraint 3)

- **What:** trust verification is ON (it is what makes `Trusted` — and thus
  "Human — verified" — reachable). At provider init, three global
  trust-infrastructure files are fetched and inlined into the c2pa-rs
  settings JSON, mirroring `c2pa-web`'s `resolveSettings`:
  - `https://contentcredentials.org/trust/anchors.pem` (trust anchors, ~44 KB)
  - `https://contentcredentials.org/trust/store.cfg` (allowed EKUs, ~260 B)
  - `https://contentcredentials.org/trust/allowed.pem` (end-entity list, ~240 KB)

  These are the same public lists the CR Verify site and c2patool use.
  They currently 301 to `verify.contentauthenticity.org` and serve
  `access-control-allow-origin: *` (verified 2026-07-26), so no host
  permissions are needed. Fetches happen once per service-worker lifetime
  (memoized init), never per-content.

- **Hard network disable for the SDK itself:** the settings set
  `verify.ocsp_fetch = false`, `verify.remote_manifest_fetch = false`, and —
  belt and braces — `core.allowed_network_hosts = []`, which c2pa-rs
  documents as "all traffic blocked" for its HTTP resolvers. So even if an
  upstream default changes, no validation path can make a per-content
  request. (Caveat noted upstream: the CAWG identity assertion does not yet
  respect `allowed_network_hosts`, c2pa-rs #1645; we also configure no CAWG
  trust list, so no CAWG fetches are triggered.)
- **Accepted trade-offs:**
  - Remote-only manifests (asset carries a manifest URL instead of embedded
    data) read as "no metadata" → Unknown. Rare in practice; fetching them
    would reveal per-content viewing activity to manifest hosts. Revisit
    with an explicit privacy story if coverage warrants.
  - OCSP revocation is not fetched live (staples and CertificateStatus
    assertions in the manifest are still honored — c2pa-rs checks those
    without network).
  - No trust-list caching across worker restarts yet; belongs with the
    Phase 2 caching task (likely `chrome.storage` — will need the
    permission ask).
  - CAWG identity trust is not configured at launch (no identity UI yet);
    to be revisited when identity surfaces in the popup.
- **Verification:** integration tests stub `fetch` to throw and validate
  fixtures with locally supplied trust text — proving validation itself
  touches no network. The in-browser network-panel check required by
  constraint 3 happens at the task 4 human checkpoint, when the extension
  first loads in Chrome.

### Finding mapping (`src/providers/c2pa/mapping.ts`)

- **What:** a validated store maps to a finding as follows:
  - `validation_state` not `Valid`/`Trusted` → `none` (a broken manifest
    proves nothing — even an AI assertion inside it is unusable).
  - Any action with digital source type `trainedAlgorithmicMedia` or
    `compositeWithTrainedAlgorithmicMedia`, in **any** manifest of the
    validated chain (ingredients included) → `ai-declared`. Accepted at
    both `Valid` and `Trusted`.
  - Else a `c2pa.created` action on the **active** manifest with
    `digitalCapture`/`computationalCapture` → `human-provenance`, but
    **only** at `Trusted`; at merely `Valid` it maps to `none`
    (untrusted capture).
  - Else `none` (no origin declaration). Confidence pins to 1 for the two
    cryptographic findings, 0 for `none`.
- **Why the asymmetry:** an AI declaration is a statement _against_
  interest — forging "this is AI" onto human work is an unlikely attack,
  and requiring `Trusted` would flip real Midjourney/DALL·E output to
  Unknown whenever the public trust list lags a new signer. A capture claim
  is the opposite: self-signing a fake "camera" manifest is the obvious
  attack on a "Human — verified" badge, so it is only as strong as the
  signer's presence on the trust list. This is §2's "confidence is
  asymmetric" applied at the provider level.
- **Scope choices (provisional, recorded for revisit):**
  - AI set excludes `algorithmicMedia` (procedural, "not based on sampled
    training data") and `digitalArt` (human digital art) — erring toward
    Unknown per §2.
  - Capture accepted only when the _active_ manifest is the capture itself.
    A capture manifest buried under edit manifests means the edit chain
    would need benign/disqualifying analysis — Phase 2+ territory; until
    then such assets are honestly Unknown.
  - Capture set excludes film scans (`negativeFilm` etc.) for launch.
- **Rejected:** inferring AI from `softwareAgent` name strings (brittle,
  vocabulary exists precisely to avoid this); treating `Valid` capture as
  weaker-confidence human provenance (§2 pins "Human — verified" to
  cryptographic certainty — there is no "probably human" verdict).

### Test strategy and fixtures

- **What:** two tiers. (1) Pure unit tests drive `mapManifestStore` through
  the full taxonomy matrix with synthetic store JSON. (2) Integration tests
  run the real WASM binary in Node — same shim, same settings path as the
  extension — against fixtures vendored from the c2pa-rs test suite
  (MIT OR Apache-2.0; see `src/providers/c2pa/fixtures/README.md`):
  `C.jpg` validates to `Trusted` against the vendored test root bundle,
  `no_manifest.jpg` exercises absence, and a byte-flipped `C.jpg` exercises
  `Invalid` (`assertion.dataHash.mismatch`).
- **Why:** taxonomy correctness lives in fast pure tests; the integration
  tier proves the real crypto pipeline (including the Trusted state, which
  needs real chain validation) with no network and no committed secrets —
  the vendored certificates are c2pa-rs's published "FOR TESTING_ONLY"
  materials.
- **Rejected:** generating AI/capture-declared fixtures at test time via the
  SDK's Builder — its WASM signer requires the callback to produce a full
  COSE_Sign1 structure (`direct_cose_handling`), i.e. a hand-rolled COSE
  implementation in test code; too much fragile machinery for what the
  mapper tests already cover. A real AI-generated image gets validated
  end-to-end at the task 4 human checkpoint instead.

### Misc

- `@types/node` added (dev tooling) for test file I/O typing.
- The provider treats read errors `JumbfNotFound`/`UnsupportedType` as
  "absence of signal" (`none`), not provider failures — an image without
  metadata is the normal case, not an error. Everything else throws and is
  isolated by the aggregator as a `ProviderFailure`.
