import type { Action, ManifestStore } from "@contentauth/c2pa-web";
import { describe, expect, it } from "vitest";
import { EXPIRED_AI_DECLARATION_CONFIDENCE, mapManifestStore } from "./mapping";

const DST = {
  aiCreated:
    "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia",
  aiComposite:
    "http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia",
  capture: "http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture",
  computational:
    "http://cv.iptc.org/newscodes/digitalsourcetype/computationalCapture",
  digitalArt: "http://cv.iptc.org/newscodes/digitalsourcetype/digitalArt",
  algorithmic:
    "http://cv.iptc.org/newscodes/digitalsourcetype/algorithmicMedia",
};

interface ManifestSpec {
  label: string;
  actions?: Action[];
  actionsLabel?: string;
}

function store(options: {
  state?: ManifestStore["validation_state"];
  manifests?: ManifestSpec[];
  active?: string;
  failureCodes?: string[];
}): ManifestStore {
  const specs = options.manifests ?? [{ label: "m1", actions: [] }];
  const manifests: NonNullable<ManifestStore["manifests"]> = {};
  for (const spec of specs) {
    manifests[spec.label] = {
      claim_generator: "test-generator/1.0",
      title: "test.jpg",
      signature_info: { issuer: "Test Issuer" },
      assertions: [
        {
          label: spec.actionsLabel ?? "c2pa.actions.v2",
          data: { actions: spec.actions ?? [] },
        },
      ],
    };
  }
  return {
    active_manifest: options.active ?? specs[0]?.label,
    manifests,
    validation_state: options.state === undefined ? "Trusted" : options.state,
    validation_results: {
      activeManifest: {
        success: [],
        informational: [],
        failure: (options.failureCodes ?? []).map((code) => ({ code })),
      },
    },
  };
}

describe("mapManifestStore", () => {
  it("maps a trusted AI creation to ai-declared", () => {
    const result = mapManifestStore(
      store({
        manifests: [
          {
            label: "m1",
            actions: [
              { action: "c2pa.created", digitalSourceType: DST.aiCreated },
            ],
          },
        ],
      }),
    );
    expect(result.finding).toBe("ai-declared");
    expect(result.detail.reason).toBe("ai-source-type");
    expect(result.detail.aiSourceTypes).toEqual([DST.aiCreated]);
  });

  it("accepts AI declarations from merely Valid (untrusted) manifests", () => {
    const result = mapManifestStore(
      store({
        state: "Valid",
        manifests: [
          {
            label: "m1",
            actions: [
              { action: "c2pa.created", digitalSourceType: DST.aiCreated },
            ],
          },
        ],
      }),
    );
    expect(result.finding).toBe("ai-declared");
    expect(result.detail.validationState).toBe("Valid");
  });

  it("maps an AI composite on an edit action to ai-declared", () => {
    const result = mapManifestStore(
      store({
        manifests: [
          {
            label: "m1",
            actions: [
              { action: "c2pa.created", digitalSourceType: DST.digitalArt },
              { action: "c2pa.edited", digitalSourceType: DST.aiComposite },
            ],
          },
        ],
      }),
    );
    expect(result.finding).toBe("ai-declared");
  });

  it("honors AI declarations from ingredient manifests in the chain", () => {
    const result = mapManifestStore(
      store({
        active: "edit",
        manifests: [
          { label: "edit", actions: [{ action: "c2pa.opened" }] },
          {
            label: "ingredient",
            actions: [
              { action: "c2pa.created", digitalSourceType: DST.aiCreated },
            ],
          },
        ],
      }),
    );
    expect(result.finding).toBe("ai-declared");
  });

  it("reads v1 actions assertions too", () => {
    const result = mapManifestStore(
      store({
        manifests: [
          {
            label: "m1",
            actionsLabel: "c2pa.actions",
            actions: [
              { action: "c2pa.created", digitalSourceType: DST.aiCreated },
            ],
          },
        ],
      }),
    );
    expect(result.finding).toBe("ai-declared");
  });

  it("maps a trusted capture creation to human-provenance", () => {
    const result = mapManifestStore(
      store({
        manifests: [
          {
            label: "m1",
            actions: [
              { action: "c2pa.created", digitalSourceType: DST.capture },
            ],
          },
        ],
      }),
    );
    expect(result.finding).toBe("human-provenance");
    expect(result.detail.reason).toBe("trusted-capture");
    expect(result.detail.captureSourceType).toBe(DST.capture);
  });

  it("accepts computational capture as capture provenance", () => {
    const result = mapManifestStore(
      store({
        manifests: [
          {
            label: "m1",
            actions: [
              { action: "c2pa.created", digitalSourceType: DST.computational },
            ],
          },
        ],
      }),
    );
    expect(result.finding).toBe("human-provenance");
  });

  it("never claims human-provenance without the Trusted state", () => {
    const result = mapManifestStore(
      store({
        state: "Valid",
        manifests: [
          {
            label: "m1",
            actions: [
              { action: "c2pa.created", digitalSourceType: DST.capture },
            ],
          },
        ],
      }),
    );
    expect(result.finding).toBe("none");
    expect(result.detail.reason).toBe("untrusted-capture");
  });

  it("does not claim capture when the capture manifest is buried under edits", () => {
    const result = mapManifestStore(
      store({
        active: "edit",
        manifests: [
          { label: "edit", actions: [{ action: "c2pa.opened" }] },
          {
            label: "camera",
            actions: [
              { action: "c2pa.created", digitalSourceType: DST.capture },
            ],
          },
        ],
      }),
    );
    expect(result.finding).toBe("none");
    expect(result.detail.reason).toBe("no-origin-declaration");
  });

  it("lets an AI declaration disqualify a capture in the same store", () => {
    const result = mapManifestStore(
      store({
        manifests: [
          {
            label: "m1",
            actions: [
              { action: "c2pa.created", digitalSourceType: DST.capture },
              { action: "c2pa.edited", digitalSourceType: DST.aiComposite },
            ],
          },
        ],
      }),
    );
    expect(result.finding).toBe("ai-declared");
  });

  it("treats non-AI, non-capture source types as no declaration", () => {
    for (const digitalSourceType of [DST.digitalArt, DST.algorithmic]) {
      const result = mapManifestStore(
        store({
          manifests: [
            {
              label: "m1",
              actions: [{ action: "c2pa.created", digitalSourceType }],
            },
          ],
        }),
      );
      expect(result.finding).toBe("none");
      expect(result.detail.reason).toBe("no-origin-declaration");
    }
  });

  it("maps a capture source type on a non-creation action to none", () => {
    const result = mapManifestStore(
      store({
        manifests: [
          {
            label: "m1",
            actions: [
              { action: "c2pa.opened", digitalSourceType: DST.capture },
            ],
          },
        ],
      }),
    );
    expect(result.finding).toBe("none");
  });

  it("maps an Invalid store to none even when it declares AI", () => {
    const result = mapManifestStore(
      store({
        state: "Invalid",
        failureCodes: ["assertion.dataHash.mismatch"],
        manifests: [
          {
            label: "m1",
            actions: [
              { action: "c2pa.created", digitalSourceType: DST.aiCreated },
            ],
          },
        ],
      }),
    );
    expect(result.finding).toBe("none");
    expect(result.detail.reason).toBe("invalid-manifest");
    expect(result.detail.validationFailures).toEqual([
      "assertion.dataHash.mismatch",
    ]);
  });

  it("treats a missing validation state as unusable", () => {
    const result = mapManifestStore(store({ state: null }));
    expect(result.finding).toBe("none");
    expect(result.detail.reason).toBe("invalid-manifest");
  });

  it("maps an AI declaration whose only defect is an expired cert to ai-indicated", () => {
    // Owner decision 2026-08-04: content hashes verified, chain otherwise
    // fine, but the signing cert expired with no trusted timestamp — the
    // declaration is real yet its timing is unprovable, so it is
    // probabilistic (verdict "AI — likely"), never "ai-declared".
    const result = mapManifestStore(
      store({
        state: "Invalid",
        failureCodes: ["signingCredential.expired"],
        manifests: [
          {
            label: "m1",
            actions: [
              { action: "c2pa.created", digitalSourceType: DST.aiCreated },
            ],
          },
        ],
      }),
    );
    expect(result.finding).toBe("ai-indicated");
    expect(result.confidence).toBe(EXPIRED_AI_DECLARATION_CONFIDENCE);
    expect(result.detail.reason).toBe("expired-ai-declaration");
    expect(result.detail.aiSourceTypes).toEqual([DST.aiCreated]);
    expect(result.detail.validationFailures).toEqual([
      "signingCredential.expired",
    ]);
  });

  it("tolerates an untrusted signer alongside the expired cert", () => {
    // Untrusted signers already pass the accept-AI-at-Valid policy at
    // full ai-declared strength, so untrusted cannot be what blocks the
    // strictly weaker ai-indicated.
    const result = mapManifestStore(
      store({
        state: "Invalid",
        failureCodes: [
          "signingCredential.expired",
          "signingCredential.untrusted",
        ],
        manifests: [
          {
            label: "m1",
            actions: [
              { action: "c2pa.created", digitalSourceType: DST.aiCreated },
            ],
          },
        ],
      }),
    );
    expect(result.finding).toBe("ai-indicated");
    expect(result.detail.reason).toBe("expired-ai-declaration");
  });

  it("requires expiry itself — untrusted alone stays invalid-manifest", () => {
    const result = mapManifestStore(
      store({
        state: "Invalid",
        failureCodes: ["signingCredential.untrusted"],
        manifests: [
          {
            label: "m1",
            actions: [
              { action: "c2pa.created", digitalSourceType: DST.aiCreated },
            ],
          },
        ],
      }),
    );
    expect(result.finding).toBe("none");
    expect(result.detail.reason).toBe("invalid-manifest");
  });

  it("gives a revoked cert no forgiveness even with expiry present", () => {
    // Revocation is the leaked-cert scenario itself — the exact attack
    // the timestamp caveat worries about.
    const result = mapManifestStore(
      store({
        state: "Invalid",
        failureCodes: [
          "signingCredential.expired",
          "signingCredential.revoked",
        ],
        manifests: [
          {
            label: "m1",
            actions: [
              { action: "c2pa.created", digitalSourceType: DST.aiCreated },
            ],
          },
        ],
      }),
    );
    expect(result.finding).toBe("none");
    expect(result.detail.reason).toBe("invalid-manifest");
  });

  it("keeps invalid-manifest when an expired cert is joined by any other failure", () => {
    const result = mapManifestStore(
      store({
        state: "Invalid",
        failureCodes: [
          "signingCredential.expired",
          "assertion.dataHash.mismatch",
        ],
        manifests: [
          {
            label: "m1",
            actions: [
              { action: "c2pa.created", digitalSourceType: DST.aiCreated },
            ],
          },
        ],
      }),
    );
    expect(result.finding).toBe("none");
    expect(result.detail.reason).toBe("invalid-manifest");
  });

  it("gives an expired capture claim no forgiveness (asymmetry, §2)", () => {
    // Self-signing a "camera" manifest with a leaked expired cert is the
    // attack on "Human — verified"; only AI declarations — statements
    // against interest — get the probabilistic reading.
    const result = mapManifestStore(
      store({
        state: "Invalid",
        failureCodes: ["signingCredential.expired"],
        manifests: [
          {
            label: "m1",
            actions: [
              { action: "c2pa.created", digitalSourceType: DST.capture },
            ],
          },
        ],
      }),
    );
    expect(result.finding).toBe("none");
    expect(result.detail.reason).toBe("invalid-manifest");
  });

  it("keeps invalid-manifest for an expired cert with no AI declaration", () => {
    const result = mapManifestStore(
      store({
        state: "Invalid",
        failureCodes: ["signingCredential.expired"],
        manifests: [{ label: "m1", actions: [{ action: "c2pa.created" }] }],
      }),
    );
    expect(result.finding).toBe("none");
    expect(result.detail.reason).toBe("invalid-manifest");
  });

  it("maps a validated store with no origin declaration to none", () => {
    const result = mapManifestStore(
      store({
        manifests: [{ label: "m1", actions: [{ action: "c2pa.created" }] }],
      }),
    );
    expect(result.finding).toBe("none");
    expect(result.detail.reason).toBe("no-origin-declaration");
    expect(result.detail.claimGenerator).toBe("test-generator/1.0");
    expect(result.detail.signatureIssuer).toBe("Test Issuer");
  });
});
