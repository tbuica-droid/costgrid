import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findUpdate, installBucket, isNewer, rolloutPercent } from "../src/update-check.js";

const release = (over: Record<string, unknown> = {}) =>
  (async () =>
    new Response(
      JSON.stringify({
        tag_name: "v2.1.0",
        html_url: "https://github.com/tbuica-droid/costgrid-releases/releases/tag/v2.1.0",
        body: "Fixes.",
        draft: false,
        prerelease: false,
        ...over,
      }),
    )) as unknown as typeof fetch;

describe("update check", () => {
  it("compares plain versions, and ignores anything else", () => {
    expect(isNewer("v2.1.0", "2.0.0")).toBe(true);
    expect(isNewer("2.0.10", "2.0.9")).toBe(true);
    expect(isNewer("v2.0.0", "2.0.0")).toBe(false);
    expect(isNewer("v1.9.9", "2.0.0")).toBe(false);
    expect(isNewer("v3.0.0-beta.1", "2.0.0")).toBe(false);
  });

  it("reads a rollout share from the release notes", () => {
    expect(rolloutPercent("Fixes.\nrollout: 25%\n")).toBe(25);
    expect(rolloutPercent("Fixes.")).toBe(100);
    expect(rolloutPercent("rollout: 400%")).toBe(100);
  });

  it("keeps the same bucket for an install", () => {
    const dir = mkdtempSync(join(tmpdir(), "cg-update-"));
    try {
      const file = join(dir, "install-id");
      const first = installBucket(file);
      expect(first).toBeGreaterThanOrEqual(0);
      expect(first).toBeLessThan(100);
      expect(installBucket(file)).toBe(first);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("announces a newer release to installs inside its rollout only", async () => {
    expect(await findUpdate("2.0.0", 10, release())).toEqual({
      version: "2.1.0",
      url: "https://github.com/tbuica-droid/costgrid-releases/releases/tag/v2.1.0",
    });
    expect(await findUpdate("2.0.0", 10, release({ body: "rollout: 20%" }))).toBeDefined();
    expect(await findUpdate("2.0.0", 30, release({ body: "rollout: 20%" }))).toBeUndefined();
  });

  it("stays quiet for drafts, pre-releases, odd links, failures and the current version", async () => {
    expect(await findUpdate("2.0.0", 0, release({ draft: true }))).toBeUndefined();
    expect(await findUpdate("2.0.0", 0, release({ prerelease: true }))).toBeUndefined();
    expect(await findUpdate("2.0.0", 0, release({ html_url: "https://evil.example/x" }))).toBeUndefined();
    expect(await findUpdate("2.1.0", 0, release())).toBeUndefined();
    const broken = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await findUpdate("2.0.0", 0, broken)).toBeUndefined();
  });
});
