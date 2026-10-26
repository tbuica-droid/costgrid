import type { FastifyRequest } from "fastify";

/**
 * What the request log may say about a request.
 *
 * Fastify logs every request's URL, query string included. Most query strings
 * are filters, but an identity provider's redirect back to the SSO callback
 * carries a one-time authorization code and the sign-in's state, and a log
 * file is read by far more people than the database. Those values are
 * replaced before the line is written; the parameter names stay, so the log
 * still says what kind of request it was.
 */

/** Query parameters whose values are credentials, whatever the route. */
const SECRET_PARAMS = new Set([
  "code",
  "state",
  "token",
  "key",
  "api_key",
  "apikey",
  "secret",
  "password",
  "access_token",
  "id_token",
  "refresh_token",
]);

/** A request URL with any credential-bearing query values replaced. */
export function redactUrl(url: string): string {
  const at = url.indexOf("?");
  if (at === -1) return url;
  const query = url
    .slice(at + 1)
    .split("&")
    .map((pair) => {
      const eq = pair.indexOf("=");
      if (eq === -1) return pair;
      let name: string;
      try {
        name = decodeURIComponent(pair.slice(0, eq).replace(/\+/g, " "));
      } catch {
        name = pair.slice(0, eq);
      }
      return SECRET_PARAMS.has(name.toLowerCase()) ? `${pair.slice(0, eq)}=[redacted]` : pair;
    })
    .join("&");
  return `${url.slice(0, at)}?${query}`;
}

/** The parts of a request the serializer reads; structural, so Fastify's server type is not narrowed by it. */
type LoggedRequest = Pick<FastifyRequest, "method" | "url" | "host" | "ip"> & {
  readonly socket?: { readonly remotePort?: number | undefined } | undefined;
};

/** Fastify's own request serializer, with the URL redacted. */
export const logSerializers = {
  req(request: LoggedRequest) {
    const remotePort = request.socket?.remotePort;
    return {
      method: request.method,
      url: redactUrl(request.url),
      host: request.host,
      remoteAddress: request.ip,
      ...(remotePort === undefined ? {} : { remotePort }),
    };
  },
};
