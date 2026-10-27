import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Tells someone a newer CostGrid is out, and where to get it.
 *
 * Not an auto-updater: installing an update on a Mac needs the app signed
 * with an Apple Developer ID, and this one is ad-hoc signed. So it asks
 * GitHub for the newest published release of costgrid-releases and, when it
 * is newer than this one, shows a notification that opens the release page.
 *
 * The request is a plain read of a public page. Nothing about this computer,
 * its data or its use is sent; GitHub sees an address, as it would for anyone
 * visiting the download page. COSTGRID_UPDATE_CHECK=false turns it off.
 *
 * Staged rollout: a release whose notes contain a line like `rollout: 25%`
 * is announced to that share of installs only, picked by a random id this
 * install keeps, so the same install stays in or out as the share grows.
 */

export const LATEST_RELEASE_URL = "https://api.github.com/repos/tbuica-droid/costgrid-releases/releases/latest";

export interface AvailableUpdate {
  readonly version: string;
  readonly url: string;
}

/** `v2.1.0` → [2, 1, 0]; undefined for anything that isn't plain x.y.z. */
function parse(version: string): [number, number, number] | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

/** Whether `candidate` is a later release than `current`. Pre-releases and odd tags never are. */
export function isNewer(candidate: string, current: string): boolean {
  const a = parse(candidate);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}

/** The share of installs a release is for, from a `rollout: N%` line in its notes; 100 without one. */
export function rolloutPercent(notes: string): number {
  const m = /^\s*rollout:\s*(\d{1,3})\s*%\s*$/im.exec(notes);
  return m ? Math.min(100, Number(m[1])) : 100;
}

/** This install's place, 0–99, in every rollout. Stable, because the id is kept. */
export function installBucket(idFile: string): number {
  let id: string;
  try {
    id = readFileSync(idFile, "utf8").trim();
  } catch {
    id = "";
  }
  if (id === "") {
    id = randomUUID();
    try {
      mkdirSync(dirname(idFile), { recursive: true });
      writeFileSync(idFile, id);
    } catch {
      // Unsaved, the install gets a fresh place next time; harmless.
    }
  }
  return createHash("sha256").update(id).digest().readUInt32BE(0) % 100;
}

/** The newer release this install should hear about, if any. Never throws. */
export async function findUpdate(
  current: string,
  bucket: number,
  fetchImpl: typeof fetch = fetch,
): Promise<AvailableUpdate | undefined> {
  try {
    const response = await fetchImpl(LATEST_RELEASE_URL, {
      headers: { accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return undefined;
    const release = (await response.json()) as Record<string, unknown>;
    const tag = typeof release["tag_name"] === "string" ? release["tag_name"] : "";
    const url = typeof release["html_url"] === "string" ? release["html_url"] : "";
    const notes = typeof release["body"] === "string" ? release["body"] : "";
    if (release["draft"] === true || release["prerelease"] === true) return undefined;
    if (!url.startsWith("https://github.com/")) return undefined;
    if (!isNewer(tag, current)) return undefined;
    if (bucket >= rolloutPercent(notes)) return undefined;
    return { version: tag.replace(/^v/, ""), url };
  } catch {
    return undefined;
  }
}
