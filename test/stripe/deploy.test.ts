import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url);

describe("website billing deploy", () => {
  it("installs the same pinned Stripe and Supabase versions the functions import", () => {
    const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
    const vercel = JSON.parse(readFileSync(new URL("vercel.json", root), "utf8"));
    expect(pkg.dependencies.stripe).toBe("23.2.0");
    expect(pkg.dependencies["@supabase/supabase-js"]).toBe("2.117.1");
    expect(vercel.installCommand).toContain(`stripe@${pkg.dependencies.stripe}`);
    expect(vercel.installCommand).toContain(`@supabase/supabase-js@${pkg.dependencies["@supabase/supabase-js"]}`);
    expect(vercel.installCommand).not.toBe("echo 'no dependencies to install'");
  });

  it("keeps the functions and their modules in the deployment, and the page scripts self-hosted", () => {
    const ignore = readFileSync(new URL(".vercelignore", root), "utf8");
    for (const blocked of ["api", "site", "api/stripe"]) {
      expect(ignore.split("\n").map((line) => line.trim())).not.toContain(blocked);
    }
    const vercel = JSON.parse(readFileSync(new URL("vercel.json", root), "utf8"));
    const csp = vercel.headers
      .flatMap((entry: { headers: Array<{ key: string; value: string }> }) => entry.headers)
      .find((header: { key: string }) => header.key === "content-security-policy");
    expect(csp.value).toContain("script-src 'self'");
    expect(csp.value).toContain("connect-src 'self'");
    expect(csp.value).not.toContain("js.stripe.com");
  });
});
