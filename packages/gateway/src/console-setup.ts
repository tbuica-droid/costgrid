import type { AccountsRepository } from "@costgrid/db";
import type { FastifyInstance } from "fastify";
import type { GatewayConfig } from "./config.js";

/**
 * What the console should offer a signed-out visitor.
 *
 * On a desktop install the first visit creates the one account and every
 * visit after it signs in, so the page needs to know which it is. Only desktop
 * mode answers "is there an account yet": on a multi-tenant deployment that
 * would tell anyone on the internet whether the service has users.
 */
export function registerSetup(
  app: FastifyInstance,
  deps: { config: GatewayConfig; accounts: AccountsRepository },
): void {
  app.get("/console/setup", async () =>
    deps.config.desktop === true
      ? {
          singleAccount: true,
          needsAccount: !deps.accounts.hasAnyUser(),
          // So the page only says "held in your keychain" when it is.
          keychain: deps.config.masterKeySource === "keychain",
        }
      : { singleAccount: false },
  );
}
