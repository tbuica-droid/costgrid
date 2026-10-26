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
import type { GatewayConfig } from "../src/config.js";
import { AUTH_LIMITS } from "../src/ratelimit.js";
import { createServer } from "../src/server.js";

const MASTER_SECRET = "test-master-key-long-enough-to-be-accepted-0123456789";
const PASSWORD = "a-sufficiently-long-password";

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

/**
 * The checks a security review walks through on the console: who may sign in
 * how often, what a session cookie looks like and how it ends, and that one
 * organisation cannot reach another's records by changing an id.
 */
describe("console auth hardening", () => {
  let db: ReturnType<typeof openDatabase>;
  let accounts: AccountsRepository;
  let repository: CostGridRepository;
  let app: FastifyInstance;

  const build = (config: GatewayConfig = HOSTED): FastifyInstance =>
    createServer({
      config,
      db,
      repository,
      analytics: new Analytics(db),
      accounts,
      imports: new ImportsRepository(db),
    });

  const cookieFrom = (res: { headers: Record<string, unknown> }): string =>
    String(res.headers["set-cookie"]).split(";")[0]!;

  const signup = (over: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
    app.inject({
      method: "POST",
      url: "/console/signup",
      headers,
      payload: {
        email: "owner@acme.test",
        name: "Owner",
        password: PASSWORD,
        organisation: "Acme",
        ...over,
      },
    });

  const login = (email: string, password: string, headers: Record<string, string> = {}) =>
    app.inject({ method: "POST", url: "/console/login", headers, payload: { email, password } });

  beforeEach(() => {
    db = openDatabase({ path: ":memory:" });
    accounts = new AccountsRepository(db, deriveMasterKey(MASTER_SECRET));
    repository = new CostGridRepository(db);
    app = build();
  });

  afterEach(async () => {
    await app?.close();
    db.close();
  });

  // ------------------------------------------------------------ rate limits

  it("locks an account after repeated wrong passwords, even against the right one", async () => {
    await signup();
    for (let i = 0; i < AUTH_LIMITS.loginFailuresPerAccount; i += 1) {
      expect((await login("owner@acme.test", "wrong-password-guess")).statusCode).toBe(401);
    }
    const locked = await login("owner@acme.test", PASSWORD);
    expect(locked.statusCode).toBe(429);
    expect(Number(locked.headers["retry-after"])).toBeGreaterThan(0);

    // Counted by the address typed, so another account is untouched.
    expect((await login("other@acme.test", "wrong-password-guess")).statusCode).toBe(401);
  });

  it("locks an address with no account the same way, so a lockout reveals nothing", async () => {
    for (let i = 0; i < AUTH_LIMITS.loginFailuresPerAccount; i += 1) {
      await login("nobody@acme.test", "wrong-password-guess");
    }
    expect((await login("nobody@acme.test", "wrong-password-guess")).statusCode).toBe(429);
  });

  it("limits login attempts per IP across many accounts", async () => {
    for (let i = 0; i < AUTH_LIMITS.loginPerIp; i += 1) {
      expect((await login(`user${i}@acme.test`, "wrong-password-guess")).statusCode).toBe(401);
    }
    expect((await login("fresh@acme.test", "wrong-password-guess")).statusCode).toBe(429);
  });

  it("limits signups per IP", async () => {
    for (let i = 0; i < AUTH_LIMITS.signupPerIp; i += 1) {
      expect((await signup({ email: `owner${i}@acme.test` })).statusCode).toBe(201);
    }
    expect((await signup({ email: "one-more@acme.test" })).statusCode).toBe(429);
  });

  // -------------------------------------------------------------- honeypot

  it("refuses a signup or login that fills the hidden field", async () => {
    const res = await signup({ website: "http://spam.test" });
    expect(res.statusCode).toBe(400);
    expect(accounts.findUserByEmail("owner@acme.test")).toBeUndefined();

    await signup();
    const bot = await app.inject({
      method: "POST",
      url: "/console/login",
      payload: { email: "owner@acme.test", password: PASSWORD, website: "x" },
    });
    expect(bot.statusCode).toBe(401);
    expect(bot.headers["set-cookie"]).toBeUndefined();
  });

  // ------------------------------------------------------- mass assignment

  it("ignores role, plan and tenant fields sent with a signup", async () => {
    const res = await signup({ plan: "enterprise", role: "member", tenantId: "chosen", id: "mine" });
    expect(res.statusCode).toBe(201);
    const { user, tenantId } = res.json() as { user: { id: string }; tenantId: string };
    expect(tenantId).not.toBe("chosen");
    expect(user.id).not.toBe("mine");
    expect(accounts.planOf(tenantId)).toBe("free");
    expect(accounts.roleIn(user.id, tenantId)).toBe("owner");
  });

  // -------------------------------------------------------------- passwords

  it("never sends a password or its hash back", async () => {
    const created = await signup();
    const signedIn = await login("owner@acme.test", PASSWORD);
    const me = await app.inject({
      method: "GET",
      url: "/console/me",
      headers: { cookie: cookieFrom(signedIn) },
    });
    for (const res of [created, signedIn, me]) {
      expect(res.body).not.toContain(PASSWORD);
      expect(res.body).not.toMatch(/scrypt|password/i);
    }
  });

  // --------------------------------------------------------------- sessions

  it("sets the session cookie HttpOnly, SameSite=Lax, with an expiry, and Secure when asked", async () => {
    const plain = String((await signup()).headers["set-cookie"]);
    expect(plain).toMatch(/HttpOnly/);
    expect(plain).toMatch(/SameSite=Lax/);
    expect(plain).toMatch(/Expires=/);
    expect(plain).not.toMatch(/Secure/);

    await app.close();
    app = build({ ...HOSTED, secureCookies: true });
    const secure = String((await login("owner@acme.test", PASSWORD)).headers["set-cookie"]);
    expect(secure).toMatch(/; Secure/);
  });

  it("issues a new session on sign-in and ends the one the browser had", async () => {
    const planted = cookieFrom(await signup());
    const res = await login("owner@acme.test", PASSWORD, { cookie: planted });
    const fresh = cookieFrom(res);
    expect(fresh).not.toBe(planted);

    const old = await app.inject({ method: "GET", url: "/console/me", headers: { cookie: planted } });
    expect(old.statusCode).toBe(401);
    const current = await app.inject({ method: "GET", url: "/console/me", headers: { cookie: fresh } });
    expect(current.statusCode).toBe(200);
  });

  it("ends the session on logout", async () => {
    const cookie = cookieFrom(await signup());
    await app.inject({ method: "POST", url: "/console/logout", headers: { cookie } });
    const after = await app.inject({ method: "GET", url: "/console/me", headers: { cookie } });
    expect(after.statusCode).toBe(401);
  });

  // ------------------------------------------------------------------- csrf

  it("refuses a cross-site state change, by Origin or by fetch metadata", async () => {
    const created = await signup();
    const cookie = cookieFrom(created);
    const tenantId = (created.json() as { tenantId: string }).tenantId;

    for (const headers of [
      { origin: "https://evil.test" },
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
    ]) {
      const res = await app.inject({
        method: "POST",
        url: `/console/${tenantId}/keys`,
        headers: { cookie, ...headers },
        payload: { name: "forged" },
      });
      expect(res.statusCode).toBe(403);
    }
    expect(repository.listApiKeys(tenantId)).toHaveLength(0);

    const ok = await app.inject({
      method: "POST",
      url: `/console/${tenantId}/keys`,
      headers: { cookie, "sec-fetch-site": "same-origin", origin: "https://app.test", host: "app.test" },
      payload: { name: "real" },
    });
    expect(ok.statusCode).toBe(201);
  });

  // ------------------------------------------------------- tenant isolation

  describe("between two organisations", () => {
    let acme: { cookie: string; tenantId: string };
    let globex: { cookie: string; tenantId: string; userId: string };

    beforeEach(async () => {
      const a = await signup();
      acme = { cookie: cookieFrom(a), tenantId: (a.json() as { tenantId: string }).tenantId };
      const g = await signup({ email: "owner@globex.test", organisation: "Globex" });
      const body = g.json() as { tenantId: string; user: { id: string } };
      globex = { cookie: cookieFrom(g), tenantId: body.tenantId, userId: body.user.id };
    });

    it("hides one organisation's records from the other", async () => {
      for (const path of ["keys", "credentials", "billing", "limits", "agents", "audit", "sso"]) {
        const res = await app.inject({
          method: "GET",
          url: `/console/${acme.tenantId}/${path}`,
          headers: { cookie: globex.cookie },
        });
        expect(res.statusCode, path).toBe(404);
      }
    });

    it("refuses an id from the other organisation under one's own", async () => {
      const key = repository.createApiKey(acme.tenantId, "acme-ci");
      const revoke = await app.inject({
        method: "DELETE",
        url: `/console/${globex.tenantId}/keys/${key.id}`,
        headers: { cookie: globex.cookie },
      });
      expect(revoke.statusCode).toBe(404);
      expect(repository.resolveApiKey(key.plaintext)).toBeDefined();

      const policy = repository.createPolicy(acme.tenantId, {
        name: "acme rule",
        scope: { kind: "tenant" },
        rule: { kind: "max-output-tokens", limit: 10 },
        action: "block",
        enabled: true,
      });
      const patch = await app.inject({
        method: "PATCH",
        url: `/console/${globex.tenantId}/limits/${policy}`,
        headers: { cookie: globex.cookie },
        payload: { enabled: false },
      });
      expect(patch.statusCode).toBe(404);
      const resume = await app.inject({
        method: "POST",
        url: `/console/${globex.tenantId}/resume/${policy}`,
        headers: { cookie: globex.cookie },
      });
      expect(resume.statusCode).toBe(404);
      expect(repository.listPolicies(acme.tenantId)[0]?.enabled).toBe(true);
    });

    it("keeps a member to reading on the dashboard API, and an owner to same-origin writes", async () => {
      const policy = repository.createPolicy(acme.tenantId, {
        name: "acme rule",
        scope: { kind: "tenant" },
        rule: { kind: "max-output-tokens", limit: 10 },
        action: "block",
        enabled: true,
      });
      // Globex's owner joins Acme as a member, and picks Acme by ?tenant=.
      accounts.addMember(acme.tenantId, globex.userId, "member");
      const read = await app.inject({
        method: "GET",
        url: `/api/policies?tenant=${acme.tenantId}`,
        headers: { cookie: globex.cookie },
      });
      expect(read.statusCode).toBe(200);
      const write = await app.inject({
        method: "PATCH",
        url: `/api/policies/${policy}?tenant=${acme.tenantId}`,
        headers: { cookie: globex.cookie },
        payload: { enabled: false },
      });
      expect(write.statusCode).toBe(401);

      const forged = await app.inject({
        method: "PATCH",
        url: `/api/policies/${policy}`,
        headers: { cookie: acme.cookie, "sec-fetch-site": "cross-site" },
        payload: { enabled: false },
      });
      expect(forged.statusCode).toBe(401);
      expect(repository.listPolicies(acme.tenantId)[0]?.enabled).toBe(true);

      const owner = await app.inject({
        method: "PATCH",
        url: `/api/policies/${policy}`,
        headers: { cookie: acme.cookie },
        payload: { enabled: false },
      });
      expect(owner.statusCode).toBe(200);
    });
  });
});
