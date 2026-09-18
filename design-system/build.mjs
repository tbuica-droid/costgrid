/*
 * esbuild bundles the library to dist/index.js and collects every component's
 * imported CSS into dist/index.css.
 *
 * tokens.css is also copied out on its own. That copy is what the product's
 * dashboard loads: it is plain CSS custom properties with no React anywhere
 * near it, so the same palette and type scale reach a vanilla page without
 * the dashboard taking on a build step it does not want.
 *
 * React stays external so Claude Design's bundle provides its own copy.
 */
import esbuild from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";

await esbuild.build({
  entryPoints: ["src/index.ts"],
  outdir: "dist",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2020"],
  jsx: "automatic",
  sourcemap: true,
  external: ["react", "react-dom", "react/jsx-runtime"],
  loader: { ".css": "css" },
  logLevel: "info",
});

mkdirSync("dist", { recursive: true });
copyFileSync("src/tokens.css", "dist/tokens.css");

console.log("built dist/index.js, dist/index.css and dist/tokens.css");
