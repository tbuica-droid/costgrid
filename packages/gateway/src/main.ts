import { loadConfig } from "./config.js";
import { startGateway } from "./start.js";

/**
 * Gateway entry point for the command line: configuration from the
 * environment, a clean shutdown on a signal. Everything else is `startGateway`.
 */
async function main(): Promise<void> {
  const gateway = await startGateway(loadConfig());

  const shutdown = async (signal: string): Promise<void> => {
    gateway.app.log.info({ signal }, "shutting down");
    await gateway.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
