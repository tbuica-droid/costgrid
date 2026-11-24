import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url);

describe("website billing deploy", () => {
  it("gives the functions their own package, pinned to the same versions", () => {
    const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
    const api = JSON.parse(readFileSync(new URL("api/package.json", root), "utf8"));
    const vercel = JSON.parse(readFileSync(new URL("vercel.json", root), "utf8"));
    expect(pkg.dependencies.stripe).toBe("23.2.0");
    expect(api.dependencies).toEqual(pkg.dependencies);
    expect(api.engines.node).toBe("22.x");
    expect(vercel.installCommand.length).toBeLessThanOrEqual(256);
    expect(vercel.installCommand).toBe("sh scripts/vercel-install.sh");
    const script = readFileSync(new URL("scripts/vercel-install.sh", root), "utf8");
    expect(script).toContain(`stripe@${pkg.dependencies.stripe}`);
    expect(script).toContain(`@supabase/supabase-js@${pkg.dependencies["@supabase/supabase-js"]}`);
    expect(vercel.functions).toBeUndefined();
  });

  it("keeps the functions and their modules in the deployment, and the page scripts self-hosted", () => {
    const ignore = readFileSync(new URL(".vercelignore", root), "utf8")
      .split("\n")
      .map((line) => line.trim());
    for (const blocked of ["api", "site", "api/stripe", "api/package.json"]) {
      expect(ignore).not.toContain(blocked);
    }
    // A bare "package.json" would also hide api/package.json from the upload.
    expect(ignore).toContain("/package.json");
    expect(ignore).not.toContain("package.json");
    const vercel = JSON.parse(readFileSync(new URL("vercel.json", root), "utf8"));
    const csp = vercel.headers
      .flatMap((entry: { headers: Array<{ key: string; value: string }> }) => entry.headers)
      .find((header: { key: string }) => header.key === "content-security-policy");
    expect(csp.value).toContain("script-src 'self'");
    expect(csp.value).toContain("connect-src 'self'");
    expect(csp.value).not.toContain("js.stripe.com");
  });
});
