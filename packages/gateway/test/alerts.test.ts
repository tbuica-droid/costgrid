import { deriveMasterKey } from "@costgrid/core";
import { AlertsRepository, CostGridRepository, openDatabase } from "@costgrid/db";
import type { FastifyBaseLogger } from "fastify";
import { describe, expect, it } from "vitest";
import { Alerter } from "../src/alerts.js";

/**
 * Delivering an alert to a webhook. The address is a credential (a Slack
 * incoming webhook is one), so a failed delivery must not write it anywhere.
 */

const TENANT = "tenant-1";
const WEBHOOK = "https://hooks.slack.example/services/T000/B000/SECRETTOKEN0123456789";

describe("alert delivery", () => {
  it("keeps the webhook address out of the stored error and the log", async () => {
    const db = openDatabase({ path: ":memory:" });
    new CostGridRepository(db).createTenant("Acme", TENANT);
    const alerts = new AlertsRepository(db, deriveMasterKey("x".repeat(32)));
    alerts.configure(TENANT, { webhookUrl: WEBHOOK });

    const logged: unknown[] = [];
    const log = {
      info: () => {},
      warn: (...args: unknown[]) => logged.push(args),
      error: (...args: unknown[]) => logged.push(args),
    } as unknown as FastifyBaseLogger;
    // A transport whose error quotes the address it was given, as some do.
    const fetchImpl = (async (url: unknown) => {
      throw new TypeError(`could not connect to ${String(url)}`);
    }) as unknown as typeof fetch;

    const alerter = new Alerter({ alerts, log, fetchImpl });
    const stored = alerts.raise(TENANT, { kind: "test", dedupeKey: "t", subject: "s", message: "m" })!;
    const result = await alerter.deliver(stored);

    expect(result.delivered).toBe(false);
    expect(result.error).toBe("could not connect to [alert address]");
    expect(alerts.recent(TENANT)[0]!.lastError).toBe("could not connect to [alert address]");
    expect(JSON.stringify(logged)).not.toContain("SECRETTOKEN");
    // At rest it is only ciphertext and a masked hint.
    expect(JSON.stringify(db.prepare("SELECT * FROM alert_settings").all())).not.toContain("SECRETTOKEN");
  });
});
