import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Keeps a hosted gateway from being pointed at its own network (SSRF).
 *
 * In hosted mode each organisation types in addresses the server then calls:
 * its sign-in provider, its alert webhook, its own provider endpoint. Https is
 * already required, but an https address can still name an internal service,
 * the cloud metadata endpoint, or this machine. This refuses any address that
 * resolves to somewhere other than the public internet, and refuses redirects,
 * which would otherwise take a checked address to an unchecked one.
 *
 * What it does not stop: a name that resolves publicly when checked and
 * privately a moment later (DNS rebinding). Closing that needs the connection
 * pinned to the checked address; until then the network around a hosted
 * deployment should also deny egress to private ranges (HOSTING.md).
 *
 * Self-hosted and desktop installs are left alone: there, the person typing
 * the address owns the network, and a local SSO or webhook is legitimate.
 */

type Lookup = (host: string) => Promise<readonly { address: string }[]>;

const defaultLookup: Lookup = (host) => dnsLookup(host, { all: true, verbatim: true });

function ipv4Parts(ip: string): number[] {
  return ip.split(".").map(Number);
}

/** True only for addresses on the public internet. */
export function isPublicAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    const [a, b] = ipv4Parts(ip) as [number, number, number, number];
    if (a === 0 || a === 10 || a === 127) return false; // this network, private, loopback
    if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
    if (a === 169 && b === 254) return false; // link-local, cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return false; // private
    if (a === 192 && b === 168) return false; // private
    if (a === 192 && b === 0 && ipv4Parts(ip)[2] === 0) return false; // IETF protocol assignments
    if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
    if (a >= 224) return false; // multicast and reserved
    return true;
  }
  if (kind === 6) {
    const lower = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPublicAddress(mapped[1]!);
    if (lower === "::" || lower === "::1") return false;
    if (/^f[cd]/.test(lower)) return false; // unique local
    if (/^fe[89ab]/.test(lower)) return false; // link-local
    if (lower.startsWith("ff")) return false; // multicast
    if (lower.startsWith("64:ff9b:")) return false; // NAT64 can reach IPv4 private space
    return true;
  }
  return false;
}

export class BlockedAddressError extends Error {
  constructor(host: string) {
    super(`${host} is not a public internet address, so a hosted CostGrid will not call it`);
    this.name = "BlockedAddressError";
  }
}

/** Throws unless `url` is https and every address its host resolves to is public. */
export async function assertPublicUrl(url: string | URL, lookup: Lookup = defaultLookup): Promise<void> {
  const parsed = typeof url === "string" ? new URL(url) : url;
  if (parsed.protocol !== "https:") throw new Error(`${parsed.origin} must be https`);
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host);
  if (addresses.length === 0 || !addresses.every((a) => isPublicAddress(a.address))) {
    throw new BlockedAddressError(host);
  }
}

/** Default deadline for a guarded call that brought no signal of its own. */
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * A fetch that checks each address before calling it, refuses redirects, and
 * gives up after 15 seconds unless the caller set its own deadline.
 */
export function guardedFetch(base: typeof fetch = fetch, lookup: Lookup = defaultLookup): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" || input instanceof URL ? input : input.url;
    await assertPublicUrl(url, lookup);
    return base(input, {
      ...init,
      redirect: "error",
      signal: init?.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  }) as typeof fetch;
}
