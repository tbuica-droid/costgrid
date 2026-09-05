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

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

export function registerDashboard(app: FastifyInstance): void {
  app.get("/", async (_request, reply) => serve(reply, "index.html"));

  app.get("/app/:file", async (request, reply) => {
    const { file } = request.params as { file: string };
    return serve(reply, file);
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
      return reply.header("content-type", contentType).send(body);
    } catch {
      return reply.code(404).send({ error: "not found" });
    }
  }
}
