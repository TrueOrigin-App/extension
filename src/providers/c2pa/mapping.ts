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
  ValidationResults,
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

/** Confidence for an AI declaration whose only defect is an expired
 * signing credential (owner decision, 2026-08-04 — see DECISIONS.md).
 * High, because the content hashes verify (these are provably the bytes
 * the AI provider signed); short of 1, because without a trusted
 * timestamp the signing time is unprovable, so the cryptographic
 * certainty "ai-declared" promises is unavailable. Clears
 * AI_LIKELY_MIN_CONFIDENCE (0.7), so the verdict reads "AI — likely". */
export const EXPIRED_AI_DECLARATION_CONFIDENCE = 0.9;

/** Failure codes the expired-AI-declaration rule tolerates: cert-status
 * codes that say nothing about content integrity. Expiry must be present
 * (the rule is about expiry); untrusted may ride along (see the rule's
 * comment). Nothing else — not revocation, not hash or assertion
 * failures. */
const EXPIRY_TOLERATED_FAILURES: ReadonlySet<string> = new Set([
  "signingCredential.expired",
  "signingCredential.untrusted",
]);

export interface C2paDetail {
  reason:
    | "no-c2pa-metadata"
    | "unsupported-format"
    | "invalid-manifest"
    | "expired-ai-declaration"
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
  /** 0–1; cryptographic findings pin to 1, "none" to 0, the expired-cert
   * AI declaration to EXPIRED_AI_DECLARATION_CONFIDENCE. */
  confidence: number;
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
    const validationFailures = failureCodesOf(store);
    // One narrow exception (owner decision, 2026-08-04): an AI declaration
    // whose failures, everywhere in the store, are only cert-status codes
    // with expiry among them. The content hashes verified, so these are
    // provably the bytes the declarer signed; what's missing is proof the
    // signature predates the cert's expiry (no trusted timestamp — an
    // attacker with a leaked expired cert could backdate). That is exactly
    // a probabilistic "ai-indicated", never the cryptographic
    // "ai-declared". An untrusted signer rides along because the
    // Valid-state policy already accepts AI declarations from untrusted
    // signers at full strength — it cannot be what blocks the weaker
    // finding. Revocation is deliberately NOT tolerated (a revoked cert is
    // the leaked-cert scenario itself), and neither is any content
    // failure. Deliberately asymmetric (§2): an expired *capture* claim
    // stays invalid-manifest → none — forging "human" is the attack that
    // matters, and it gets no such forgiveness.
    const expiredAiSourceTypes = collectAiSourceTypes(store);
    if (
      state === "Invalid" &&
      expiredAiSourceTypes.length > 0 &&
      validationFailures.includes("signingCredential.expired") &&
      validationFailures.every((code) => EXPIRY_TOLERATED_FAILURES.has(code))
    ) {
      return {
        finding: "ai-indicated",
        confidence: EXPIRED_AI_DECLARATION_CONFIDENCE,
        detail: {
          ...common,
          reason: "expired-ai-declaration",
          aiSourceTypes: expiredAiSourceTypes,
          validationFailures,
        },
      };
    }
    return {
      finding: "none",
      confidence: 0,
      detail: {
        ...common,
        reason: "invalid-manifest",
        validationFailures,
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
      confidence: 1,
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
        confidence: 1,
        detail: { ...common, reason: "trusted-capture", captureSourceType },
      };
    }
    return {
      finding: "none",
      confidence: 0,
      detail: { ...common, reason: "untrusted-capture", captureSourceType },
    };
  }

  return {
    finding: "none",
    confidence: 0,
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
  addResultCodes(store.validation_results, codes);
  // Legacy stores surface problems via validation_status instead.
  addStatusCodes(store.validation_status, codes);
  // The store-level results cover the active manifest plus *deltas* since
  // ingredient time — a failure already recorded when an ingredient was
  // consumed (e.g. its hashes never verified) appears only on the
  // ingredient entry itself, and must count: the expired-cert exception
  // below gates on there being no failure anywhere in the store beyond
  // the tolerated cert-status codes.
  for (const manifest of Object.values(store.manifests ?? {})) {
    for (const ingredient of manifest.ingredients ?? []) {
      addResultCodes(ingredient.validation_results, codes);
      addStatusCodes(ingredient.validation_status, codes);
    }
  }
  return [...codes];
}

function addResultCodes(
  results: ValidationResults | null | undefined,
  codes: Set<string>,
): void {
  for (const status of results?.activeManifest?.failure ?? []) {
    codes.add(status.code);
  }
  for (const delta of results?.ingredientDeltas ?? []) {
    for (const status of delta.validationDeltas.failure) {
      codes.add(status.code);
    }
  }
}

function addStatusCodes(
  statuses: { code: string; success?: boolean | null }[] | null | undefined,
  codes: Set<string>,
): void {
  for (const status of statuses ?? []) {
    if (status.success === false) codes.add(status.code);
  }
}
