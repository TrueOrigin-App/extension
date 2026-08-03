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

  // Permissions require asking before adding (plan.md §8). Owner-approved so
  // far (task 5.1): broad host access via content_scripts matches and
  // host_permissions, both http/https only. Nothing under `permissions` has
  // been approved.
  it("requests no API permissions", () => {
    expect(manifest).not.toHaveProperty("permissions");
    expect(manifest).not.toHaveProperty("optional_permissions");
    expect(manifest).not.toHaveProperty("optional_host_permissions");
  });

  // Owner-approved scope (task 5.1 ask): broad static access on http/https —
  // deliberately not <all_urls> (no file:/ftp: schemes). Changing this scope
  // in either direction is a new §8 ask.
  it("registers the content script for all http(s) pages", () => {
    expect(manifest.content_scripts).toEqual([
      {
        matches: ["http://*/*", "https://*/*"],
        js: ["content.js"],
      },
    ]);
  });

  it("holds host permissions matching the content-script scope", () => {
    expect(manifest.host_permissions).toEqual(["http://*/*", "https://*/*"]);
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
