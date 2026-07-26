import * as esbuild from "esbuild";
import { cp, mkdir } from "node:fs/promises";

const watch = process.argv.includes("--watch");

async function copyStatic() {
  await mkdir("dist", { recursive: true });
  await cp("src/manifest.json", "dist/manifest.json");
}

/** @type {import("esbuild").BuildOptions} */
const options = {
  entryPoints: { background: "src/background/index.ts" },
  bundle: true,
  format: "esm",
  target: "es2022",
  outdir: "dist",
  sourcemap: watch ? "inline" : false,
  logLevel: "info",
};

if (watch) {
  const ctx = await esbuild.context({
    ...options,
    plugins: [
      {
        name: "copy-static",
        setup(build) {
          build.onEnd(copyStatic);
        },
      },
    ],
  });
  await ctx.watch();
} else {
  await esbuild.build(options);
  await copyStatic();
}
