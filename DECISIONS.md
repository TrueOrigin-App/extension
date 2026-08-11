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
- **Upgrade policy (added 2026-07-26):** because this arrangement depends on
  SDK internals (the wasm-bindgen Blob usage, error strings, settings
  keys), `@contentauth/c2pa-web` and `@contentauth/c2pa-wasm` are pinned to
  exact versions in `package.json` — no caret/tilde ranges, and `c2pa-wasm`
  is declared directly rather than ridden in transitively. SDK version
  bumps are deliberate events: done manually, never by an automated range
  resolution, and the full integration test suite (`c2pa-provider.test.ts`,
  `egress.test.ts` — the tests that run the real WASM) must pass before the
  bump merges.
- **Exit condition:** if upstream changes break the direct-wasm integration
  twice, stop extending the shim and migrate to the offscreen-document
  pattern (own worker file importing `c2pa-wasm`, `offscreen` permission
  ask, message relay). Two breaks would mean the internals this rests on
  are churning; the shim is only worth keeping while it stays ~50 lines of
  stable glue.

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

## 2026-07-26 — Task 3 follow-up: remote manifests enabled, trust lists cached

### Remote manifest fetching: ON, with disclosure (owner decision)

- **What:** `verify.remote_manifest_fetch = true`. When an asset carries only
  a manifest URL (XMP `dcterms:provenance` or JUMBF reference), the SDK
  fetches that URL to retrieve the provenance. Verified against the real
  WASM: the fetch is a single async `fetch()` of the manifest URL (SW-safe;
  the wasm has no sync-XHR path), and the retrieved manifest goes through
  the full validation pipeline (`fixtures/cloud.jpg` +
  `cloud_manifest.c2pa` integration test).
- **Privacy framing:** this is a per-asset request that reveals to the
  manifest host that the asset is being viewed. It does not carry media
  bytes or page URLs (constraint 3 intact), and it is the request the asset
  itself asks a validator to make. **Disclosure obligation:** the Phase 3
  privacy write-up and store listing must state that assets referencing
  remote provenance trigger a fetch of that reference; the popup can
  disclose it per-image later (wording is Phase 3 brand work).
- **Consequences:**
  - `core.allowed_network_hosts` (the previous belt-and-braces block-all)
    is removed — manifests may live on any host, so a blanket block is
    incompatible with this feature. `ocsp_fetch = false` remains the guard
    on the SDK's only other reading-time network path.
  - An unreachable remote manifest (offline, 404, CORS) maps to finding
    "none" with detail reason `remote-manifest-unavailable` — the check ran
    and the referenced provenance was unreachable, which is an absence the
    popup can disclose, not a provider failure. Error shape
    (`C2pa(RemoteManifestFetch(...))`) verified against the real WASM.
  - **CORS caveat:** until broad host permissions land (task 4/5, with the
    required ask), cross-origin manifest fetches only succeed where hosts
    serve permissive CORS headers. Host permissions will lift this; noted
    for the task 4 checkpoint.

### Trust lists cached via the Cache API, 24h TTL, stale-on-error

- **What:** trust-list fetches now go through
  `src/providers/c2pa/trust-cache.ts`: a Cache API cache
  (`trueorigin-trust-v1`) stamped with a fetched-at header. Entries younger
  than 24h are served without network; stale entries are refetched; a
  failed refetch falls back to the stale copy (a day-old trust list beats
  disabled verification). Cache writes are best-effort; environments
  without `caches` (Node tests) degrade to plain fetches.
- **Why:** MV3 terminates idle service workers in ~30s, so the previous
  "once per worker lifetime" memoization would refetch ~285 KB many times
  per browsing session; upstream's own HTTP caching hints are too short
  (max-age=60 on the allowed list) to absorb that.
- **Why Cache API and not `chrome.storage`:** `chrome.storage.local` would
  require adding the `storage` permission (a must-ask under §8, and a dent
  in the zero-permission posture the trust positioning leans on). The Cache
  API is available in service workers with no manifest permission and is
  purpose-built for URL-keyed responses. Trade-off: browser storage
  eviction could theoretically clear it, in which case the worst case is a
  refetch — graceful.
- **TTL choice:** 24h. Upstream serves s-maxage=12h; a day keeps us at most
  one signer-onboarding cycle behind while cutting network chatter to at
  most one refresh per list per day. Revisit with real usage data in
  Phase 2.

### Egress allowlist enforced as a test

- **What:** `src/providers/c2pa/egress.test.ts` runs the real WASM across
  the whole fixture suite with the provider in its production configuration
  (shipped `DEFAULT_TRUST_CONFIG`, remote manifests enabled) and fetch
  instrumented. Allowed egress is exactly: the trust-bundle URLs (at
  initialization, derived from the shipped config so the allowlist tracks
  it) and the manifest URL embedded in the asset under test — asserted
  per-asset, so a remote-manifest fetch during someone else's asset would
  fail too. Any other URL, whether from our code or from inside the SDK,
  throws at fetch time and fails the suite.
- **Why:** turns constraint 3 from a review-time property into a regression
  guard — an SDK upgrade that grows a new network path (OCSP default flip,
  telemetry, CAWG trust fetches) breaks the build instead of shipping. The
  test also proves the URL-served trust config is applied, not just fetched
  (C.jpg must validate as Trusted through it).

## 2026-07-26 — Real AI-declared fixture; trust-URL fix

### `fixtures/ai_declared.png`: real OpenAI provenance in the test suite

- **What:** the deferred "real AI image" end-to-end test now exists. The
  owner supplied a gpt-image 2.0 generation carrying a claim v2 manifest
  from "OpenAI Media Service API" (`c2pa.created` with
  `digitalSourceType: trainedAlgorithmicMedia`, signed by "OpenAI OpCo,
  LLC"). Integration tests assert the provider maps it to `ai-declared`
  (confidence 1) and that the full pipeline emits the `ai-declared`
  verdict; the egress suite confirms analyzing it makes no network
  requests.
- **What it proved:** the signer is absent from both the c2pa-rs test
  anchors and — verified against the live lists — the CR trust list
  (2026-07-26), so the image validates as `Valid` with
  `signingCredential.untrusted`, not `Trusted`. Real production AI
  provenance would read Unknown under a Trusted-only rule; the
  accept-AI-at-Valid decision is now exercised by a real asset in CI.
- **Phase 2 note:** the CR list is Adobe's known-certificates list, not the
  C2PA conformance program's trust list. Evaluate adding the conformance
  list as a second anchor source — it likely covers signers (OpenAI among
  them) that CR lags on, which matters more once "Human — verified"
  coverage is in focus.

### Trust list URLs corrected to verify.contentauthenticity.org

- **What:** `DEFAULT_TRUST_CONFIG` pointed at
  `contentcredentials.org/trust/*`. Probing the new fixture revealed
  `allowed.pem` 404s there — only `anchors.pem` and `store.cfg` redirect to
  `verify.contentauthenticity.org`, where all three files exist (with
  `access-control-allow-origin: *`). Shipped config would have failed
  provider initialization on first use. All three URLs now point at
  `verify.contentauthenticity.org` directly.
- **Why tests missed it:** the egress suite stubs fetch (by design — no
  network in tests), so a dead default URL is invisible to it. The task 4
  human checkpoint (extension loaded for real, network panel open) remains
  the verification point for live defaults; recorded here so that check
  explicitly includes all trust fetches succeeding (five, after the
  conformance lists were added below).

## 2026-07-26 — C2PA conformance trust lists added as anchor sources

- **What:** `DEFAULT_TRUST_CONFIG.trustAnchors` is now an array of three
  PEM sources, fetched and concatenated by the existing resolver: Adobe's
  CR anchors, the C2PA conformance program's official trust list, and its
  TSA (time-stamping authority) trust list — both published in
  `c2pa-org/conformance-public` on GitHub (raw URLs serve
  `access-control-allow-origin: *`; still no host permissions). Owner
  approved promoting this from the earlier Phase 2 note.
- **Why:** verified against the real WASM: the OpenAI-signed
  `ai_declared.png` fixture validates as **Trusted** via the conformance
  list (and via the concatenation) but only **Valid** via Adobe's list —
  the standards body has certified signers Adobe's list lags on. Wider
  Trusted coverage upgrades real AI provenance from "valid but untrusted
  signer" to cryptographically trusted, and directly increases how often
  the (Trusted-only) "Human — verified" verdict is reachable. The TSA list
  rides along because c2pa-rs validates timestamp certificates against the
  same `trust_anchors` store (there is no separate TSA setting), and
  trusted timestamps keep manifests verifiable after signing certs expire.
- **Verified:** production concatenation (CR + conformance + TSA +
  allowed_list + store.cfg) validates `ai_declared.png` → Trusted with no
  failures, and correctly leaves the test-CA-signed `C.jpg` at Valid. The
  egress allowlist test derives its allowed URLs from the config, so the
  two new fetches are covered automatically.
- **Note:** the lists are fetched from the repo's `main` branch — the live,
  standards-maintained version — deliberately not pinned to a commit:
  freezing trust anchors would freeze signer onboarding and revocation. The
  24h trust cache bounds staleness either way.

## 2026-07-26 — State at task 3 close / handoff notes for task 4

Task 3 (and follow-ups) are complete: real C2PA provider in the service
worker, remote manifests, trust caching, conformance trust lists, egress
allowlist test, real-AI fixture. 73 tests green; `npm run build` produces a
loadable `dist/`. Task 4 per plan.md §8: content script, single-image
validation on a test page, one badge — **human checkpoint before
proceeding**.

Accumulated obligations that land on task 4, consolidated from the entries
above:

- **First real-browser run.** Nothing has been loaded into Chrome yet. The
  first `analyze()` in a real MV3 worker exercises the FileReaderSync shim,
  WASM init via `chrome.runtime.getURL`, and the Cache API trust cache
  outside Node for the first time.
- **Network-panel audit (constraint 3).** While validating a test image:
  exactly five trust fetches on first run
  (`verify.contentauthenticity.org` ×3, `raw.githubusercontent.com` ×2),
  none on a warm run within 24h (cache), no other egress except a
  remote-manifest fetch for assets that reference one. Findings feed the
  Phase 3 privacy write-up.
- **Real AI image end-to-end:** `fixtures/ai_declared.png` (or any fresh
  OpenAI/Firefly image) through the content script should badge as
  AI — declared, now expected Trusted via the conformance list.
- **Remote-manifest CORS reality check:** confirm behavior on hosts without
  permissive CORS (expected: `remote-manifest-unavailable` detail until
  host permissions land).

Asks task 4 must put to the owner before proceeding (§8):

- `content_scripts` registration and host access — a permission change.
- Badge wording/presentation — verdict wording is brand territory; note
  plan.md Phase 3 expects a first `/impeccable init` pass around now so
  brand context exists while UI is built.

The seam to build against: `analyzeMedia()` in `src/background/index.ts`
(message protocol shape is a free choice; record it here).

## 2026-07-26 — Task 4: content script, first badge, localhost test page

### Owner decisions (§8 asks, resolved before building)

- **Content script scope: localhost only.** `content_scripts.matches` is
  `http://localhost/*` + `http://127.0.0.1/*` (match patterns ignore ports);
  still no `permissions`/`host_permissions` keys. Owner directive for
  task 5: when broad access is needed, bring it as a §8 ask covering both
  `content_scripts` matches and `host_permissions`, with the
  optional-host-permissions alternative explicitly evaluated. The manifest
  test now enforces exactly this scope.
- **Badge wording: plan.md §2 labels verbatim** ("AI — declared",
  "AI — likely", "Human — verified", "Unknown") in deliberately plain,
  neutral styling, marked placeholder in `src/content/labels.ts`. Final
  wording/presentation is Phase 3 brand work (Impeccable).

### Message protocol (`src/messaging/protocol.ts`)

- **What:** one request/response pair over `chrome.runtime.sendMessage`:
  `{ type: "trueorigin:analyze", bytesBase64, mimeType, sourceUrl }` →
  `{ ok: true, verdict: WireVerdict } | { ok: false, error: string }`.
  `WireVerdict` is `Verdict` with each failure's `error: unknown` reduced
  to a string; everything else passes through. The worker keeps the
  channel open (`return true`), which also extends its lifetime across the
  lazy WASM init on first analysis.
- **Why base64:** extension messaging JSON-serializes payloads — typed
  arrays do not survive. ~33% size overhead is fine at task-4 scale;
  revisit at task 5 alongside byte acquisition (Chrome's ~64 MB message
  cap and double-buffering both argue for moving large-image transport or
  fetching into the worker once host permissions exist).
- **Constraint 3 note:** bytes and `sourceUrl` cross an extension-internal
  channel only; nothing new leaves the machine.
- **Rejected:** worker-side fetch of the image URL (needs host
  permissions + hits CORS; in-page fetch runs with the page's own
  privileges); `chrome.runtime.connect` port streaming (complexity without
  need at one message per image).

### Badge overlay technique (`src/content/badge.ts`)

- **What:** one zero-size, absolutely-positioned host `<div>` appended to
  `<html>`, `pointer-events: none`, max z-index, with an open shadow root
  isolating badge styles both directions. Badges are children positioned
  in document coordinates over each image's top-left corner, so they
  scroll with the page. Removing the single host removes everything.
- **Why:** the host page's DOM is never restructured (§8: must not break
  layout) and removability is one `remove()` (§8: must be removable).
- **Accepted task-4 limitations** (task 5 territory, with viewport
  scanning): no reposition on resize/layout shift, one-shot scan at
  `document_idle` (dynamically added images unseen), no dedupe or verdict
  caching.
- **Failure = no badge.** A failed analysis supports no claim about the
  image — not even "Unknown", which the mapper reserves for checks that
  ran. Failures log to the console (`[TrueOrigin]` prefix); honest error
  presentation belongs to the popup (Phase 2).
- **Rejected:** wrapping images in a positioned container (restructures
  host DOM — the constraint this technique exists to satisfy); one host
  per image (more churn, harder removal, no isolation benefit).

### Scope: every image on the test page, not literally one

- Plan.md §8 says "single-image validation on a test page → one badge",
  but the accumulated checkpoint obligations (real-AI badge, no-manifest
  absence, remote-manifest CORS reality check) require several fixtures
  analyzed in one session. The content script loops over `document.images`
  — same single-image logic per image, no scheduling/caching machinery.

### Test page and server (`test-page/`)

- `index.html` shows the four vendored fixtures with expected outcomes and
  the network-audit checklist; `serve.mjs` is a node-stdlib static server
  (zero dependencies — keeps clear of the §8 new-dependency ask; dev-only,
  never in the extension package). `npm run test-page`, port 8917, serves
  an explicit fixture allowlist (images only — never the certs/configs in
  the same directory).

### Verification

- 80 tests green (73 + 6 protocol + 1 manifest-scope), typecheck clean,
  `dist/` builds (content.js bundles as IIFE, 3.9 kB). The human
  checkpoint — first real-browser run, network-panel audit, real-AI badge,
  remote-manifest CORS behavior — is pending and gates task 5.

## 2026-07-26 — Task 4 checkpoint: PASSED (first real-browser run)

Extension loaded unpacked in Chrome for the first time; owner watched the
service-worker network panel while the agent drove the test page via
browser automation. Results feed the Phase 3 privacy write-up.

### Verdicts and badges — all correct

- `ai_declared.png` → **AI — declared**, validation state **Trusted**
  confirmed in the live console (conformance trust list working in-browser,
  not just in Node).
- `C.jpg`, `no_manifest.jpg`, `cloud.jpg` → **Unknown**, each for its
  expected distinct reason. No content-script errors; badges positioned
  correctly; re-render on reload works.
- First real exercise of the FileReaderSync/Blob shim, WASM init via
  `chrome.runtime.getURL`, and the Cache API trust cache inside a real MV3
  worker — all behaved as in the Node integration tests.

### Network audit (constraint 3) — clean

- **Cold run (SW panel):** exactly the six expected external requests —
  `verify.contentauthenticity.org` ×3 (anchors, store.cfg, allowed list),
  `raw.githubusercontent.com` ×2 (conformance + TSA lists),
  `cai-manifests.adobe.com` ×1 (the remote manifest cloud.jpg itself
  references). Plus the local `chrome-extension://…/c2pa_bg.wasm` load.
  Nothing else — no media bytes, no page URLs, no telemetry.
- **Warm runs:** page reloads added only `cai-manifests.adobe.com`
  requests — zero trust-list refetches. The 24 h Cache API trust cache
  works in the real worker.
- **Page-side:** only `localhost:8917` requests.
- **Remote-manifest CORS reality check:** the Adobe manifest fetch
  returned **200 without host permissions** — `cai-manifests.adobe.com`
  serves permissive CORS, so the `remote-manifest-unavailable` fallback
  was not exercised live (it remains covered by integration tests). The
  fetched manifest validated and still honestly yielded Unknown. Hosts
  with strict CORS remain a task-5 concern alongside the host-permissions
  ask.

### Observations for task 5

- **Every image is fetched twice** (browser render + content-script byte
  acquisition — visible as doubled requests to the local server). Verdict
  caching / smarter byte acquisition in task 5 should collapse this.
- **Chrome crashed once** when the owner reloaded the extension through
  `chrome://extensions` during manual testing. Not reproduced or
  diagnosed; worth watching during task-5 daily-driver use — if it
  recurs, suspect the 8 MB WASM worker teardown/restart path first.

Task 5 may proceed, opening with the §8 ask for broad `content_scripts`
matches + `host_permissions` (optional-host-permissions alternative to be
evaluated, per the owner's task-4 directive).

## 2026-07-26 — First `/impeccable init` pass: PRODUCT.md created

Plan.md §6 Phase 3 schedules two init passes; this is the first (before the
popup task, so brand context is standing input for Phase 2 UI work). The
second, post-soak re-interview remains the authoritative one for Phase 3.

### PRODUCT.md written via Impeccable (per §8 constraint 5)

- Generated by the `/impeccable init` interview, sourced from plan.md plus
  three owner answers: primary user is the **general public from day one**
  (not a verification-minded beachhead); success is the **free tier as
  foundation for the paid tier** (trust-first, conversion-ready); and
  **WCAG 2.2 AA is a hard floor** for all extension UI. Everything else in
  the file restates confirmed plan.md/DECISIONS.md facts — the verdict
  taxonomy and its rules remain governed by plan.md §2.
- No DESIGN.md and no visual direction — init records product truth only;
  the visual world is established later when visual work is requested.

### PRODUCT.md added to `.prettierignore`

- Same rationale as plan.md's entry: authored docs stay out of repo-wide
  formatting; formatters are scoped to code.

## 2026-07-26 — Impeccable scoped to the project; formatter fence

### Vendored skill + shared settings committed (why, alternatives)

- The impeccable skill is vendored at `.claude/skills/impeccable/` with
  its detector hooks and an `enabledPlugins` override (disabling the
  owner's global impeccable plugin here) in the committed
  `.claude/settings.json`, so every contributor runs the same pinned
  version. Rejected: relying on each contributor's global plugin
  install (version drift, doubled hooks for anyone with both).
  Updates are deliberate: `npx impeccable check` / `update`, landing as
  reviewable commits. The installer honors hooks living in the shared
  settings.json and won't re-duplicate them into settings.local.json.
- Per-machine files stay out of the repo: `.claude/settings.local.json`
  and `.impeccable/config.local.json` (hook consent) are gitignored.

### `.claude/` added to `.prettierignore`

- `format:check` flagged 107 vendored skill files. Formatting them
  would drift the vendored copy from upstream and pollute every future
  `npx impeccable update` diff — formatters stay scoped to this
  project's own code.

## 2026-07-26 — Trust-list parts joined with a newline

### `resolveTrustValue` concatenates with `\n`, not `""`

- Raised by review as defensive hardening; no current source triggers it.
  RFC 7468 requires PEM BEGIN/END boundaries to occupy their own line. If
  any configured trust-list URL ever stopped serving a trailing newline,
  bare concatenation would fuse two boundaries into a 10-dash run, and
  rustls_pemfile (under c2pa-rs) skips malformed sections silently — the
  affected anchors would drop out of the trust store with no error, and
  the `requirePem` substring check would still pass on the remaining
  certificates. The visible symptom would be capture-provenance assets
  silently degrading from Trusted to Valid, i.e. human-provenance →
  unknown.
- Rejected: normalizing each part to end with a newline before joining
  (same effect, more code); leaving it and relying on upstream sources to
  keep their trailing newlines (an invariant we do not control and cannot
  detect breaking). Blank lines between encapsulated messages are legal,
  so the separator is inert while every source already ends with one.

### `.impeccable/` fenced from Prettier; hook state files gitignored

- Same rationale as the `.claude/` entry: `hook.cache.json` is generated
  by the design hook and never hand-edited, so `format:check` flagging it
  is pure noise.
- `hook.cache.json` and `hook.pending.json` move into the committed
  `.gitignore`. The impeccable installer had registered them in
  `.git/info/exclude`, which is per-clone and never shared — every other
  contributor would have seen the cache as untracked. Rejected: ignoring
  `.impeccable/` wholesale, which would also swallow `config.json`, the
  shared config that is meant to be committed.

## 2026-07-26 — Task 5.1: broad host access, viewport lazy scanning, scan scheduling

### Owner decision (§8 ask, resolved before building): broad static access, both keys

- **What:** `content_scripts.matches` and `host_permissions` both become
  `["http://*/*", "https://*/*"]`. No `permissions` key; nothing optional.
- **Evaluation presented (per the task-4 owner directive):**
  - _Broad static, both keys_ (chosen): a broad `content_scripts` match alone
    already triggers Chrome's maximal "read and change all your data on all
    websites" install warning, so adding `host_permissions` costs nothing
    further in warning terms while immediately granting the service worker
    cross-origin fetch — which fixes the known strict-CORS remote-manifest
    caveat now and unblocks 5.5's CORS fallbacks and 5.2's double-fetch
    collapse. Since Chrome 127, users can downgrade any extension to
    per-site/on-click access in browser UI, so opt-down exists without us
    building opt-in machinery.
  - _Broad scripts, defer host_permissions to 5.5_ (rejected): identical
    install warning, so the deferral reduces capability without reducing
    scariness.
  - _Optional host permissions_ (rejected): `optional_host_permissions` +
    `scripting` + runtime-registered content scripts would minimize the
    install warning, but the extension would do nothing passively until the
    user grants access through UI that only exists after the popup task
    (5.3) — the core promise (verdicts as you browse) would become
    conditional. Revisitable later as a "minimal footprint" mode without
    architectural change.
- **Scope detail:** `http/https` only, deliberately not `<all_urls>` —
  `file:` is gated behind a user toggle anyway and `ftp:` is dead; narrower
  is honest. The manifest test pins both keys to exactly this scope.

### Viewport scanning: IntersectionObserver + DOM discovery split

- **What:** discovery and analysis are separate. All light-DOM `<img>`
  elements are _discovered_ (initial pass over `document.images`, then a
  MutationObserver for added subtrees and `src`/`srcset` attribute changes)
  and handed to one IntersectionObserver (`rootMargin: 200px` lookahead).
  Images authored inside shadow roots are not discovered — none of the
  discovery entry points pierce shadow boundaries (still-open list at the
  end of this entry). Only images that
  actually intersect are fed to the scheduler — discovery observes, it never
  analyzes, keeping §4's "no full-page sweeps" true on dynamic pages.
- **Src swaps are identity changes:** a `src`/`srcset` mutation removes any
  existing badge immediately (a badge for the old bytes is a false claim),
  forgets the element's scan state, and re-observes it (re-`observe()`
  always emits a fresh entry, so a visible swapped image re-queues without
  waiting for a threshold crossing). A verdict that arrives after the image
  it described was swapped is discarded by a URL recheck before badging.
- **Rejected:** analyzing on discovery (full-page sweep, exactly what §4
  forbids); polling `document.images` (misses nothing but burns CPU;
  MutationObserver is the platform's push channel for this).

### Scan scheduling: dwell debounce + bounded concurrency (`scheduler.ts`)

- **What:** a DOM-free `ScanScheduler` (unit-tested with fake timers) with
  per-item lifecycle: entering the viewport starts a **250 ms dwell**;
  leaving before it elapses cancels at zero cost (this is the §4 "debounce
  viewport churn" requirement — fast scrolling analyzes nothing). Dwelled
  items queue through a concurrency gate of **2** in-flight analyses;
  leaving the viewport while queued dequeues, while running lets the
  analysis finish (the work is paid for; the verdict stays useful). Completed
  items never re-analyze this page view; failures are likewise terminal for
  the page view (retry policy belongs with verdict caching, 5.2).
- **Numbers (provisional):** 250 ms dwell ≈ below-perception delay but
  enough for flick-scrolling to skip past; concurrency 2 because the WASM
  validator serializes in the worker anyway — the overlap only hides
  fetch/encode latency; 200 px lookahead pre-warms near-viewport images
  without scanning the whole page. Revisit all three against daily-driver
  feel (§6 cadence note).
- **Min-size gate:** images under **64 px** on their short side are skipped
  (icons, avatars, spacers — the badge itself would outsize them). Skipped
  images are forgotten, not marked done, so one that grows past the
  threshold is reconsidered on viewport re-entry. Threshold provisional.
- **In-flight URL coalescing was considered and deferred:** duplicate
  same-URL images analyze independently this session; the URL-keyed cache
  (5.2) subsumes coalescing properly. Recorded so 5.2 picks it up.

### Badge lifecycle: keyed per image, event-driven re-anchoring

- **What:** `badge.ts` now keeps one badge per image (a `Map`), so
  re-analysis replaces rather than stacks. `syncBadges()` re-anchors every
  badge to its image's current document coordinates, hides badges whose
  image has a collapsed rect (hidden carousel slides), and removes badges
  whose image left the document — also untracking the element so a
  re-inserted image is scanned fresh. Sync runs rAF-coalesced on the events
  that actually move layout: window resize, any DOM mutation batch,
  capture-phase subresource `load` events (an image finishing its load
  shifts everything below it with no mutation), and `document.fonts.ready`.
- **Known gap (accepted):** pure CSS-driven movement with none of those
  triggers (animations/transitions repositioning images) leaves a badge
  stale until the next layout event. A continuous rAF loop would close it
  at a standing battery cost; revisit only if daily-driver use surfaces it.
- **Task-4 limitations now lifted:** one-shot scan (dynamic images are
  discovered), no reposition on resize/layout shift (event-driven sync),
  badge stacking on re-render (keyed). Still open by design: verdict
  caching + double-fetch collapse (5.2), cross-origin byte acquisition
  (5.5), `all_frames` (iframes unscanned — embedded content; needs its own
  look at frame-flooding cost before enabling), shadow-DOM discovery
  (images authored inside shadow roots are invisible to `document.images`,
  the document-rooted MutationObserver, and `querySelectorAll` alike —
  revisit after the daily-driver soak; Lit-based sites like Reddit are
  the natural test).

## 2026-07-28 — Task 5.1 review fixes (pre-merge batch)

Fixes from the pre-merge review of PR #2; each closes a path to a false or
stale badge, or to scanning silently stopping. Larger follow-ups the review
also surfaced (URL-keyed badge invalidation, `removedNodes` handling,
ResizeObserver revival for small-gated images, a DOM test environment) are
deliberately not in this batch.

### Analysis fetch pins Chrome's image Accept header

- **What:** the byte-acquisition `fetch` sends the same `Accept` list
  Chrome sends for `<img>` requests instead of the default `*/*`.
- **Why:** on `Vary: Accept` content-negotiating CDNs (Cloudflare Polish,
  Vercel image optimization, Cloudinary `f_auto`, …) `*/*` can be served a
  different representation than the page displayed — e.g. the signed
  original while the user sees an unsigned transcode, and transcoding is
  exactly what strips C2PA. The verdict must describe the bytes on screen.
- **Rejected:** reading the actual request header via `webRequest` (a
  permission ask for observability we don't otherwise need); leaving the
  default (verdicts about the wrong bytes). The hardcoded list can drift
  from future Chrome defaults; revisit if Chrome's image Accept changes.

### Hung loads and fetches are bounded (10 s settle, 30 s fetch)

- **What:** `imageSettled` resolves after 10 s even if neither `load` nor
  `error` fired, and the byte fetch carries `AbortSignal.timeout(30_000)`.
  Both settle listeners now unregister through one AbortController
  (previously the un-fired half of the load/error pair leaked per
  analysis).
- **Why:** an image whose network request never settles held one of the
  two analysis slots forever; two such images silently stopped all
  scanning for the page view, with nothing logged.
- **Rejected:** treating settle-timeout as failure (punishes slow but
  legitimate loads — analysis can proceed with the currentSrc already
  chosen); no fetch timeout (any tarpit URL permanently burns a slot).
  Numbers are provisional like the other scheduling constants.

### Same-value src writes are not identity changes

- **What:** the MutationObserver requests `attributeOldValue`, and
  `handleSrcChange` runs only when the attribute value actually changed.
- **Why:** per the DOM spec, `setAttribute` queues a record even when the
  value is identical — jQuery `.attr("src", url)` galleries and the
  `img.src = img.src` reload idiom do this routinely. Each spurious record
  stripped the badge and restarted the 250 ms dwell; a page rewriting src
  faster than the dwell starved analysis forever.
- **Rejected:** tracking last-analyzed URL per element (that is the
  URL-keyed invalidation redesign, follow-up work — this guard is the
  minimal per-record fix and stays correct under it).

### Badges re-anchor on scroll (capture phase)

- **What:** `document.addEventListener("scroll", scheduleSync, true)`
  joins the sync triggers.
- **Why:** document-coordinate anchoring makes plain window scrolling free
  only for normal-flow images. position:fixed/sticky subtrees move
  relative to the document on every scroll tick, and inner scrollers
  (modals, chat panes, carousels) move their images without touching
  `window.scrollY` — the stranded badge could sit over a different image
  and misattribute a verdict. Capture phase because scroll doesn't bubble.
- **Cost:** one rAF-coalesced sync pass per frame during active scrolling —
  precisely the moments a re-anchor is needed. The accepted CSS-animation
  gap from the 5.1 entry stands.

### Verdicts for detached images are dropped; badge host self-heals

- **What:** the pre-badge staleness guard now also checks
  `image.isConnected`, and `ensureHost()` re-adopts all live badges into a
  rebuilt host — with `syncBadges` calling it, so a page-removed host is
  restored on the next layout event rather than the next fresh verdict.
- **Why:** a verdict landing after its image was detached re-created a
  ghost badge for an element no longer on screen; and a page tearing out
  the overlay host (document.write, SPA root replacement) left every
  cached badge parented to the detached shadow root — updated and
  positioned forever, visible never. A regression vs the pre-5.1 render
  path, which appended a fresh div per render.

## 2026-07-28 — URL-keyed badge invalidation and scan generations

Second review batch: one design change replaces per-symptom patches for
the remaining false-claim findings. The invariant it adds: **a badge is a
claim about a specific URL, and it survives only while the image still
displays that URL.**

### Badges carry the URL they describe; sync enforces the match

- **What:** `renderBadge` records the analyzed URL with each badge, and
  `syncBadges` removes any badge whose image's live `currentSrc` no
  longer matches, invoking a new `onImageStale` callback so the content
  script re-queues the image (`invalidateScan`).
- **Why:** element-keyed state cannot see same-element representation
  changes. Responsive `srcset` re-selection (window resize, DPR change)
  and `<picture>` source selection swap the displayed bytes with **no
  mutation record on the img** — previously the badge silently kept
  asserting a verdict about bytes no longer on screen, and a mid-analysis
  swap on this path marked the element "done", unbadged forever.
- **Rejected:** patching each symptom separately (three patches, and the
  next unforeseen identity path would lie again — the URL recheck is a
  backstop for all of them); a ResizeObserver on badged images (detects
  layout, not representation, and misses DPR-only changes).
- 5.2 note: the verdict cache should key on this same analyzed-URL
  identity, and its cache hits will absorb the rescan cost of spurious
  invalidations.

### `<picture>` mutations invalidate the sibling `<img>`

- **What:** attribute records on `<source>` children (`srcset`, `sizes`,
  `media`, `type`) and `<source>` add/remove (childList on the
  `<picture>`) invalidate the enclosing picture's `<img>`. `sizes` joins
  `src`/`srcset` as identity attributes on `<img>` itself.
- **Why:** the sync-time URL recheck only protects _badged_ images; an
  unbadged image (failed analysis, or one still dwelling) also needs
  source changes to reset its state, exactly as `src` writes already do.
- **Unconditional by design:** whether the mutation actually changed
  selection is unknowable at record time (the browser re-runs selection
  asynchronously), and a spurious rescan is the safe direction — the
  false-claim direction is not.

### Scan generations close the stale-run race

- **What:** a per-element generation counter (WeakMap). Every
  invalidation (`invalidateScan`, `untrack`) bumps it; `analyzeImage`
  captures the generation at start and re-checks after every await —
  a run whose generation is stale returns without touching scheduler
  state or badges. The post-analysis URL mismatch (current generation,
  changed URL) is the one case where the run itself invalidates: it
  means re-selection happened with no record, so nothing else re-queued
  the element.
- **Why:** the review confirmed a stale run's unconditional
  `scheduler.reset` could cancel the fresh dwell a src swap had just
  queued. Ownership-by-generation makes stale runs inert instead of
  destructive, and it is precisely the guard that lets the mid-analysis
  invalidation above exist (a blind reset there would clobber the fresh
  cycle a mutation already queued).
- **Rejected:** threading an AbortSignal into `analyzeImage` (stops
  wasted fetch work too, but is a larger change with the same
  correctness result — worth revisiting with 5.2, where an aborted run
  should also skip cache writes); run tokens inside `ScanScheduler`
  (the scheduler stays DOM-free and identity-blind; the content script
  owns element identity).

### All attributes observed (attributeFilter dropped)

- **What:** the MutationObserver now observes every attribute
  (`attributeOldValue` retained; the same-value guard from the previous
  batch still gates identity handling).
- **Why:** two consumers need records the old
  `["src", "srcset"]` filter suppressed: identity handling
  (`sizes` on `<img>`; `srcset`/`sizes`/`media`/`type` on `<source>`)
  and badge sync — class/style toggles are how carousels and tabs hide
  slides, and without a record the stale badge of a hidden slide kept
  painting over the shared box of the newly shown one (verdict
  misattribution), while a revealed slide's badge stayed hidden.
- **Cost accepted:** per-record work is an instanceof plus a Set lookup;
  sync is rAF-coalesced and returns immediately on pages with no badges.
  Side effect: style-attribute-driven movement (animation libraries
  writing inline styles) now re-anchors badges — the accepted CSS gap
  narrows to stylesheet-driven animations/transitions only.

### Rode along: `tracked` WeakSet deleted; syncBadges read/write split

- The review proved `tracked` a bijective mirror of the observer's own
  `[[ObservationTargets]]` (`observe`/`unobserve` are spec-idempotent),
  with the `handleSrcChange` untracked branch unreachable and equivalent
  to the fall-through. `track()` is now bare `observe()`;
  `handleSrcChange` is subsumed by `invalidateScan` with one
  unconditional body.
- `syncBadges` batches all `getBoundingClientRect` reads before the
  first style write: one forced layout flush per pass instead of one per
  moving badge.

## 2026-07-28 — Removed images are untracked at the mutation, not the badge

- **What:** the MutationObserver's childList branch walks `removedNodes`
  symmetrically with `addedNodes`: every disconnected `<img>` (including
  those inside a removed subtree) is untracked — generation bump,
  scheduler reset, unobserve. A node still connected when the callback
  runs was _moved_ in the same task, not removed, and keeps its scan
  state and badge.
- **Why:** removal was previously only noticed for **badged** images
  (via the syncBadges reap path). A removed image that failed analysis
  or never earned a badge stayed in the scheduler's states Map for the
  page lifetime — retaining the detached element — and a recycled
  element re-inserted by a virtualized list was never scanned again
  (`states.has` short-circuits `enter()`), contradicting the
  scanned-fresh-on-reinsertion contract.
- **Rejected:** WeakMap-keyed scheduler state. Mechanically possible
  (states/dwellTimers are pure keyed access), but it forces
  `T extends object` and breaks the scheduler's string-item unit tests,
  still leaves the transient queue array holding strong refs, and hides
  the lifecycle bug rather than fixing it — the element would become
  collectable yet remain unscannable on re-insertion. Deterministic
  untracking fixes the leak and the rescan hole together.
- The syncBadges disconnected-image path stays as a backstop for
  removals that never produced a record (e.g. nodes detached before the
  observer started).

## 2026-07-28 — Min-size gate: layout metric + ResizeObserver revival

- **What:** two coupled changes to the 64 px furniture gate. (1) It now
  measures layout (border-box `offsetWidth`/`offsetHeight`) instead of
  the transformed `getBoundingClientRect`. (2) A gated image is handed
  to a shared ResizeObserver and revived (`invalidateScan`) the moment
  its border-box crosses the threshold; observation ends at revival or
  at any untrack/invalidation.
- **Why (revival):** with `thresholds: [0]`, an already-intersecting
  image never receives another IntersectionObserver entry, so in-place
  growth — a lazy-load placeholder hydrating, a container expanding, a
  hidden slide toggled visible — previously left the image unanalyzed
  for the whole page view unless it fully left the 200 px margin and
  came back.
- **Why (metric):** ResizeObserver reports layout size and cannot see
  transforms, so gating on the visual rect while reviving on layout
  would loop forever on a persistently scaled-down image (revive →
  re-fail → re-observe → initial entry ≥ threshold → revive …). Gating
  on layout aligns the two metrics, which also makes the revival
  self-limiting: the initial entry a fresh `observe()` delivers reports
  the same too-small size the gate just measured, so it never revives.
  Semantically, layout size is the space the page allocated to the
  image — a scale-animated entrance (transform 0.2 → 1) is content and
  now analyzes immediately instead of being permanently skipped, while
  true furniture (icons, avatars) is small in layout too.
- **Rejected:** keeping the rect gate plus remembering the gated size to
  detect "real" growth (extra bookkeeping to preserve a metric whose
  only distinct behavior — skipping transform-scaled content — was a
  bug); a periodic re-measure loop (standing cost for an event the
  platform will push to us).

## 2026-07-28 — DOM test environment (jsdom) and lifecycle tests

- **What:** `jsdom` added as a dev dependency; `badge.test.ts` runs
  under a per-file `@vitest-environment jsdom` pragma while the default
  stays node (the scheduler and pipeline tests are DOM-free and fast).
  New coverage: the badge lifecycle (keying and replacement,
  positioning, collapsed-rect hiding, removed-image reaping, stale-URL
  dropping, host-rebuild re-adoption, fresh-attach after removal) and
  two scheduler contracts the review found unpinned — a stale run
  finishing after `reset()` must not re-mark the item done, and
  `leave()` while running lets the analysis finish and frees the slot.
  The test helper's handle map is now keyed per call rather than per
  item; the review showed the old shape resolved the fresh run instead
  of the stale one, making the reset test's core assertion pass even
  with the guard deleted. Both new pins were mutation-checked: removing
  the `finally` guard fails the stale-run test, and dropping
  `badges.delete` in `removeBadgeFor` fails the removal test.
- **Why:** the review demonstrated the entire DOM-side lifecycle was
  unfalsifiable — `npm test` stayed green under deliberate breakage.
  CLAUDE.md's "run tests before declaring done" only means something if
  the tests can fail.
- **Rejected:** happy-dom (faster, but weaker fidelity on the shadow
  DOM this code leans on); jsdom as the global default (environment
  cost for the DOM-free majority of the suite).
- **Limits (accepted):** jsdom has no layout, so rects are mocked, and
  the IntersectionObserver / MutationObserver / ResizeObserver wiring
  in index.ts stays untested — that is real-browser soak territory
  (§6 cadence note).

## 2026-07-28 — Design-hook exception: broken-image off for the content script

- **What:** `.impeccable/config.json` gains a `detector.ignoreValues`
  entry: rule `broken-image`, all values, scoped to
  `src/content/index.ts` only.
- **Why:** the rule pattern-matches the string `<img>` inside that
  file's code comments — which necessarily discuss the elements the
  script processes on host pages — and re-flagged every edit. The file
  ships no markup, so there is no broken-image box to fix.
- **Rejected:** `ignore-file` (silences every rule, including future
  ones, for a file that may someday hold real findings); inline disable
  comments (suppressions belong in one reviewable config place);
  ignoring the rule project-wide (it must stay active for real UI
  surfaces — the 5.3 popup ships actual `<img>` tags).

## 2026-08-03 — Task 5.2: verdict caching per URL/content-hash, double-fetch collapse

Plan.md §4 asks for verdicts "cached per URL/content-hash"; both keys now
exist, as two layers with different lifetimes, built on one shared
primitive. No new permissions, no protocol changes, no changes outside the
existing layers.

### One primitive, two layers (`src/lib/coalescing-lru.ts`)

- **What:** `CoalescingLruCache` — async memo with in-flight coalescing
  (concurrent `getOrRun` calls for one key share one run), a `retain`
  gate on resolved values, never-cached rejections, and LRU eviction.
  Two instances:
  - **Content script, URL-keyed** (`verdictsByUrl`, 200 entries,
    page-view lifetime): keyed by the same analyzed-URL identity badges
    carry, exactly as the 5.1 review note prescribed. Duplicate same-URL
    images share one analysis (the coalescing 5.1 deferred here), and the
    rescans spurious invalidations trigger are absorbed as cache hits.
  - **Worker, content-hash-keyed** (`src/background/verdict-cache.ts`,
    256 entries, worker lifetime): key is SHA-256 of the bytes plus the
    declared MIME type (an analysis input — same bytes parse differently
    under a different type). Serves the same image under a different URL,
    from another tab, or across a reload while the worker lives.
    `sourceUrl` is deliberately absent from the key — the pipeline's
    output depends only on bytes and MIME type (verified: provider detail
    is derived from the manifest store alone), so URL aliasing must not
    fragment the cache.
- **Why in-memory, not persistent:** `chrome.storage` is a permission ask
  (§8) and a dent in the zero-permission posture; persisting a
  browsing-derived URL→verdict map to disk is also a new privacy surface
  for marginal gain — re-analysis after a worker restart costs one local
  WASM run against the already-cached HTTP entry and 24h-cached trust
  lists. Revisit only if soak shows real cost. `src/lib/` is a new
  directory for context-neutral utilities: core stays verdict-domain,
  and both the content script and worker import the primitive.
- **Cap sizes (200/256) are provisional** like the other tuning
  constants; entries are one verdict object each, so the bounds only
  guard pathological sessions (infinite scroll, image-heavy browsing).
- **Rejected:** Cache API for verdicts (URL-keyed Response store fits
  trust lists, not hash-keyed JSON, and persistence is unwanted per
  above); coalescing in the scheduler (it stays identity-blind; URL
  identity is the content script's business).

### Retention and retry policy (the 5.1 open item)

- **What:** only failure-free verdicts are cached, in both layers; a
  verdict carrying `ProviderFailure`s renders as before but reflects a
  transient condition (WASM init failure, trust-list outage) that must
  not be replayed after it clears. Rejections (fetch/CORS/protocol
  errors) are never cached and propagate to every coalesced caller.
  Within a page view a failed element stays terminal (scheduler "done",
  unchanged from 5.1) — but the failure is not remembered by URL, so
  another same-URL element, any identity invalidation, or the next page
  view retries fresh.
- **Why not retry-on-viewport-re-entry:** the dominant failure class
  until 5.5 is strict-CORS byte acquisition, which is deterministic per
  URL — blind in-view retries would refetch on every scroll pass for
  nothing.
- **The review's "aborted runs must skip cache writes" concern
  dissolved:** `fetchAndAnalyze` is element-independent by design — its
  result is a claim about a URL, valid regardless of what happened to
  the element that wanted it (a mid-flight src swap means the verdict
  describes the _old_ URL, which is precisely what the cache key says).
  Element staleness is still enforced at badge time by the existing
  generation/URL rechecks.
- **data:/blob: URLs bypass the URL layer:** a data: URL as a Map key
  would retain the full payload string; the worker's hash layer dedupes
  their analysis regardless.

### Double-fetch collapse: analysis fetch is `cache: "force-cache"`

- **What:** the content-script byte fetch now reuses the HTTP-cache entry
  the render stored, regardless of freshness. Content-script fetches
  share the page's cache partition, and the Accept header pinned in 5.1
  keeps `Vary: Accept` entries matching — so the doubled requests
  observed at the task-4 checkpoint collapse to one network fetch per
  image (analysis reads from disk/memory cache). Where no entry exists
  (`no-store`, eviction), the fetch falls through to the network — one
  fetch total, same as before.
- **Why this is also a correctness fix:** default cache mode may
  revalidate and be served a _newer_ representation than the one on
  screen; force-cache pins the analysis to the bytes the render actually
  stored. The verdict must describe what the user sees.
- **Rejected:** worker-side fetch under the new host permissions —
  Chrome's HTTP cache is partitioned by top-frame site, so an extension
  service worker fetch can never hit the page's cache entry
  (guaranteeing a second network fetch, the opposite of the goal), and
  it drops page-context cookies/referer some CDNs require. Worker-side
  fetch remains the _fallback_ story for strict-CORS hosts (task 5.5),
  not the primary path.

### Test page

- A duplicate ai_declared.png figure exercises same-URL coalescing; the
  audit checklist adds the page-panel check (each fixture: one network
  request, one from-cache request) and `serve.mjs` logs one line per hit
  so the collapse is verifiable server-side too.

## 2026-08-03 — Task 5.2 follow-ups (same PR): CI workflow, audit-text tiers

### GitHub Actions CI: the checks become a merge gate

- **What:** `.github/workflows/ci.yml` runs `npm ci`, typecheck,
  `format:check`, the test suite, and the build on every pull request
  and on pushes to main. Single job, Node 24 (current LTS), read-only
  token.
- **Why:** the egress allowlist and taxonomy tests only guard anything
  when they run, and until now that relied on the CLAUDE.md
  run-tests-before-done convention — discipline, not machinery. A
  public repo whose privacy story is "audit the free tier yourself"
  (plan.md §7) should also show its checks passing in public. The suite
  is CI-clean by design: the WASM integration tests stub all network,
  so no secrets and no egress are needed.
- **Owner action noted:** a green check only gates merges once branch
  protection requires it — that is a GitHub settings toggle, not repo
  code; flip it after this PR's run appears.
- **Rejected:** a Node version matrix (single dev toolchain; esbuild
  output is what ships; a matrix adds minutes for no signal);
  release/packaging automation (nothing to release until the store
  listing, Phase 3).

### Service-worker audit text describes all three cache tiers

- **What:** the test page's worker-panel expectations now enumerate the
  three warmth tiers — cold worker + cold trust cache (five trust
  fetches + cloud.jpg's manifest fetch), cold worker within 24 h
  (manifest fetch only), warm worker (possibly zero requests).
- **Why:** the previous text promised the cloud.jpg manifest fetch on
  every warm run — true before 5.2, falsified by the worker verdict
  cache (a warm-worker reload serves cloud.jpg's verdict from the hash
  cache and never re-analyzes). An audit checklist that mispredicts the
  expected picture generates phantom regressions during the soak.

## 2026-08-03 — Task 5.2 code-review fixes (same PR)

An adversarial review of this branch surfaced 13 verified findings; the
confirmed ones are fixed here. Everything below is free-choice territory
(no permission changes, no new dependencies, no SignalProvider /
SignalResult changes, no user-facing wording).

### Remote-manifest outages are provider failures (supersedes task 4)

- **What:** `RemoteManifestFetch` errors no longer map to finding "none"
  with detail reason `remote-manifest-unavailable`; the provider throws,
  the aggregator records a `ProviderFailure`, and the reason leaves the
  `C2paDetail` union.
- **Why:** the task-4 framing ("the check ran; the referenced provenance
  was unreachable — an absence, not a failure") predates verdict caching.
  Under 5.2 both retention gates key on `failures` alone, so the absence
  framing let a transient network blip be cached as a durable,
  failure-free "unknown" for the worker's lifetime — contradicting this
  PR's own retention policy. As a failure the verdict renders the same
  Unknown badge but is never cached, so the next analysis retries the
  fetch once the condition clears.
- **Cost accepted:** a permanently missing remote manifest (durable 404)
  is refetched on every analysis instead of cached — pre-5.2 parity.
- **Popup note (5.3):** the outage stays disclosable; it now arrives as a
  failure message (`C2PA read failed: … RemoteManifestFetch …`) instead
  of a detail reason.

### URL-cache soundness for bytes that rotate under a stable URL

- **What:** two guards on `verdictsByUrl`. (1) The retain gate also
  requires the analyzed response to be _pinnable_: a `no-store` response
  (live images, webcams) can serve different bytes on every fetch, so its
  verdict is good for exactly the analysis that produced it. (2)
  `invalidateScan()` evicts the entry for the element's current URL, so
  an identity invalidation re-fetches instead of replaying a verdict
  about older bytes — usually straight from disk cache, with the worker's
  hash layer still absorbing the WASM run when bytes are unchanged.
- **Why:** the review demonstrated a same-URL rotating image keeping its
  t0 badge for the whole page view (an "AI — declared" badge over an
  unrelated later frame). This narrows the original 5.2 claim that
  spurious invalidations are "absorbed as cache hits": duplicate-element
  absorption — the dominant win — is unchanged, but invalidation-driven
  rescans now pay one cheap refetch for honesty.

### force-cache falls back past CORS-unusable cache entries

- **What:** when the force-cache analysis fetch rejects with a
  `TypeError`, it is retried once with `cache: "no-cache"`.
- **Why:** Chrome's HTTP cache sits below the CORS layer
  (crbug.com/409090): an entry stored by the no-cors `<img>` render on a
  server that only emits `Access-Control-Allow-Origin` for Origin-bearing
  requests (S3-style, no `Vary: Origin`) carries no CORS headers, and
  force-cache serves it to the cors-mode analysis fetch as a
  deterministic TypeError — where the pre-5.2 default-mode fetch would
  have revalidated and succeeded. The fallback revalidates past the
  unusable entry; its bytes may be newer than the render's (pre-5.2
  behavior, accepted on this error path — the pinned bytes are unreadable
  here by definition). Other TypeErrors (offline, DNS) fail the same way
  twice, quickly.

### No badge for images that are not rendering

- **What:** after settle, an image with `complete && naturalWidth === 0`
  (error event fired, or already broken) is skipped — forgotten, not
  terminal, so a scroll re-entry re-checks cheaply.
- **Why:** force-cache serves stale prior-session entries regardless of
  freshness, so with the origin unreachable the render fails (alt text)
  while the analysis succeeds against the old cached 200 — a provenance
  badge for bytes the user cannot see. A badge is a claim about displayed
  content. The residual risk of a missed badge on odd `naturalWidth`
  behavior (edge-case SVGs) is accepted: a silent miss is the honest
  direction, a false claim is not.

### Analysis failures: retry budget instead of terminal (supersedes 5.1/5.2)

- **What:** a rejected analysis no longer marks the element permanently
  done. Each scan cycle (generation) has `MAX_ANALYSIS_ATTEMPTS = 2`: the
  first failure forgets the element so a later viewport re-entry retries;
  the last is terminal for the cycle. Success and invalidation reset the
  budget.
- **Why:** the 5.1 rationale for terminal failures (deterministic
  strict-CORS failures would retry-loop) assumed unbounded retries; a
  budget of 2 bounds a deterministic failure to one extra attempt while
  letting transient failures heal on the next scroll pass. This matters
  more after 5.2: URL coalescing shares one rejection across every
  concurrently joined same-URL element, so a single transient 503
  terminally un-badged _all_ copies — and the old comment's claim that
  another same-URL element "retries fresh" was false for exactly those
  coalesced elements.

### blob: URLs join the URL cache

- **What:** only `data:` URLs bypass `verdictsByUrl`; `blob:` URLs now
  cache like http(s).
- **Why:** the data: exclusion exists because the URL _is_ the payload (a
  Map key would retain megabytes of string). A blob: URL is a short
  opaque handle to content that is immutable for the handle's lifetime;
  excluding it charged every duplicate element the full
  fetch + base64 + IPC + hash cost for no benefit.

### Mechanical cleanups from the review

- `MediaInput.bytes` is now `Uint8Array<ArrayBuffer>` (a free-choice
  shape): every producer decodes into a fresh plain buffer, and the
  tighter type lets `contentHashKey` hash the bytes directly instead of
  copying the full buffer per analysis just to satisfy `BufferSource`.
- The two textually identical retain predicates collapsed into
  `isCacheableVerdict` (`core/types.ts`) — structural on `failures`, so
  one policy site types against both `Verdict` and `WireVerdict`.
- `VerdictCache` (a single-caller class wrapper) is replaced by
  `createVerdictCache()` returning a configured `CoalescingLruCache`;
  the class added nothing beyond `contentHashKey` plus configuration.
  Its tests that duplicated the primitive's suite were dropped; the
  key-shape and retention-wiring tests remain.
- `IMAGE_ACCEPT` and `mimeTypeFor` moved to `src/lib/image-accept.ts`:
  task 5.5's worker-side fallback needs the identical Accept header for
  the identical `Vary: Accept` reason, and a file-local constant invited
  a drifting second copy. The pin's silent-drift failure mode (Chrome
  revising its default header un-matches cached entries with no signal)
  is now documented at the constant. The `.impeccable/config.json`
  `broken-image` ignore extends to the new file — same
  comments-mention-`<img>` false positive as content/index.ts.
- `CoalescingLruCache.delete()` added for the invalidation eviction.
- Test-page audit text: the worker-panel instructions now state the
  observer effect (an open worker inspector pins the worker alive, so
  the ~30 s teardown separating the tiers never happens while watching)
  and give the close-wait-reopen recipe for reproducing the cold tiers.

### Deferred review findings (recorded, intentionally not fixed here)

- **Degraded verdicts still badge:** a failure-carrying verdict renders
  Unknown and the element goes terminal, while both caches refuse to
  retain it — the review called this two-layer policy incoherence
  (largely pre-5.2). Whether a degraded check should badge at all, and
  how failures split into deterministic vs transient classes, is 5.3
  popup / Phase 3 wording territory; revisit alongside 5.5.
- **Accept-header drift** has no code-level fix (Chrome's default is not
  introspectable); mitigated by documentation at the constant and the
  soak-time network audit.

## 2026-08-03 — Task 5.3: the popup is a badge popover (verdict, explanation, disclosure)

### Owner decisions (§8 asks, resolved before building)

- **"Popup" means a badge-anchored popover, not a toolbar action popup.**
  Clicking a badge opens a panel on the image itself with the verdict, a
  plain-language explanation, and the "How do we know?" progressive
  disclosure (plan.md §4). The owner confirmed this reading of §4/§6;
  a toolbar (`action`) popup — a page-level list of verdicts — was
  considered and deferred: it needs an answer to "which image is this
  entry about?" (thumbnails would add extension-context refetches to the
  audited network story), and there is no page-level content yet
  ("nothing checked / can't run here" states, settings, paid tier).
  Revisit when such content exists. Consequence: **no manifest changes at
  all** — no `action` key, no new permissions, no protocol changes, and
  the worker is untouched.
- **Phase-2 placeholder presentation.** The popover extends the badge's
  deliberately plain neutral styling; the visual world remains Phase 3
  work (post-soak Impeccable pass), per plan.md's phasing.
- **Placeholder copy in the brand voice**, extending the task-4 wording
  decision: §2 labels verbatim as headlines; short, calm, honest
  explanations with no C2PA jargon at the surface (jargon is allowed
  inside the disclosure layer, where "Content Credentials" is named).
  All strings live in `content/labels.ts` and
  `providers/c2pa/present.ts`, marked placeholder; Phase 3 finalizes.
  The §2 rules bind the content: "Unknown" never reads as "not AI", and
  "AI — likely" is written as probabilistic.
- Impeccable stays at v4.0.2 (update to v4.0.4 offered, declined for now).

### Badges are now real buttons (pointer-events change)

- **What:** the badge is a `<button>` with `pointer-events: auto`,
  `cursor: pointer`, hover/focus states, and `min-height: 24px`
  (WCAG 2.2 AA 2.5.8 target size). Clicks on it are consumed
  (`stopPropagation`) — the host page never sees them.
- **Why:** the popover needs a trigger, and the badge is the thing users
  notice. Trade-off accepted: the badge's own pixels now capture clicks
  that previously fell through to the page (often an image link).
  Confined to the badge; everything else in the overlay stays
  `pointer-events: none`.

### Popover lifecycle (free choice)

- One popover at a time; opening another closes the first. The panel is
  inserted immediately after its badge in the shadow root, so keyboard
  focus flows badge → panel; `aria-haspopup`/`aria-expanded` on the
  badge, non-modal `role="dialog"` on the panel, disclosure via
  `<button aria-expanded aria-controls>`.
- Light dismiss: pointerdown outside or Escape (which refocuses the
  badge), both registered capture-phase while open so host pages that
  stop propagation at their own roots can't strand an open panel; both
  torn down through one AbortController.
- The panel closes when its image's badge goes away for any reason
  (removed, stale URL, collapsed rect) and is re-adopted next to its
  badge when a page-removed host is rebuilt; a re-render while open
  refreshes the content in place. syncBadges keeps its single
  read-then-write layout pass — popover width/badge height are read in
  the read phase.
- **Rejected:** hover-triggered popover (WCAG 1.4.13 hover machinery,
  no touch affordance); `role="tooltip"` (the panel holds interactive
  content).

### Signal presenters live in the providers layer (constraint 4)

- **What:** `src/providers/presenters.ts` maps a `SignalResult` to
  `{ summary, facts }` via a per-provider registry;
  `src/providers/c2pa/present.ts` is the C2PA presenter (humanized
  source types, signer, trust status). Unknown providers get a generic
  factual fallback (finding + confidence), pinned by test — so adding a
  provider requires zero popover changes, and richer presentation is a
  providers-layer edit.
- **Purity constraint:** presenters bundle into the content script, so
  they import types only — `C2PA_PROVIDER_ID` moved into `present.ts`
  (re-exported from the provider index) to keep WASM machinery out of
  the content bundle (verified: dist/content.js has no wasm references,
  29.7 kB).

### Degraded verdicts are disclosed (5.2 deferred finding, disclosure half)

- A verdict carrying provider failures now shows "part of this check
  didn't finish, so this result may be incomplete" in the popover, with
  each failure listed inside the disclosure. Whether a degraded check
  should badge at all (the policy half) still belongs with 5.5.
- The content script's full-verdict `console.info` is removed — the
  popover is the home task 4 promised for that detail; failures still
  log under `[TrueOrigin]`. Test-page copy updated accordingly, plus a
  popover checklist section.

### Task 5.3 finish-review fixes (same session)

A finish-review pass (general-purpose agent substituting for the
impeccable finish reviewer, which this harness doesn't ship) confirmed
taxonomy honesty, computed AA contrast on every color pair, target sizes,
and constraint 4 — and surfaced four findings, fixed immediately:

- **Disclosure could never visually collapse:** `.evidence`'s
  `display: grid` (author origin) overrode the UA's `[hidden]` rule, so
  the evidence rendered expanded regardless of the toggle. Fixed with an
  explicit `.evidence[hidden] { display: none }`; pinned by a stylesheet
  test, since jsdom asserts the attribute, not computed display.
- **Privacy note overclaimed for remote-manifest assets:** "the image
  never left your machine" implied no per-image network activity, but
  remote-manifest assets trigger the disclosed reference fetch. Reworded
  to claim only what always holds ("The image itself never left your
  machine — the check ran on this device"); per-image disclosure of the
  manifest fetch remains Phase 3.
- **Badge buttons were context-free for keyboard/screen-reader users**
  (the overlay host sits at the end of the tab order, so an image-heavy
  page yields a run of identical verdict buttons): the image's alt text,
  when present, now joins the badge and popover `aria-label`s.
- **"AI — declared" explanation overstated composites:** an ingredient's
  `compositeWithTrainedAlgorithmicMedia` declaration read as "created
  with AI" and misattributed the statement to "the maker". Now: "This
  image carries a signed statement that it was made with AI or contains
  AI-generated material."
- Minor: popover gets `z-index: 1` (a later-rendered badge could paint
  over it); the disclosure caret uses `content: "▸" / ""` so screen
  readers skip it.
- Recorded, not fixed (placeholder-acceptable): no vertical flip near the
  page bottom (max-height + page scroll bound it); `replaceChildren` on
  re-render-while-open resets disclosure state; raw provider ids/error
  strings inside the disclosure (a display-name field in the presenters
  registry is the constraint-4-clean Phase 3 fix); keyboard-only
  scrolling of an overflowing evidence list.

## 2026-08-03 — Task 5.3 code-review fixes (post-merge review, 15 findings)

A multi-agent code review of the 5.3 branch (10 finder angles, adversarial
verification) confirmed 13 findings and carried 2 plausible ones; all 15
are fixed here. Free-choice decisions made while fixing:

### Copy corrections (placeholder status unchanged; Phase 3 still finalizes)

- **"Unknown" explanation** now says "No _usable_ provenance information
  was found" — the §2 definition. The old "No provenance information was
  found" was false for three of the four C2PA reasons mapping to Unknown
  (invalid-manifest, untrusted-capture, no-origin-declaration: credentials
  were found, they just weren't usable) and self-contradicted the
  disclosure text under it.
- **C2PA `ai-source-type` summary** re-worded to mirror the approved
  verdict-level "ai-declared" copy ("made with AI or contains AI-generated
  material", no "from the tool that made it"): the reason also fires on
  composite declarations from ingredient manifests, and the signer/
  generator facts can name a later editor, so the old sentence repeated
  the exact composite overclaim this task fixed in labels.ts.

### Overlay containment and dismissal (badge.ts)

- **Event containment at the host boundary:** discrete interaction events
  (pointer up/down/cancel, mouse, click/aux/dbl, contextmenu, touch,
  key, wheel) are stopPropagation'd on the host div in the bubble phase,
  replacing the single click-only stopPropagation. Previously every other
  overlay event retargeted to the host and reached page document/window
  handlers — closing page dropdowns via their outside-click handlers.
  Move streams (pointermove/mousemove) deliberately still flow: pages
  track those continuously and a badge-sized dead zone is its own bug.
- **Escape is scoped to the overlay and fully consumed.** It closes the
  popover only when the keypress originates inside the overlay (badge or
  panel), with an `isComposing` guard, `preventDefault` (stops native
  `<dialog>` cancel / fullscreen exit), and `stopImmediatePropagation`.
  Behavior change: an Escape while focus is in page UI now belongs to the
  page and leaves the panel open (light dismiss still bounds it). The old
  handler hijacked every Escape on the page, stole focus into the badge,
  and still let native defaults run (double dismiss).
- **Light-dismiss blind spots:** main-scrollbar drags (pointerdown on the
  root element in the scrollbar gutter, RTL-aware) no longer close the
  popover — that was the one scroll method that killed it. Cross-document
  iframes swallow pointer/key events entirely, so a `window` blur with
  `document.activeElement` being an iframe now closes the panel — the one
  interaction signal that crosses the boundary. Inner-scroller scrollbar
  drags still light-dismiss (ordinary outside interaction; not worth the
  per-element offsetX heuristics).
- **Focus rescue on every close path:** closePopover returns focus to the
  badge whenever the departing panel contained it (previously only the
  Escape path did), so reaps/outside-clicks no longer drop keyboard focus
  to `<body>`. A same-verdict re-render (cached verdict, position churn)
  no longer rebuilds the panel — preserving disclosure state and focus;
  rebuild happens only on an actual verdict change.
- **Collapsed-rect close on the re-render path:** renderBadge now applies
  the same rule as syncBadges (shared `isCollapsed` predicate, third copy
  removed) instead of placing the panel against a zeroed rect at the
  document origin.

### Overlay isolation and a11y (badge.ts, labels.ts)

- **`all: initial` on `.badge` and `.popover`:** the shadow boundary stops
  selectors but not inheritance — page rules matching the host div leaked
  `direction`, `letter-spacing`, `text-transform`, etc. into the overlay
  (RTL sites re-ordered the English popover text). Both roots reset and
  re-declare everything they need; descendants inherit from the reset
  roots. `lang="en"` added on the host (WCAG 3.1.2 — overlay strings are
  English regardless of page language; localization is future work).
- **Alt text moved from accessible name to `aria-description`** on both
  badge and popover: page-authored alt can be paragraph-length, and the
  name is what voice-control users must speak. The badge's name is its
  visible label; the popover dialog's name is "<verdict> — details" via
  `POPOVER_STRINGS.dialogLabel`, moving the last user-facing template out
  of badge.ts (per the strings-live-in-labels decision).

### Structure and hardening

- **placePopover takes a placement object** including a caller-supplied
  `viewportWidth`: it read `documentElement.clientWidth` mid-write, which
  forced a synchronous reflow on every popover-open sync frame despite
  its write-only contract. syncBadges gathers all reads ahead of writes;
  the open/re-render paths use a shared measure-then-place helper.
- **Presenter registry is a `Map`,** so a future provider id colliding
  with an `Object.prototype` key falls back generically instead of
  invoking an inherited function.
- **REASONS set removed from the C2PA presenter:** `SUMMARIES` (a
  compiler-exhaustive `Record` over the reason union) is now the reason
  whitelist via `Object.hasOwn` — a new reason can no longer be silently
  rejected by a stale hand-maintained list.
- **Worker replies are validated** (`isAnalyzeResponse`/`isWireVerdict` in
  protocol.ts) instead of cast: the verdict is retained per badge and
  dereferenced at click time, so a malformed reply now takes the handled
  analysis-failure path rather than throwing in a click handler.

### Deferred (recorded, intentionally not fixed)

- **Badge captures clicks over page UI stacked above the image** (modals,
  cookie banners under our max z-index): every hit-test heuristic
  considered (elementsFromPoint at click or sync time) misfires on the
  far-more-common stretched-link card pattern, where a page overlay
  legitimately covers the image — hiding or muting the badge exactly
  where badges matter most. Native top-layer UI (`<dialog>.showModal`,
  popover API) already paints and hit-tests above the overlay, which
  bounds the damage to z-index-based overlays that happen to overlap the
  24px pill. Accepted for the soak; revisit with Phase 3 (a smaller
  badge, or a yield-on-cover heuristic informed by real sites).

### Live-pass corrections (same session, after the review fixes)

A driven browser pass on the test page (real clicks/keys, not synthetic
dispatch) verified the review fixes and caught two bugs jsdom could not:

- **`all: initial` does not reset `direction`.** The CSS `all` property
  excludes `direction` and `unicode-bidi` by spec, so the RTL leak — the
  most consequential part of the inheritance finding — survived the
  reset: with `dir="rtl"` on the page, popover text re-ordered while
  letter-spacing/text-transform/text-align were correctly cut off. Fixed
  with explicit `direction: ltr` on both shadow roots, pinned by a
  stylesheet test.
- **Overlay scrollbars defeat the gutter test.** On macOS (the default),
  scrollbars occupy zero layout width — `clientWidth === innerWidth` —
  so "pointerdown outside the root's client box" can never match, and a
  main-scrollbar drag still closed the popover. The guard now covers
  both realities: the classic gutter when one exists, otherwise a 17px
  edge band on axes where the document actually scrolls. A rare genuine
  root-targeted click inside that band merely leaves the popover open.
- Verified live with trusted input: event containment (page-level spies
  saw zero overlay events), Escape consumed from inside vs. delivered to
  the page from outside, iframe-focus dismiss, alt-as-description +
  `lang="en"`, the corrected "Unknown" copy coherent with its
  disclosure, all five fixtures badging (including the remote-manifest
  fetch path), zero console errors.

## 2026-08-03 — Task 5.4: Google Lens right-click — skipped as redundant

### Owner decision (§8 ask, resolved instead of built)

- **What:** task 5.4 ships nothing. The §8 permission ask was prepared
  (`contextMenus` — Chrome's no-warning tier; image-URL-only egress to
  `lens.google.com` on explicit click), but the owner's observation that
  Chrome already ships a built-in **"Search with Google Lens"** image
  context-menu item resolved the ask as _skip_: the manual escalation
  path plan.md §5 wants already exists natively, in the exact gesture
  the plan prescribes.
- **Why the duplicate loses to the built-in:**
  - The built-in item (Chrome ~M100+, default whenever Google is the
    default search engine; now opens the Lens side panel) sends the
    rendered image itself, so it works behind logins, cookie-gated CDNs,
    and expiring signed URLs. The extension route would be a constructed
    `lens.google.com/uploadbyurl?url=…` link that Google fetches
    server-side — strictly weaker on exactly those images.
  - Our entry would sit directly below Chrome's own and work less often:
    menu clutter that erodes rather than builds trust.
  - Even a warning-free permission must be justified in the store
    listing's privacy story; a documented egress path for near-zero
    incremental value is a bad trade against the minimum-permissions
    posture (plan.md §4).
- **Rejected:**
  - _Build as planned_ — the only cohort served is users whose default
    search engine is not Google (their menu says "Search image with
    [engine]" instead). They chose that engine; force-inserting a
    Google entry for them is dubious value for the cost above.
  - _Popover Lens link now_ — permissionless and contextual, but
    deferred rather than built: surfacing an escalation affordance on
    (e.g.) Unknown verdicts is wording/placement territory, i.e.
    Phase 3 brand work. **Recorded as the Phase 3 home for escalation:**
    a contextual "look this image up" link in the badge popover is the
    one form the built-in cannot provide.
- **Consequences:**
  - No manifest change; the zero-API-permissions posture holds and the
    manifest test's "requests no API permissions" pin stands unchanged.
  - No new egress paths; the constraint-3 network story is untouched.
  - Plan.md §5 (free-tier table) and §8 (task order) still name the
    feature — noted as plan drift for the owner to amend; the free-tier
    "Open in Google Lens" line is fulfilled by the platform itself.
  - Revisit only if Chrome removes or degrades the built-in item.
  - Next per §8 order: task 5.5 (byte-acquisition CORS fallbacks),
    informed by the daily-driver soak.

## 2026-08-03 — Task 5.5: byte-acquisition CORS fallbacks

The last Phase 2 item. Everything here is free-choice territory: no
manifest changes (the host permissions granted in 5.1 are what make the
fallback possible), no new dependencies, no SignalProvider/SignalResult
changes, no user-facing wording. The daily-driver soak (§6 cadence note)
continues after this lands and may retune the constants.

### The acquisition ladder: force-cache → no-cache → worker-side fetch

- **What:** in-page acquisition (unchanged from 5.2) now falls back to a
  worker-side fetch when the page context cannot read the bytes: a new
  `trueorigin:analyze-url` message asks the worker to fetch the URL under
  its host permissions (CORS-exempt) and run the same pipeline. Fallback
  triggers: `TypeError` from both in-page cache modes (the strict-CORS
  signature — the dominant deterministic failure class since 5.1) and
  HTTP error statuses (hosts that 403 Origin-carrying requests they
  serve happily without one; the worker's request is exempt from that
  refusal class too). Deliberately **not** a trigger: timeouts — a 30 s
  stall is origin slowness, the worker would pay the same 30 s for the
  same likely outcome, and the 5.2 retry budget already re-attempts
  transient stalls on viewport re-entry. data:/blob: URLs never fall
  back (data: decodes in-page without CORS; blob: handles are scoped to
  the page's context and unreachable from the worker).
- **Why worker fetch stays the fallback, not the primary:** unchanged
  from the 5.2 rejection — the extension's cache partition can never hit
  the page's HTTP-cache entry (guaranteeing a network fetch) and the
  request lacks the page's Referer, so its bytes are less certainly the
  render's bytes. The divergence risk is accepted only on paths where
  the in-page bytes are unreachable anyway; the module headers record
  it, and the text/* guard below catches the catastrophic form.
- **Rejected:** canvas readback as a further fallback (drawing the image
  and re-encoding strips the C2PA container — the fallback would destroy
  the very evidence it exists to read; useless for provenance by
  construction); an offscreen-document fetch (same partition problem as
  the worker plus an `offscreen` permission ask).

### Worker fetch policy (`src/background/fetch-image.ts`)

- **`credentials: "include"`, mirroring the render request.** The render
  sent the user's cookies; an anonymous refetch is likelier to be
  answered with a different representation — or a login/challenge page —
  than the bytes on screen, and cookie-gated CDN images (the class the
  5.4 evaluation highlighted) would fail outright. Chrome exempts
  extension-initiated requests to hosts the extension has permissions
  for from SameSite blocking, so the cookies attach in practice.
  Constraint 3 intact: the request goes only to the image's own host —
  the host that already served these bytes to this user — carrying
  nothing but the image URL it already knows. **Rejected:**
  `credentials: "omit"` (a more "anonymous" posture, but it maximizes
  representation divergence, which is the actual privacy-adjacent harm
  here — a verdict about bytes the user never saw).
- **Same Accept pin** (`IMAGE_ACCEPT`, the shared constant 5.2 moved to
  `src/lib/` for exactly this) for the same `Vary: Accept` reason.
- _*text/* responses are rejected_*, not analyzed: the render displayed
  an image, so a text reply means this context was served something else
  (login redirect, bot challenge). Feeding it to the pipeline would
  yield finding "none" → an "Unknown" badge describing bytes that are
  not the image. Other non-image types pass through (parity with the
  in-page path, which also forwards whatever Content-Type it got).
- **Non-http(s) URLs are refused before fetching** — defense in depth
  should a compromised renderer ever forge the message.
- **Pinnability is computed by the worker and returned in the reply**
  (`pinned` on `AnalyzeUrlResponse`): only the worker saw the response
  headers, and the content script's URL cache must apply the same
  no-store retention rule to fallback verdicts as to its own. The
  previously duplicated predicate is now shared
  (`isPinnableResponse`, `src/lib/image-accept.ts`), as is the fetch
  timeout.

### Oversized transport routes through the worker fetch

- **What:** in-page acquisitions larger than 32 MiB
  (`MAX_INLINE_TRANSPORT_BYTES`) skip the message channel and use the
  worker-fetch path even though the bytes were readable in-page.
- **Why:** `sendMessage` JSON-serializes, so bytes travel as base64 (4/3
  inflation) against Chrome's 64 MB message cap — a ~48 MiB image dies
  in transport with an opaque error. 32 MiB of bytes is ~44.7 MB of
  base64: comfortably under the cap while covering essentially every
  real image. Cost accepted: the worker re-fetches from its own
  partition on this rare path. Oversized data:/blob: payloads (which
  the worker cannot fetch) still attempt inline transport and surface
  as an analysis failure if the channel refuses them.
- **Rejected:** chunked multi-message transport (protocol machinery for
  a case the fallback already handles); skipping large images silently
  (a silent coverage hole, and large images skew toward exactly the
  high-resolution photography provenance matters for).

### Verdicts in which no check completed do not badge (5.2/5.3 deferral)

- **What:** the policy half of the "degraded verdicts still badge"
  finding, resolved: a verdict carrying provider failures and **zero**
  collected signals is rejected in `acquire.ts` (`assertCompleted`) and
  takes the same path as any failed analysis — no badge, never cached
  (both layers already refused retention), bounded by the 5.2 retry
  budget, healable on viewport re-entry. A verdict mixing completed
  signals with failures still renders, with the 5.3 popover disclosure
  as its honesty mechanism — that split is now pinned by test.
- **Why:** with a single provider, "failures only" means the one check
  errored — epistemically identical to the analysis failing, which
  task 4 already decided renders nothing ("a failed check supports no
  claim, not even Unknown, which the mapper reserves for checks that
  ran"). Badging Unknown from a WASM init failure while both caches
  refuse to retain it was the two-layer incoherence the 5.2 review
  called out; this aligns the badge with the caches instead of the
  caches with the badge.
- **Placement:** in the content script's acquisition layer, not the
  worker — the worker reports pipeline results faithfully; badge policy
  belongs to the surface that badges. Throwing (rather than filtering at
  render) shares the rejection with every coalesced same-URL caller and
  keeps it out of the URL cache by the existing no-cached-rejections
  rule.

### Acquisition extracted to `src/content/acquire.ts`

- The ladder, transport, and policy logic moved out of the content
  script's DOM wiring into a URL-in/verdict-out module with no element
  coupling — same falsifiability rationale as the jsdom batch: the 5.2
  force-cache → no-cache recovery was previously untestable (and
  untested); now the whole ladder is pinned (`acquire.test.ts`, 13
  tests), including which rung runs for which failure class and what
  crosses the message channel. `fetch-image.test.ts` is the
  background-level counterpart of the provider egress suite: it pins
  that the handler fetches exactly the requested URL, once, with the
  pinned Accept header and credentials.

### Test page: live strict-CORS fixture

- `index.html` adds ai_declared.png referenced via
  `http://127.0.0.1:8917` — a different origin than the `localhost` page,
  from a server that (deliberately, now documented) sends no
  `Access-Control-Allow-Origin`. In-page acquisition fails at the CORS
  layer for real, and the badge can only come from the worker fallback.
  The audit checklist now expects the fallback fetch in the worker panel
  in every warmth tier (the page-view URL cache dies with the page, so
  the worker must re-acquire the bytes before its hash cache can
  recognize them), and `serve.mjs` logs the requested host per hit so
  render, blocked in-page attempt, and worker fetch are tellable apart
  server-side.

### Soak notes (what daily-driver use should watch, task 5.5 edition)

- Frequency of the fallback firing (each firing is a doubled fetch for
  that image — if it dominates on some major CDN, revisit).
- text/* rejections in the console: each is a host where even the
  credentialed worker fetch got a challenge page — a coverage hole to
  characterize before Phase 3's privacy write-up.
- Whether the fallback's requests in the worker network panel ever look
  different from the render's own (same URL, same redirect chain — the
  fetch follows redirects exactly as the render did; anything beyond
  that would contradict the constraint-3 story and needs investigating).

## 2026-08-04 — Task 5.5 soak findings, first batch (same PR)

Three owner-reported findings from daily-driver use. Two fixed here; one
recorded and deliberately kept on the Phase 3 docket.

### Popover dismissal no longer hijacks scroll position (fixed)

- **Report:** open a popover, scroll the page, click anywhere — the
  popover closes and the page jumps back to where the badge was.
- **Cause:** the 5.3 focus rescue. `closePopover` hands focus back to
  the badge whenever the departing panel contained it (so keyboard focus
  never silently drops to `<body>`), and a bare `focus()` scrolls the
  focused element into view — turning every pointer dismissal after a
  scroll into a viewport yank.
- **Fix:** the rescue distinguishes intent. Escape — deliberate keyboard
  navigation — keeps plain `focus()`, scrolling the badge into view so
  the focus indicator stays visible (WCAG 2.4.11 direction). Every other
  close path (outside click, reaps, re-render collapses) rescues with
  `focus({ preventScroll: true })`: focus continuity without moving the
  page. Pinned by test in both directions.
- **Rejected:** skipping the rescue entirely on pointer dismissals (the
  browser's own mousedown focus handling usually overrides it anyway,
  but when the click target chain is non-focusable, the rescue is still
  what keeps Tab order anchored near the content the user was reading).

### Min-size gate raised to 96 px (fixed; still provisional)

- **Report:** badges appear on icons — images that should not be
  analyzed at all.
- **Change:** `MIN_IMAGE_DIMENSION_PX` 64 → 96 (short side, layout
  metric; the ResizeObserver revival shares the constant, so gate and
  revival stay aligned). At 64, large icons, avatars, and app tiles in
  the 64–95 px band were analyzed and badged, and the ~24 px badge pill
  visually dominates images that size. 96 keeps typical content
  thumbnails (≥ ~100 px) while dropping the icon band. Skipping happens
  before analysis, so this also cuts wasted fetches and WASM runs.
- **Note:** like the other scheduling constants this is soak-tunable;
  if real thumbnails start getting skipped, 96 is one line to revisit.

### Badges paint over Google's search-suggestions dropdown (recorded, not fixed)

- **Report:** on Google, the search box's suggestion dropdown opens and
  badges from result images beneath it paint on top of the list.
- **Assessment:** this is the first concrete real-site instance of the
  5.3 deferred finding (overlay at max z-index vs. page UI stacked above
  images). Google's dropdown is a plain z-indexed div, not top-layer UI
  (`<dialog>`/popover API would paint above us), so our host wins the
  stacking contest. The 5.3 analysis still holds: every yield-on-cover
  heuristic evaluated (elementsFromPoint at sync or click time) misfires
  on the stretched-link card pattern — hiding badges exactly where they
  matter most — and any fixed lower z-index just loses somewhere else.
  Phase 3 owns the real fix (smaller badge, or a cover heuristic built
  against a corpus of real sites, of which google.com is now the first
  entry). The 96 px gate above incidentally removes the worst cases
  where the covered "image" was itself an icon-sized thumbnail.
- **Third candidate (owner question, 2026-08-04):** matching the image's
  z-index is impossible in principle — z-index only orders siblings
  within one stacking context, and occlusion is decided by the ancestor
  chains, not by any number on the image — but the underlying goal
  ("badge covered exactly when its image is covered") has a
  construction-correct form: inject each badge into the page DOM as a
  positioned sibling of its image, sharing its stacking context,
  clipping, and scrolling by definition. Rejected at task 4 for
  DOM-safety (host layout, framework reconciliation, page CSS selectors,
  self-filtering observers); goes on the Phase 3 docket as the
  alternative to heuristics, to be weighed against that risk.

## 2026-08-04 — Expired-cert AI declarations map to "AI — likely" (owner decision)

A soak finding with product-wide reach, resolved by the owner after the
options were presented (this touches §2 verdict semantics, so it was an
ask, not a free choice).

### The finding

The owner's GPT-4o-era ChatGPT image (real OpenAI provenance: two-manifest
chain signed "OpenAI" via "Truepic Lens CLI in Sora", `c2pa.created` by
GPT-4o with `trainedAlgorithmicMedia`) badged **Unknown**. Diagnosis
against the real WASM with production trust lists: every content check
passes — data hashes match, chain anchors to the trust list, claim
signature valid — but `signingCredential.expired` fails, and that era of
OpenAI's pipeline attached **no trusted timestamp**, so there is no
independent proof the signature predates the cert's expiry. c2pa-rs rules
the store `Invalid`; the task-3 mapping ("not Valid/Trusted → none") made
it Unknown. Impact class: every un-timestamped AI provenance ages into
this state as its short-lived signing certs expire — plausibly the
largest population of real AI images on the web.

### The decision (owner-selected from three options)

Map the narrow class to **`ai-indicated`, confidence 0.9**
(`EXPIRED_AI_DECLARATION_CONFIDENCE`) → verdict **"AI — likely"**:

- **Qualifying conditions (all required):** validation state `Invalid`;
  an AI source type present in the chain; `signingCredential.expired`
  among the failure codes; and every failure code in the tolerated set
  {`signingCredential.expired`, `signingCredential.untrusted`}.
- **Why untrusted rides along:** the task-3 accept-AI-at-Valid policy
  already takes AI declarations from untrusted signers at full
  `ai-declared` strength — an untrusted signer cannot coherently block
  the strictly weaker probabilistic finding. (Verified: under production
  anchors the OpenAI fixture fails with `expired` alone; under the
  vendored test anchors `untrusted` joins it.)
- **Why not revocation or content failures:** a revoked cert is the
  leaked-cert scenario itself, and any hash/assertion failure means the
  manifest may not describe these bytes — both stay `invalid-manifest`.
- **Why 0.9:** hash-verified bytes, provably what the declarer signed —
  high; timing unprovable (backdating with a leaked expired cert is
  unfalsifiable) — short of the 1.0 that §2 reserves for cryptographic
  certainty. Clears `AI_LIKELY_MIN_CONFIDENCE` (0.7), so the verdict is
  the probabilistic one §2 already defines, labeled as probabilistic.
- **Asymmetry preserved (§2):** expired _capture_ claims get no
  forgiveness — still `invalid-manifest` → Unknown. Forging "human" is
  the attack that matters. Pinned by test.
- **Rejected:** keeping Unknown (the strictest reading writes off the
  biggest real-world AI class while its declarations are hash-verified);
  accepting as `ai-declared` (overclaims — §2 pins that verdict to
  cryptographic confidence that expired-without-timestamp cannot
  deliver).

### Mechanics

- `mapManifestStore` now owns the confidence scale (`MappedStore` gained
  `confidence`; the provider passes it through instead of pinning 1/0 by
  finding). New detail reason `expired-ai-declaration`; the presenter
  registry's compiler-exhaustive `SUMMARIES` forced the popover copy at
  compile time (placeholder wording, Phase 3 refines).
- **Fixture:** the owner's image is vendored as
  `fixtures/ai_expired.png` (README updated) — integration tests pin the
  provider mapping and the end-to-end "AI — likely" verdict against the
  real WASM, the egress suite pins that expiry handling makes no network
  requests (no OCSP/CRL/TSA lookups), and the test page gains the
  figure. This fixture is stable by nature: the cert stays expired.
- **Phase 3 wording note:** the verdict-level "AI — likely" explanation
  ("Detection signals suggest…") was written for classifier signals;
  for this path the specifics live in the disclosure summary. Fine as
  placeholder; the Phase 3 pass should make the verdict line cover both
  sources honestly.
- **Watch item (pinned down 2026-08-04, owner follow-up):**
  `ai_declared.png` (newer OpenAI pipeline) IS on the C2PA conformance
  trust list — production config validates it **Trusted** — and it does
  carry a timestamp, but that timestamp is signed by OpenAI's own TSA
  ("OpenAI TSA Leaf"): `timeStamp.validated` (digest matches) yet
  `timeStamp.untrusted` (the TSA is not on the C2PA TSA trust list). An
  untrusted timestamp cannot establish signing time, so the expiry
  forgiveness that keeps e.g. DigiCert-timestamped manifests verifiable
  after cert expiry will not apply. When this cert expires: if the
  conformance TSA list has added OpenAI's TSA by then (it is fetched
  live, so the fixture heals automatically), nothing changes; otherwise
  the fixture flips to Invalid + expired, the mapping above keeps the
  product verdict sane ("AI — likely"), and the CI assertions pinning
  Trusted/ai-declared will need updating.

## 2026-08-04 — Future task (owner-approved): unsigned generator-metadata provider

Queued during the task-5.5 soak, after the expired-cert discussion
established that the C2PA mapping now covers everything C2PA can honestly
say. This is the next growth path for "AI — likely", approved by the
owner as a docket item — not yet scheduled.

- **What:** a second local signal provider that reads the _unsigned_
  generator metadata many real AI images carry: Stable Diffusion /
  A1111 "parameters" and ComfyUI "prompt"/"workflow" PNG text chunks,
  IPTC credits like "Made with Google AI" (Gemini), and unsigned XMP
  `Iptc4xmpExt:DigitalSourceType` values in the AI set. Emits
  `ai-indicated` at moderate confidence (provisionally ~0.7–0.8; below
  the C2PA expired-declaration's 0.9 — no signature at all here), so the
  verdict reads "AI — likely", explicitly probabilistic.
- **Why:** the largest population of AI images in the wild (local SD
  output, tools that never adopted C2PA) carries exactly this metadata
  and no Content Credentials — today it all reads Unknown. The signal is
  trivially strippable and forgeable, which is precisely what the
  probabilistic tier is for; nobody accidentally embeds an SD prompt in
  a family photo, so accidental false positives are rare.
- **Architecture:** a new provider in `src/providers/` — constraint 4
  makes this the zero-cost path (the Phase-1 exit-criterion test already
  proves the pipeline takes a new provider with no outside changes),
  plus a presenter entry for the popover. Runs in the worker on the
  bytes already acquired; no new permissions, no network.
- **§8 flags for the implementation session:** parsing PNG text chunks
  and basic EXIF/XMP by hand is feasible; if a parsing library is
  preferred instead, that is a new-runtime-dependency ask. Popover
  wording for the new signal is placeholder-then-Phase-3 like the rest.
- **Open design questions:** exact marker list and how conservative to
  be (a bare "Software: xyz" EXIF name is weaker evidence than a full SD
  parameters block — the task-3 rejection of name matching stays binding
  for signed C2PA fields, but this provider's whole domain is heuristic,
  so it needs its own recorded line); confidence value; whether a
  detected-but-below-threshold marker should still surface in the
  popover's evidence list (the pipeline already supports it —
  below-threshold signals stay visible in `Verdict.signals`).

## 2026-08-04 — State at task 5.5 close / handoff notes

Task 5.5 and its soak follow-ups are complete on PR #6
(`task-5.5-cors-fallbacks`, CI green, description current — including the
one owner-decided verdict-semantics change). 185 tests green; live pass
in Chrome verified the CORS fallback end to end. With 5.1–5.5 done, the
§8 task order is exhausted: **Phase 2 is code-complete**, pending the §6
cadence gate (multi-day daily-driver soak) before it is declared done.

Open items, consolidated for whoever picks this up:

- **Merge PR #6** when review satisfies; branch protection note from the
  5.2 entry still applies (owner flips the setting).
- **Soak continues.** Constants raised/tuned this session
  (96 px min-size gate, dwell/concurrency/lookahead, 32 MiB transport
  ceiling, verdict-cache caps) are all provisional against soak feel.
  Watch specifically: fallback-fetch frequency per CDN, text/* rejection
  sightings, popover feel after the scroll-hijack fix.
- **"Human — verified" fixture still missing** (plan.md task-order
  note): needs a capture-signed photo from a trust-listed device
  (recent Pixel with Content Credentials, Leica M11-P, Sony/Nikon/Canon
  C2PA firmware, or a published Content Credentials sample). The
  verdict is unreachable end-to-end until then — by design.
- **Deliberate CI tripwire:** `ai_declared.png`'s OpenAI signing cert
  will eventually expire; its timestamp is from OpenAI's own TSA (not
  on the C2PA TSA list), so Trusted/ai-declared assertions will fail
  that day unless the conformance TSA list adds it first. Owner chose
  to leave it. The product behavior at that point is the new
  expired-declaration mapping ("AI — likely"); only test expectations
  need updating. Option recorded if it becomes annoying: freeze the
  clock the WASM sees (it reads JS `Date.now()`).
- **Phase 3 docket** (from this session): badge occlusion by page
  overlays (three candidates recorded — smaller badge, cover
  heuristic, in-DOM sibling injection); "AI — likely" verdict-line
  wording now covers two sources (classifier-style signals and the
  expired-declaration path) and should be reworded accordingly;
  contextual "look this image up" popover link (from 5.4).
- **Future task (owner-approved):** unsigned generator-metadata
  provider (previous entry). Note plan.md §6 frames the first
  non-C2PA provider as Phase 4 paid-tier territory — this one is local
  and free, so the owner may want to amend the plan's framing when
  scheduling it (plan.md is owner-authored; not edited from here).
- **Known-open from 5.1 (unchanged):** shadow-DOM image discovery
  (Lit sites like Reddit), `all_frames` iframes, CSS-animation badge
  re-anchoring gap.
- **Next per plan.md:** the second `/impeccable init` pass (the
  post-soak re-interview, the authoritative one) opens Phase 3.
- Housekeeping: `ai_image.png` in the repo root is the owner's scratch
  copy of the vendored `fixtures/ai_expired.png` — untracked,
  deletable.

## 2026-08-04 — Code-review fixes on task 5.5 (PR #6)

An adversarial review of the branch confirmed one taxonomy violation and
a cluster of acquisition-path defects. Fixes 1–8 below are applied;
review items 9 (credential asymmetry of the in-page rungs) and 11 (the
strict-CORS triple-fetch cost) are deliberately **not** decided here —
they need an owner call and are listed at the end.

- **Expired-AI exception now gates on failures recorded anywhere in the
  store, including ingredient entries.** `failureCodesOf` previously read
  only store-level `validation_results` (active manifest + ingredient
  _deltas_) and legacy `validation_status`; a content failure recorded at
  ingredient time (e.g. `assertion.dataHash.mismatch` on the AI
  ingredient itself) lives on `manifests[*].ingredients[*]` and was
  invisible — so an AI declaration whose hashes never verified could be
  promoted to "AI — likely" (§2 violation, review-confirmed by
  execution). Now ingredient `validation_results`/`validation_status`
  failures count, which also makes the invalid-manifest popover detail
  more complete. Alternative rejected: restricting the exception to the
  active manifest — the owner decision it implements is explicitly about
  declarations anywhere in the store.
- **The worker fallback fetch refuses redirects** (`redirect: "manual"`;
  an `opaqueredirect` or raw 3xx fails the acquisition). The fetch is
  CORS-exempt and credentialed under broad host permissions, so
  following redirects let the image host steer a cookie-bearing request
  at intranet/localhost targets — and falsified the module's
  constraint-3 claim that the only request goes to the image's own host.
  Cost: images behind redirecting URLs lose the fallback verdict
  (fail-closed). Alternatives rejected: post-hoc `response.url` origin
  check (the request has already been made — that is the harm);
  validate-and-follow via Location (unreadable through the
  opaqueredirect filter).
- **The badge overlay's shadow root is closed.** With the credentialed
  fallback, an open root converted images the page can render but not
  read into page-readable provenance (verdict text, signer, title via
  `host.shadowRoot`). Closed mode required one behavioral companion: the
  popover's light-dismiss check now tests for the _host_ in
  `composedPath()` (the path no longer exposes shadow-internal nodes to
  document-level listeners; the host is an exact stand-in because it is
  0×0 and pointer-events: none). Tests capture the root by wrapping
  `attachShadow`; a new test pins `host.shadowRoot === null`.
- **One shared not-the-rendered-image guard on both acquisition paths**
  (`imageMimeTypeFor` in image-accept.ts), replacing the worker-only
  `text/*` check and the URL-extension MIME fallback. Declared image/*
  types are trusted; any other declared type fails the analysis (the
  in-page path previously analyzed an HTML login page into an "Unknown"
  badge — review-confirmed); no declaration (or octet-stream) resolves
  by magic-byte sniffing (JPEG/PNG/GIF/WebP/TIFF/AVIF; SVG by
  document-start inspection), never by URL extension — which typed an
  extensionless HTML challenge named photo.jpg as image/jpeg
  (review-confirmed bypass). Side effects: octet-stream-served real
  images now analyze (sniffed), and the `new URL("")` crash on
  service-worker-synthesized responses dissolves (the URL is no longer
  consulted). An in-page guard failure escalates to the worker once: the
  in-page analysis fetch is cookieless cross-origin, so a session-gated
  host may have served it a challenge it would not serve the worker's
  cookie-bearing request.
- **64 MiB ceiling on the worker fetch body, enforced while streaming.**
  The worker path is the deliberate destination for >32 MiB images, so
  the ceiling sits above the transport cap with margin, but unbounded
  bodies could OOM the MV3 worker (killing every pending analysis).
  Content-Length is checked first for the honest case; the streamed
  count is the enforcement (header can be absent, wrong, or compressed
  — the reader yields decoded bytes), and never more than the ceiling
  is held. 128 MiB rejected (two copies + hash approach worker memory
  limits); "no cap, rely on timeout" rejected (bounds time, not size).
- **A `sendMessage` rejection on the inline path now falls back to the
  worker fetch** (`TransportError`): the channel refusing the payload is
  not an analysis failure, and the worker fetch does not ship bytes over
  the channel at all. data:/blob: payloads still surface the error (the
  worker cannot fetch those; pre-existing policy).
- **Only 401/403 escalate an in-page HTTP error to the worker.** The
  escalation exists for Origin-conditioned refusals; 404/5xx cannot be
  cured by the worker's request, and re-hitting a 429 with a second,
  credentialed fetch would amplify the limit it just signalled.
- The acquire.ts header no longer claims the in-page path shares the
  render's full request context — on a cross-origin cache miss the
  analysis fetch carries no cookies where the render did.

**Open (owner call needed, from the same review):** (a) whether in-page
analysis fetches should send `credentials: "include"` to actually mirror
the render, or the divergence stays accepted-and-documented; (b) the
strict-CORS path still costs ~3 origin requests / 2 downloads per image
(the no-cache rung is a guaranteed-blocked round trip there, but is not
simply removable — its TypeError is indistinguishable from the
recoverable task-5.2 case); (c) test-page port hard-coding, checklist
fetch-count corrections, and an onMessage wiring test (review items
12–14) remain unapplied.

## 2026-08-04 — Owner decisions on the review's open items

- **Strict-CORS fetch waste (review item b): designs #1+#2 accepted** —
  per-page-view negative memory (URL-level certain, origin-level hint;
  in-page path skipped once proven CORS-blocked) plus a short-TTL
  negative cache for acquisition failures (cleared with the scheduler's
  reset so transient failures cannot go sticky). **#3 (webRequest header
  observation) rejected on permission posture:** it would not violate
  constraint 3 (all local), but it grants observational power over all
  page traffic to read one header — the opposite of the minimum-viable
  posture the trust story sells. Queued as a follow-up task, not part
  of the review-fix diff.
- **Credential asymmetry (review item a): resolved** — rung 2 (the
  no-cache revalidation) now sends `credentials: "include"`; rung 1
  (force-cache) stays uncredentialed, and the residual divergence is
  accepted. Why this split: a credentialed CORS read requires an
  exact-origin ACAO plus Allow-Credentials, so include on rung 1 would
  break the common `ACAO: *` cache reads that are the double-fetch
  collapse — and the cache-hit path needs no cookies anyway (the entry
  was stored by the render's own cookie-bearing request). Rung 2 always
  hits the network, where the render did send cookies, and it only runs
  after rung 1 failed, so nothing that works today is affected; if a
  server refuses the credentialed read, the worker fallback's
  cookie-bearing fetch cures it. **Accepted residual:** a rung-1 cache
  _miss_ (no-store render, evicted entry) goes to the network
  cookieless, so a session-gated host serving `ACAO: *` can hand the
  analysis a different representation undetected. Closing it needs
  credentialed-first-with-retry, which taxes every uncached `ACAO: *`
  image (the common case) with a doubled round trip — rejected. Full
  alternatives analysis in the session log.

## 2026-08-04 — Review follow-ups implemented (same session)

The accepted designs above plus review items 12–14, applied:

- **Acquisition memory (acquire.ts, per page view).** CORS-blocked
  memory records a URL only when both in-page rungs TypeErrored _and_
  the worker fetch then succeeded — worker success is what rules out
  offline/DNS, so nothing transient can be "proven". Origin hint
  threshold: **2 distinct proven URLs** (1 felt too eager for
  mixed-CORS origins; the only cost of over-generalizing is losing the
  double-fetch collapse for that origin, never a wrong verdict).
  Failure memory: 30 s TTL, 500-entry cap, records non-escalated HTTP
  errors and worker-leg (`ok:false`) refusals; deliberately excludes
  timeouts (retry budget heals those) and analysis-side failures
  (worker restarts heal those — an incomplete verdict arrives `ok:true`
  and is rejected fresh each time). index.ts clears a URL's failure
  entry on identity invalidation; CORS memory survives invalidation
  (CORS is server config, not content). data:/blob: URLs bypass both
  memories (URL-as-payload retention, same reason as the verdict
  cache). Test seam: `resetAcquisitionMemory()`.
- **Test page (items 12–13).** The strict-CORS figure's src is now set
  by inline script — same port as the page (serve.mjs honors PORT; the
  hard-coded 8917 silently disabled the tier on any other port),
  opposite host (localhost ↔ 127.0.0.1) so the tier survives opening
  the page by either name. Audit checklist corrected to the counts the
  tests pin: two CORS-blocked in-page attempts per first analysis, and
  a retry after a failed attempt is legitimate (attempt budget is 2),
  not a bug.
- **onMessage wiring test (item 14).** src/background/index.test.ts
  pins: both arms return `true` synchronously (the channel-hold
  contract), both eventually sendResponse a guard-passing reply (the
  inline arm against the real pipeline with the provider failure
  isolated), and unknown messages get neither. Closes the review's
  "wiring regression ships green" gap.

## 2026-08-04 — Review finding 10 (stacked timeouts), caught by owner audit

Initially dropped from the fix rounds (it sat in a "fix or consciously
accept" bucket that never got decided); the owner's completeness check
caught it. Fix: the in-page ladder's two rungs now share **one**
`AbortSignal.timeout(30_000)` instead of minting one each, restoring the
pre-5.5 worst case — ≤30 s in page context plus the worker fetch's own
≤30 s when the fallback runs (~60 s total, down from ~90 s) — so a
stall-then-reset host can no longer hold one of the two analysis slots
for three full budgets. The worker's own deadline stays separate by
design (it is a different context; threading a remaining-time budget
through the message channel was rejected as complexity without a real
win). The timeout-never-falls-back policy is unchanged: a shared-deadline
expiry surfaces as TimeoutError and still fails the attempt rather than
escalating. Pinned by asserting both rungs receive the same signal
instance.

## 2026-08-04 — Live verification of the review-fix wave (owner pass)

Chrome pass over `ad1cf6b`, all green:

- Page network panel matches the corrected audit checklist exactly:
  script-set strict-CORS render, two CORS-blocked in-page attempts,
  disk-cache analysis fetches for same-origin figures (double-fetch
  collapse intact), no request added by the duplicate figure.
- Worker panel: exactly one cross-host fallback fetch; otherwise only
  the WASM load and the cached cloud.jpg manifest fetch (cold-worker /
  warm-trust-cache tier, as the checklist describes). Constraint-3
  audit artifact: no media bytes or page URLs anywhere else.
- Cross-host figure badges "AI — declared" via the fallback.
- PORT override rerun works end to end (the tier the hard-coded port
  used to silently disable).
- Closed-shadow popover: click inside does not dismiss; outside click
  and Escape behave as pinned.

## 2026-08-04 — Phase 2 declared complete (owner decision)

The owner has closed the §6 cadence gate: the daily-driver soak is done
(its findings — scroll hijack, min-size gate, badge occlusion, the
expired-declaration mapping, and the review wave — are all recorded and
resolved above). With that, the §6 Phase 2 checklist is fully
accounted for: viewport lazy scanning and verdict caching (5.1/5.2),
popup/popover with progressive disclosure (5.3), Google Lens
right-click resolved as skipped (5.4, owner decision), byte-acquisition
CORS fallbacks hardened and review-verified (5.5 + fixes), and all four
badge states implemented. **Phase 2 is complete.**

Honest caveats carried forward, not gates:

- **"Human — verified" has never been exercised end to end** — the
  state is implemented and unit-tested, but the capture-signed fixture
  (trust-listed device) was never acquired during the soak. Carries as
  an open item; the verdict is unreachable with self-signed material by
  design.
- Known-open trio from 5.1 (shadow-DOM image discovery on Lit sites,
  `all_frames` iframes, CSS-animation re-anchoring) and the Phase 3
  docket (badge occlusion, "AI — likely" wording, popover link) carry
  into Phase 3.
- The `ai_declared.png` cert-expiry CI tripwire stands as documented.

Next per plan.md: merge PR #6 (owner), then the second
`/impeccable init` pass — the authoritative post-soak re-interview —
opens Phase 3.

## 2026-08-05 — Second `/impeccable init` pass: post-soak re-interview (Phase 3 opens)

### PRODUCT.md updated (per plan.md §6 Phase 3 timing note; §8 constraint 5)

- The authoritative second init pass ran at the start of Phase 3, via the
  Impeccable init flow (interview → update, no hand-writing). Owner answers
  (2026-08-05): Phase 2 declared complete with all soak findings already
  recorded here; real-browsing verdict mix is almost entirely Unknown; no
  "Human — verified" fixture was acquired during the soak.
- What changed in PRODUCT.md: development reality (Phases 1–2 complete, soak
  done, Phase 3 current); the detail surface is the badge popover, not a
  browser-action popup; **real-world verdict mix recorded as durable product
  truth — Unknown is the everyday face of the product, and Phase 3 designs
  for that reality**; the soak-era Phase 3 docket carried in (stacking over
  page UI, placeholder copy, the "AI — likely" line covering both evidence
  classes, the popover "look this image up" candidate); a new capabilities
  bullet for the two "AI — likely" evidence classes (2026-08-04 owner
  decision); the queued generator-metadata provider noted under undecided;
  fixtures updated (`ai_expired.png` added; HV fixture still absent,
  unit-level only).
- Confirmed fields — users, positioning, brand commitments, principles, the
  AA accessibility floor — were not reopened; the interview found no reason.

### Live mode not configured during init (deferred, free choice)

- Init offers live-mode config for runnable web projects. Deferred: the
  extension's UI is injected by the content script into host pages, not
  served by the test-page server, so the live-mode file mapping needs the
  real session flow (live-setup.md) against an actual target. Configure when
  Phase 3 reaches browser iteration. Existing `.impeccable/config.json`
  (detector ignores) untouched.

## 2026-08-05 — Phase 3 ask round (owner decisions shaping the design)

### Unknown badges appear on intent only (owner decision)

- With real browsing almost entirely Unknown, the owner chose intent-gated
  presence: Unknown badges render only when the user shows interest in an
  image (hover/interaction); the strong verdicts (AI — declared, AI —
  likely, Human — verified) assert themselves without prompting. An absent
  badge means "nothing known yet." Acknowledged risk, accepted: the honest
  default is mostly invisible in passing — the popover and (later) store
  copy carry the "Unknown is honest" story instead.
- This is presentation/surfacing, not taxonomy: the Unknown verdict still
  exists, still computes, still renders on intent. §2 untouched.
- Implementation lands with the Phase 3 badge rebuild (content-script
  behavior: intent-gated reveal for Unknown).
- Rejected: uniform presence for all four states (badge density on every
  page); "Unknown recedes" middle ground (quiet-but-present marks still
  accumulate on image-heavy pages).

### Personality lives throughout, badge included (owner decision)

- The badge itself carries the friendly/approachable character (shape,
  motion, wording) — recognizable and likable at a glance, not a neutral
  pill with a warm popover behind it. Bounded by the standing
  anti-references (no alarmism, no enterprise density, no crypto-trust
  gloss) and the WCAG 2.2 AA floor.

### Phase 3 scope: polish only for now; store work deferred (owner decision)

- This phase covers the in-page UI and verdict wording. Store listing,
  screenshots, and the privacy write-up move to their own later effort
  (plan.md §6 Phase 3 item deferred, not dropped).

## 2026-08-05 — Phase 3 visual world: Evidence Ring (owner-selected via Impeccable)

### The selection process (new-work direction flow)

- Four seeded direction rounds on the Impeccable decision page, three
  owner re-rolls. Eliminated along the way: field-guide plate, eBoy
  pixorama, one-bit desktop, WPA park poster (round 1); camera
  viewfinder, teletext page, zip-tie tag, generative living mark
  (round 2); annotation pin, Metro type tiles, cyclorama dawn
  (round 3). Owner steer after round 2: contemporary, no costume,
  born at badge scale — craft carries the identity, not a metaphor.
- Round 4 (seed key af6230f8) assigned the owner's grounded candidate
  "Evidence Ring" — activity-ring / watch-complication grammar — and
  the owner took it over two challengers (creator-hardware bench,
  racing livery flood) and the standing category-standard exit.

### The world (recorded in the surface brief for src/content/badge.ts)

- Confidence drawn as geometry: rounded-cap ring on a dark-glass chip;
  ring closes only for cryptographic verdicts, sits visibly open for
  "AI — likely", stays a faint open arc for Unknown; traces while
  checks run. Every signal provider is its own ring in the popover —
  the aggregation architecture is literally the geometry, and Phase 4
  providers join without new grammar.
- Ring fill renders discrete honest bands only, never continuous
  percentages — partial fill must not fake precision (§2 alignment).
- Color strategy: Restrained — neutral dark glass + one functional hue
  per verdict class; never color alone (center glyph carries class, AA).
- Faces: `ui-rounded`-first system stack — zero web fonts injected into
  host pages (performance, CSP); rounded system faces carry the
  friendly register natively.
- Rejected: all eleven eliminated directions above; light-chip
  material (badge must self-ground over arbitrary imagery, both
  themes, like a complication on any watch face).

### Mechanics

- Surface brief written via surface-brief.mjs (primary
  src/content/badge.ts; related popover.ts, labels.ts, index.ts).
- DESIGN.md is deliberately not written now — per the skill it is
  generated at build finish from the built world by the documenter.
- No image generation in this session's harness: direction cards
  carried palette chips and prose, no sketches (per skill, that page
  is complete, not degraded).

## 2026-08-05 — Phase 3 badge/popover rebuild shipped (finish review: "ship")

### The build (task #2 of the Phase 3 docket)

- Badge and popover rebuilt in the committed Evidence Ring world:
  dark-glass 28px chip (ring + authored glyph) that grows into a labeled
  pill on hover/focus; popover as a glass card with a headline ring,
  per-signal miniature rings, internally scrolling evidence, and the
  privacy line always visible. New `src/content/ring.ts` owns all ring
  geometry: honest bands (closed 100 / open 85 / trace 15) plus a
  non-evidence `checking` arc; hues key on `data-ring` in one place.
- Owner behavior decisions implemented: Unknown badges intent-gated
  (pointerenter/pointermove/focus reveal, graceful re-hide, popover and
  focus hold the reveal); an intent-gated in-flight "checking" indicator
  spans the whole analysis window (markPending/clearPending, wired in
  index.ts, reveal-continuity handoff to a gated Unknown verdict).
- The direction contract ships as the shadow root's first node
  (DIRECTION_CONTRACT, seed af6230f8 — grep-able in dist/content.js).

### Bounded verification rounds (Impeccable §7)

- Live inspection found one material gap, fixed and confirmed: scrolling
  can put an image under a stationary cursor with no boundary event, so
  pointermove joined pointerenter as a reveal trigger (pinned by test).
- Finish review ran as a fresh general-purpose subagent following the
  skill's degraded reviewer charter (this harness ships no
  impeccable-finish-reviewer agent type — substitution disclosed). Round
  1: four material fixes (privacy line buried under an invisible scroll
  edge; missing checking state; popover never flipping above the fold;
  no pressed state). All four applied; the reviewer's round-2 verdict
  caught one batch regression (the pending spin ignored
  prefers-reduced-motion — fixed) and demanded in-extension evidence for
  two partials. Both captured (the checking state via a
  dribbled-bytes localhost server holding a real analysis open).
  Closing disposition, verbatim: **ship** — "remaining: clear".
- Chrome-only note: `scrollbar-width: thin` disables `::-webkit-scrollbar`
  styling, and macOS overlay scrollbars hide the native thin thumb — the
  always-visible evidence-scroll cue therefore uses the webkit pseudos.

### DESIGN.md recorded (documenter pass)

- DESIGN.md + `.impeccable/design.json` written from the built world by
  the documenter charter (same disclosed substitution). All labels.ts
  strings recorded as placeholder pending the owner wording pass.
- DESIGN.md added to `.prettierignore` — same fence as PRODUCT.md
  (Impeccable-owned file; the formatter stays off it).

### Docket effects

- Google-dropdown stacking (5.5 soak finding): the 28px chip replaces the
  ~90px text pill, materially shrinking the collision surface; the
  cover-heuristic / page-DOM-sibling question stays on the docket, not
  resolved by this task.

## 2026-08-05 — Phase 3 wording pass: verdict copy finalized (owner-selected)

### Badge labels (presentation of §2; the rules and enum values untouched)

- `ai-declared` → **"Made with AI"** (industry-familiar, matches the
  signed statement's own claim; composites clarified in the popover).
- `ai-likely` → **"Likely AI"** (leads with the hedge — unmisreadable as
  certainty, satisfying §2's probabilistic-labeling rule at a glance).
- `human-verified` → **"Verified photo"** (names exactly the
  signed-capture evidence class; avoids "Human", which invites
  over-reading beyond capture provenance).
- `unknown` → **"Unknown"**, unchanged — the restraint is the brand.
- Owner selected each from a structured options round. Rejected: keeping
  the engineering labels at the surface ("declared" is insider
  vocabulary; the em-dash constructions read as taxonomy, not language);
  "AI (signed)"; "Probably AI" (weaker than the 0.9-confidence class
  deserves); "Camera-verified" (more technical than the audience needs).

### Explanations and remaining strings

- ai-likely explanation rewritten to cover both evidence classes
  honestly (the 2026-08-04 decision's Phase 3 note): "Signs point to
  this image being AI-made, but the evidence falls short of proof. This
  is an estimate, not a certainty." — true of a probabilistic detector
  signal and of an expired, un-timestamped declaration alike.
- unknown explanation drops the "provenance" jargon: "We couldn't find
  any usable origin information for this image. Most images carry none —
  so this says nothing either way."
- Kept verbatim by owner decision: the ai-declared and human-verified
  explanations, "How do we know?", the degraded notice, the failure
  line, and the privacy line. CHECKING_LABEL finalized as shipped.
- Presenter summaries (providers layer) unchanged — already
  plain-language and consistent with the new labels.
- labels.ts comments now mark the wording finalized (edits remain an §8
  owner ask); three pinned test literals updated; 225/225 pass.

Phase 3 as scoped by the owner (in-page UI + wording; store assets
deferred to a later effort) is complete: visual world committed and
recorded (DESIGN.md), badge/popover shipped through the finish review
("ship"), wording finalized.

## 2026-08-05 — Post-ship code review of PR #8: 15 findings fixed

A full review pass over the Phase 3 branch surfaced 15 verified findings,
all fixed in one session. The cluster: the new pending-indicator and
intent-gate machinery lived outside the lifecycle invariants the badge
pipeline enforces. Free choices made while fixing (alternatives noted):

### Pending/intent-gate lifecycle

- `analyze()`'s `finally` now clears pending state only when the run's
  generation is still current — overlapping runs are a supported state
  (`ScanScheduler.reset` leaves in-flight runs going), and a stale run
  settling must not destroy the fresh cycle's indicator. Every
  generation-bump path clears pending itself (`invalidateScan` via
  `removeBadgeFor`; `untrack` now directly), so nothing leaks.
- `markPending` moved after the settle wait and every skip gate (no URL,
  broken render, `MIN_IMAGE_DIMENSION_PX`): the chip must never claim a
  check on an image that can produce no verdict. Rejected: keeping it at
  the top of the analyze callback with per-gate clears — one placement
  after the gates is strictly simpler.
- Visible pending chips joined the `syncBadges` pass (reposition on
  layout shift, hide on collapse, reap on disconnect), and
  `revealPendingChip` re-runs `ensureHost` so a host teardown can no
  longer strand a chip in a detached shadow root. Rejected: promoting
  "checking" to a full `BadgeEntry` state — a bigger refactor with the
  same observable behavior; reconsider if the pending path grows again.
- The intent-hide timer guard now also holds while the _image_ is
  hovered (`image.matches(":hover")`), not just the badge — a verdict
  handoff or popover close under a stationary pointer no longer blinks
  the badge out. Same holds applied to gate creation (`syncIntentGate`),
  so an in-place downgrade to Unknown under an open popover stays shown.
- `removeAllBadges` aborts every gate controller and hide timer —
  listeners live on the page's own `<img>` elements, so host removal
  alone left them firing forever (§8 removability).

### Popover

- `.popover` is a scroll container again (`overflow-y: auto` +
  `overscroll-behavior: contain`) _as a fallback layer_ under the
  evidence-only scroll: when even the flex-none stack outgrows the
  height cap (short viewports, degraded notice), the panel scrolls
  instead of painting past the card unreachably. `.evidence` got a 64px
  min-height floor so the borderline band can't squeeze an expanded
  disclosure into a sliver. Rejected: reverting to whole-panel-only
  scroll (loses the always-visible privacy line, reviewer fix 1).
- Wheel containment is JavaScript, not CSS: `overscroll-behavior`
  engages only where scrollable overflow exists (per spec), so a panel
  whose evidence region absorbed the excess has no containment layer
  under the pointer at all. The panel now consumes wheel events
  unconditionally (non-passive `preventDefault`, binding for real wheel
  input) and routes the delta to the innermost scrollable region under
  the pointer (evidence, else the panel itself). Deliberate behavior
  change: wheel over a short, uncapped panel scrolls nothing rather
  than the page — a dialog under the pointer owns the wheel. Soak
  caveat (2026-08-05): the browser-automation scroll action drives the
  viewport at the compositor level regardless of pointer target — it
  bypasses wheel dispatch, so it can neither exercise nor falsify this
  path. Earlier same-day "page scrolled under the dialog" readings were
  this artifact (the review's "empirically verified" chaining claim
  likely was too). What is verified: delta routing live (wheel bursts
  scrolled the evidence to its limit), preventDefault via the jsdom
  test, and panel-internal scrolling via the live keyboard-scroll check
  (privacy line reached, page scrollY unchanged), and the owner's
  manual trackpad pass (2026-08-05): wheel over the open panel leaves
  the page still.
- The below/above flip side is decided once at first placement and held
  for the panel's open lifetime (`data-side`). Rejected: threshold
  hysteresis — decide-once is simpler and matches the old always-below
  stability.
- Entrance motion plays once per element: badges drop `.enter` on
  `animationend`, the panel neutralizes `trueorigin-pop` (and its
  headline arc's sweep) after they run — host-rebuild re-adoption no
  longer replays animations ("never on positional re-renders").

### Accessibility, performance, wire hardening

- A persistent visually-hidden `role=status` region in the shadow root
  announces "Checking this image…" when a chip first reveals (cleared
  when the last chip goes). The chip keeps its own `role`/`aria-label`
  for tree/touch discovery, but a live region only announces mutations
  made while it's in the tree — the chip enters fully formed and could
  never speak.
- Chips lost their resting `backdrop-filter` (a live blur readback per
  chip per scrolled frame on image-heavy pages); base alpha raised
  0.82 → 0.92, glass now applied on hover/focus/expanded only. The
  popover keeps full glass — one panel at a time.
- `isWireVerdict` now validates each signal's `finding` (∈ FINDINGS) and
  `confidence` (number): badge click keys the per-signal ring off both,
  and an out-of-union finding would throw in the click handler the
  guard's contract promises to prevent.
- New `verdictClassForSignal` in core/verdict.ts (beside `mapVerdict`)
  is the one finding→verdict-class mapping; it honors
  `AI_LIKELY_MIN_CONFIDENCE`, so a below-threshold probabilistic signal
  draws the unknown trace, never the near-closed "Likely AI" band.
  `ring.ts`'s `ringStateForFinding` (which re-encoded the mapping and
  ignored the threshold) is deleted.
- Recorded correction: `ui-rounded` is Safari-only — no Chromium version
  supports it, so Chrome ships the plain system face. The stack stays
  (unknown families cost nothing; future-proof), but DESIGN.md and the
  badge.ts comment now carry the caveat instead of claiming the rounded
  register ships.

236/236 tests pass (11 added), typecheck and Prettier clean.

Post-fix live soak (same day, fixture page + reloaded unpacked build):
verified working — resting chip solid with glass returning on hover;
Unknown intent reveal, hover-hold after light dismiss under a resting
pointer, and the ordinary fade-out; flip side-lock under scroll (panel
held above its badge after space opened below); evidence min-height
floor (usable window, no sliver); capped-panel internal scrolling to
the privacy line via keyboard with page scroll unmoved; host-teardown
rebuild re-adopting badge, open popover, and disclosure state, shadow
root still closed. Wheel containment could not be exercised by
automation (compositor-gesture caveat above) — covered by the jsdom
preventDefault pin plus the owner's manual trackpad check (passed).

## 2026-08-05 — `/impeccable audit` of badge.ts (18/20) and its fix wave

Audit scored the overlay 18/20 (a11y 3, perf 4, responsive 4, theming 3,
implementation integrity 4; bundled detector: zero findings). All verdict
hues measured 6.0–8.8:1 non-text and all text 7.2:1+ against worst-case
(white-page) backdrops. Fixes applied in the audit's recommended order:

- Evidence scrollbar thumb alpha 0.3 → 0.38 (`badge.ts`): worst-case
  contrast measured 2.58:1, under the WCAG 1.4.11 3:1 non-text floor —
  and the always-visible thumb is load-bearing as the truncation cue.
  0.38 measures 3.29:1 (0.36 is the bare 3.10:1 minimum; 0.38 buys
  margin). Value recorded in DESIGN.md alongside the rationale.
- Popover headline is a real `<h2>` now (was `<p>` via the paragraph
  helper): the one heading-navigation stop screen readers get inside the
  dialog. Class-based styling and the dialog's aria-label are unchanged.
- Wheel containment lets Ctrl+wheel through (`badge.ts`): Chrome
  synthesizes ctrlKey wheel events for trackpad pinch, and Ctrl+scroll
  is browser zoom on every platform — consuming them silently blocked
  zoom whenever the pointer rested on an open panel. Scroll containment
  is untouched. New jsdom pin: ctrlKey wheel is not defaultPrevented.
  Like wheel containment, the pinch path is compositor-level and
  unreachable by automation — verified by the owner's manual pinch
  check over an open panel (2026-08-05): zoom works.
- DESIGN.md reconciled with two shipped decisions it had drifted from:
  the resting-chip material (frontmatter chip-glass 0.82 → 0.92 with
  hover/focus/open-only blur — decided and recorded here 2026-08-05 but
  never carried into DESIGN.md's token or Elevation prose) and the new
  thumb value. `.impeccable/design.json` regenerated to match (badge
  component snippets, chip-glass canonical, ui-rounded Chrome caveat in
  keyCharacteristics), clearing the sidecar-stale warning.

237/237 tests pass (1 added), typecheck and Prettier clean.

## 2026-08-05 — Chevron optical centering; system face committed on Chrome

Two `/impeccable` fixes from an owner report (the disclosure chevron
riding off its label's centerline; "the rounded font we wanted isn't
available on Chrome").

- Disclosure chevron re-centered (`badge.ts`): the rotated stroked
  corner carries its visual mass ~1.75px off its box center toward the
  point (stroke midlines sit 2.5px from center on a 3.5px half-box,
  x sqrt(2)/2), and the old eyeballed `margin-top: -2px` / `-4px`
  compensation pushed the glyph ~3px below the text centerline — the
  misalignment the owner saw — and jumped without transition at toggle
  (only `transform` was transitioned). Replaced with per-state
  counter-translates inside the transform itself
  (`translate(-1.75px, 0) rotate(-45deg)` closed,
  `translate(0, -1.75px) rotate(45deg)` open): matching
  translate+rotate function lists interpolate as one move, and no
  layout property shifts between states. Verified at 7x magnification
  against the shipped CSS — both states sit on the label's optical
  centerline. Alternatives rejected: re-tuning the margins (stays
  eyeballed, couples layout to rotation state, and margin changes
  don't transition); an SVG chevron (DESIGN.md commits the disclosure
  to a stroked, rotating CSS corner; no reason to grow the DOM).
- The plain system face is the committed type voice on Chrome (owner
  decision via structured ask, this session). `ui-rounded` resolves
  only in Safari, and a live probe — validated against a
  document-level `src: local()` control that did resolve — confirmed
  Chrome ignores `@font-face` declared inside shadow roots, so a
  bundled rounded face could not stay inside the overlay's closed
  shadow scope; it would need document-level registration in every
  host page. Alternatives rejected: bundling an OFL rounded face
  (~40–80KB into every page visited, page-observable fingerprint
  surface, breaches the zero-web-fonts and single-footprint
  commitments); popover-in-iframe (partial — the badge pill keeps the
  system face anyway — plus a web_accessible_resources fingerprint
  surface and cross-frame anchoring/focus/dismiss rework). DESIGN.md's
  2026-08-05 caveat is rewritten as the commitment (roundness lives in
  the geometry: pill, rings, round caps, drawn glyphs);
  `.impeccable/design.json` synced (chevron snippet, type
  characteristic). The stack keeps `ui-rounded` first — unknown family
  names cost nothing and Safari resolves it for free.

237/237 tests pass, typecheck, build, and Prettier clean.

## 2026-08-05 — Panel scrollbar bounded to the popover's rounded shape

Owner report: in the whole-panel scroll fallback (short viewport), the
popover's own scrollbar runs the full padding-box height, so the thumb's
extremes sit inside the 14px corner arcs — a gray pill floating past the
glass, over the host page. Fix (`badge.ts`):
`.popover::-webkit-scrollbar-track { margin: 14px 0 }` — insetting the
track by exactly the corner radius bounds the thumb's travel to the
straight edge. Verified in Chrome against a light host background
(worst case for a floating thumb): top corner clean at rest, bottom
corner clean scrolled to end. The evidence region's scrollbar gets no
inset — it sits 14px inside the panel, nowhere near the corners.
Alternatives rejected: an inner scroll wrapper clipped by the radius
(restructures the panel DOM and the flex column that keeps the privacy
line pinned, for the same visual result); `border-radius`-clipping via
`overflow: clip` on a wrapper (same objection). DESIGN.md's popover
section records the rule alongside the scrollbar prose; the
`.impeccable/design.json` popover snippet carries no scrollbar CSS, so
no sidecar sync was needed.

237/237 tests pass, typecheck, build, and Prettier clean.

## 2026-08-05 — `/impeccable document` refresh: DESIGN.md trued against code

Owner chose refresh over overwrite/merge (structured ask): re-scan the
shipped implementation and true up values while keeping the committed
voice, North Star, and named rules. Full diff of DESIGN.md against
`badge.ts` (complete stylesheet, host setup, placement math), `ring.ts`
(bands, geometry, glyph paths), `popover.ts` (content order), and
`labels.ts` (finalized strings): **every frontmatter token and prose
value matches the code** — the session's incremental syncs held, so no
corrections were needed. The scan surfaced one durable placement fact
DESIGN.md lacked, now added to Layout: the popover's side (below/above)
is decided at first placement and held for the open lifetime
(`data-side`), so an open panel never teleports across its badge as
scrolling crosses the fits-below threshold. Sidecar refreshed:
`generatedAt` bumped, and the type keyCharacteristic made verbatim with
DESIGN.md's bullet per the narrative-mapping rule (it had drifted into a
paraphrase). Components, colorMeta, shadows, and motion all verified
current — untouched.

## 2026-08-05 — Roadmap round: docket decisions and the chunk queue

A planning session over the consolidated open-item list. Owner decisions
below; the resulting task queue lives in **ROADMAP.md** (new file — one
chunk = one session = one PR), pointed to from CLAUDE.md. The roadmap
holds scope and context pointers only; reasoning stays here.

- **Popover "look this image up" Lens link: dropped.** The owner's
  standing condition was that it route through Chrome's built-in Lens
  path; no extension API can invoke a built-in context-menu item or open
  the Lens side panel (`chrome.sidePanel` controls only the extension's
  own panel). The only buildable form is the `lens.google.com/uploadbyurl`
  link — the strictly weaker path the task-5.4 evaluation documented
  (fails behind logins, cookie-gated CDNs, expiring signed URLs).
  Shipping a feature that works less often than the gesture users
  already have erodes trust for no gain. Revisit only if Chrome exposes
  an API into the built-in item.
- **Per-image remote-manifest disclosure: dropped; write-up sentence
  kept.** The task-4 disclosure obligation splits: the privacy write-up
  and store listing keep the one-sentence disclosure (the fetch
  genuinely reveals asset-viewing activity to the manifest host, and
  network-panel auditability is the brand — one sentence is cheap
  insurance), while the per-image popover disclosure is dropped (low
  value; remote-manifest assets are rare; the popover privacy line
  already claims only what always holds). labels.ts's "per-image
  disclosure of it is Phase 3 work" comment is now stale — clean up in
  the next chunk that touches labels.ts.
- **Instagram broken, Reddit fine (owner field report).** Instagram
  shows no badges; diagnosis is chunk 1. Reddit working suggests the
  5.1 shadow-DOM known-open item may be stale — the chunk confirms or
  retires it. Instagram is React/light-DOM, so the chunk starts from
  zero assumptions (suspects listed in the roadmap).
- **Iframe scanning: approved in principle.** `all_frames` scanning
  (5.1 known-open) is queued as chunk 2. The formal §8 ask still opens
  that session — this approval covers intent, not the concrete
  manifest/perf posture.
- **Generator-metadata provider scheduled before Phase 4** (chunks 5–6,
  split PNG-first then IPTC/XMP). Plan.md §6's framing of the first
  non-C2PA provider as Phase 4 paid territory is owner-acknowledged
  drift (this provider is local and free); amendment stays with the
  owner.
- **Store work ordered last** (chunks 7–10: README, privacy write-up,
  listing + screenshots, publication), and **no Phase 4 planning** —
  the roadmap explicitly stops at the store launch.
- **"Human — verified" fixture parked:** owner expects no trust-listed
  capture device or sample for a while; the verdict remains unit-tested
  only. Carried as a parked item, not a chunk.
- **Rejected for the queue mechanism:** tracking chunks in plan.md
  (owner-authored; agents don't edit it), in DECISIONS.md itself (a
  ledger, not a queue — status lines would drown the record), or in
  session-local task tools (invisible to future sessions and to
  reviewers). A committed ROADMAP.md is reviewable in PRs, and each
  chunk's PR updates its own status line.

## 2026-08-05 — plan.md annotated (owner-authorized, one-off)

- **What:** two dated update blockquotes added to plan.md, in the house
  style of the existing §5 update: one atop §6 (Roadmap) marking Phases
  1–2 complete and Phase 3 partially shipped, with ROADMAP.md
  superseding §6/§8 as the task source and the generator-metadata
  provider framing correction; one atop §8's task order marking it
  exhausted while everything else in §8 stays in force.
- **Why this is an exception, not a precedent:** plan.md is
  owner-authored and the standing rule (recorded 2026-08-04) is that
  sessions don't edit it. The owner explicitly authorized these two
  annotations in conversation (2026-08-05); nothing else in plan.md was
  touched, and the rule stands for future sessions.
- **Wording note (owner catch):** the draft said "Phases 1–3 are
  complete." Wrong against plan.md's own definition — plan.md's Phase 3
  includes the store listing, screenshots, and privacy write-up, which
  are queued as roadmap chunks 7–10 (the 2026-08-05 "Phase 3 complete"
  declaration earlier in this ledger was scoped by the owner to in-page
  UI + wording only). The applied note says Phase 3's in-page work
  shipped and the rest is queued.

## 2026-08-06 — Instagram field bug: intent gate was blind under page overlays (roadmap chunk 1)

### The diagnosis (live, logged in)

- **Report:** no badges anywhere on instagram.com (owner, 2026-08-05).
- **What was actually happening:** everything upstream worked. Feed and
  carousel images are plain light-DOM `<img>` elements with `https:`
  scontent CDN srcs — discovery found them, the 96px gate passed them
  (feed images are 468px+), acquisition and analysis completed without a
  single console failure, and verdict badges rendered. But Instagram
  strips metadata, so every verdict is **Unknown** — and Unknown badges
  are intent-gated (owner decision 2026-08-05): hidden until
  `pointerenter`/`pointermove` fires **on the img element**. Instagram
  stacks an absolutely-positioned click-capture div over every feed
  slide, so the img is never the hit-test target and those events never
  fire — verified live with instrumented listeners (a real cursor wiggle
  over a post: zero events on the img; the only `pointermove` target
  document-wide was the overlay div). Badges sat permanently at
  `opacity: 0`. Neutralizing the overlay's `pointer-events` for one
  hover revealed the chip instantly, closing the causal loop.
- **Suspects ruled out** (the roadmap's list): `blob:` URLs (feed is
  all `https:`), srcset/wrapper discovery misses (badges rendered, so
  discovery saw the images), the 96px gate (feed images are well past
  it), and badge occlusion (nothing painted over our overlay; the badge
  was invisible by its own gating).
- **Same blindness, second site class:** the pending "checking" chip's
  reveal listeners and both `image.matches(":hover")` guards (initial
  presence, hide-timer hold) fail identically under overlays — `:hover`
  follows the hovered element's ancestor chain, which never includes a
  covered sibling image.

### The fix: a shared document-level intent sensor (badge.ts)

- **What:** the per-image `pointerenter`/`pointermove`/`pointerleave`
  listeners are gone. One document-level capture-phase listener pair
  (`pointermove` + `pointerdown` — taps are intent too) serves every
  intent-gated entry: on each event it asks
  `document.elementsFromPoint()` for the full hit stack under the
  pointer and reveals any gated badge or pending chip whose image is in
  the stack, scheduling the standard 200ms-grace hide for revealed
  entries whose image is not. A `pointerout` with no `relatedTarget`
  (pointer left the window) hides everything. The
  `image.matches(":hover")` guards became the same hit-stack check
  against the pointer's last position — viewport coordinates, which
  scroll and layout cannot invalidate, re-hit-tested at fire time.
- **Why elementsFromPoint:** it is the engine's own hit tester, and it
  reports elements _underneath_ overlays (that is its purpose), while
  excluding clipped or hidden ones — so "the pointer is visually over
  this image" stays answerable no matter what the page paints on top,
  and an off-screen carousel slide never reveals. Construction-correct
  rather than site-specific: no Instagram selectors, no guessing which
  div is an overlay.
- **Cost posture:** the sensor installs only while a gated entry exists
  and tears down with the last one (and in `removeAllBadges` — §8
  removability). No rAF throttle: Chrome already aligns `pointermove`
  dispatch to the frame rate, so the handler runs at most ~once per
  frame, doing one `elementsFromPoint` walk plus Map iteration over the
  handful of gated entries. Consistent with the standing-cost line drawn
  at 5.1 (rAF re-anchoring loop rejected).
- **Rejected:** listeners on the covering overlay or a positioned
  ancestor (framework reconciliation churns those nodes; brittle,
  site-shaped); per-gated-image `getBoundingClientRect` containment
  checks per move (layout reads per event, and a rect check cannot see
  clipping — it would reveal hidden carousel slides); revealing Unknown
  unprompted on overlay sites (a policy change; the owner's intent-only
  decision stands untouched — this fix changes the sensor, not the
  policy).
- **Behavior deltas, accepted:** continued pointer movement outside a
  revealed badge's image keeps resetting the 200ms hide grace (hide
  lands after movement pauses — marginally softer than the old
  boundary-event hide); `pointerdown` now counts as reveal intent
  (previously touch reveal rode on pointerenter quirks). `PendingEntry`
  lost its per-image AbortController — the sensor is the only pointer
  channel for chips now.
- **Semantics preserved:** scrolling still reveals nothing until the
  first in-image pointer move (scroll fires no pointer events — the
  5.1-era finding stands); badge-element hover/focus listeners stay
  (our overlay outpaints page UI, so they were never blind);
  DESIGN.md's presence contract ("pointer entering or moving on the
  image") is unchanged at the level it specifies.

> **Corrections (2026-08-06, PR #12 review — see the review fix wave
> entry below):** three claims above overstate. "Answerable no matter
> what the page paints on top" — not for images with
> `pointer-events: none` (own or inherited): hit testing skips them
> entirely, so their gated badges reveal only via keyboard focus
> (residual site class, now a ROADMAP parked item). "Construction-
> correct" — `document.elementsFromPoint` also retargets shadow-tree
> hits to the host, so a gated image inside a shadow root could never
> match; moot while discovery is light-DOM-only, but binding on whoever
> adds shadow discovery. And the cost note ("one elementsFromPoint walk
> plus Map iteration") omits that a layout-dependent read forces a
> synchronous style+layout flush whenever the page has dirtied layout —
> per-frame jank risk on SPA feeds, queued as its own roadmap chunk.
> The single-slot `lastPointer` this fix introduced also carried a
> family of state-staleness bugs (touch, multi-pointer, iframe exit,
> teardown); the fix-wave entry records their repair.

### Verification

- Unit: intent-gate and pending suites rewritten against the sensor
  (scripted `elementsFromPoint` stacks — jsdom has no hit tester), with
  two new regression pins: reveal-through-overlay (the Instagram case:
  event target is the overlay, image only in the stack) and
  no-reveal-for-stack-absent images (the clipped-slide case). 240
  tests, typecheck, Prettier all green.
- Live: on instagram.com (logged in, extension rebuilt and reloaded) the
  Unknown chip now reveals through the intact overlay on hover and
  fades on move-away; test-page baseline intact — ai_declared badges
  unprompted, ai_expired badges "AI — likely" unprompted, C.jpg's
  Unknown reveals on plain hover.
- Session note: the first reproduction pass found no badges because the
  extension was _disabled_ in the browser — worth checking before
  diagnosing (the test-page baseline catches it in one load).

### Reddit shadow-DOM known-open item: retired (stale)

- The 5.1 known-open list flagged shadow-DOM image discovery with
  "Lit sites like Reddit" as the motivating case. Checked live on
  reddit.com (r/EarthPorn): all 56 content-sized images are slotted
  **light DOM** children of the shreddit web components —
  `document.images` finds every one, and badges work (owner report
  matches). The only images inside shadow roots are 0–32px chrome
  (community icons, nav assets), all below the 96px gate even if
  discovery could see them. The abstract gap — a site authoring
  content-sized images inside shadow roots — remains real but has no
  known real-site instance; it stops being a tracked known-open item
  until one appears.

## 2026-08-06 — PR #12 review fix wave: per-pointer state, sticky touch, sensor hardening

An xhigh-effort review of PR #12 (12 adversarially verified findings)
confirmed that replacing browser-maintained `:hover` truth with a single
event-fed `lastPointer` slot introduced a family of state-staleness bugs.
This wave repairs them on the same PR. All decisions below were free
choices under §8.

### Per-pointer-type state: `hoverPoint` + `touchPoint`

- **What:** the single `lastPointer` became two slots — `hoverPoint`
  (mouse/pen) and `touchPoint` — keyed on `event.pointerType`.
  `isImageUnderPointer` probes each at its own coordinates.
- **Why:** boundary events are per-pointer, state was not: an unrelated
  touch tap overwrote — and on lift, nulled — the point holding a mouse
  reveal, hiding the badge under a stationary cursor with no boundary
  event left to re-reveal it (review finding 5).
- **Rejected:** a per-`pointerId` Map — only the hover/touch semantic
  split changes outcomes (two hovering mice don't exist; multi-touch
  collapses to "last tap"), so per-id tracking is bookkeeping without
  behavior.

### Sticky touch point (the touch-tap regression)

- **What:** a touch lift's trailing `pointerout` (`relatedTarget: null`)
  no longer clears state or schedules hides; `touchPoint` survives until
  the next touch lands elsewhere, the touch becomes a scroll or gesture
  (`pointercancel`, a new sensor listener), or the pointer crosses into
  an iframe.
- **Why:** the old per-image gate leaned on Chrome's sticky post-tap
  `:hover`; the sensor cleared everything on lift, so every tap's reveal
  self-destructed 200ms later — before the second tap that opens the
  popover, and hidden badges are `pointer-events: none`, so that second
  tap fell through to the page. Unknown badges were effectively
  unreachable on touch (review finding 1, the wave's most severe).
  Stickiness mirrors the platform: Chrome holds post-tap hover at the
  tap point until the next tap, including across layout changes.
- **Accepted:** a stale sticky point can hold a reveal over whatever an
  infinite-scroll feed later places under it — exactly what platform
  sticky hover does; bounded by the next touch event.

### Sensor teardown clears pointer state; `dropPending` split

- **What:** `syncIntentSensor`'s uninstall branch now nulls both points.
  Made safe by splitting `clearPending` into an internal non-syncing
  `dropPending` (used by `renderBadge`) plus the syncing export:
  `renderBadge` settles sensor accounting once, after `syncIntentGate`,
  so the pending→Unknown handoff no longer bounces the sensor down and
  up mid-render (which would have wiped the points the handoff's
  `held` check reads moments later — the trap the review flagged in the
  same breath as the fix).
- **Why:** movement while no sensor listens is untracked; a point kept
  across the gap goes stale, and a later gate consulting it revealed a
  badge no reader asked about — an intent-policy violation, not just a
  glitch (finding 2). Invariant now: points are non-null only while the
  sensor is installed. The split also deletes the two-AbortController /
  six-listener churn on every first verdict (finding 15).

### Initial presence: `:hover` fallback while hover data is absent

- **What:** `isImageUnderPointer` falls back to `image.matches(":hover")`
  only while `hoverPoint` is null.
- **Why:** a page can load with the cursor already resting on an image
  and the verdict landing before any pointer event; the event-fed points
  know nothing, and the old code showed the badge (browser hover chain —
  event-independent). Overlay-covered images never enter the hover
  chain, but for them the fallback returns the same false the missing
  data would — strictly a restoration, never a new reveal path (finding
  4).
- **Rejected:** an always-on lightweight coordinate tracker installed at
  content-script init — standing listeners on pages with no badges
  contradict the §8 removability posture, and it still cannot see a
  cursor that never moves.

### Pointer-into-iframe = pointer gone

- **What:** the sensor's `pointerout` handler also treats
  `relatedTarget instanceof HTMLIFrameElement` as departure: clear that
  pointer's point, schedule the grace hide everywhere.
- **Why:** entering a cross-document iframe delivers all further pointer
  events to the child document; the frozen point sat exactly where the
  fire-time guard would re-hold any hide, pinning the reveal open for as
  long as the reader worked in the frame (finding 3). Matches the
  popover's recorded iframe blindness (its dismiss uses window blur).
  Scoped to iframes like the popover path — framesets and
  object/embed are not worth the extra instanceof checks until a field
  report says otherwise.

### Window capture, own-overlay exclusion, topmost-image rule

- **Window capture:** all sensor listeners moved from document capture
  to window capture — window-capture listeners fire before everything
  else, so only an earlier `stopImmediatePropagation` on window itself
  can starve the sensor (finding 11; the containment comment in badge.ts
  already recorded the ordering).
- **Own-overlay exclusion:** `hitStackAt` returns an empty stack when
  its top element is the overlay host (the retargeted shadow-tree hit —
  the host itself is 0×0 `pointer-events: none`, so it tops a stack only
  when the point is on a shown badge or the open panel). Reading the
  panel no longer strobes reveals across the images under its footprint
  (finding 6); the panel's own image is held by the `openPopover` guard,
  a hovered badge by its `:hover` guard.
- **Topmost-image rule:** reveal and hold semantics changed from "image
  anywhere in the stack" to "image is the topmost image in the stack"
  (`topImageAt`). `elementsFromPoint` includes images fully covered by
  other images — LQIP placeholders under their final image, crossfading
  carousel frames — and revealing both piled two chips on the same
  +8/+8 anchor for an image the reader cannot see (finding 7). Non-image
  overlays above still lose (the Instagram case is unchanged); a visible
  image above wins, matching what `:hover` said before the sensor.
  **Refinement (same wave, owner follow-up):** when a stack holds two or
  more images, opacity-hidden frames — own or ancestor opacity 0, per
  `checkVisibility({ opacityProperty: true })`, the engine's own walk
  (both option spellings passed for pre-rename Chromes; a browser
  without the API degrades to plain topmost-wins) — are skipped, so a
  crossfade's settled-out frame parked at `opacity: 0` above the active
  one no longer takes the reveal. Cost posture: single-image stacks —
  the overwhelmingly common case — return before any style read; the
  opacity walk runs only to arbitrate between stacked images, right
  after `elementsFromPoint` left style clean at that point. When every
  image in the stack is opacity-hidden the topmost still wins (`:hover`'s
  answer; with no visible twin there is nothing to mis-attribute).
  Residuals, accepted: fractional opacity counts as visible (mid-fade,
  either attribution is defensible — 0 is the only principled
  threshold), and `filter: opacity(0)` is not checked (no known
  crossfade pattern uses it).

### Consolidation

- `scheduleHideAll` was `processPointerAt([])` with the loop bodies
  hand-copied; deleted, callers pass the empty stack (finding 13).
- The three-clause "never hide under the reader" predicate, previously
  duplicated between `syncIntentGate`'s initial presence and the hide
  timer's fire-time guard, is now one named `readerEngaged` used at both
  sites (finding 14).

### Test coverage (the mutual-masking finding)

- The review mutation-tested the suite: deleting either the
  reveal-continuity block in `renderBadge` or the pointer clause in the
  engagement check left all tests green — each path masked the other
  (finding 9). Two killers added and verified by re-running both
  mutations (1 and 4 failures respectively): a verdict landing under the
  pointer with no chip ever visible (engagement path alone), and a
  verdict landing in the hide-grace window just after the pointer left
  (continuity path alone, then the ordinary grace hide). Eight more
  tests pin the wave's fixes; `elementsFromPoint` is now scripted
  per-coordinate so multi-pointer scenarios can diverge.

### Recorded, not fixed here

- **Per-move hit-test cost** (finding 12): the unconditional
  `elementsFromPoint` per `pointermove` forces a style+layout flush
  whenever the page has dirtied layout — real jank risk on SPA feeds
  where the sensor never uninstalls. The fix needs design (a cached-rect
  AABB prefilter is only sound with a staleness escape: syncBadges rects
  lag scroll by up to a frame and never see pure-transform animations).
  Queued as its own roadmap chunk rather than rushed here.
- **`pointer-events: none` images** (finding 8): hit testing skips them,
  so their gated badges reveal only via keyboard focus. No behavior
  change made — the sensor comment and a ROADMAP parked item now record
  the limit so the next field report is a lookup, not a re-diagnosis.
- **Shadow-DOM coupling** (finding 10): `document.elementsFromPoint`
  retargets shadow-tree hits to the host, so shadow-discovery work (if
  ever scheduled) must extend the sensor, not just discovery — recorded
  in the sensor's header comment and the correction block above.

## 2026-08-10 — Roadmap chunk 2: iframe scanning

### Owner decision (§8 ask, resolved before building): all frames, creator-origin fallback

- **What:** the single `content_scripts` entry gains `"all_frames": true`
  and `"match_origin_as_fallback": true`. No new permissions; scope stays
  `http/https`; the install warning is unchanged (broad host access
  already maxed it). The manifest test pins the new shape.
- **Evaluation presented:**
  - _`all_frames` only_ (rejected by owner): http(s) child frames only —
    covers social/article embeds but leaves `about:blank`/`srcdoc`/
    `data:`/`blob:` frames unscanned. Smaller blast radius; was the
    session's recommendation as a soak-informed first step.
  - _Plus `match_origin_as_fallback`_ (chosen): also injects into
    `about:`/`data:`/`blob:` frames created by http(s) documents, matched
    via the creator's origin (Chrome 106+; requires wildcard-path match
    patterns, which ours are). Embedded content in those frame types —
    ad-creative layers, srcdoc embeds — is scanned too, at the cost of
    the maximal frame-flood exposure. Sandboxed (opaque-origin) frame
    behavior is documented but thin — flagged for live soak verification.
- **Per-frame cost posture (the 5.1 "frame-flooding" question, answered):**
  - Injection is the unavoidable cost: one 68 KB `content.js` instance
    per matching frame, paid at the manifest level for every frame
    whether or not it ever badges.
  - Viewport gating holds across frame boundaries: IntersectionObserver
    inside a cross-origin iframe computes real visibility through the
    frame chain (the ad-visibility use case IO was built for), so images
    in offscreen frames never enter their scheduler. Caveat to watch
    live: the 200px `rootMargin` lookahead has historically been ignored
    for the implicit root in cross-origin frames — images there queue at
    actual visibility (later, never more).
  - The 96px min-size gate skips frame furniture exactly as it does in
    top documents.

### Tiny-frame early-exit (owner-selected from the ask)

- **What:** in a child frame (`window.self !== window.top`) whose
  viewport short side is under `MIN_IMAGE_DIMENSION_PX`, the boot path
  installs no observers and no scheduler — nothing but a `resize`
  listener that re-runs the check and starts scanning once the frame
  grows past the threshold.
- **Why:** such a frame cannot display an image the min-size gate would
  pass, and tracking-pixel/ad-slot frames are legion on real pages —
  without the guard each would run discovery observers and dwell cycles
  that can never produce a badge. The revive listener exists because
  `display:none` frames report a 0×0 viewport until shown, and reveal
  arrives as a resize; a one-shot exit would permanently blind them.
- **Rejected:** no guard (rely on viewport + size gates alone — simplest,
  but pays standing observer cost in every pixel frame); a frame-size
  manifest heuristic doesn't exist (injection is all-or-nothing), so the
  guard is the earliest point the extension controls.

### Per-frame schedulers share the worker without coordination

- Messaging is already frame-agnostic: `chrome.runtime.sendMessage`
  reaches the same service worker from any frame, and no worker code
  changed in this chunk. Each frame's `ScanScheduler` bounds its own
  in-flight analyses at 2, so the global bound becomes 2 × (frames with
  visible images) — but that parallelism only hides fetch/encode
  latency: the WASM validator serializes inside the worker regardless,
  which is the natural global throttle. The worker's content-hash
  verdict cache is shared, so the same bytes appearing in N frames
  validate once; each frame keeps its own page-view URL cache
  (per-document by construction — no change needed).
- Constraint 3 is unaffected: frames fetch their own images exactly as
  top documents already did; no new request types exist.

### Test-page iframe fixtures (chunk-directed)

- `test-page/frame.html` (served at `/frame.html`, allowlisted in
  serve.mjs): ai_declared.png + no_manifest.jpg referenced same-origin,
  so acquisition inside the frame needs no fallback. Embedded four ways
  in index.html:
  - **Same-origin iframe** — badges render inside the frame; a warm
    worker hash-matches the parent's bytes and skips re-validation.
  - **Cross-origin iframe** — the existing localhost/127.0.0.1 host flip
    (same pattern as the strict-CORS figure, port-agnostic). Separate
    content-script instance; requests appear under the flipped host in
    the server log; no worker fallback (images are same-origin to their
    frame).
  - **srcdoc iframe** — exercises `match_origin_as_fallback` (an
    `about:srcdoc` document has no http(s) URL to match); no badge there
    means fallback matching is broken.
  - **Tiny 80×80 iframe** — exercises the early-exit: no badges, no
    analysis requests, and growing it past 96px must revive scanning.
- Audit text updated: iframe fixtures add per-document render+analysis
  pairs to the page panel and nothing to the worker panel.

### Residuals (recorded, accepted)

- **Popover clipping:** badges and popovers render inside their frame's
  document, so a popover in a frame smaller than itself clips at the
  frame boundary. Rendering outside the frame is cross-origin-impossible
  (and same-origin escapes aren't worth a second rendering path); the
  tiny-frame guard removes the worst of it. Revisit only on a field
  report.
- **Intent handoff at frame edges** is now two-sided by construction:
  the parent sensor's "pointer-into-iframe = pointer gone" rule (PR #12)
  releases the pointer, and the frame's own instance picks it up.
- **Sandboxed opaque-origin frames** and the cross-origin `rootMargin`
  caveat: verify during the live soak; no code contingent on either.

### Verification (live, this session)

- Extension rebuilt and reloaded; test page served on 8917. All four
  fixtures behaved as specified: AI-declared chips rendered inside both
  the same-origin and cross-origin (127.0.0.1) frames by their own
  instances; the srcdoc frame revealed its intent-gated Unknown chip on
  hover and opened the popover with the finalized wording (proving
  `match_origin_as_fallback` injection); the 80×80 frame showed nothing,
  and growing it to 480×420 from the parent revived scanning — the
  chip appeared after the resize with no further interaction. No
  `[TrueOrigin]` console errors.
- The popover-clipping residual was observed as predicted: in the
  260px-tall srcdoc frame the popover's last line sits at the frame
  boundary. Accepted per the residuals above.
- Unit suite (251 tests), typecheck, and Prettier all pass; `content.js`
  is 67 KB.
