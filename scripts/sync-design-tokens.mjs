/*
 * Copy the design system's tokens into the dashboard's stylesheet.
 *
 * The dashboard is vanilla CSS served from inside a customer's network, so it
 * cannot import from a package at runtime. Inlining is the honest fix; the
 * risk it creates is drift, which this script exists to remove. Run it after
 * changing tokens, and CI fails if the two are out of step.
 */
import { readFileSync, writeFileSync } from "node:fs";

const TOKENS = "design-system/src/tokens.css";
const TARGETS = ["packages/gateway/web/styles.css", "demo/styles.css"];
const BEGIN = "/* --- BEGIN generated tokens, do not edit ------------------------------- */";
const END = "/* --- END generated tokens ---------------------------------------------- */";

const tokens = readFileSync(TOKENS, "utf8");
const check = process.argv.includes("--check");
let drifted = false;

for (const target of TARGETS) {
  const css = readFileSync(target, "utf8");
  const a = css.indexOf(BEGIN);
  const b = css.indexOf(END);
  if (a === -1 || b === -1) {
    console.error(`${target}: no generated token block found`);
    process.exitCode = 1;
    continue;
  }

  const next = `${css.slice(0, a)}${BEGIN}\n${tokens}${css.slice(b)}`;
  if (next === css) continue;

  if (check) {
    console.error(`${target} is out of date. Run: npm run sync-design-tokens`);
    drifted = true;
  } else {
    writeFileSync(target, next);
    console.log(`updated ${target}`);
  }
}

if (drifted) process.exitCode = 1;
else if (check) console.log("design tokens are in sync");
