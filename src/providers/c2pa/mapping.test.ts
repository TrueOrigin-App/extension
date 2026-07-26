import type { Action, ManifestStore } from "@contentauth/c2pa-web";
import { describe, expect, it } from "vitest";
import { mapManifestStore } from "./mapping";

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
