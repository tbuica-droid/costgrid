import { maskSecret, PURPOSE_PRESETS, type Provider } from "@costgrid/core";
import {
  type AccountsRepository,
  type ImportsRepository,
  type KeyFactsRepository,
  type SourcesRepository,
  toUtcDay,
} from "@costgrid/db";
import type { FastifyInstance, FastifyReply } from "fastify";
import { developerMessage, explainImportError, isMessageAudience, notAnAdminKey } from "./connect-copy.js";
import { type ConsoleRequest, createGuards } from "./console.js";
import { bodyOf, by, CONTROL, rangeOf, sourceView } from "./console-fields.js";
import { ImportRunError, runImport } from "./import-run.js";
import { MAX_FILE_CHARS, parseUsageFile, UsageFileError } from "./importers/csv.js";
import { importerFor, IMPORTERS } from "./importers/index.js";
import { fetchSourceDirectory } from "./importers/names.js";
import { adminKeyAccount, type SecretStore } from "./secret-store.js";

/**
 * Step 2 of setup: connect a provider. Matching what it found to agents is
 * step 3, in `console-agents.ts`.
 *
 * Connecting is either an admin key or a usage file. An admin key is used
 * straight away for 90 days of history, and kept only if that worked and this
 * computer has a keychain to keep it in (the desktop app). The key goes to the
 * keychain; the database learns only that one exists, its last four
 * characters and when it expires. It never appears in a response, an audit
 * entry, a recorded error or a log line.
 *
 * Every body here comes from a browser, so each field is checked by hand
 * before anything reaches a repository or the keychain.
 */

export interface ConnectDeps {
  readonly accounts: AccountsRepository;
  readonly imports: ImportsRepository;
  readonly sources: SourcesRepository;
  readonly keyFacts?: KeyFactsRepository | undefined;
  /** The desktop app's keychain. Absent on a server: a key is then used once. */
  readonly secretStore?: SecretStore | undefined;
  /** Overridable so tests never reach a real provider. */
  readonly fetchImpl?: typeof fetch | undefined;
}

const DAY_MS = 86_400_000;
/** History a newly connected key brings in. */
export const CONNECT_DAYS = 90;
const MAX_KEY_CHARS = 512;
/** Further ahead than this is "never" in disguise, and should say so. */
const MAX_EXPIRY_MS = 2 * 365 * DAY_MS;
const MAX_FILE_NAME = 120;

/** The admin key, or why it is not one. Never echoes the value. */
function readAdminKey(raw: unknown): string | { error: string } {
  if (typeof raw !== "string") return { error: "adminKey is required" };
  const key = raw.trim();
  if (key === "") return { error: "adminKey is required" };
  if (key.length > MAX_KEY_CHARS) return { error: `adminKey is longer than ${MAX_KEY_CHARS} characters` };
  if (/\s/.test(key)) return { error: "adminKey has spaces or line breaks inside it; paste the key alone" };
  return key;
}

function readExpiry(raw: unknown, now: number): number | null | { error: string } {
  if (raw === null) return null;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw)) {
    return { error: "expiresAt must be null (never) or a time in milliseconds" };
  }
  if (raw <= now) return { error: "expiresAt must be in the future" };
  if (raw > now + MAX_EXPIRY_MS) return { error: "expiresAt must be within two years" };
  return raw;
}

function readFileName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const name = raw.trim();
  if (name === "" || name.length > MAX_FILE_NAME || /[/\\]/.test(name) || CONTROL.test(name)) {
    return undefined;
  }
  return name;
}

export function registerConnect(app: FastifyInstance, deps: ConnectDeps): void {
  const { accounts, imports, sources, secretStore } = deps;
  const { audit } = accounts;
  const { requireUser, requireRole } = createGuards(accounts);
  const doFetch = deps.fetchImpl ?? fetch;

  /** The provider from the URL, or a 400 already sent. */
  function providerOf(raw: string, reply: FastifyReply): Provider | undefined {
    const importer = importerFor(raw);
    if (!importer) {
      void reply.code(400).send({ error: "unknown provider" });
      return undefined;
    }
    return importer.provider;
  }

  // -------------------------------------------------------------- state

  app.get("/console/:tenantId/connect", async (request: ConsoleRequest, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    if (!requireRole(request, reply, tenantId, "owner")) return;

    const keys = new Map(sources.adminKeys(tenantId).map((k) => [k.provider, k]));
    return {
      secretStore: secretStore !== undefined,
      providers: IMPORTERS.map((i) => {
        const key = keys.get(i.provider);
        return {
          provider: i.provider,
          adminKey: key
            ? {
                hint: key.hint,
                expiresAt: key.expiresAt,
                lastSyncAt: key.lastSyncAt,
                lastSyncStatus: key.lastSyncStatus,
                lastSyncError: key.lastSyncError,
              }
            : null,
        };
      }),
      hasImports: imports.hasImports(tenantId),
      sourceCount: sources.count(tenantId),
      runs: imports.recentRuns(tenantId),
    };
  });

  // ---------------------------------------------------------- admin key

  app.put("/console/:tenantId/connect/:provider/admin-key", async (request: ConsoleRequest, reply) => {
    const params = request.params as { tenantId: string; provider: string };
    const actor = requireRole(request, reply, params.tenantId, "owner");
    if (!actor) return;
    const provider = providerOf(params.provider, reply);
    if (!provider) return;
    const { tenantId } = params;

    const body = bodyOf(request);
    const adminKey = readAdminKey(body["adminKey"]);
    if (typeof adminKey !== "string") return reply.code(400).send(adminKey);
    const wrongKind = notAnAdminKey(provider, adminKey);
    if (wrongKind !== undefined) return reply.code(400).send({ error: wrongKind });
    const now = Date.now();
    const expiresAt = readExpiry(body["expiresAt"], now);
    if (expiresAt !== null && typeof expiresAt !== "number") return reply.code(400).send(expiresAt);

    // The import first: a key that cannot read usage is not worth keeping.
    const to = new Date(now);
    const from = new Date(now - CONNECT_DAYS * DAY_MS);
    let outcome;
    try {
      outcome = await runImport(deps, {
        tenantId,
        provider,
        origin: "admin-api",
        window: { fromDay: toUtcDay(from), toDay: toUtcDay(to) },
        secret: adminKey,
        load: () => importerFor(provider)!.run({ apiKey: adminKey, from, to, fetchImpl: doFetch }),
        directory: () => fetchSourceDirectory(provider, adminKey, doFetch),
        audit: { log: audit, actor: by(actor.user), action: "import.ran", detail: { origin: "admin-api" } },
      });
    } catch (error) {
      if (!(error instanceof ImportRunError)) throw error;
      return reply.code(502).send({ error: explainImportError(provider, error.message) });
    }

    let stored = false;
    const hint = maskSecret(adminKey);
    if (secretStore !== undefined) {
      const account = adminKeyAccount(tenantId, provider);
      let written = false;
      try {
        await secretStore.set(account, adminKey);
        written = true;
        sources.putAdminKey(tenantId, { provider, hint, expiresAt, createdAt: now });
        // The import above was this key's first sync, so the background sync
        // picks up from here rather than reading the same 90 days again.
        sources.recordSync(tenantId, provider, true);
        stored = true;
      } catch {
        // The keychain refused (locked, or access denied), or the metadata
        // could not be written. The import already happened, so this is
        // "used once", not a failure, and a key nothing knows about is not
        // left behind. Not logged with the error itself: a keychain library
        // may describe what it was given.
        if (written) await secretStore.delete(account).catch(() => false);
        request.log.warn({ provider }, "the admin key could not be kept in the keychain");
      }
    }

    audit.record(tenantId, {
      actor: by(actor.user),
      action: stored ? "connect.key-stored" : "connect.key-used-once",
      subject: provider,
      detail: stored ? { provider, hint, expiresAt } : { provider },
    });

    return { stored, ...outcome };
  });

  app.delete("/console/:tenantId/connect/:provider/admin-key", async (request: ConsoleRequest, reply) => {
    const params = request.params as { tenantId: string; provider: string };
    const actor = requireRole(request, reply, params.tenantId, "owner");
    if (!actor) return;
    const provider = providerOf(params.provider, reply);
    if (!provider) return;
    const { tenantId } = params;

    let removed = false;
    if (secretStore !== undefined) {
      try {
        removed = await secretStore.delete(adminKeyAccount(tenantId, provider));
      } catch {
        // Keep the metadata, so the owner still sees a key and can try again.
        request.log.warn({ provider }, "the admin key could not be removed from the keychain");
        return reply.code(500).send({ error: "the key could not be removed from the keychain; try again" });
      }
    }
    const forgotten = sources.deleteAdminKey(tenantId, provider) || removed;
    // What the key's lists said goes too: without the key it can only go stale.
    deps.keyFacts?.replace(tenantId, provider, []);

    audit.record(tenantId, {
      actor: by(actor.user),
      action: "connect.key-forgotten",
      subject: provider,
      detail: { provider },
    });
    return { forgotten };
  });

  // --------------------------------------------------------- usage file

  // The one console route allowed a large body: the file, as JSON text, where
  // escaping can double it. Every other console route keeps the 1 MiB default.
  app.post("/console/:tenantId/connect/:provider/usage-file", { bodyLimit: 2 * MAX_FILE_CHARS }, async (request: ConsoleRequest, reply) => {
    const params = request.params as { tenantId: string; provider: string };
    const actor = requireRole(request, reply, params.tenantId, "owner");
    if (!actor) return;
    const provider = providerOf(params.provider, reply);
    if (!provider) return;

    const body = bodyOf(request);
    const fileName = readFileName(body["fileName"]);
    if (fileName === undefined) {
      return reply
        .code(400)
        .send({ error: `fileName must be a file name of at most ${MAX_FILE_NAME} characters` });
    }
    const text = body["text"];
    if (typeof text !== "string") return reply.code(400).send({ error: "text is required" });
    if (text.length > MAX_FILE_CHARS) {
      return reply
        .code(400)
        .send({ error: "This file is larger than 32 MB. Export a shorter period.", code: "too-large" });
    }

    let parsed;
    try {
      parsed = parseUsageFile(provider, text);
    } catch (error) {
      if (!(error instanceof UsageFileError)) throw error;
      return reply.code(400).send({
        error: error.message,
        code: error.code,
        ...(error.missing !== undefined ? { missing: error.missing } : {}),
        ...(error.row !== undefined ? { row: error.row } : {}),
      });
    }
    if (parsed.fromDay === null || parsed.toDay === null) {
      return reply.code(400).send({
        error:
          "This file has no dates in it, so it cannot say which days to import. " +
          "Export a period with usage.",
        code: "empty",
      });
    }

    // A file with no usage replaces nothing: the wrong export, or one filtered
    // to an idle project, must not wipe days already imported.
    if (parsed.rows.length === 0) {
      return {
        rowsWritten: 0,
        sources: 0,
        fromDay: parsed.fromDay,
        toDay: parsed.toDay,
        warnings: [...parsed.warnings, "Nothing already imported for these days was changed."],
      };
    }

    try {
      const outcome = await runImport(deps, {
        tenantId: params.tenantId,
        provider,
        origin: "csv",
        window: { fromDay: parsed.fromDay, toDay: parsed.toDay },
        load: async () => parsed,
        audit: {
          log: audit,
          actor: by(actor.user),
          action: "import.file",
          detail: { fileName, rows: parsed.rows.length },
        },
      });
      return {
        rowsWritten: outcome.rowsWritten,
        sources: outcome.sources,
        fromDay: outcome.fromDay,
        toDay: outcome.toDay,
        warnings: parsed.warnings,
      };
    } catch (error) {
      if (!(error instanceof ImportRunError)) throw error;
      return reply.code(500).send({ error: `The file could not be saved: ${error.message}` });
    }
  });

  // ------------------------------------------------------------ sources

  app.get("/console/:tenantId/sources", async (request: ConsoleRequest, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    if (!requireRole(request, reply, tenantId, "owner")) return;
    const range = rangeOf(request);
    if ("error" in range) return reply.code(400).send(range);
    return { sources: sources.list(tenantId, range).map(sourceView) };
  });

  // ------------------------------------------------------ presets, copy

  app.get("/console/presets", async (request: ConsoleRequest, reply) => {
    if (!requireUser(request, reply)) return;
    return {
      presets: PURPOSE_PRESETS.map(({ id, version, label, finishedJob, evidence }) => ({
        id,
        version,
        label,
        finishedJob,
        evidence,
      })),
    };
  });

  app.get("/console/:tenantId/connect/developer-message", async (request: ConsoleRequest, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    if (!requireRole(request, reply, tenantId, "owner")) return;
    const audience = (request.query as Record<string, unknown> | undefined)?.["provider"] ?? "both";
    if (!isMessageAudience(audience)) {
      return reply.code(400).send({ error: "provider must be anthropic, openai or both" });
    }
    return developerMessage(audience);
  });
}
