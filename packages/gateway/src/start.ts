import {
  CATALOG_VERIFIED_AT,
  catalogAgeDays,
  deriveMasterKey,
  isCatalogStale,
} from "@costgrid/core";
import {
  AccountsRepository,
  Analytics,
  Anchors,
  CostGridRepository,
  ImportsRepository,
  openDatabase,
  Retention,
} from "@costgrid/db";
import type { FastifyInstance } from "fastify";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { AnchorSender } from "./anchor-sender.js";
import type { GatewayConfig } from "./config.js";
import { assertToolPoliciesEnforceable, createServer } from "./server.js";

/**
 * Bring the gateway up from a resolved configuration.
 *
 * Shared by the command line (`main.ts`, which adds signal handling) and the
 * desktop app, which runs the gateway inside its own process and hands it a
 * master key from the operating system's secure storage rather than from the
 * environment. Everything that happens at boot happens here, once, so the two
 * cannot drift.
 *
 * In `allowAnonymous` mode (the single-operator / self-hosted case) a `local`
 * tenant is created on first boot so there is somewhere to attribute spend
 * without an onboarding step.
 */
export interface RunningGateway {
  readonly app: FastifyInstance;
  /** The address browsers and clients reach it at. */
  readonly url: string;
  close(): Promise<void>;
}

export async function startGateway(config: GatewayConfig): Promise<RunningGateway> {
  if (config.desktop) {
    // Owner-only, folder and files both: the database holds the encrypted
    // provider keys. The folder alone would protect them today, but a file
    // that is world-readable the moment it is copied elsewhere is not the
    // default to ship.
    process.umask(0o077);
    mkdirSync(dirname(config.databasePath), { recursive: true, mode: 0o700 });
  }
  const db = openDatabase({ path: config.databasePath });
  const repository = new CostGridRepository(db);
  const analytics = new Analytics(db);
  const imports = new ImportsRepository(db);
  const accounts =
    config.masterKeySecret === undefined
      ? undefined
      : new AccountsRepository(db, deriveMasterKey(config.masterKeySecret));

  if (config.allowAnonymous && !repository.getTenant("local")) {
    repository.createTenant("Local", "local");
  }

  assertToolPoliciesEnforceable(config, repository);

  const app = createServer({ config, db, repository, analytics, accounts, imports });
  const timers: NodeJS.Timeout[] = [];

  // Expired rows can never authenticate anything; sweeping them keeps the
  // table from growing without bound in a long-lived deployment.
  const sweep = setInterval(() => {
    accounts?.purgeExpiredSessions();
    accounts?.sso.purgeExpiredRequests();
  }, 60 * 60 * 1000);
  sweep.unref();
  timers.push(sweep);

  // Retention runs daily rather than hourly: it deletes, and a deletion job
  // that runs often is a deletion job whose blast radius nobody watches. It
  // never touches the audit log, which only a person may remove.
  const retention = new Retention(db);
  const applyRetention = (): void => {
    try {
      for (const [tenant, result] of retention.purgeAll()) {
        app.log.info({ tenant, ...result }, "retention policy applied");
      }
    } catch (error) {
      // Never take the gateway down over housekeeping. A failed purge means
      // data is kept longer than asked, which is the safe direction to fail in.
      app.log.error({ err: error }, "retention policy could not be applied");
    }
  };
  const purge = setInterval(applyRetention, 24 * 60 * 60 * 1000);
  purge.unref();
  timers.push(purge);

  /*
   * Anchoring, when the operator has somewhere to send to.
   *
   * Off unless both a destination and a signing key are configured. Turning it
   * on by default would mean inventing a destination, and an anchor sent
   * nowhere is worse than none at all: it looks like the guarantee is in place.
   */
  if (config.anchorUrl !== undefined && config.anchorKey !== undefined) {
    const sender = new AnchorSender(new Anchors(db), {
      url: config.anchorUrl,
      privateKey: config.anchorKey,
      log: app.log,
    });
    const anchor = (): void => {
      void sender.run().catch((error: unknown) => {
        app.log.error({ err: error }, "the audit anchor run failed");
      });
    };
    anchor();
    const anchoring = setInterval(anchor, config.anchorIntervalMinutes * 60 * 1000);
    anchoring.unref();
    timers.push(anchoring);
    app.log.info(
      { every: `${config.anchorIntervalMinutes}m` },
      "anchoring the audit log to an external receiver",
    );
  } else if (config.hosted && !config.desktop) {
    // Not on a desktop install: there is no separate system to anchor to, and
    // one person on one laptop is not who an external audit trail serves.
    // Worth saying at boot rather than leaving somebody to discover during an
    // audit that the fingerprint was only ever on this machine.
    app.log.warn(
      "audit anchoring is off. The audit log can be checked here, but nothing outside this " +
        "host holds a copy of its fingerprint. Set COSTGRID_ANCHOR_URL and COSTGRID_ANCHOR_KEY.",
    );
  }

  try {
    await app.listen({ port: config.port, host: config.host });
  } catch (error) {
    for (const timer of timers) clearInterval(timer);
    db.close();
    throw error;
  }

  // Surfaced at boot as well as in the UI: an operator restarting the gateway
  // is the most likely person to act on it.
  if (isCatalogStale()) {
    app.log.warn(
      { verifiedAt: CATALOG_VERIFIED_AT, ageDays: catalogAgeDays() },
      "price catalog is stale — run `npm run verify-pricing`; costs may be billed at outdated rates",
    );
  }
  const url = `http://${config.host}:${config.port}`;
  if (config.desktop) {
    app.log.info(
      { database: config.databasePath, masterKey: config.masterKeySource },
      `CostGrid desktop gateway listening — open ${url}/console to set up this computer`,
    );
  } else {
    app.log.info(
      { database: config.databasePath, anonymous: config.allowAnonymous },
      `CostGrid gateway listening — point ANTHROPIC_BASE_URL at ${url}`,
    );
  }

  return {
    app,
    url,
    async close() {
      for (const timer of timers) clearInterval(timer);
      await app.close();
      db.close();
    },
  };
}
