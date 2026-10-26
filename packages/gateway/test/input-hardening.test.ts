import { readFileSync } from "node:fs";
import { deriveMasterKey } from "@costgrid/core";
import {
  AccountsRepository,
  Analytics,
  CostGridRepository,
  ImportsRepository,
  openDatabase,
} from "@costgrid/db";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONTROL_BODY_LIMIT } from "../src/api.js";
import type { GatewayConfig } from "../src/config.js";
import { withoutAddress } from "../src/console-limits.js";
import { MAX_COLUMNS, parseUsageFile, UsageFileError } from "../src/importers/csv.js";
import { createServer } from "../src/server.js";

/**
 * What the console and API refuse before it reaches a repository: bodies too
 * large for the route, fields too long or the wrong shape, and errors that
 * would say more than they should.
 */

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

describe("input hardening", () => {
  let db: ReturnType<typeof openDatabase>;
  let app: FastifyInstance;
  let cookie: string;
  let tenantId: string;
  let apiKey: string;

  const as = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { cookie },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });

  beforeEach(async () => {
    db = openDatabase({ path: ":memory:" });
    const accounts = new AccountsRepository(db, deriveMasterKey(MASTER_SECRET));
    const repository = new CostGridRepository(db);
    app = createServer({
      config: HOSTED,
      db,
      repository,
      analytics: new Analytics(db),
      accounts,
      imports: new ImportsRepository(db),
      fetchImpl: (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch,
    });
    // A route that fails the way a database does, to see what the caller is told.
    app.get("/console/test-failure", async () => {
      throw new Error("SQLITE_CONSTRAINT: UNIQUE constraint failed: api_keys.key_hash");
    });

    const res = await app.inject({
      method: "POST",
      url: "/console/signup",
      payload: { email: "owner@acme.test", name: "Owner", password: "a-sufficiently-long-password", organisation: "Acme" },
    });
    cookie = String(res.headers["set-cookie"]).split(";")[0]!;
    tenantId = res.json().tenantId;
    apiKey = repository.createApiKey(tenantId, "dashboard").plaintext;
  });

  afterEach(async () => {
    await app?.close();
    db.close();
  });

  // ------------------------------------------------------------ body size

  it("caps console and API bodies at 1 MiB, leaving the usage file its own larger limit", async () => {
    const big = "x".repeat(CONTROL_BODY_LIMIT + 1);
    const signup = await app.inject({
      method: "POST",
      url: "/console/signup",
      payload: { email: "a@b.test", name: big, password: "a-sufficiently-long-password", organisation: "X" },
    });
    expect(signup.statusCode).toBe(413);

    const policy = await app.inject({
      method: "POST",
      url: "/api/policies",
      headers: { "x-costgrid-key": apiKey },
      payload: { name: big },
    });
    expect(policy.statusCode).toBe(413);

    // Two megabytes of file: refused for what it is, not for its size.
    const file = await as("POST", `/console/${tenantId}/connect/anthropic/usage-file`, {
      fileName: "claude_api_tokens_2026_10.csv",
      text: `a,b\n1,${"2".repeat(2_000_000)}\n`,
    });
    expect(file.statusCode).toBe(400);
    expect(file.json().code).not.toBe("too-large");
  });

  // -------------------------------------------------------- error handler

  it("answers a server error without its message, and keeps a client error's", async () => {
    const failed = await as("GET", "/console/test-failure");
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toEqual({ error: "internal error" });
    expect(failed.body).not.toMatch(/SQLITE|api_keys|stack/i);

    const bad = await app.inject({ method: "GET", url: "/api/overview?days=0", headers: { "x-costgrid-key": apiKey } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/days must be an integer/);
  });

  // ------------------------------------------------------------ /api policies

  it("refuses policy payloads that are out of range or oversized", async () => {
    const post = (payload: Record<string, unknown>) =>
      app.inject({ method: "POST", url: "/api/policies", headers: { "x-costgrid-key": apiKey }, payload });
    const budget = { kind: "budget", window: "month", limitUsd: "100" };
    const base = { action: "block", scope: { kind: "tenant" }, rule: budget };

    expect((await post(base)).statusCode).toBe(201);
    expect((await post({ ...base, rule: { ...budget, limitUsd: "-5" } })).statusCode).toBe(400);
    expect((await post({ ...base, rule: { ...budget, limitUsd: "0" } })).statusCode).toBe(400);
    expect((await post({ ...base, rule: { ...budget, limitUsd: "99999999999999999999" } })).statusCode).toBe(400);
    expect((await post({ ...base, name: "n".repeat(81) })).statusCode).toBe(400);
    expect((await post({ ...base, name: 42 })).statusCode).toBe(400);
    expect((await post({ ...base, enabled: "yes" })).statusCode).toBe(400);
    expect((await post({ ...base, scope: { kind: "agent", agentId: "a".repeat(129) } })).statusCode).toBe(400);
    expect((await post({ ...base, scope: { kind: "agent", agentId: "a\nb" } })).statusCode).toBe(400);
    const models = (n: number) => ({ ...base, rule: { kind: "model-denylist", models: Array(n).fill("m") } });
    expect((await post(models(100))).statusCode).toBe(201);
    expect((await post(models(101))).statusCode).toBe(400);
    const tokens = (limit: number) => ({ ...base, rule: { kind: "max-output-tokens", limit } });
    expect((await post(tokens(10_000_001))).statusCode).toBe(400);
  });

  // ----------------------------------------------------------------- console

  it("refuses over-long signup fields and refuses an over-long password at login the same way as a wrong one", async () => {
    const signup = (over: Record<string, string>) =>
      app.inject({
        method: "POST",
        url: "/console/signup",
        payload: { email: "new@acme.test", name: "New", password: "a-sufficiently-long-password", organisation: "New", ...over },
      });
    expect((await signup({ name: "n".repeat(81) })).statusCode).toBe(400);
    expect((await signup({ organisation: "o".repeat(81) })).statusCode).toBe(400);
    expect((await signup({ password: "p".repeat(1025) })).json().error).toMatch(/password must be at most/);

    const login = await app.inject({
      method: "POST",
      url: "/console/login",
      payload: { email: "owner@acme.test", password: "p".repeat(1025) },
    });
    expect(login.statusCode).toBe(401);
    expect(login.json().error).toBe("email or password is incorrect");
  });

  it("refuses over-long key names and provider keys, and does not echo an unknown plan", async () => {
    expect((await as("POST", `/console/${tenantId}/keys`, { name: "k".repeat(81) })).statusCode).toBe(400);
    expect((await as("PUT", `/console/${tenantId}/credentials/anthropic`, { apiKey: "k".repeat(513) })).statusCode).toBe(400);
    const plan = await as("PUT", `/console/${tenantId}/plan`, { plan: "<script>" });
    expect(plan.statusCode).toBe(400);
    expect(plan.body).not.toContain("<script>");
  });

  it("refuses an admin key for a one-off import that is too long or not one key", async () => {
    const run = (adminKey: string) => as("POST", `/console/${tenantId}/import/anthropic`, { adminKey });
    expect((await run("sk-ant-admin a second word")).statusCode).toBe(400);
    expect((await run(`sk-ant-admin${"x".repeat(600)}`)).statusCode).toBe(400);
  });

  it("refuses drift rules, preflight models and limits outside their bounds", async () => {
    const deny = await as("POST", `/console/${tenantId}/drift/deny`, { agentId: "bot", tool: "t".repeat(129) });
    expect(deny.statusCode).toBe(400);

    await as("PUT", `/console/${tenantId}/credentials/anthropic`, { apiKey: "sk-ant-test-key-0000" });
    const preflight = await as("POST", `/console/${tenantId}/preflight/anthropic`, { model: "../../v1/admin" });
    expect(preflight.statusCode).toBe(400);

    const limit = (limitUsd: string) =>
      as("POST", `/console/${tenantId}/limits`, { kind: "run-budget", limitUsd, scope: { kind: "tenant" } });
    expect((await limit("250")).statusCode).toBe(201);
    expect((await limit("12345678901")).statusCode).toBe(400);
    const thinking = await as("POST", `/console/${tenantId}/limits`, {
      kind: "max-reasoning",
      budgetTokens: 10_000_001,
      scope: { kind: "tenant" },
    });
    expect(thinking.statusCode).toBe(400);
  });

  it("refuses an audit filter it cannot apply rather than ignoring it", async () => {
    expect((await as("GET", `/console/${tenantId}/audit?limit=abc`)).statusCode).toBe(400);
    expect((await as("GET", `/console/${tenantId}/audit?from=-1`)).statusCode).toBe(400);
    expect((await as("GET", `/console/${tenantId}/audit?action=%25`)).statusCode).toBe(400);
    expect((await as("GET", `/console/${tenantId}/audit?action=organisation&limit=10`)).statusCode).toBe(200);
  });

  it("lists alerts without their tenant or dedupe key", async () => {
    const res = await as("GET", `/console/${tenantId}/limits`);
    expect(res.statusCode).toBe(200);
    for (const alert of res.json().alerts) {
      expect(alert).not.toHaveProperty("tenantId");
      expect(alert).not.toHaveProperty("dedupeKey");
    }
  });
});

describe("withoutAddress", () => {
  it("takes a webhook address out of a delivery error", () => {
    const message = withoutAddress("Failed to parse URL from https://hooks.slack.com/services/T0/B0/secret-token");
    expect(message).toBe("Failed to parse URL from [address]");
    expect(withoutAddress("the receiver answered HTTP 404")).toBe("the receiver answered HTTP 404");
  });
});

describe("usage file width", () => {
  it(`refuses a file wider than ${MAX_COLUMNS} columns`, () => {
    const header = ["usage_date_utc", ...Array.from({ length: MAX_COLUMNS }, (_, i) => `c${i}`)].join(",");
    try {
      parseUsageFile("anthropic", `${header}\n2026-10-01\n`);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(UsageFileError);
      expect((error as UsageFileError).message).toMatch(/more than 500 columns/);
    }
  });
});

describe("dashboard markup", () => {
  it("escapes every server value it puts in a tag, in the gateway and the demo copy", () => {
    for (const file of ["../web/app.js", "../../../demo/app.js", "../web/topology-view.js", "../../../demo/topology-view.js"]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source).not.toMatch(/class="tag \$\{[pv]\.action\}"/);
      expect(source).not.toMatch(/>\$\{[pv]\.action\}</);
      expect(source).not.toMatch(/>\$\{n\.kind\}/);
    }
  });
});
