import {
  CATALOG_VERIFIED_AT,
  catalogAgeDays,
  deriveMasterKey,
  isCatalogStale,
} from "@costgrid/core";
import {
  AccountsRepository,
  Analytics,
  CostGridRepository,
  ImportsRepository,
  openDatabase,
  Retention,
} from "@costgrid/db";
import { loadConfig } from "./config.js";
import { assertToolPoliciesEnforceable, createServer } from "./server.js";

/**
 * Gateway entry point.
 *
 * In `allowAnonymous` mode (the single-operator / self-hosted case) a `local`
 * tenant is created on first boot so there is somewhere to attribute spend
 * without an onboarding step.
 */
async function main(): Promise<void> {
  const config = loadConfig();
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

  const app = createServer({ config, repository, analytics, accounts, imports });

  // Expired rows can never authenticate anything; sweeping them keeps the
  // table from growing without bound in a long-lived deployment.
  const sweep = setInterval(() => {
    accounts?.purgeExpiredSessions();
    accounts?.sso.purgeExpiredRequests();
  }, 60 * 60 * 1000);
  sweep.unref();

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

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ port: config.port, host: config.host });

  // Surfaced at boot as well as in the UI: an operator restarting the gateway
  // is the most likely person to act on it.
  if (isCatalogStale()) {
    app.log.warn(
      { verifiedAt: CATALOG_VERIFIED_AT, ageDays: catalogAgeDays() },
      "price catalog is stale — run `npm run verify-pricing`; costs may be billed at outdated rates",
    );
  }
  app.log.info(
    { database: config.databasePath, anonymous: config.allowAnonymous },
    `CostGrid gateway listening — point ANTHROPIC_BASE_URL at http://${config.host}:${config.port}`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
