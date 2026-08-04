// Maps a validated C2PA manifest store to a pipeline finding. Pure — all
// WASM and network concerns live in the provider; everything here is
// deterministic on the store JSON, which is what the unit tests exercise.
//
// The mapping rules and their rationale are recorded in DECISIONS.md
// (task 3); the taxonomy they serve is plan.md §2.

import type {
  Action,
  Manifest,
  ManifestStore,
  ValidationState,
} from "@contentauth/c2pa-web";
import type { Finding } from "../../core/types";

/** Digital source types treated as a cryptographic AI declaration. Only the
 * unambiguous "trained model" values qualify; procedural values
 * (algorithmicMedia) and human digital art do not, erring toward Unknown. */
export const AI_SOURCE_TYPES: ReadonlySet<string> = new Set([
  "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia",
  "http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia",
]);

/** Digital source types accepted as capture provenance when they appear on
 * the active manifest's creation action. computationalCapture covers modern
 * phone cameras, which still capture light from a real scene. */
export const CAPTURE_SOURCE_TYPES: ReadonlySet<string> = new Set([
  "http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture",
  "http://cv.iptc.org/newscodes/digitalsourcetype/computationalCapture",
]);

export interface C2paDetail {
  reason:
    | "no-c2pa-metadata"
    | "unsupported-format"
    | "invalid-manifest"
    | "ai-source-type"
    | "trusted-capture"
    | "untrusted-capture"
    | "no-origin-declaration";
  validationState?: ValidationState;
  /** Failure codes when the manifest store did not validate. */
  validationFailures?: string[];
  /** Digital source type URIs that triggered the AI finding. */
  aiSourceTypes?: string[];
  /** Capture source type found on the active manifest's creation action. */
  captureSourceType?: string;
  claimGenerator?: string;
  signatureIssuer?: string;
  title?: string;
}

export interface MappedStore {
  finding: Finding;
  detail: C2paDetail;
}

export function mapManifestStore(store: ManifestStore): MappedStore {
  const state = store.validation_state ?? undefined;
  const active = activeManifestOf(store);
  const common = {
    validationState: state,
    claimGenerator: claimGeneratorOf(active),
    signatureIssuer: active?.signature_info?.issuer ?? undefined,
    title: active?.title ?? undefined,
  };

  // Anything short of a validated store proves nothing: a broken signature
  // or hash mismatch means the manifest may not describe these bytes at all,
  // so even an AI assertion inside it is unusable (plan.md §2 — absence of
  // evidence maps to Unknown, never to a claim).
  if (state !== "Valid" && state !== "Trusted") {
    return {
      finding: "none",
      detail: {
        ...common,
        reason: "invalid-manifest",
        validationFailures: failureCodesOf(store),
      },
    };
  }

  // AI declarations are honored anywhere in the validated chain: an AI
  // source type on an ingredient's manifest means AI-derived material is in
  // this content even when the active manifest only records later edits.
  const aiSourceTypes = collectAiSourceTypes(store);
  if (aiSourceTypes.length > 0) {
    return {
      finding: "ai-declared",
      detail: { ...common, reason: "ai-source-type", aiSourceTypes },
    };
  }

  // Capture provenance is only claimed when the *active* manifest is the
  // signed capture itself — if the capture manifest is buried under edit
  // manifests, whether those edits are disqualifying is unknown, and
  // unknown maps to "none". It also requires the Trusted state: anyone can
  // self-sign a manifest that says "digitalCapture", so the claim is only as
  // strong as the signer's presence on the trust list.
  const captureSourceType = captureSourceTypeOf(active);
  if (captureSourceType !== undefined) {
    if (state === "Trusted") {
      return {
        finding: "human-provenance",
        detail: { ...common, reason: "trusted-capture", captureSourceType },
      };
    }
    return {
      finding: "none",
      detail: { ...common, reason: "untrusted-capture", captureSourceType },
    };
  }

  return {
    finding: "none",
    detail: { ...common, reason: "no-origin-declaration" },
  };
}

function activeManifestOf(store: ManifestStore): Manifest | undefined {
  if (!store.active_manifest) return undefined;
  return store.manifests?.[store.active_manifest];
}

function claimGeneratorOf(manifest: Manifest | undefined): string | undefined {
  if (!manifest) return undefined;
  if (manifest.claim_generator) return manifest.claim_generator;
  const info = manifest.claim_generator_info?.[0];
  if (!info) return undefined;
  return info.version ? `${info.name}/${info.version}` : info.name;
}

/** Extracts the actions from a manifest's actions assertion (v1 and v2). */
function actionsOf(manifest: Manifest): Action[] {
  const actions: Action[] = [];
  for (const assertion of manifest.assertions ?? []) {
    if (
      assertion.label !== "c2pa.actions" &&
      !assertion.label.startsWith("c2pa.actions.")
    ) {
      continue;
    }
    const data = assertion.data as { actions?: unknown } | null | undefined;
    if (!data || !Array.isArray(data.actions)) continue;
    for (const action of data.actions) {
      if (action && typeof action === "object") {
        actions.push(action as Action);
      }
    }
  }
  return actions;
}

function collectAiSourceTypes(store: ManifestStore): string[] {
  const found = new Set<string>();
  for (const manifest of Object.values(store.manifests ?? {})) {
    for (const action of actionsOf(manifest)) {
      const sourceType = action.digitalSourceType;
      if (sourceType && AI_SOURCE_TYPES.has(sourceType)) {
        found.add(sourceType);
      }
    }
  }
  return [...found];
}

function captureSourceTypeOf(
  manifest: Manifest | undefined,
): string | undefined {
  if (!manifest) return undefined;
  for (const action of actionsOf(manifest)) {
    if (action.action !== "c2pa.created") continue;
    const sourceType = action.digitalSourceType;
    if (sourceType && CAPTURE_SOURCE_TYPES.has(sourceType)) {
      return sourceType;
    }
  }
  return undefined;
}

function failureCodesOf(store: ManifestStore): string[] {
  const codes = new Set<string>();
  const results = store.validation_results;
  for (const status of results?.activeManifest?.failure ?? []) {
    codes.add(status.code);
  }
  for (const delta of results?.ingredientDeltas ?? []) {
    for (const status of delta.validationDeltas.failure) {
      codes.add(status.code);
    }
  }
  // Legacy stores surface problems via validation_status instead.
  for (const status of store.validation_status ?? []) {
    if (status.success === false) codes.add(status.code);
  }
  return [...codes];
}
