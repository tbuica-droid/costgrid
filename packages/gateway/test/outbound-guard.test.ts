import { describe, expect, it } from "vitest";
import { assertPublicUrl, guardedFetch, isPublicAddress } from "../src/outbound-guard.js";

const resolvesTo =
  (...addresses: string[]) =>
  async () =>
    addresses.map((address) => ({ address }));

describe("which addresses count as the public internet", () => {
  it("refuses private, loopback, link-local and other internal ranges", () => {
    for (const ip of [
      "10.0.0.1", "127.0.0.1", "0.0.0.0", "100.64.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255",
      "192.168.1.1", "192.0.0.8", "198.18.0.1", "224.0.0.1", "255.255.255.255",
      "::", "::1", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1", "::ffff:10.0.0.1", "::ffff:127.0.0.1", "64:ff9b::a00:1",
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });

  it("allows public addresses, including ones next to private ranges", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "172.15.255.255", "100.128.0.1", "2606:4700::1111", "::ffff:8.8.8.8"]) {
      expect(isPublicAddress(ip), ip).toBe(true);
    }
  });

  it("refuses anything that is not an address", () => {
    expect(isPublicAddress("example.com")).toBe(false);
  });
});

describe("checking a URL before calling it", () => {
  it("passes a name that resolves only to public addresses", async () => {
    await expect(assertPublicUrl("https://idp.example.com/x", resolvesTo("93.184.216.34"))).resolves.toBeUndefined();
  });

  it("refuses a name with any private answer, a private literal, or plain http", async () => {
    await expect(assertPublicUrl("https://sneaky.example.com", resolvesTo("93.184.216.34", "10.0.0.5"))).rejects.toThrow(
      /not a public internet address/,
    );
    await expect(assertPublicUrl("https://[::1]:8443/", resolvesTo())).rejects.toThrow(/not a public/);
    await expect(assertPublicUrl("https://127.0.0.1/", resolvesTo())).rejects.toThrow(/not a public/);
    await expect(assertPublicUrl("http://idp.example.com", resolvesTo("93.184.216.34"))).rejects.toThrow(/must be https/);
  });

  it("refuses a name that resolves to nothing", async () => {
    await expect(assertPublicUrl("https://nowhere.example.com", resolvesTo())).rejects.toThrow(/not a public/);
  });
});

describe("the guarded fetch", () => {
  it("checks first, refuses redirects, and sets a deadline", async () => {
    let seen: RequestInit | undefined;
    const base = (async (_url: unknown, init?: RequestInit) => {
      seen = init;
      return new Response("ok");
    }) as unknown as typeof fetch;
    const guarded = guardedFetch(base, resolvesTo("93.184.216.34"));
    await guarded("https://idp.example.com/.well-known/openid-configuration");
    expect(seen?.redirect).toBe("error");
    expect(seen?.signal).toBeInstanceOf(AbortSignal);

    const blocked = guardedFetch(base, resolvesTo("192.168.0.10"));
    seen = undefined;
    await expect(blocked("https://intranet.example.com")).rejects.toThrow(/not a public/);
    expect(seen).toBeUndefined();
  });
});
