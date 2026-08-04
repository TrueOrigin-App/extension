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
