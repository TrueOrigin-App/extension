import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSettingsJson } from "./settings";

const PEM = "-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----\n";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildSettingsJson", () => {
  it("passes literal trust values through with the expected verify flags", async () => {
    const json = await buildSettingsJson({
      trustAnchors: PEM,
      trustConfig: "1.3.6.1.5.5.7.3.36",
    });
    const settings = JSON.parse(json);
    expect(settings.trust.trust_anchors).toBe(PEM);
    expect(settings.trust.trust_config).toBe("1.3.6.1.5.5.7.3.36");
    expect(settings.trust.allowed_list).toBeUndefined();
    expect(settings.verify.verify_trust).toBe(true);
    expect(settings.verify.verify_after_reading).toBe(true);
    expect(settings.verify.ocsp_fetch).toBe(false);
    // Remote manifests are fetched deliberately, with disclosure
    // (DECISIONS.md) — and that requires the SDK's network resolvers to be
    // unrestricted, so there must be no allowed_network_hosts block.
    expect(settings.verify.remote_manifest_fetch).toBe(true);
    expect(settings.core).toBeUndefined();
  });

  it("fetches and inlines URL trust values, concatenating arrays", async () => {
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => `${PEM}<from ${url}>`,
    }));
    vi.stubGlobal("fetch", fetchMock);

    const json = await buildSettingsJson({
      trustAnchors: [
        "https://example.test/a.pem",
        "https://example.test/b.pem",
      ],
    });
    const settings = JSON.parse(json);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(settings.trust.trust_anchors).toContain(
      "<from https://example.test/a.pem>",
    );
    expect(settings.trust.trust_anchors).toContain(
      "<from https://example.test/b.pem>",
    );
  });

  it("rejects anchors that resolve to something other than PEM", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => "<html>captive portal</html>",
      })),
    );
    await expect(
      buildSettingsJson({ trustAnchors: "https://example.test/anchors.pem" }),
    ).rejects.toThrow(/PEM/);
  });

  it("rejects failed trust list fetches", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        text: async () => "",
      })),
    );
    await expect(
      buildSettingsJson({ trustAnchors: "https://example.test/anchors.pem" }),
    ).rejects.toThrow(/503/);
  });
});
