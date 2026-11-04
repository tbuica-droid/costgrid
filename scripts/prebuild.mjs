/*
 * Run before `tsc --build`. A package whose build info survives without its
 * dist/ (a CI cache restores the one but not the other, or someone deleted
 * dist/ by hand) makes tsc believe the missing files are already written: it
 * rebuilds only what changed and leaves dist/ incomplete. Deleting that build
 * info makes tsc rebuild the package in full.
 */
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

for (const name of readdirSync("packages")) {
  const info = join("packages", name, "tsconfig.tsbuildinfo");
  if (existsSync(info) && !existsSync(join("packages", name, "dist"))) {
    rmSync(info);
    console.log(`rebuilding ${name} in full: its dist/ was missing`);
  }
}
