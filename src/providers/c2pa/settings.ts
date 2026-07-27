// Builds the c2pa-rs settings JSON the WASM validator consumes, mirroring
// what c2pa-web's resolveSettings produces: trust-list values given as
// http(s) URLs are fetched and inlined as text, and the result is the
// snake_case shape c2pa-rs deserializes (verified against
// c2pa-rs sdk/src/settings/mod.rs — unknown keys are silently ignored, so
// key names here must match exactly).
//
// Free-tier privacy (plan.md §8, constraint 3): media bytes and page URLs
// never leave the machine. The network requests configured here are (a) the
// global trust-list fetches — cached with a TTL, never per-content — and
// (b) remote manifest fetches, a per-asset request for the manifest URL
// embedded in the asset itself, enabled deliberately and disclosed
// (DECISIONS.md, 2026-07-26 follow-up).

import { cachedFetchText } from "./trust-cache";

export interface TrustListConfig {
  /** PEM text, an http(s) URL to a PEM file, or an array of either. */
  trustAnchors: string | string[];
  /** Trust store config (allowed EKUs): text, URL, or array of either. */
  trustConfig?: string | string[];
  /** End-entity certificate list: PEM text, URL, or array of either. */
  allowedList?: string | string[];
}

/** Trust anchors from two sources, concatenated (verified 2026-07-26; all
 * serve `access-control-allow-origin: *`, so no host permissions needed):
 *
 * - Adobe's Content Credentials known-certificates lists, addressed at
 *   verify.contentauthenticity.org directly (contentcredentials.org 301s
 *   there for anchors.pem/store.cfg but 404s allowed.pem) — the lists the
 *   CR Verify site and c2patool use.
 * - The C2PA conformance program's official trust list and TSA trust list,
 *   published by the standards body itself. These cover conforming
 *   generators Adobe's list lags on (e.g. OpenAI's signer validates as
 *   Trusted only via the conformance list), and the TSA list keeps
 *   timestamped manifests verifiable after signing certs expire. c2pa-rs
 *   validates timestamp certificates against the same trust_anchors store,
 *   so the TSA list is concatenated here rather than configured separately.
 */
export const DEFAULT_TRUST_CONFIG: TrustListConfig = {
  trustAnchors: [
    "https://verify.contentauthenticity.org/trust/anchors.pem",
    "https://raw.githubusercontent.com/c2pa-org/conformance-public/main/trust-list/C2PA-TRUST-LIST.pem",
    "https://raw.githubusercontent.com/c2pa-org/conformance-public/main/trust-list/C2PA-TSA-TRUST-LIST.pem",
  ],
  trustConfig: "https://verify.contentauthenticity.org/trust/store.cfg",
  allowedList: "https://verify.contentauthenticity.org/trust/allowed.pem",
};

/** Same cap c2pa-web applies to trust-list responses. */
const MAX_TRUST_RESPONSE_BYTES = 1024 * 1024;

function isUrl(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}

async function resolveTrustValue(
  value: string | string[],
  options: { requirePem: boolean; label: string },
): Promise<string> {
  const parts = Array.isArray(value) ? value : [value];
  const resolved = await Promise.all(
    parts.map((part) =>
      isUrl(part) ? cachedFetchText(part, MAX_TRUST_RESPONSE_BYTES) : part,
    ),
  );
  // Newline-separated, not bare-concatenated: RFC 7468 requires the
  // BEGIN/END boundaries to stand on their own line, and a source that
  // stopped serving a trailing newline would fuse two boundaries into
  // `-----END CERTIFICATE----------BEGIN CERTIFICATE-----`. rustls_pemfile
  // (under c2pa-rs) skips malformed sections silently, so those anchors
  // would vanish from the trust store with no error — and the requirePem
  // check below would still pass on the other certificates. Blank lines
  // between encapsulated messages are legal, so the extra newline is inert
  // when every source already ends with one (all three do today).
  const joined = resolved.join("\n");
  if (options.requirePem && !joined.includes("-----BEGIN CERTIFICATE-----")) {
    throw new Error(`${options.label} does not contain a PEM certificate`);
  }
  return joined;
}

export async function buildSettingsJson(
  trust: TrustListConfig,
): Promise<string> {
  const [trustAnchors, trustConfig, allowedList] = await Promise.all([
    resolveTrustValue(trust.trustAnchors, {
      requirePem: true,
      label: "trustAnchors",
    }),
    trust.trustConfig === undefined
      ? undefined
      : resolveTrustValue(trust.trustConfig, {
          requirePem: false,
          label: "trustConfig",
        }),
    trust.allowedList === undefined
      ? undefined
      : resolveTrustValue(trust.allowedList, {
          requirePem: true,
          label: "allowedList",
        }),
  ]);

  return JSON.stringify({
    trust: {
      trust_anchors: trustAnchors,
      ...(trustConfig !== undefined && { trust_config: trustConfig }),
      ...(allowedList !== undefined && { allowed_list: allowedList }),
    },
    verify: {
      // Trust verification is REQUIRED by the C2PA spec and is what makes
      // the Trusted validation state (and thus "human-provenance")
      // reachable. These are the c2pa-rs defaults, stated explicitly.
      verify_trust: true,
      verify_after_reading: true,
      // Live OCSP is a per-content request to certificate authorities;
      // staples and CertificateStatus assertions embedded in manifests are
      // still honored without network.
      ocsp_fetch: false,
      // Assets that carry only a manifest URL get that URL fetched — a
      // disclosed per-asset request for the provenance the asset itself
      // points to (DECISIONS.md). Because manifests may live on any host,
      // core.allowed_network_hosts cannot be used as a blanket block here;
      // ocsp_fetch=false is what keeps the SDK's other network path off.
      remote_manifest_fetch: true,
    },
  });
}
