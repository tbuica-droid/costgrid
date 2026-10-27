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

  const setup = () => {
    const db = openDatabase({ path: ":memory:" });
    new CostGridRepository(db).createTenant("Acme", TENANT);
    const alerts = new AlertsRepository(db, deriveMasterKey("x".repeat(32)));
    alerts.configure(TENANT, { webhookUrl: WEBHOOK });
    const log = { info: () => {}, warn: () => {}, error: () => {} } as unknown as FastifyBaseLogger;
    const stored = alerts.raise(TENANT, { kind: "test", dedupeKey: "t", subject: "s", message: "m" })!;
    return { alerts, log, stored };
  };

  it("tries again while the receiver is down or busy, then delivers", async () => {
    const { alerts, log, stored } = setup();
    const answers = [503, 429, 200];
    let calls = 0;
    const fetchImpl = (async () => new Response("", { status: answers[calls++]! })) as unknown as typeof fetch;
    const result = await new Alerter({ alerts, log, fetchImpl, retryDelaysMs: [0, 0] }).deliver(stored);
    expect(result.delivered).toBe(true);
    expect(calls).toBe(3);
  });

  it("gives up after its retries, and never retries a receiver that refused", async () => {
    const { alerts, log, stored } = setup();
    let calls = 0;
    const down = (async () => {
      calls++;
      return new Response("", { status: 502 });
    }) as unknown as typeof fetch;
    const failed = await new Alerter({ alerts, log, fetchImpl: down, retryDelaysMs: [0, 0] }).deliver(stored);
    expect(failed).toMatchObject({ delivered: false, error: "the receiver answered HTTP 502" });
    expect(calls).toBe(3);

    calls = 0;
    const refused = (async () => {
      calls++;
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;
    await new Alerter({ alerts, log, fetchImpl: refused, retryDelaysMs: [0, 0] }).deliver(stored);
    expect(calls).toBe(1);
  });

  it("in hosted mode, will not deliver an organisation's alerts to a private address", async () => {
    const { alerts, log, stored } = setup();
    alerts.configure(TENANT, { webhookUrl: "https://169.254.169.254/latest/meta-data" });
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    const result = await new Alerter({ alerts, log, fetchImpl, guardTenantWebhooks: true }).deliver(stored);
    expect(result.delivered).toBe(false);
    expect(result.error).toMatch(/not a public internet address/);
    expect(calls).toBe(0);
  });
});
