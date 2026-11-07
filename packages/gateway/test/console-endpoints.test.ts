import { deriveMasterKey } from "@costgrid/core";
import { AccountsRepository, AgentsRepository, Analytics, CostGridRepository, EndpointsRepository, ImportsRepository, openDatabase } from "@costgrid/db";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GatewayConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

const MASTER_SECRET = "test-master-key-long-enough-to-be-accepted-0123456789";
const HOSTED: GatewayConfig = {
  port: 0,
  host: "127.0.0.1",
  databasePath: ":memory:",
  providerKeys: {},
  providerBaseUrls: {},
  upstreamTimeoutMs: 5_000,
  injectUsageRequest: true,
  allowAnonymous: false,
  hosted: true,
  masterKeySecret: MASTER_SECRET,
  secureCookies: false,
  logLevel: "silent",
};

describe("open-model endpoints and opt-ins on the console", () => {
  let db: ReturnType<typeof openDatabase>;
  let app: FastifyInstance;
  let cookie: string;
  let tenantId: string;

  const call = (method: "GET" | "PUT" | "DELETE", url: string, payload?: object) =>
    app.inject({ method, url: `/console/${tenantId}${url}`, headers: { cookie }, ...(payload ? { payload } : {}) });

  beforeEach(async () => {
    db = openDatabase({ path: ":memory:" });
    const accounts = new AccountsRepository(db, deriveMasterKey(MASTER_SECRET));
    app = createServer({
      config: HOSTED,
      db,
      repository: new CostGridRepository(db),
      analytics: new Analytics(db),
      accounts,
      imports: new ImportsRepository(db),
    });
    const res = await app.inject({
      method: "POST",
      url: "/console/signup",
      payload: { email: "owner@acme.test", name: "Owner", password: "a-sufficiently-long-password", organisation: "Acme" },
    });
    cookie = String(res.headers["set-cookie"]).split(";")[0]!;
    tenantId = res.json().tenantId as string;
    new AgentsRepository(db).create(tenantId, { name: "Support bot", purposeId: "support", purposeVersion: "2" });
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it("refuses an address inside the network when hosted", async () => {
    for (const baseUrl of ["http://127.0.0.1:11434/v1", "https://10.0.0.5/v1", "https://user:pw@api.example.com/v1"]) {
      const res = await call("PUT", "/endpoints/local", { name: "Local", baseUrl });
      expect(res.statusCode).toBe(400);
    }
  });

  it("stores a key encrypted, shows only its hint, and requires a source for prices", async () => {
    const saved = await call("PUT", "/endpoints/together", { name: "Together", baseUrl: "https://8.8.8.8/v1", apiKey: "tg-secret-key-123456" });
    expect(saved.statusCode).toBe(200);
    expect(JSON.stringify(saved.json())).not.toContain("tg-secret-key-123456");
    expect(saved.json().endpoints[0]).toMatchObject({ id: "together", baseUrl: "https://8.8.8.8/v1" });
    const raw = db.prepare("SELECT encrypted_key AS k FROM model_endpoints").get() as { k: string };
    expect(raw.k).not.toContain("tg-secret");
    expect(new EndpointsRepository(db, deriveMasterKey(MASTER_SECRET)).reveal(tenantId, "together")?.apiKey).toBe("tg-secret-key-123456");

    const unsourced = await call("PUT", "/endpoints/together/models", { model: "meta-llama/Llama-3.3-70B", inputPerMUsd: "0.88", outputPerMUsd: "0.88" });
    expect(unsourced.statusCode).toBe(400);
    const priced = await call("PUT", "/endpoints/together/models", {
      model: "meta-llama/Llama-3.3-70B",
      inputPerMUsd: "0.88",
      outputPerMUsd: "0.88",
      priceSource: "https://www.together.ai/pricing",
      pricedOn: "2026-11-07",
    });
    expect(priced.json().endpoints[0].models[0]).toMatchObject({
      id: "open:together/meta-llama/Llama-3.3-70B",
      inputPerMUsd: "0.88",
      priceSource: "https://www.together.ai/pricing",
    });
  });

  it("opts an agent in only to destinations that exist, and audits it", async () => {
    await call("PUT", "/endpoints/together", { name: "Together", baseUrl: "https://8.8.8.8/v1" });
    expect((await call("PUT", "/agents/support-bot/destinations", { destinations: ["open:nowhere"] })).statusCode).toBe(400);
    expect((await call("PUT", "/agents/support-bot/destinations", { destinations: ["gemini"] })).statusCode).toBe(400);
    const ok = await call("PUT", "/agents/support-bot/destinations", { destinations: ["anthropic", "open:together"] });
    expect(ok.json().agents[0]).toMatchObject({ id: "support-bot", destinations: ["anthropic", "open:together"] });
    const audited = db.prepare("SELECT detail FROM audit_log WHERE action = 'agent.destinations'").get() as { detail: string };
    expect(audited.detail).toContain("open:together");

    // Removing the endpoint takes the opt-in with it.
    await call("DELETE", "/endpoints/together");
    expect((await call("GET", "/endpoints")).json().agents[0].destinations).toEqual(["anthropic"]);
  });
});
