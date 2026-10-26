import {
  type AccountsRepository,
  describeVerification,
  domainOf,
  MIN_AUDIT_DAYS,
  type SsoConnection,
  SESSION_TTL_MS,
} from "@costgrid/db";
import { hashPassword } from "@costgrid/core";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { GatewayConfig } from "./config.js";
import { type ConsoleRequest, createGuards, setSessionCookie } from "./console.js";
import {
  buildAuthorizeUrl,
  createPkcePair,
  discover,
  exchangeCode,
  randomToken,
  verifyIdToken,
} from "./oidc.js";

/**
 * The console routes a security review asks for: the audit log, single sign-on
 * and data retention.
 *
 * Split from `console.ts` for length rather than for any deeper reason. They
 * authenticate the same way, guard the same way, and are registered together.
 *
 * One rule runs through all of them: an owner may configure how their
 * organisation is governed, and may not quietly undo the record of having done
 * so. Every write here writes an audit entry, and the audit routes themselves
 * are read and verify only. Deleting audit history takes a command run by a
 * person with access to the machine, not a button in a browser.
 */

export interface SecurityDeps {
  readonly config: GatewayConfig;
  readonly accounts: AccountsRepository;
  readonly fetchImpl?: typeof fetch | undefined;
}

/** Where the identity provider sends the browser back to. */
const CALLBACK_PATH = "/console/sso/callback";

function originOf(request: ConsoleRequest, config: GatewayConfig): string {
  if (config.publicUrl !== undefined) return config.publicUrl;
  // Falling back to the request means the redirect follows whatever Host the
  // browser used. The identity provider still matches it against the list the
  // customer registered, so a forged Host fails there rather than here, but
  // the failure is confusing. COSTGRID_PUBLIC_URL exists to avoid it.
  const host = request.headers.host ?? "localhost";
  return `${config.secureCookies ? "https" : "http"}://${host}`;
}

function publicView(connection: SsoConnection): Record<string, unknown> {
  return {
    issuer: connection.issuer,
    clientId: connection.clientId,
    clientSecretHint: connection.secretHint,
    authorizeUrl: connection.authorizeUrl,
    tokenUrl: connection.tokenUrl,
    jwksUrl: connection.jwksUrl,
    emailDomains: connection.emailDomains,
    autoProvision: connection.autoProvision,
    enforced: connection.enforced,
    enabled: connection.enabled,
    updatedAt: connection.updatedAt,
  };
}

/** Errors are shown to the person in the browser, so they land as text. */
function signInFailure(reply: FastifyReply, message: string): FastifyReply {
  return reply
    .code(400)
    .header("content-type", "text/plain; charset=utf-8")
    .send(`Sign-in could not be completed.\n\n${message}\n`);
}

export function registerSecurity(app: FastifyInstance, deps: SecurityDeps): void {
  const { accounts, config } = deps;
  const { audit, retention, sso } = accounts;
  const { requireRole } = createGuards(accounts);
  const doFetch = deps.fetchImpl ?? fetch;

  // ------------------------------------------------------------- audit log

  app.get("/console/:tenantId/audit", async (request: ConsoleRequest, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    if (!requireRole(request, reply, tenantId, "owner")) return;

    const query = request.query as Record<string, unknown>;
    // Refused rather than ignored: a filter that silently fell away would hand
    // back the whole log as if it were the answer to the question asked.
    const number = (value: unknown): number | undefined | null => {
      if (value === undefined) return undefined;
      const parsed = Number(value);
      return typeof value === "string" && value !== "" && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
    };
    const from = number(query["from"]);
    const to = number(query["to"]);
    const limit = number(query["limit"]);
    if (from === null || to === null || limit === null) {
      return reply.code(400).send({ error: "from, to and limit must be whole numbers" });
    }
    const action = query["action"];
    if (action !== undefined && (typeof action !== "string" || !/^[a-z0-9.-]{1,64}$/.test(action))) {
      return reply.code(400).send({ error: "action must be an audit action, like policy.created" });
    }

    return {
      entries: audit.list(tenantId, { from, to, action, limit }),
      head: audit.head(tenantId),
    };
  });

  /**
   * Check the chain and say whether it holds.
   *
   * Deliberately readable by any member, not just an owner. An audit log whose
   * integrity only the administrator can check is worth less than one anybody
   * in the organisation can, and the result contains no detail, only whether
   * it verified.
   */
  app.get("/console/:tenantId/audit/verify", async (request: ConsoleRequest, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    if (!requireRole(request, reply, tenantId)) return;

    const result = audit.verify(tenantId);
    // Said in words too, because "intact: true" is not what a person filling
    // in a security questionnaire needs to copy into it.
    return { ...result, summary: describeVerification(result) };
  });

  // ------------------------------------------------------------- retention

  app.get("/console/:tenantId/retention", async (request: ConsoleRequest, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    if (!requireRole(request, reply, tenantId, "owner")) return;

    const settings = retention.settingsOf(tenantId);
    return {
      ...settings,
      minimumAuditDays: MIN_AUDIT_DAYS,
      note:
        "Zero means keep indefinitely. Deleting call detail removes it from every " +
        "report, including months already sent out.",
    };
  });

  app.put("/console/:tenantId/retention", async (request: ConsoleRequest, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const actor = requireRole(request, reply, tenantId, "owner");
    if (!actor) return;

    const body = request.body as Record<string, unknown> | undefined;
    const days = (field: string): number | undefined =>
      typeof body?.[field] === "number" ? (body[field] as number) : undefined;

    try {
      return retention.set(
        tenantId,
        { callDays: days("callDays"), eventDays: days("eventDays"), auditDays: days("auditDays") },
        { kind: "user", id: actor.user.id, label: actor.user.email },
      );
    } catch (error) {
      return reply
        .code(400)
        .send({ error: error instanceof Error ? error.message : "could not save" });
    }
  });

  /**
   * Apply the policy now rather than waiting for the nightly run.
   *
   * Exists because the first thing anyone does after setting a retention
   * window is want to see it take effect, and because a support question
   * about it should not require shell access.
   */
  app.post("/console/:tenantId/retention/purge", async (request: ConsoleRequest, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    if (!requireRole(request, reply, tenantId, "owner")) return;
    return retention.purge(tenantId);
  });

  // ----------------------------------------------------------------- sso

  app.get("/console/:tenantId/sso", async (request: ConsoleRequest, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    if (!requireRole(request, reply, tenantId, "owner")) return;

    const connection = sso.get(tenantId);
    return {
      configured: connection !== undefined,
      connection: connection ? publicView(connection) : null,
      // Given here because it is the value the customer must paste into their
      // identity provider, and getting it wrong is the single most common way
      // an OIDC setup fails.
      redirectUri: `${originOf(request, config)}${CALLBACK_PATH}`,
    };
  });

  /**
   * Resolve a provider's endpoints from its issuer.
   *
   * Done once here rather than on every sign-in, so a login never waits on the
   * provider's metadata endpoint and a changed discovery document cannot
   * silently move the token endpoint somewhere else.
   */
  app.post("/console/:tenantId/sso/discover", async (request: ConsoleRequest, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    if (!requireRole(request, reply, tenantId, "owner")) return;

    const body = request.body as Record<string, unknown> | undefined;
    const issuer = typeof body?.["issuer"] === "string" ? body["issuer"].trim() : "";
    if (issuer === "") return reply.code(400).send({ error: "issuer is required" });

    try {
      return await discover(issuer, doFetch);
    } catch (error) {
      return reply
        .code(400)
        .send({ error: error instanceof Error ? error.message : "could not read the issuer" });
    }
  });

  app.put("/console/:tenantId/sso", async (request: ConsoleRequest, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const actor = requireRole(request, reply, tenantId, "owner");
    if (!actor) return;

    const body = (request.body ?? {}) as Record<string, unknown>;
    const text = (field: string): string =>
      typeof body[field] === "string" ? (body[field] as string).trim() : "";
    const flag = (field: string): boolean | undefined =>
      typeof body[field] === "boolean" ? (body[field] as boolean) : undefined;

    const domains = Array.isArray(body["emailDomains"])
      ? (body["emailDomains"] as unknown[]).filter((d): d is string => typeof d === "string")
      : text("emailDomains").split(/[,\s]+/);

    try {
      const saved = sso.put(tenantId, {
        issuer: text("issuer"),
        clientId: text("clientId"),
        clientSecret: text("clientSecret"),
        authorizeUrl: text("authorizeUrl"),
        tokenUrl: text("tokenUrl"),
        jwksUrl: text("jwksUrl"),
        emailDomains: domains,
        autoProvision: flag("autoProvision"),
        enforced: flag("enforced"),
        enabled: flag("enabled"),
      });

      audit.record(tenantId, {
        actor: { kind: "user", id: actor.user.id, label: actor.user.email },
        action: "sso.configured",
        subject: saved.issuer,
        // The secret is not here, and neither is a hint of it. A masked tail
        // in an audit log is a masked tail in every export of that log.
        detail: {
          clientId: saved.clientId,
          emailDomains: saved.emailDomains.join(","),
          autoProvision: saved.autoProvision,
          enforced: saved.enforced,
          enabled: saved.enabled,
        },
      });

      return publicView(saved);
    } catch (error) {
      return reply
        .code(400)
        .send({ error: error instanceof Error ? error.message : "could not save" });
    }
  });

  app.delete("/console/:tenantId/sso", async (request: ConsoleRequest, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const actor = requireRole(request, reply, tenantId, "owner");
    if (!actor) return;

    const existing = sso.get(tenantId);
    sso.delete(tenantId);
    audit.record(tenantId, {
      actor: { kind: "user", id: actor.user.id, label: actor.user.email },
      action: "sso.removed",
      subject: existing?.issuer ?? tenantId,
      detail: {},
    });
    return { ok: true };
  });

  // ----------------------------------------------------- signing in by sso

  /**
   * Begin a sign-in.
   *
   * Takes an email address and answers with where to send the browser. It
   * answers the same way whether or not the address has an account, because a
   * different answer would turn this into a way to test whether someone works
   * at a customer.
   */
  app.post("/console/sso/start", async (request: ConsoleRequest, reply) => {
    const body = request.body as Record<string, unknown> | undefined;
    const email = typeof body?.["email"] === "string" ? body["email"].trim().toLowerCase() : "";

    const connection = email === "" ? undefined : sso.forEmail(email);
    if (!connection) {
      return reply.code(404).send({
        error: "that address is not set up for single sign-on",
      });
    }

    const state = randomToken();
    const nonce = randomToken();
    const pkce = createPkcePair();
    const redirectUri = `${originOf(request, config)}${CALLBACK_PATH}`;

    sso.beginRequest(connection.tenantId, {
      state,
      nonce,
      codeVerifier: pkce.verifier,
      redirectUri,
    });

    return {
      redirectTo: buildAuthorizeUrl(connection, {
        redirectUri,
        state,
        nonce,
        codeChallenge: pkce.challenge,
      }),
    };
  });

  /**
   * Finish a sign-in.
   *
   * The order matters. The pending request is consumed first, so a replayed
   * callback finds nothing even if everything after it would have passed. The
   * token is then verified against the provider's keys, and only then is the
   * email matched to the organisation.
   */
  app.get(CALLBACK_PATH, async (request: ConsoleRequest, reply) => {
    const query = request.query as Record<string, string | undefined>;

    if (typeof query["error"] === "string") {
      return signInFailure(reply, `Your identity provider reported: ${query["error"]}`);
    }

    const state = query["state"];
    const code = query["code"];
    if (typeof state !== "string" || typeof code !== "string") {
      return signInFailure(reply, "The response was missing its state or code.");
    }

    const pending = sso.consumeRequest(state);
    if (!pending) {
      return signInFailure(
        reply,
        "This sign-in has already been used or has expired. Start again.",
      );
    }

    const connection = sso.get(pending.tenantId);
    if (!connection || !connection.enabled) {
      return signInFailure(reply, "Single sign-on is no longer enabled for that organisation.");
    }

    const clientSecret = sso.revealSecret(pending.tenantId);
    if (clientSecret === undefined) {
      return signInFailure(reply, "That connection is not fully configured.");
    }

    let identity: { email: string; name: string };
    try {
      const idToken = await exchangeCode(
        connection,
        { code, redirectUri: pending.redirectUri, codeVerifier: pending.codeVerifier, clientSecret },
        doFetch,
      );
      identity = await verifyIdToken(
        idToken,
        {
          issuer: connection.issuer,
          clientId: connection.clientId,
          nonce: pending.nonce,
          jwksUrl: connection.jwksUrl,
        },
        { fetchImpl: doFetch },
      );
    } catch (error) {
      // A failure here is recorded: a burst of them is what an attack on this
      // route looks like from the inside.
      audit.record(pending.tenantId, {
        actor: { kind: "system", id: "sso", label: "single sign-on" },
        action: "auth.sso-failed",
        subject: connection.issuer,
        detail: { reason: error instanceof Error ? error.message : "unknown" },
      });
      return signInFailure(
        reply,
        error instanceof Error ? error.message : "The identity could not be verified.",
      );
    }

    let provisioned: { userId: string; created: boolean };
    try {
      provisioned = sso.provision(connection, identity, hashPassword);
    } catch (error) {
      audit.record(pending.tenantId, {
        actor: { kind: "system", id: "sso", label: "single sign-on" },
        action: "auth.sso-rejected",
        subject: identity.email,
        detail: { reason: error instanceof Error ? error.message : "unknown" },
      });
      return signInFailure(
        reply,
        error instanceof Error ? error.message : "That account may not sign in here.",
      );
    }

    audit.record(pending.tenantId, {
      actor: { kind: "user", id: provisioned.userId, label: identity.email },
      action: provisioned.created ? "auth.sso-provisioned" : "auth.sso-signed-in",
      subject: identity.email,
      detail: { issuer: connection.issuer },
    });

    const session = accounts.createSession(provisioned.userId, SESSION_TTL_MS);
    setSessionCookie(reply, session.token, session.expiresAt, config.secureCookies);
    return reply.redirect("/console");
  });

  // ---------------------------------------------------------------- lookup

  /**
   * Whether an address must use single sign-on.
   *
   * The sign-in page asks this before showing a password field, so someone at
   * an organisation that has enforced SSO is not offered a box that will
   * refuse them. It reveals only what that person's own employer has already
   * decided, for an address they have just typed.
   */
  app.post("/console/sso/lookup", async (request: ConsoleRequest) => {
    const body = request.body as Record<string, unknown> | undefined;
    const email = typeof body?.["email"] === "string" ? body["email"].trim().toLowerCase() : "";
    const connection = domainOf(email) === undefined ? undefined : sso.forEmail(email);

    return {
      available: connection !== undefined,
      required: connection?.enforced === true,
    };
  });
}
