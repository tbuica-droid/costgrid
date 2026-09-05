import { Analytics, CostGridRepository, openDatabase } from "@costgrid/db";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

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

  if (config.allowAnonymous && !repository.getTenant("local")) {
    repository.createTenant("Local", "local");
  }

  const app = createServer({ config, repository, analytics });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    { database: config.databasePath, anonymous: config.allowAnonymous },
    `CostGrid gateway listening — point ANTHROPIC_BASE_URL at http://${config.host}:${config.port}`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
