import { type AccountsRepository, type ImportsRepository, toUtcDay } from "@costgrid/db";
import type { FastifyInstance } from "fastify";
import { type ConsoleRequest, createGuards } from "./console.js";
import { importerFor, IMPORTERS } from "./importers/index.js";

/**
 * Backfilling a customer's history from their provider's admin API.
 *
 * Its own file because it is the one console feature that reaches out to
 * somebody else's network, with a credential powerful enough to read an entire
 * organisation's usage. That deserves to be read on its own rather than found
 * in the middle of settings pages.
 */

export interface ImportDeps {
  readonly accounts: AccountsRepository;
  readonly imports: ImportsRepository;
  /** Overridable so tests never reach a real provider. */
  readonly fetchImpl?: typeof fetch | undefined;
}

export function registerImport(app: FastifyInstance, deps: ImportDeps): void {
  const { accounts, imports } = deps;
  const { audit } = accounts;
  const { requireRole } = createGuards(accounts);

  // ------------------------------------------------------- historical import

  app.get("/console/:tenantId/import", async (request: ConsoleRequest, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    if (!requireRole(request, reply, tenantId, "owner")) return;

    return {
      providers: IMPORTERS.map((i) => ({ provider: i.provider, keyHint: i.keyHint })),
      hasImports: imports.hasImports(tenantId),
      runs: imports.recentRuns(tenantId),
    };
  });

  /**
   * Backfill history from a provider's admin API.
   *
   * The admin key is used for the duration of this request and then dropped.
   * It is never written anywhere — not the database, not the log. A one-off
   * backfill does not justify holding a credential that can read an entire
   * organisation's usage.
   */
  app.post("/console/:tenantId/import/:provider", async (request: ConsoleRequest, reply) => {
    const { tenantId, provider } = request.params as { tenantId: string; provider: string };
    const actor = requireRole(request, reply, tenantId, "owner");
    if (!actor) return;

    const importer = importerFor(provider);
    if (!importer) return reply.code(400).send({ error: `unknown provider: ${provider}` });

    const body = request.body as Record<string, unknown> | undefined;
    const adminKey = typeof body?.["adminKey"] === "string" ? body["adminKey"].trim() : "";
    if (adminKey === "") return reply.code(400).send({ error: "adminKey is required" });

    const days = typeof body?.["days"] === "number" ? body["days"] : 90;
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      return reply.code(400).send({ error: "days must be an integer between 1 and 365" });
    }

    const to = new Date();
    const from = new Date(to.getTime() - days * 86_400_000);
    const runId = imports.startRun(tenantId, importer.provider, toUtcDay(from), toUtcDay(to));

    try {
      const result = await importer.run({
        apiKey: adminKey,
        from,
        to,
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      });
      const written = imports.putRows(tenantId, result.rows);
      imports.finishRun(runId, written);

      // Recorded because someone used an admin credential against the
      // customer's provider account. Which credential is not recorded, because
      // it was never stored.
      audit.record(tenantId, {
        actor: { kind: "user", id: actor.user.id, label: actor.user.email },
        action: "import.ran",
        subject: importer.provider,
        detail: { fromDay: toUtcDay(from), toDay: toUtcDay(to), rowsWritten: written },
      });

      return {
        provider: importer.provider,
        fromDay: toUtcDay(from),
        toDay: toUtcDay(to),
        rowsWritten: written,
        // Named so nobody mistakes an unpriced model for free traffic.
        unpricedModels: result.unpricedModels,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      imports.failRun(runId, message);
      return reply.code(502).send({ error: `import failed: ${message}` });
    }
  });

  app.delete("/console/:tenantId/import", async (request: ConsoleRequest, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const actor = requireRole(request, reply, tenantId, "owner");
    if (!actor) return;

    const deleted = imports.deleteAll(tenantId);
    audit.record(tenantId, {
      actor: { kind: "user", id: actor.user.id, label: actor.user.email },
      action: "import.deleted",
      subject: tenantId,
      detail: { rows: deleted },
    });
    return { deleted };
  });
}
