import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply } from "fastify";

/**
 * Serves the dashboard's static files.
 *
 * Hand-rolled rather than pulling in @fastify/static: it is three file types
 * and a path check, and the gateway's dependency surface is worth keeping
 * small in something that sits in a customer's request path.
 */

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "web");

/**
 * What a page served here may load and do: only what came from this gateway.
 *
 * No inline or remote script, so a script injected into a page cannot run;
 * nothing fetched from anywhere else, so nothing on these pages phones out.
 * Inline styles are allowed because the pages set them on elements; the icon
 * is a data: URL. The desktop app relies on this header as much as a browser
 * does, which is why it is set at the source rather than by the app.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

export function registerDashboard(app: FastifyInstance, options: { hosted?: boolean } = {}): void {
  app.get("/", async (_request, reply) => serve(reply, "index.html"));

  // The console only exists where there are accounts to manage.
  if (options.hosted === true) {
    app.get("/console", async (_request, reply) => serve(reply, "console.html"));
  }

  app.get("/app/:file", async (request, reply) => {
    const { file } = request.params as { file: string };
    return serve(reply, file);
  });

  // The webfonts, served from here so the page needs no font CDN.
  app.get("/app/fonts/:file", async (request, reply) => {
    const { file } = request.params as { file: string };
    return serve(reply, join("fonts", file));
  });

  async function serve(reply: FastifyReply, file: string): Promise<FastifyReply> {
    // Reject anything that could escape the web root. Normalising first means
    // "..%2f" style tricks are resolved before the check, not after.
    const normalized = normalize(file);
    if (normalized.includes("..") || normalized.startsWith(sep) || normalized.includes("\0")) {
      return reply.code(400).send({ error: "bad path" });
    }

    const fullPath = join(WEB_ROOT, normalized);
    if (!fullPath.startsWith(WEB_ROOT + sep)) {
      return reply.code(400).send({ error: "bad path" });
    }

    const contentType = CONTENT_TYPES[extname(normalized)];
    if (contentType === undefined) return reply.code(404).send({ error: "not found" });

    try {
      const body = await readFile(fullPath);
      if (contentType.startsWith("text/html")) {
        reply
          .header("content-security-policy", CONTENT_SECURITY_POLICY)
          .header("x-content-type-options", "nosniff")
          .header("referrer-policy", "no-referrer");
      }
      return reply.header("content-type", contentType).send(body);
    } catch {
      return reply.code(404).send({ error: "not found" });
    }
  }
}
