import * as esbuild from "esbuild";
import { cp, mkdir } from "node:fs/promises";

const watch = process.argv.includes("--watch");

async function copyStatic() {
  await mkdir("dist", { recursive: true });
  await cp("src/manifest.json", "dist/manifest.json");
  // The C2PA validator binary ships inside the extension package and is
  // loaded via chrome.runtime.getURL("c2pa_bg.wasm") — never fetched from a
  // CDN at runtime (plan.md §8, task 3).
  await cp(
    "node_modules/@contentauth/c2pa-wasm/pkg/c2pa_bg.wasm",
    "dist/c2pa_bg.wasm",
  );
}

/** @type {import("esbuild").BuildOptions} */
const common = {
  bundle: true,
  target: "es2022",
  outdir: "dist",
  sourcemap: watch ? "inline" : false,
  logLevel: "info",
};

/** One build per extension context: the service worker is a module, but
 * content scripts are injected as classic scripts and must not leak
 * bindings into page scope — hence IIFE. */
const builds = [
  {
    ...common,
    entryPoints: { background: "src/background/index.ts" },
    format: "esm",
  },
  {
    ...common,
    entryPoints: { content: "src/content/index.ts" },
    format: "iife",
  },
];

if (watch) {
  for (const [index, options] of builds.entries()) {
    const ctx = await esbuild.context({
      ...options,
      plugins:
        index === 0
          ? [{ name: "copy-static", setup: (b) => b.onEnd(copyStatic) }]
          : [],
    });
    await ctx.watch();
  }
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
  await copyStatic();
}
