import type { FastifyInstance } from "fastify";
import type { GatewayConfig } from "./config.js";
import { CONTENT_SECURITY_POLICY } from "./dashboard.js";

/**
 * Browser-facing response headers, on every response the gateway builds.
 *
 * The console and dashboard pages already carry their own policy; this puts
 * the same floor under everything else (JSON, errors, redirects), so a
 * response rendered by mistake as a page still cannot be framed, sniffed into
 * script or reach anywhere but this gateway. A route that sets one of these
 * itself keeps its own value.
 *
 * Streamed proxy responses write their head directly and do not pass through
 * here. They go to API clients, not browsers, so nothing is lost.
 */
const BASELINE: Readonly<Record<string, string>> = {
  "content-security-policy": CONTENT_SECURITY_POLICY,
  "x-content-type-options": "nosniff",
  // frame-ancestors 'none' in the policy says the same; this is for browsers
  // that predate it.
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "cross-origin-opener-policy": "same-origin",
};

/**
 * One year. Only sent by a hosted deployment, which must sit behind TLS; a
 * desktop or self-hosted gateway is plain http on a machine or a private
 * network, and pinning a browser to https there would lock its owner out.
 */
export const STRICT_TRANSPORT_SECURITY = "max-age=31536000; includeSubDomains";

/** Whether a deployment is one that must only ever be reached over https. */
function servesOverTls(config: GatewayConfig): boolean {
  return config.hosted && !config.desktop;
}

export function registerSecurityHeaders(app: FastifyInstance, config: GatewayConfig): void {
  const tls = servesOverTls(config);

  /*
   * Plain http that reached a hosted gateway through its TLS proxy.
   *
   * Only acted on when the proxy is trusted, so the protocol is one the
   * operator's own proxy reported rather than whatever a client claimed. A
   * request with no forwarded protocol at all (a container health check
   * talking to the port directly) is left alone. 308 keeps the method and
   * body, so an SDK pointed at http:// is moved rather than broken.
   */
  if (tls && config.trustProxy !== undefined && config.trustProxy !== false) {
    app.addHook("onRequest", async (request, reply) => {
      if (request.headers["x-forwarded-proto"] === undefined) return;
      if (request.protocol !== "http") return;
      // The configured address, when there is one, so the target is not
      // taken from a header a client chose.
      const base = config.publicUrl?.startsWith("https://")
        ? config.publicUrl
        : `https://${request.host}`;
      return reply.redirect(`${base}${request.url}`, 308);
    });
  }

  app.addHook("onSend", async (_request, reply, payload) => {
    for (const [name, value] of Object.entries(BASELINE)) {
      if (!reply.hasHeader(name)) reply.header(name, value);
    }
    if (tls) reply.header("strict-transport-security", STRICT_TRANSPORT_SECURITY);
    reply.removeHeader("x-powered-by");
    return payload;
  });
}
