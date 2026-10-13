import { cp, mkdir, rm } from "node:fs/promises";
import process from "node:process";
import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const production = process.env.NODE_ENV === "production";

const options = {
  entryPoints: ["src/background.ts", "src/popup.ts", "src/options.ts"],
  outdir: "dist",
  bundle: true,
  format: "iife",
  target: ["chrome121", "firefox128"],
  sourcemap: !production,
  minify: false,
  logLevel: "info",
};

async function copyStatic() {
  await mkdir("dist", { recursive: true });
  await cp("static", "dist", { recursive: true });
}

async function main() {
  if (!watch) {
    await rm("dist", { recursive: true, force: true });
    await copyStatic();
    await esbuild.build(options);
    return;
  }
  await copyStatic();
  const ctx = await esbuild.context(options);
  await ctx.watch();
}

await main();
