import { deriveMasterKey, usd } from "@costgrid/core";
import {
  AccountsRepository,
  Analytics,
  CostGridRepository,
  ImportsRepository,
  openDatabase,
} from "@costgrid/db";
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

const MESSAGE = {
  id: "msg_1",
  model: "claude-opus-5",
  stop_reason: "end_turn",
  usage: { input_tokens: 1_000, output_tokens: 500 },
};

describe("hosted control plane", () => {
  let db: ReturnType<typeof openDatabase>;
  let accounts: AccountsRepository;
  let repository: CostGridRepository;
  let imports: ImportsRepository;
  let app: FastifyInstance;
  let upstreamKeys: string[];

  const signup = (over: Record<string, string> = {}) =>
    app.inject({
      method: "POST",
      url: "/console/signup",
      payload: {
        email: "owner@acme.test",
        name: "Owner",
        password: "a-sufficiently-long-password",
        organisation: "Acme",
        ...over,
      },
    });

  /** Extract the session cookie value from a Set-Cookie header. */
  const cookieFrom = (res: { headers: Record<string, unknown> }): string =>
    String(res.headers["set-cookie"]).split(";")[0]!;

  beforeEach(() => {
    db = openDatabase({ path: ":memory:" });
    accounts = new AccountsRepository(db, deriveMasterKey(MASTER_SECRET));
    repository = new CostGridRepository(db);
    imports = new ImportsRepository(db);
    upstreamKeys = [];

    app = createServer({
      config: HOSTED,
      repository,
      analytics: new Analytics(db),
      accounts,
      imports,
      fetchImpl: (async (_url: unknown, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        upstreamKeys.push(headers["x-api-key"] ?? headers["authorization"] ?? "(none)");
        return new Response(JSON.stringify(MESSAGE), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });
  });

  afterEach(async () => {
    await app?.close();
    db.close();
  });

  // ------------------------------------------------------------------ signup

  it("creates a user, an organisation and a session in one step", async () => {
    const res = await signup();
    expect(res.statusCode).toBe(201);

    const body = res.json();
    expect(body.user.email).toBe("owner@acme.test");
    expect(body.tenantId).toBeTruthy();
    expect(String(res.headers["set-cookie"])).toMatch(/costgrid_session=.+HttpOnly/);

    // The owner is a member of the org they created, on the free plan.
    expect(accounts.roleIn(body.user.id, body.tenantId)).toBe("owner");
    expect(accounts.planOf(body.tenantId)).toBe("free");
  });

  it("refuses a weak password and a duplicate email", async () => {
    expect((await signup({ password: "short" })).statusCode).toBe(400);
    expect((await signup()).statusCode).toBe(201);

    const duplicate = await signup({ name: "Someone Else" });
    expect(duplicate.statusCode).toBe(400);
    expect(duplicate.json().error).toMatch(/already exists/);
  });

  it("treats email as case-insensitive so one person cannot get two accounts", async () => {
    await signup({ email: "Owner@Acme.test" });
    const duplicate = await signup({ email: "owner@acme.TEST" });
    expect(duplicate.statusCode).toBe(400);
  });

  it("does not set a Secure cookie over plain http, and does when configured", async () => {
    expect(String((await signup()).headers["set-cookie"])).not.toMatch(/Secure/);

    await app.close();
    app = createServer({
      config: { ...HOSTED, secureCookies: true },
      repository,
      analytics: new Analytics(db),
      accounts,
      imports,
    });
    const res = await signup({ email: "second@acme.test" });
    expect(String(res.headers["set-cookie"])).toMatch(/Secure/);
  });

  // ------------------------------------------------------------------- login

  it("logs in and out", async () => {
    await signup();

    const login = await app.inject({
      method: "POST",
      url: "/console/login",
      payload: { email: "owner@acme.test", password: "a-sufficiently-long-password" },
    });
    expect(login.statusCode).toBe(200);

    const cookie = cookieFrom(login);
    const me = await app.inject({ method: "GET", url: "/console/me", headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().organisations[0].tenantName).toBe("Acme");

    await app.inject({ method: "POST", url: "/console/logout", headers: { cookie } });
    // The session is revoked server-side, not merely cleared in the browser.
    const after = await app.inject({ method: "GET", url: "/console/me", headers: { cookie } });
    expect(after.statusCode).toBe(401);
  });

  it("gives the same answer for a wrong password and an unknown account", async () => {
    await signup();
    const wrongPassword = await app.inject({
      method: "POST",
      url: "/console/login",
      payload: { email: "owner@acme.test", password: "wrong-but-long-enough" },
    });
    const unknownEmail = await app.inject({
      method: "POST",
      url: "/console/login",
      payload: { email: "nobody@acme.test", password: "wrong-but-long-enough" },
    });

    // Identical status and message, so this cannot enumerate accounts.
    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownEmail.statusCode).toBe(401);
    expect(wrongPassword.json()).toEqual(unknownEmail.json());
  });

  it("rejects an expired session", async () => {
    const created = await signup();
    const userId = created.json().user.id;
    const expired = accounts.createSession(userId, -1_000);

    expect(accounts.resolveSession(expired.token)).toBeUndefined();
  });

  // --------------------------------------------------------------- isolation

  it("hides another organisation entirely", async () => {
    const acme = await signup();
    const other = await signup({ email: "other@other.test", organisation: "Other" });
    const acmeCookie = cookieFrom(acme);
    const otherTenant = other.json().tenantId;

    // 404, not 403 — a non-member should not learn the org exists.
    for (const url of [
      `/console/${otherTenant}/credentials`,
      `/console/${otherTenant}/keys`,
      `/console/${otherTenant}/billing`,
    ]) {
      const res = await app.inject({ method: "GET", url, headers: { cookie: acmeCookie } });
      expect(res.statusCode, url).toBe(404);
    }
  });

  it("stops a member from writing another organisation's credentials", async () => {
    const acme = await signup();
    const other = await signup({ email: "other@other.test", organisation: "Other" });

    const res = await app.inject({
      method: "PUT",
      url: `/console/${other.json().tenantId}/credentials/anthropic`,
      headers: { cookie: cookieFrom(acme) },
      payload: { apiKey: "sk-ant-stolen" },
    });

    expect(res.statusCode).toBe(404);
    expect(accounts.listCredentials(other.json().tenantId)).toHaveLength(0);
  });

  it("requires the owner role for administration", async () => {
    const acme = await signup();
    const tenantId = acme.json().tenantId;

    // A plain member of the same org.
    const memberSignup = await signup({ email: "member@acme.test", organisation: "Personal" });
    const memberId = memberSignup.json().user.id;
    accounts.addMember(tenantId, memberId, "member");

    const res = await app.inject({
      method: "GET",
      url: `/console/${tenantId}/credentials`,
      headers: { cookie: cookieFrom(memberSignup) },
    });
    expect(res.statusCode).toBe(403);
  });

  it("rejects a cross-origin state-changing request", async () => {
    const acme = await signup();
    const res = await app.inject({
      method: "PUT",
      url: `/console/${acme.json().tenantId}/credentials/anthropic`,
      headers: { cookie: cookieFrom(acme), origin: "https://evil.test", host: "costgrid.test" },
      payload: { apiKey: "sk-ant-forged" },
    });

    expect(res.statusCode).toBe(403);
    expect(accounts.listCredentials(acme.json().tenantId)).toHaveLength(0);
  });

  // -------------------------------------------------------------- credentials

  it("stores a provider key encrypted and never returns it", async () => {
    const acme = await signup();
    const tenantId = acme.json().tenantId;
    const cookie = cookieFrom(acme);

    const put = await app.inject({
      method: "PUT",
      url: `/console/${tenantId}/credentials/anthropic`,
      headers: { cookie },
      payload: { apiKey: "sk-ant-api03-the-real-secret" },
    });
    expect(put.statusCode).toBe(200);
    expect(put.body).not.toContain("the-real-secret");
    expect(put.json().hint).toBe("********cret");

    const list = await app.inject({
      method: "GET",
      url: `/console/${tenantId}/credentials`,
      headers: { cookie },
    });
    expect(list.body).not.toContain("the-real-secret");

    // Nor is it readable from the table.
    const row = db
      .prepare("SELECT encrypted_key AS k FROM provider_credentials WHERE tenant_id = ?")
      .get(tenantId) as { k: string };
    expect(row.k).not.toContain("the-real-secret");
    // …but the gateway can still recover it.
    expect(accounts.revealCredential(tenantId, "anthropic")?.apiKey).toBe(
      "sk-ant-api03-the-real-secret",
    );
  });

  it("refuses a plaintext base URL that would leak the key", async () => {
    const acme = await signup();
    const res = await app.inject({
      method: "PUT",
      url: `/console/${acme.json().tenantId}/credentials/anthropic`,
      headers: { cookie: cookieFrom(acme) },
      payload: { apiKey: "sk-ant-x", baseUrl: "http://proxy.evil.test" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/https/);
  });

  // ---------------------------------------------------------------- proxying

  it("spends each tenant's own credential, not the operator's", async () => {
    const acme = await signup();
    const other = await signup({ email: "other@other.test", organisation: "Other" });

    for (const [signupRes, key] of [
      [acme, "sk-ant-acme-key"],
      [other, "sk-ant-other-key"],
    ] as const) {
      await app.inject({
        method: "PUT",
        url: `/console/${signupRes.json().tenantId}/credentials/anthropic`,
        headers: { cookie: cookieFrom(signupRes) },
        payload: { apiKey: key },
      });
    }

    const acmeApiKey = repository.createApiKey(acme.json().tenantId, "a").plaintext;
    const otherApiKey = repository.createApiKey(other.json().tenantId, "b").plaintext;

    for (const key of [acmeApiKey, otherApiKey]) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: { "x-costgrid-key": key },
        payload: { model: "claude-opus-5", max_tokens: 10 },
      });
      expect(res.statusCode).toBe(200);
    }

    // The whole point of hosting: two tenants, two upstream credentials.
    expect(upstreamKeys).toEqual(["sk-ant-acme-key", "sk-ant-other-key"]);
  });

  it("refuses to proxy for a tenant with no credential", async () => {
    const acme = await signup();
    const apiKey = repository.createApiKey(acme.json().tenantId, "a").plaintext;

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-costgrid-key": apiKey },
      payload: { model: "claude-opus-5", max_tokens: 10 },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.type).toBe("provider_not_configured");
    expect(upstreamKeys).toHaveLength(0);
  });

  // ------------------------------------------------------------- rate limits

  it("enforces the plan's rate limit", async () => {
    const acme = await signup();
    const tenantId = acme.json().tenantId;
    await app.inject({
      method: "PUT",
      url: `/console/${tenantId}/credentials/anthropic`,
      headers: { cookie: cookieFrom(acme) },
      payload: { apiKey: "sk-ant-x" },
    });
    const apiKey = repository.createApiKey(tenantId, "a").plaintext;

    // Free plan allows 60/minute.
    let limited: number | undefined;
    for (let i = 0; i < 62; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: { "x-costgrid-key": apiKey },
        payload: { model: "claude-opus-5", max_tokens: 10 },
      });
      if (res.statusCode === 429) {
        limited = i;
        expect(res.headers["retry-after"]).toBeDefined();
        expect(res.json().error.type).toBe("rate_limit_error");
        break;
      }
    }

    expect(limited).toBe(60); // the 61st call
  });

  // ------------------------------------------------- session-authed dashboard

  it("lets a signed-in user read their own dashboard without an API key", async () => {
    const acme = await signup();
    const cookie = cookieFrom(acme);

    const res = await app.inject({ method: "GET", url: "/api/overview", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().calls).toBe(0);
  });

  it("refuses to SPEND on a session cookie, only to read", async () => {
    /*
     * Browsers attach cookies to cross-site requests. If the proxy accepted a
     * session, any page on the internet could POST to /v1/messages and burn a
     * logged-in user's tokens. Spending requires an API key, which a
     * cross-site page cannot obtain.
     */
    const acme = await signup();
    const tenantId = acme.json().tenantId;
    const cookie = cookieFrom(acme);

    await app.inject({
      method: "PUT",
      url: `/console/${tenantId}/credentials/anthropic`,
      headers: { cookie },
      payload: { apiKey: "sk-ant-victim-key" },
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { cookie },
      payload: { model: "claude-opus-5", max_tokens: 10 },
    });

    expect(res.statusCode).toBe(401);
    expect(upstreamKeys).toHaveLength(0); // nothing reached the provider
  });

  it("scopes a session-read dashboard to the user's own organisation", async () => {
    const acme = await signup();
    const other = await signup({ email: "other@other.test", organisation: "Other" });

    // A guessed tenant id in the query string resolves to nothing, so the
    // request falls back to the caller's own first membership.
    const res = await app.inject({
      method: "GET",
      url: `/api/overview?tenant=${other.json().tenantId}`,
      headers: { cookie: cookieFrom(acme) },
    });
    expect(res.statusCode).toBe(401);
  });

  // ---------------------------------------------------------- import

  it("imports history, prices it, and keeps it out of metered spend", async () => {
    const acme = await signup();
    const tenantId = acme.json().tenantId;
    const cookie = cookieFrom(acme);

    // Stub the provider's admin report for this one call.
    await app.close();
    app = createServer({
      config: HOSTED,
      repository,
      analytics: new Analytics(db),
      accounts,
      imports,
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                starting_at: "2026-06-01T00:00:00Z",
                results: [
                  {
                    model: "claude-opus-5",
                    uncached_input_tokens: 1_000_000,
                    output_tokens: 1_000_000,
                  },
                ],
              },
            ],
            has_more: false,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as unknown as typeof fetch,
    });

    const run = await app.inject({
      method: "POST",
      url: `/console/${tenantId}/import/anthropic`,
      headers: { cookie },
      payload: { adminKey: "sk-ant-admin-demo", days: 90 },
    });

    expect(run.statusCode).toBe(200);
    expect(run.json().rowsWritten).toBe(1);
    expect(run.json().unpricedModels).toEqual([]);
    // The admin key must not come back out, in any form.
    expect(run.body).not.toContain("sk-ant-admin-demo");

    // Imported history is visible...
    const apiKey = repository.createApiKey(tenantId, "reader").plaintext;
    const history = (
      await app.inject({
        method: "GET",
        url: "/api/history?days=365",
        headers: { "x-costgrid-key": apiKey },
      })
    ).json();
    expect(history.present).toBe(true);
    expect(history.effectiveCostUsd).toBe("30.000000"); // $5 + $25 per MTok

    // ...and has NOT been mixed into metered spend, which is still zero.
    const overview = (
      await app.inject({
        method: "GET",
        url: "/api/overview?days=365",
        headers: { "x-costgrid-key": apiKey },
      })
    ).json();
    expect(overview.calls).toBe(0);
    expect(overview.totalCostUsd).toBe("0.000000");
    expect(overview.hasImportedHistory).toBe(true);
  });

  it("never writes the admin key anywhere", async () => {
    const acme = await signup();
    const tenantId = acme.json().tenantId;

    await app.close();
    app = createServer({
      config: HOSTED,
      repository,
      analytics: new Analytics(db),
      accounts,
      imports,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ data: [], has_more: false }), { status: 200 })) as unknown as typeof fetch,
    });

    await app.inject({
      method: "POST",
      url: `/console/${tenantId}/import/anthropic`,
      headers: { cookie: cookieFrom(acme) },
      payload: { adminKey: "sk-ant-admin-super-secret", days: 30 },
    });

    // Sweep every text column in the database for the secret.
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    for (const { name } of tables) {
      const rows = db.prepare(`SELECT * FROM "${name}"`).all() as Record<string, unknown>[];
      expect(JSON.stringify(rows), name).not.toContain("super-secret");
    }
  });

  it("records a failed import instead of losing it silently", async () => {
    const acme = await signup();
    const tenantId = acme.json().tenantId;
    const cookie = cookieFrom(acme);

    await app.close();
    app = createServer({
      config: HOSTED,
      repository,
      analytics: new Analytics(db),
      accounts,
      imports,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: { message: "invalid admin key" } }), {
          status: 401,
        })) as unknown as typeof fetch,
    });

    const run = await app.inject({
      method: "POST",
      url: `/console/${tenantId}/import/anthropic`,
      headers: { cookie },
      payload: { adminKey: "wrong", days: 30 },
    });

    expect(run.statusCode).toBe(502);
    expect(run.json().error).toMatch(/invalid admin key/);

    const state = (
      await app.inject({ method: "GET", url: `/console/${tenantId}/import`, headers: { cookie } })
    ).json();
    expect(state.runs[0].status).toBe("error");
    expect(state.hasImports).toBe(false);
  });

  it("keeps one organisation's imported history from another", async () => {
    const acme = await signup();
    const other = await signup({ email: "other@other.test", organisation: "Other" });

    const res = await app.inject({
      method: "POST",
      url: `/console/${other.json().tenantId}/import/anthropic`,
      headers: { cookie: cookieFrom(acme) },
      payload: { adminKey: "sk-ant-admin-x" },
    });
    expect(res.statusCode).toBe(404);
  });

  // ---------------------------------------------------------------- billing

  it("reports the invoice basis with our fee separate from their spend", async () => {
    const acme = await signup();
    const tenantId = acme.json().tenantId;
    const cookie = cookieFrom(acme);
    accounts.setPlan(tenantId, "team");

    await app.inject({
      method: "PUT",
      url: `/console/${tenantId}/credentials/anthropic`,
      headers: { cookie },
      payload: { apiKey: "sk-ant-x" },
    });
    const apiKey = repository.createApiKey(tenantId, "a").plaintext;
    await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-costgrid-key": apiKey },
      payload: { model: "claude-opus-5", max_tokens: 10 },
    });

    const billing = (
      await app.inject({ method: "GET", url: `/console/${tenantId}/billing`, headers: { cookie } })
    ).json();

    expect(billing.plan.id).toBe("team");
    expect(billing.meteredSpendUsd).toBe("0.017500"); // their AI spend
    expect(billing.baseUsd).toBe("99.00"); // our subscription
    expect(billing.spendFeeUsd).toBe("0.000350"); // 2% of theirs
    expect(billing.totalUsd).toBe("99.000350");
  });

  it("changes plan, and rejects an unknown one", async () => {
    const acme = await signup();
    const tenantId = acme.json().tenantId;
    const cookie = cookieFrom(acme);

    const ok = await app.inject({
      method: "PUT",
      url: `/console/${tenantId}/plan`,
      headers: { cookie },
      payload: { plan: "business" },
    });
    expect(ok.statusCode).toBe(200);
    expect(accounts.planOf(tenantId)).toBe("business");

    const bad = await app.inject({
      method: "PUT",
      url: `/console/${tenantId}/plan`,
      headers: { cookie },
      payload: { plan: "enterprise" },
    });
    expect(bad.statusCode).toBe(400);
  });

  // ---------------------------------------------------------------- api keys

  it("mints and revokes gateway API keys", async () => {
    const acme = await signup();
    const tenantId = acme.json().tenantId;
    const cookie = cookieFrom(acme);

    const created = await app.inject({
      method: "POST",
      url: `/console/${tenantId}/keys`,
      headers: { cookie },
      payload: { name: "ci-pipeline" },
    });
    expect(created.statusCode).toBe(201);
    const { id, key } = created.json();
    expect(key).toMatch(/^cg_live_/);

    // Listing never returns the secret again.
    const listed = await app.inject({
      method: "GET",
      url: `/console/${tenantId}/keys`,
      headers: { cookie },
    });
    expect(listed.body).not.toContain(key);
    expect(listed.json().keys[0].name).toBe("ci-pipeline");

    await app.inject({ method: "DELETE", url: `/console/${tenantId}/keys/${id}`, headers: { cookie } });
    expect(repository.resolveApiKey(key)).toBeUndefined();
  });

  it("will not revoke a key belonging to another organisation", async () => {
    const acme = await signup();
    const other = await signup({ email: "other@other.test", organisation: "Other" });
    const victim = repository.createApiKey(other.json().tenantId, "theirs");

    const res = await app.inject({
      method: "DELETE",
      url: `/console/${acme.json().tenantId}/keys/${victim.id}`,
      headers: { cookie: cookieFrom(acme) },
    });

    expect(res.statusCode).toBe(404);
    expect(repository.resolveApiKey(victim.plaintext)).toBeDefined(); // still live
  });
});

describe("self-hosted mode", () => {
  it("serves no control plane", async () => {
    const db = openDatabase({ path: ":memory:" });
    const app = createServer({
      config: {
        ...HOSTED,
        hosted: false,
        providerKeys: { anthropic: "sk-ant-operator" },
        masterKeySecret: undefined,
      },
      repository: new CostGridRepository(db),
      analytics: new Analytics(db),
    });

    // Signup must not exist where there are no accounts to create.
    const res = await app.inject({ method: "POST", url: "/console/signup", payload: {} });
    expect(res.statusCode).toBe(404);

    await app.close();
    db.close();
  });

  it("refuses to start hosted without the control-plane repositories", () => {
    const db = openDatabase({ path: ":memory:" });
    expect(() =>
      createServer({
        config: HOSTED,
        repository: new CostGridRepository(db),
        analytics: new Analytics(db),
      imports: new ImportsRepository(db),
      }),
    ).toThrow(/hosted mode requires/);
    db.close();
  });
});
