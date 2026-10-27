import { readFileSync } from "node:fs";

/**
 * The version this build was released as, read from the package once at
 * start. Every package carries the product version, so this is the number on
 * the release page, not a separate counter that drifts from it.
 */
function readVersion(): string {
  try {
    const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const version = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof version === "string" ? version : "unknown";
  } catch {
    return "unknown";
  }
}

export const VERSION = readVersion();
