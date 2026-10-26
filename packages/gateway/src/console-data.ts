import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Provider } from "@costgrid/core";
import {
  type AccountsRepository,
  Anchors,
  backupDatabase,
  type CostGridRepository,
  type Db,
} from "@costgrid/db";
import type { FastifyInstance } from "fastify";
import type { GatewayConfig } from "./config.js";
import { clearSessionCookie, type ConsoleRequest, createGuards } from "./console.js";
import { IMPORTERS } from "./importers/index.js";
import { defaultPreflightModel, preflight } from "./preflight.js";
import { ADAPTERS } from "./providers/index.js";
import { adminKeyAccount, type SecretStore } from "./secret-store.js";

/**
 * The console routes that touch the whole of what CostGrid holds: a copy of
 * it, proof it has not been edited, a test of a stored key, and its deletion.
 *
 * Each of these was a command run on the server. Two of them behave
 * differently in a browser and the code says so: a backup is only offered on
 * a desktop install, because on a shared deployment the file holds other
 * organisations' data too; and erasing a desktop install removes the account
 * with it, because an account that can belong to nothing is a locked door.
 */

export interface DataDeps {
  readonly config: GatewayConfig;
  readonly db: Db;
  readonly accounts: AccountsRepository;
  readonly repository: CostGridRepository;
  /** The desktop app's keychain, so erasing an organisation removes its admin keys too. */
  readonly secretStore?: SecretStore | undefined;
  /** Overridable so tests never reach a real provider. */
  readonly fetchImpl?: typeof fetch | undefined;
}

export function registerData(app: FastifyInstance, deps: DataDeps): void {
  const { accounts, config, db, repository } = deps;
  const { audit } = accounts;
  const { requireRole } = createGuards(accounts);
  const anchors = new Anchors(db);

  // ----------------------------------------------------------------- anchors

  /**
   * Whether the audit log's fingerprint is reaching somewhere else.
   *
   * Readable by any member, like the verification it complements: a check
   * only the administrator can see is worth less than one anybody can. The
   * receiver is named by host only; its full address is the operator's.
   */
  app.get("/console/:tenantId/audit/anchors", async (request: ConsoleRequest, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    if (!requireRole(request, reply, tenantId)) return;

    const recent = anchors.recent(tenantId, 20);
    const delivered = recent.filter((a) => a.deliveredAt !== undefined);
    return {
      configured: config.anchorUrl !== undefined && config.anchorKey !== undefined,
      receiverHost: config.anchorUrl === undefined ? null : new URL(config.anchorUrl).host,
      intervalMinutes: config.anchorIntervalMinutes,
      undelivered: anchors.undelivered(tenantId, 1000).length,
      lastDeliveredAt: delivered.length === 0 ? null : Math.max(...delivered.map((a) => a.deliveredAt!)),
      recent: recent.map((a) => ({
        anchorNo: a.payload.anchorNo,
        at: a.payload.at,
        auditSeq: a.payload.auditSeq,
        auditHash: a.payload.auditHash,
        deliveredAt: a.deliveredAt ?? null,
        attempts: a.attempts,
        lastError: a.lastError ?? null,
      })),
    };
  });

  // ------------------------------------------------------------------ backup

  /**
   * A consistent copy of the database, as a download.
   *
   * Desktop only. The file is the whole database, and on a shared deployment
   * that includes every other organisation; there, backups belong to whoever
   * runs the server. Provider keys inside the copy stay encrypted under the
   * master key, which is not in the file.
   */
  app.get("/console/:tenantId/backup", async (request: ConsoleRequest, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const actor = requireRole(request, reply, tenantId, "owner");
    if (!actor) return;
    if (!config.desktop) {
      return reply.code(403).send({
        error:
          "backups are taken by whoever runs this server, with costgrid backup <path>. " +
          "The file would hold every organisation's data, not only yours.",
      });
    }

    // Through SQLite's backup API, not a file copy: a copy taken while the
    // gateway is writing loses whatever is still in the WAL sidecar.
    const dir = mkdtempSync(join(tmpdir(), "costgrid-backup-"));
    let bytes: Buffer;
    try {
      const file = join(dir, "costgrid.db");
      await backupDatabase(db, file);
      bytes = await readFile(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    audit.record(tenantId, {
      actor: { kind: "user", id: actor.user.id, label: actor.user.email },
      action: "backup.downloaded",
      subject: tenantId,
      detail: { bytes: bytes.length },
    });

    const day = new Date().toISOString().slice(0, 10);
    return reply
      .header("content-type", "application/vnd.sqlite3")
      .header("content-disposition", `attachment; filename="costgrid-backup-${day}.db"`)
      .send(bytes);
  });

  // --------------------------------------------------------------- preflight

  /**
   * One real call to a provider with the key stored here, reporting which
   * stage failed. The smallest call the channel allows, on its cheapest model
   * unless told otherwise.
   */
  app.post("/console/:tenantId/preflight/:provider", async (request: ConsoleRequest, reply) => {
    const { tenantId, provider } = request.params as { tenantId: string; provider: string };
    const actor = requireRole(request, reply, tenantId, "owner");
    if (!actor) return;

    if (!ADAPTERS.some((a) => a.id === provider)) {
      return reply.code(400).send({ error: `unknown provider: ${provider}` });
    }
    const stored = accounts.revealCredential(tenantId, provider as Provider);
    if (stored === undefined) {
      return reply.code(400).send({ error: `no ${provider} key is stored. Add one first.` });
    }

    const body = request.body as Record<string, unknown> | undefined;
    const requested = typeof body?.["model"] === "string" ? body["model"].trim() : "";
    // A model id goes into the provider's URL on some channels, so only the
    // characters model ids are made of: no slashes, no spaces, nothing to escape.
    if (requested !== "" && !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(requested)) {
      return reply.code(400).send({ error: "model must be a model id, like claude-haiku-4-5" });
    }
    const model = requested === "" ? defaultPreflightModel(provider)! : requested;

    const result = await preflight({
      provider,
      credential: stored.apiKey,
      model,
      baseUrl: stored.baseUrl,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });

    // The stored key was used against the provider's account, which is worth
    // a line even when everything passed.
    audit.record(tenantId, {
      actor: { kind: "user", id: actor.user.id, label: actor.user.email },
      action: "preflight.ran",
      subject: provider,
      detail: { model, ok: result.ok, failedAt: result.steps.find((s) => !s.ok)?.name ?? null },
    });
    return result;
  });

  // ------------------------------------------------------------------- erase

  /**
   * Delete everything belonging to one organisation. Cannot be undone.
   *
   * The organisation's name has to be typed back, which is the browser's
   * version of `--confirm`. Nothing about the deletion is recorded inside
   * CostGrid afterwards, because that record would itself be their data; the
   * counts returned here are the confirmation an erasure request is closed with.
   */
  app.delete("/console/:tenantId", async (request: ConsoleRequest, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const actor = requireRole(request, reply, tenantId, "owner");
    if (!actor) return;

    const name = repository.getTenant(tenantId)?.name;
    const body = request.body as Record<string, unknown> | undefined;
    const confirm = typeof body?.["confirm"] === "string" ? body["confirm"].trim() : "";
    if (name === undefined || confirm !== name) {
      return reply.code(400).send({
        error: `type the organisation's name exactly, ${JSON.stringify(name ?? "")}, to confirm`,
      });
    }

    // The keychain first: an admin key must not outlive the organisation it
    // was connected for. A failure is logged and does not stop the erasure.
    if (deps.secretStore !== undefined) {
      for (const { provider } of IMPORTERS) {
        await deps.secretStore.delete(adminKeyAccount(tenantId, provider)).catch(() => {
          request.log.warn({ provider }, "an admin key could not be removed from the keychain");
        });
      }
    }
    const result = accounts.retention.eraseTenant(tenantId);
    if (config.desktop) {
      accounts.deleteUser(actor.user.id);
      clearSessionCookie(reply, config.secureCookies);
    }
    return { ...result, accountRemoved: config.desktop };
  });
}
