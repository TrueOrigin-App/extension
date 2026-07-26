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
  it("requests no permissions at the scaffold stage", () => {
    expect(manifest).not.toHaveProperty("permissions");
    expect(manifest).not.toHaveProperty("host_permissions");
    expect(manifest).not.toHaveProperty("content_scripts");
  });
});
