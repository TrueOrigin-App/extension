import { describe, expect, it } from "vitest";
import manifest from "./manifest.json";

describe("manifest", () => {
  it("is Manifest V3", () => {
    expect(manifest.manifest_version).toBe(3);
  });

  it("declares a module service worker", () => {
    expect(manifest.background.service_worker).toBe("background.js");
    expect(manifest.background.type).toBe("module");
  });

  // Permissions require asking before adding (plan.md §8). None have been
  // approved yet, so the manifest must not request any.
  it("requests no permissions", () => {
    expect(manifest).not.toHaveProperty("permissions");
    expect(manifest).not.toHaveProperty("host_permissions");
  });

  // Owner-approved scope (task 4): the content script runs on the localhost
  // test page only. Broadening this is a new §8 ask — task 5 is expected to
  // bring it, together with host_permissions, as an explicit proposal.
  it("registers the content script for localhost only", () => {
    expect(manifest.content_scripts).toEqual([
      {
        matches: ["http://localhost/*", "http://127.0.0.1/*"],
        js: ["content.js"],
      },
    ]);
  });

  // 'wasm-unsafe-eval' is what lets the service worker instantiate the
  // bundled C2PA validator; it is a CSP source, not a permission.
  it("allows WASM instantiation in extension contexts", () => {
    expect(manifest.content_security_policy.extension_pages).toContain(
      "'wasm-unsafe-eval'",
    );
    expect(manifest.content_security_policy.extension_pages).toContain(
      "script-src 'self'",
    );
  });
});
