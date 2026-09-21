import { createHash, createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import {
  AccountsRepository,
  Analytics,
  CostGridRepository,
  type Db,
  ImportsRepository,
  openDatabase,
} from "@costgrid/db";
import { deriveMasterKey } from "@costgrid/core";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GatewayConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import { verifyIdToken } from "../src/oidc.js";

/**
 * Single sign-on, end to end, against tokens signed with a real key.
 *
 * A mocked verifier would prove nothing here: the entire value of this feature
 * is that a token which should be refused is refused, so every test below
 * signs a genuine JWT and then breaks exactly one thing about it.
 */

const MASTER_SECRET = "a-master-secret-long-enough-to-derive-a-key-from-safely";
const ISSUER = "https://login.example.test/v2.0";
const CLIENT_ID = "costgrid-client";
const CLIENT_SECRET = "client-secret-value";
const KID = "test-key-1";

const HOSTED: GatewayConfig = {
  port: 0,
  host: "127.0.0.1",
  databasePath: ":memory:",
  providerKeys: {},
  providerBaseUrls: {},
  upstreamTimeoutMs: 5000,
  injectUsageRequest: true,
  extractTools: true,
  allowAnonymous: false,
  hosted: true,
  masterKeySecret: MASTER_SECRET,
  secureCookies: false,
  publicUrl: "http://costgrid.test",
  logLevel: "silent",
};

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

function base64url(value: string | Buffer): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Sign a JWT with the test key, or with whatever is passed instead. */
function signJwt(
  claims: Record<string, unknown>,
  options: { alg?: string; kid?: string | undefined; key?: KeyObject } = {},
): string {
  const header = { alg: options.alg ?? "RS256", typ: "JWT", kid: options.kid ?? KID };
  const body = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  if ((options.alg ?? "RS256") === "none") return `${body}.`;

  const signer = createSign("sha256");
  signer.update(body);
  return `${body}.${base64url(signer.sign(options.key ?? privateKey))}`;
}

const JWKS = {
  keys: [{ ...publicKey.export({ format: "jwk" }), kid: KID, use: "sig", alg: "RS256" }],
};

describe("single sign-on", () => {
  let db: Db;
  let app: FastifyInstance;
  let accounts: AccountsRepository;
  let ownerCookie: string;
  let tenantId: string;

  /** The claims a well-behaved identity provider would return. */
  let claimsFor: (nonce: string, over?: Record<string, unknown>) => Record<string, unknown>;
  /** What the token endpoint hands back next. Tests replace it to misbehave. */
  let nextIdToken: (nonce: string) => string;
  let tokenEndpointStatus = 200;

  const cookieFrom = (res: { headers: Record<string, unknown> }): string =>
    String(res.headers["set-cookie"]).split(";")[0]!;

  /**
   * Stands in for the identity provider. Serves discovery, the token endpoint
   * and the key set, and nothing else.
   */
  const fakeIdp = (async (url: unknown, init?: RequestInit) => {
    const href = String(url);
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });

    if (href.endsWith("/.well-known/openid-configuration")) {
      return json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/keys`,
      });
    }
    if (href === `${ISSUER}/keys`) return json(JWKS);
    if (href === `${ISSUER}/token`) {
      if (tokenEndpointStatus !== 200) return json({ error: "invalid_grant" }, tokenEndpointStatus);
      const form = new URLSearchParams(String(init?.body ?? ""));
      // The provider checks PKCE. Mirroring that here is what makes the
      // verifier's half of it meaningful rather than decorative.
      const verifier = form.get("code_verifier") ?? "";
      const challenge = base64url(createHash("sha256").update(verifier).digest());
      const expected = pendingChallenge;
      if (expected !== undefined && challenge !== expected) {
        return json({ error: "invalid_code_verifier" }, 400);
      }
      return json({ id_token: nextIdToken(pendingNonce) });
    }
    throw new Error(`unexpected request to ${href}`);
  }) as unknown as typeof fetch;

  let pendingNonce = "";
  let pendingChallenge: string | undefined;

  /** Walk a sign-in as far as the redirect, and report the state and nonce. */
  async function startSignIn(email: string): Promise<{ state: string; status: number }> {
    const res = await app.inject({
      method: "POST",
      url: "/console/sso/start",
      payload: { email },
    });
    if (res.statusCode !== 200) return { state: "", status: res.statusCode };

    const target = new URL((res.json() as { redirectTo: string }).redirectTo);
    const state = target.searchParams.get("state")!;
    pendingNonce = target.searchParams.get("nonce")!;
    pendingChallenge = target.searchParams.get("code_challenge") ?? undefined;
    return { state, status: 200 };
  }

  beforeEach(async () => {
    db = openDatabase({ path: ":memory:" });
    accounts = new AccountsRepository(db, deriveMasterKey(MASTER_SECRET));
    tokenEndpointStatus = 200;

    claimsFor = (nonce, over = {}) => ({
      iss: ISSUER,
      aud: CLIENT_ID,
      sub: "idp-subject-1",
      email: "dana@acme.test",
      email_verified: true,
      name: "Dana Reed",
      nonce,
      exp: Math.floor(Date.now() / 1000) + 300,
      iat: Math.floor(Date.now() / 1000),
      ...over,
    });
    nextIdToken = (nonce) => signJwt(claimsFor(nonce));

    app = createServer({
      config: HOSTED,
      repository: new CostGridRepository(db),
      analytics: new Analytics(db),
      accounts,
      imports: new ImportsRepository(db),
      fetchImpl: fakeIdp,
    });

    const signup = await app.inject({
      method: "POST",
      url: "/console/signup",
      payload: {
        email: "owner@acme.test",
        name: "Owner",
        password: "a-long-enough-password",
        organisation: "Acme",
      },
    });
    ownerCookie = cookieFrom(signup);
    tenantId = (signup.json() as { tenantId: string }).tenantId;

    const configured = await app.inject({
      method: "PUT",
      url: `/console/${tenantId}/sso`,
      headers: { cookie: ownerCookie },
      payload: {
        issuer: ISSUER,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        authorizeUrl: `${ISSUER}/authorize`,
        tokenUrl: `${ISSUER}/token`,
        jwksUrl: `${ISSUER}/keys`,
        emailDomains: ["acme.test"],
      },
    });
    expect(configured.statusCode).toBe(200);
  });

  afterEach(async () => {
    await app?.close();
    db.close();
  });

  describe("configuring it", () => {
    it("never hands the client secret back out", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/console/${tenantId}/sso`,
        headers: { cookie: ownerCookie },
      });
      expect(res.body).not.toContain(CLIENT_SECRET);
      expect(res.json()).toMatchObject({ configured: true });
    });

    it("gives the redirect URI to register, from the configured public address", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/console/${tenantId}/sso`,
        headers: { cookie: ownerCookie },
      });
      expect((res.json() as { redirectUri: string }).redirectUri).toBe(
        "http://costgrid.test/console/sso/callback",
      );
    });

    it("refuses an endpoint that is not https", async () => {
      const res = await app.inject({
        method: "PUT",
        url: `/console/${tenantId}/sso`,
        headers: { cookie: ownerCookie },
        payload: {
          issuer: ISSUER,
          clientId: CLIENT_ID,
          clientSecret: CLIENT_SECRET,
          authorizeUrl: `${ISSUER}/authorize`,
          tokenUrl: "http://login.example.test/token",
          jwksUrl: `${ISSUER}/keys`,
          emailDomains: ["acme.test"],
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: expect.stringContaining("https") });
    });

    it("refuses a connection with no email domain", async () => {
      const res = await app.inject({
        method: "PUT",
        url: `/console/${tenantId}/sso`,
        headers: { cookie: ownerCookie },
        payload: {
          issuer: ISSUER,
          clientId: CLIENT_ID,
          clientSecret: CLIENT_SECRET,
          authorizeUrl: `${ISSUER}/authorize`,
          tokenUrl: `${ISSUER}/token`,
          jwksUrl: `${ISSUER}/keys`,
          emailDomains: [],
        },
      });
      expect(res.statusCode).toBe(400);
    });

    it("is owner-only", async () => {
      const res = await app.inject({ method: "GET", url: `/console/${tenantId}/sso` });
      expect(res.statusCode).toBe(401);
    });

    it("records the change without recording the secret", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/console/${tenantId}/audit?action=sso`,
        headers: { cookie: ownerCookie },
      });
      expect(res.body).not.toContain(CLIENT_SECRET);
      expect((res.json() as { entries: unknown[] }).entries).toHaveLength(1);
    });
  });

  describe("signing in", () => {
    it("admits somebody the provider vouches for, and creates their account", async () => {
      const { state } = await startSignIn("dana@acme.test");
      const res = await app.inject({
        method: "GET",
        url: `/console/sso/callback?state=${state}&code=auth-code`,
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers["location"]).toBe("/console");
      expect(String(res.headers["set-cookie"])).toContain("costgrid_session=");

      const user = accounts.findUserByEmail("dana@acme.test");
      expect(user).toBeDefined();
      expect(accounts.roleIn(user!.id, tenantId)).toBe("member");
    });

    it("records the sign-in in the audit log", async () => {
      const { state } = await startSignIn("dana@acme.test");
      await app.inject({ method: "GET", url: `/console/sso/callback?state=${state}&code=c` });

      const entries = accounts.audit.list(tenantId, { action: "auth" });
      expect(entries.map((e) => e.action)).toContain("auth.sso-provisioned");
      expect(accounts.audit.verify(tenantId).intact).toBe(true);
    });

    it("does not create a second account for somebody who already has one", async () => {
      const first = await startSignIn("dana@acme.test");
      await app.inject({ method: "GET", url: `/console/sso/callback?state=${first.state}&code=c` });
      const second = await startSignIn("dana@acme.test");
      await app.inject({ method: "GET", url: `/console/sso/callback?state=${second.state}&code=c` });

      const count = db
        .prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'dana@acme.test'")
        .get() as { n: number };
      expect(count.n).toBe(1);
      expect(accounts.audit.list(tenantId, { action: "auth.sso-signed-in" })).toHaveLength(1);
    });

    it("leaves a provisioned account unable to sign in with a password", async () => {
      const { state } = await startSignIn("dana@acme.test");
      await app.inject({ method: "GET", url: `/console/sso/callback?state=${state}&code=c` });

      // The stored hash is of a value nobody has ever seen, so there is no
      // password to guess rather than a check that could be forgotten.
      expect(accounts.authenticate("dana@acme.test", "")).toBeUndefined();
      const row = db
        .prepare("SELECT auth_source AS source FROM users WHERE email = 'dana@acme.test'")
        .get() as { source: string };
      expect(row.source).toBe("sso");
    });

    it("refuses an address outside the organisation's domains", async () => {
      // A genuine, correctly signed token for somebody who does not work here.
      // Every cryptographic check passes and the sign-in must still fail.
      nextIdToken = (nonce) => signJwt(claimsFor(nonce, { email: "mallory@elsewhere.test" }));
      const { state } = await startSignIn("dana@acme.test");

      const res = await app.inject({
        method: "GET",
        url: `/console/sso/callback?state=${state}&code=c`,
      });
      expect(res.statusCode).toBe(400);
      expect(accounts.findUserByEmail("mallory@elsewhere.test")).toBeUndefined();
    });

    it("refuses a second use of the same sign-in", async () => {
      const { state } = await startSignIn("dana@acme.test");
      const first = await app.inject({
        method: "GET",
        url: `/console/sso/callback?state=${state}&code=c`,
      });
      expect(first.statusCode).toBe(302);

      const replay = await app.inject({
        method: "GET",
        url: `/console/sso/callback?state=${state}&code=c`,
      });
      expect(replay.statusCode).toBe(400);
      expect(replay.body).toContain("already been used");
    });

    it("refuses a state this server never issued", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/console/sso/callback?state=invented&code=c",
      });
      expect(res.statusCode).toBe(400);
    });

    it("refuses an unknown address without saying whether it exists", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/console/sso/start",
        payload: { email: "nobody@elsewhere.test" },
      });
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain("acme");
    });

    it("passes the provider's refusal through rather than swallowing it", async () => {
      tokenEndpointStatus = 400;
      const { state } = await startSignIn("dana@acme.test");
      const res = await app.inject({
        method: "GET",
        url: `/console/sso/callback?state=${state}&code=c`,
      });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain("invalid_grant");
    });

    it("sends a code challenge the provider can check", async () => {
      // pendingChallenge is enforced by the fake provider, so reaching a
      // session at all means the verifier matched what was sent.
      const { state } = await startSignIn("dana@acme.test");
      expect(pendingChallenge).toBeTruthy();
      const res = await app.inject({
        method: "GET",
        url: `/console/sso/callback?state=${state}&code=c`,
      });
      expect(res.statusCode).toBe(302);
    });
  });

  describe("enforcement", () => {
    beforeEach(async () => {
      await app.inject({
        method: "PUT",
        url: `/console/${tenantId}/sso`,
        headers: { cookie: ownerCookie },
        payload: {
          issuer: ISSUER,
          clientId: CLIENT_ID,
          clientSecret: CLIENT_SECRET,
          authorizeUrl: `${ISSUER}/authorize`,
          tokenUrl: `${ISSUER}/token`,
          jwksUrl: `${ISSUER}/keys`,
          emailDomains: ["acme.test"],
          enforced: true,
        },
      });
    });

    it("refuses a password even when the password is right", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/console/login",
        payload: { email: "owner@acme.test", password: "a-long-enough-password" },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ sso: true });
    });

    it("tells the sign-in page which addresses must use it", async () => {
      const required = await app.inject({
        method: "POST",
        url: "/console/sso/lookup",
        payload: { email: "someone@acme.test" },
      });
      expect(required.json()).toEqual({ available: true, required: true });

      const other = await app.inject({
        method: "POST",
        url: "/console/sso/lookup",
        payload: { email: "someone@elsewhere.test" },
      });
      expect(other.json()).toEqual({ available: false, required: false });
    });
  });

  /**
   * Each of these is a token that would be accepted if one check were missing.
   * They are written against the verifier directly so the failure is
   * attributable to the check rather than to anything around it.
   */
  describe("tokens that must be refused", () => {
    const expect_ = {
      issuer: ISSUER,
      clientId: CLIENT_ID,
      nonce: "the-nonce",
      jwksUrl: `${ISSUER}/keys`,
    };
    const verify = (token: string): Promise<unknown> =>
      verifyIdToken(token, expect_, { fetchImpl: fakeIdp });

    it("accepts the good one, so the rest mean something", async () => {
      await expect(verify(signJwt(claimsFor("the-nonce")))).resolves.toMatchObject({
        email: "dana@acme.test",
      });
    });

    it("refuses an unsigned token claiming alg none", async () => {
      await expect(verify(signJwt(claimsFor("the-nonce"), { alg: "none" }))).rejects.toThrow(
        /not accepted/,
      );
    });

    it("refuses a token signed with a symmetric algorithm", async () => {
      // The public key is published. Accepting HS256 would let anyone holding
      // it forge a token by using it as the HMAC secret.
      await expect(verify(signJwt(claimsFor("the-nonce"), { alg: "HS256" }))).rejects.toThrow(
        /not accepted/,
      );
    });

    it("refuses a token signed by a key the provider does not publish", async () => {
      const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
      await expect(
        verify(signJwt(claimsFor("the-nonce"), { key: other.privateKey })),
      ).rejects.toThrow(/signature is not valid/);
    });

    it("refuses a token naming a key id that does not exist", async () => {
      await expect(
        verify(signJwt(claimsFor("the-nonce"), { kid: "some-other-key" })),
      ).rejects.toThrow(/does not publish/);
    });

    it("refuses a token from a different tenant of the same provider", async () => {
      await expect(
        verify(signJwt(claimsFor("the-nonce", { iss: "https://login.example.test/other/v2.0" }))),
      ).rejects.toThrow(/issued by/);
    });

    it("refuses a token issued for a different application", async () => {
      await expect(
        verify(signJwt(claimsFor("the-nonce", { aud: "some-other-app" }))),
      ).rejects.toThrow(/different application/);
    });

    it("refuses an expired token", async () => {
      const exp = Math.floor(Date.now() / 1000) - 3600;
      await expect(verify(signJwt(claimsFor("the-nonce", { exp })))).rejects.toThrow(/expired/);
    });

    it("refuses a token answering a different sign-in", async () => {
      await expect(verify(signJwt(claimsFor("a-different-nonce")))).rejects.toThrow(
        /does not answer/,
      );
    });

    it("refuses a token whose email the provider has not verified", async () => {
      await expect(
        verify(signJwt(claimsFor("the-nonce", { email_verified: false }))),
      ).rejects.toThrow(/not verified/);
    });

    it("refuses a token with no email at all", async () => {
      const claims = claimsFor("the-nonce");
      delete claims["email"];
      await expect(verify(signJwt(claims))).rejects.toThrow(/no email/);
    });

    it("accepts a token that simply omits email_verified", async () => {
      // Several major providers do not send it for directory accounts, where
      // the address is authoritative by definition. Refusing those would make
      // the feature unusable at exactly the customers who want it.
      const claims = claimsFor("the-nonce");
      delete claims["email_verified"];
      await expect(verify(signJwt(claims))).resolves.toMatchObject({ email: "dana@acme.test" });
    });
  });
});
