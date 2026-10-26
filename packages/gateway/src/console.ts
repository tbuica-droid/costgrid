import {
  type AccountsRepository,
  Analytics,
  type AuditActor,
  type CostGridRepository,
  type Role,
  SESSION_TTL_MS,
  SignupClosedError,
  trailingWindow,
  type User,
} from "@costgrid/db";
import {
  computeInvoice,
  isPlanId,
  maskSecret,
  MIN_PASSWORD_LENGTH,
  PLANS,
  type Provider,
  toUsdString,
} from "@costgrid/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { GatewayConfig } from "./config.js";
import { ADAPTERS } from "./providers/index.js";
import { AUTH_LIMITS, AUTH_WINDOW_MS, type RateLimitDecision, RateLimiter } from "./ratelimit.js";

/**
 * The hosted control plane: signup, login, org settings, credentials, billing.
 *
 * Distinct from `/api`, which serves the dashboard using an API key. These
 * routes are for humans in a browser and authenticate with a session cookie,
 * which brings a different threat model — hence the CSRF handling below.
 */

const SESSION_COOKIE = "costgrid_session";

export interface ConsoleDeps {
  readonly config: GatewayConfig;
  readonly accounts: AccountsRepository;
  readonly repository: CostGridRepository;
  readonly analytics: Analytics;
  /** Overridable so tests never reach a real provider. */
  readonly fetchImpl?: typeof fetch | undefined;
}

export interface ConsoleRequest extends FastifyRequest {
  user?: User | undefined;
}

export function readCookie(request: FastifyRequest, name: string): string | undefined {
  const header = request.headers.cookie;
  if (typeof header !== "string") return undefined;

  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) {
      return decodeURIComponent(part.slice(index + 1).trim());
    }
  }
  return undefined;
}

export function setSessionCookie(
  reply: FastifyReply,
  token: string,
  expiresAt: number,
  secure: boolean,
): void {
  const attributes = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    // Lax rather than Strict: the console is a normal web app and Strict
    // breaks arriving from an external link. Combined with the origin check
    // below, Lax is sufficient against cross-site form posts.
    "SameSite=Lax",
    `Expires=${new Date(expiresAt).toUTCString()}`,
  ];
  if (secure) attributes.push("Secure");
  reply.header("set-cookie", attributes.join("; "));
}

export function clearSessionCookie(reply: FastifyReply, secure: boolean): void {
  const attributes = [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  ];
  if (secure) attributes.push("Secure");
  reply.header("set-cookie", attributes.join("; "));
}

/**
 * Reject cross-site state-changing requests.
 *
 * Session cookies are sent by the browser on cross-origin form posts, so
 * `SameSite=Lax` alone does not cover every case. Requiring the request to
 * declare its own origin — and matching it to the Host it reached us on —
 * blocks the classic forged-form attack without a token round-trip.
 */
export function sameOrigin(request: FastifyRequest): boolean {
  // Fetch metadata, where the browser sends it, is the browser's own verdict
  // and covers a sibling subdomain that an Origin match on Host would not.
  const site = request.headers["sec-fetch-site"];
  if (site === "cross-site" || site === "same-site") return false;

  const origin = request.headers.origin;
  if (typeof origin !== "string") {
    // No Origin header: not a browser-initiated cross-site POST. Same-origin
    // fetch() always sends one, as does any cross-site form.
    return true;
  }
  const host = request.headers.host;
  if (typeof host !== "string") return false;

  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * Sign someone in: end whatever session this browser presented, then start a
 * new one. Rotating on every sign-in means a session id planted in the browser
 * beforehand is never the one that ends up authenticated.
 */
export function startSession(
  request: FastifyRequest,
  reply: FastifyReply,
  accounts: AccountsRepository,
  userId: string,
  secure: boolean,
): void {
  const previous = readCookie(request, SESSION_COOKIE);
  if (previous !== undefined) accounts.revokeSession(previous);
  const session = accounts.createSession(userId, SESSION_TTL_MS);
  setSessionCookie(reply, session.token, session.expiresAt, secure);
}

/** A 429 with the wait in Retry-After, the same shape on every auth route. */
export function tooManyAttempts(reply: FastifyReply, decision: RateLimitDecision): FastifyReply {
  return reply
    .code(429)
    .header("retry-after", String(decision.retryAfterSeconds))
    .send({ error: "too many attempts; wait a few minutes and try again" });
}

/**
 * A form field no person fills in. The console's form hides it; a bot filling
 * every input it finds does not know to leave it empty.
 */
export const HONEYPOT_FIELD = "website";

function trippedHoneypot(body: Record<string, unknown> | undefined): boolean {
  const value = body?.[HONEYPOT_FIELD];
  return typeof value === "string" ? value.trim() !== "" : value !== undefined && value !== null;
}

export function registerConsole(app: FastifyInstance, deps: ConsoleDeps): void {
  const { accounts, analytics, config, repository } = deps;
  const secure = config.secureCookies;
  const authLimiter = new RateLimiter(AUTH_WINDOW_MS);

  /** Resolve the session on every console request; does not itself reject. */
  app.addHook("preHandler", async (request: ConsoleRequest, reply) => {
    if (!request.url.startsWith("/console/")) return;

    if (request.method !== "GET" && request.method !== "HEAD" && !sameOrigin(request)) {
      return reply.code(403).send({ error: "cross-origin request rejected" });
    }

    const token = readCookie(request, SESSION_COOKIE);
    if (token === undefined) return;
    request.user = accounts.resolveSession(token)?.user;
  });

  const { requireUser, requireRole } = createGuards(accounts);
  const { audit, sso } = accounts;

  /** Shorthand for "this signed-in person did it", which is most entries. */
  const by = (user: User): AuditActor => ({ kind: "user", id: user.id, label: user.email });

  // -------------------------------------------------------------- accounts

  app.post("/console/signup", async (request, reply) => {
    const limit = authLimiter.check(`signup:${request.ip}`, AUTH_LIMITS.signupPerIp);
    if (!limit.allowed) return tooManyAttempts(reply, limit);

    const body = request.body as Record<string, unknown> | undefined;
    // Refused with the same message as any other bad signup, so a bot learns
    // nothing about which field gave it away.
    if (trippedHoneypot(body)) return reply.code(400).send({ error: "could not create account" });
    const email = typeof body?.["email"] === "string" ? body["email"] : "";
    const name = typeof body?.["name"] === "string" ? body["name"] : "";
    const password = typeof body?.["password"] === "string" ? body["password"] : "";
    const organisation =
      typeof body?.["organisation"] === "string" ? body["organisation"] : "";

    if (password.length < MIN_PASSWORD_LENGTH) {
      return reply
        .code(400)
        .send({ error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    }

    let created: { user: User; tenantId: string };
    try {
      created = accounts.signUp({ email, name, password, organisation }, { onlyAccount: config.desktop });
    } catch (error) {
      return reply
        .code(error instanceof SignupClosedError ? 403 : 400)
        .send({ error: error instanceof Error ? error.message : "could not create account" });
    }

    audit.record(created.tenantId, {
      actor: by(created.user),
      action: "organisation.created",
      subject: organisation,
      detail: { email: created.user.email, role: "owner" },
    });

    startSession(request, reply, accounts, created.user.id, secure);

    return reply.code(201).send({
      user: { id: created.user.id, email: created.user.email, name: created.user.name },
      tenantId: created.tenantId,
    });
  });

  app.post("/console/login", async (request, reply) => {
    const perIp = authLimiter.check(`login:${request.ip}`, AUTH_LIMITS.loginPerIp);
    if (!perIp.allowed) return tooManyAttempts(reply, perIp);

    const body = request.body as Record<string, unknown> | undefined;
    const email = typeof body?.["email"] === "string" ? body["email"] : "";
    const password = typeof body?.["password"] === "string" ? body["password"] : "";
    if (trippedHoneypot(body)) return reply.code(401).send({ error: "email or password is incorrect" });

    const accountKey = `login-failed:${email.trim().toLowerCase()}`;
    const locked = authLimiter.peek(accountKey, AUTH_LIMITS.loginFailuresPerAccount);
    if (!locked.allowed) return tooManyAttempts(reply, locked);

    // An organisation that has turned on single sign-on has decided passwords
    // are not an acceptable way in, and leaving this path open would make that
    // decision cosmetic. Checked before the password is verified, so a correct
    // password is refused just as firmly as a wrong one.
    const connection = sso.forEmail(email);
    if (connection?.enforced === true) {
      return reply.code(403).send({
        error: "your organisation requires single sign-on",
        sso: true,
      });
    }

    const user = accounts.authenticate(email, password);
    if (!user) {
      authLimiter.check(accountKey, AUTH_LIMITS.loginFailuresPerAccount);
      // Recorded where there is an organisation it belongs to. A run of these
      // is what an attack on an account looks like from the inside, and it is
      // one of the few things an audit log can show that nothing else does.
      const existing = accounts.findUserByEmail(email);
      if (existing) {
        for (const membership of accounts.membershipsOf(existing.id)) {
          audit.record(membership.tenantId, {
            actor: { kind: "user", id: existing.id, label: existing.email },
            action: "auth.sign-in-failed",
            subject: existing.email,
            detail: { method: "password" },
          });
        }
      }
      // One message for both causes, so this cannot enumerate accounts.
      return reply.code(401).send({ error: "email or password is incorrect" });
    }

    for (const membership of accounts.membershipsOf(user.id)) {
      audit.record(membership.tenantId, {
        actor: by(user),
        action: "auth.signed-in",
        subject: user.email,
        detail: { method: "password" },
      });
    }

    startSession(request, reply, accounts, user.id, secure);
    return { user: { id: user.id, email: user.email, name: user.name } };
  });

  app.post("/console/logout", async (request, reply) => {
    const token = readCookie(request, SESSION_COOKIE);
    if (token !== undefined) accounts.revokeSession(token);
    clearSessionCookie(reply, secure);
    return { ok: true };
  });

  app.get("/console/me", async (request: ConsoleRequest, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;

    return {
      user: { id: user.id, email: user.email, name: user.name },
      organisations: accounts.membershipsOf(user.id).map((m) => ({
        ...m,
        plan: accounts.planOf(m.tenantId),
      })),
    };
  });

  // ----------------------------------------------------------- credentials

  app.get("/console/:tenantId/credentials", async (request: ConsoleRequest, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    if (!requireRole(request, reply, tenantId, "owner")) return;

    const stored = accounts.listCredentials(tenantId);
    return {
      // Every provider CostGrid can proxy, with whether this org has a key.
      providers: ADAPTERS.map((adapter) => {
        const credential = stored.find((c) => c.provider === adapter.id);
        return {
          provider: adapter.id,
          path: adapter.path,
          configured: credential !== undefined,
          hint: credential?.hint ?? null,
          baseUrl: credential?.baseUrl ?? null,
          updatedAt: credential?.updatedAt ?? null,
        };
      }),
    };
  });

  app.put("/console/:tenantId/credentials/:provider", async (request: ConsoleRequest, reply) => {
    const { tenantId, provider } = request.params as { tenantId: string; provider: string };
    const actor = requireRole(request, reply, tenantId, "owner");
    if (!actor) return;

    if (!ADAPTERS.some((a) => a.id === provider)) {
      return reply.code(400).send({ error: `unknown provider: ${provider}` });
    }

    const body = request.body as Record<string, unknown> | undefined;
    const apiKey = typeof body?.["apiKey"] === "string" ? body["apiKey"].trim() : "";
    const baseUrl = typeof body?.["baseUrl"] === "string" ? body["baseUrl"].trim() : undefined;

    if (apiKey === "") return reply.code(400).send({ error: "apiKey is required" });
    if (baseUrl !== undefined && baseUrl !== "") {
      try {
        const parsed = new URL(baseUrl);
        // An http base URL would send the tenant's key in clear text.
        if (parsed.protocol !== "https:" && parsed.hostname !== "127.0.0.1") {
          return reply.code(400).send({ error: "baseUrl must be https" });
        }
      } catch {
        return reply.code(400).send({ error: "baseUrl is not a valid URL" });
      }
    }

    const stored = accounts.putCredential(
      tenantId,
      provider as Provider,
      apiKey,
      baseUrl === "" ? undefined : baseUrl,
    );
    audit.record(tenantId, {
      actor: by(actor.user),
      action: "credential.added",
      subject: provider,
      // Not even the mask. An audit log is exported, and a masked tail in an
      // export is a masked tail wherever that export ends up.
      detail: { baseUrl: baseUrl === "" ? null : (baseUrl ?? null) },
    });

    // Echo only the mask. The key never travels back out of the server.
    return reply.code(200).send({ provider: stored.provider, hint: stored.hint });
  });

  app.delete("/console/:tenantId/credentials/:provider", async (request: ConsoleRequest, reply) => {
    const { tenantId, provider } = request.params as { tenantId: string; provider: string };
    const actor = requireRole(request, reply, tenantId, "owner");
    if (!actor) return;

    accounts.deleteCredential(tenantId, provider as Provider);
    audit.record(tenantId, {
      actor: by(actor.user),
      action: "credential.removed",
      subject: provider,
      detail: {},
    });
    return { ok: true };
  });

  // -------------------------------------------------------------- api keys

  app.get("/console/:tenantId/keys", async (request: ConsoleRequest, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    if (!requireRole(request, reply, tenantId, "owner")) return;
    return { keys: repository.listApiKeys(tenantId) };
  });

  app.post("/console/:tenantId/keys", async (request: ConsoleRequest, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const actor = requireRole(request, reply, tenantId, "owner");
    if (!actor) return;

    const body = request.body as Record<string, unknown> | undefined;
    const name = typeof body?.["name"] === "string" ? body["name"].trim() : "";
    if (name === "") return reply.code(400).send({ error: "name is required" });

    const created = repository.createApiKey(tenantId, name);
    audit.record(tenantId, {
      actor: by(actor.user),
      action: "apikey.created",
      subject: created.id,
      detail: { name },
    });
    // The only time the plaintext is ever returned.
    return reply.code(201).send({ id: created.id, key: created.plaintext, name });
  });

  app.delete("/console/:tenantId/keys/:keyId", async (request: ConsoleRequest, reply) => {
    const { tenantId, keyId } = request.params as { tenantId: string; keyId: string };
    const actor = requireRole(request, reply, tenantId, "owner");
    if (!actor) return;

    if (!repository.listApiKeys(tenantId).some((k) => k.id === keyId)) {
      return reply.code(404).send({ error: "key not found" });
    }
    repository.revokeApiKey(keyId);
    audit.record(tenantId, {
      actor: by(actor.user),
      action: "apikey.revoked",
      subject: keyId,
      detail: {},
    });
    return { ok: true };
  });


  // --------------------------------------------------------------- billing

  app.get("/console/:tenantId/billing", async (request: ConsoleRequest, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    if (!requireRole(request, reply, tenantId, "owner")) return;

    const planId = accounts.planOf(tenantId);
    const window = trailingWindow(30);
    const summary = analytics.summary(tenantId, window);
    const invoice = computeInvoice(planId, summary.totalCost, summary.calls);

    return {
      plan: {
        id: invoice.plan.id,
        name: invoice.plan.name,
        monthlyBaseUsd: toUsdString(invoice.plan.monthlyBase, 2),
        rateLimitPerMinute: invoice.plan.rateLimitPerMinute,
      },
      period: window,
      // Kept as separate lines: what the customer's AI cost them, and what
      // CostGrid charges for governing it, are different numbers. The first
      // never feeds the second.
      meteredSpendUsd: toUsdString(invoice.meteredSpend, 6),
      calls: invoice.calls,
      totalUsd: toUsdString(invoice.total, 2),
      availablePlans: Object.values(PLANS).map((p) => ({
        id: p.id,
        name: p.name,
        monthlyBaseUsd: toUsdString(p.monthlyBase, 2),
        rateLimitPerMinute: p.rateLimitPerMinute,
      })),
    };
  });

  app.put("/console/:tenantId/plan", async (request: ConsoleRequest, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const actor = requireRole(request, reply, tenantId, "owner");
    if (!actor) return;

    const body = request.body as Record<string, unknown> | undefined;
    const plan = typeof body?.["plan"] === "string" ? body["plan"] : "";
    if (!isPlanId(plan)) return reply.code(400).send({ error: `unknown plan: ${plan}` });

    // No payment processor is wired up: this records the intent, and an
    // operator collects. Charging a card is a real-world action that belongs
    // behind an explicit integration, not a PUT.
    const previous = accounts.planOf(tenantId);
    accounts.setPlan(tenantId, plan);
    audit.record(tenantId, {
      actor: by(actor.user),
      action: "plan.changed",
      subject: plan,
      detail: { from: previous, to: plan },
    });
    return { plan, note: "Plan recorded. Billing is invoiced manually in this release." };
  });
}

/**
 * The two checks every console route starts with.
 *
 * Shared rather than duplicated because the security routes added alongside
 * this file need exactly the same rules, and a second copy of an
 * authorisation check is a second place for it to drift.
 */
export function createGuards(accounts: AccountsRepository): {
  requireUser: (request: ConsoleRequest, reply: FastifyReply) => User | undefined;
  requireRole: (
    request: ConsoleRequest,
    reply: FastifyReply,
    tenantId: string,
    minimum?: Role,
  ) => { user: User; role: Role } | undefined;
} {
  /** Routes past this point need a logged-in user. */
  function requireUser(request: ConsoleRequest, reply: FastifyReply): User | undefined {
    if (!request.user) {
      void reply.code(401).send({ error: "not signed in" });
      return undefined;
    }
    return request.user;
  }

  /**
   * Resolve the tenant from the request and confirm membership.
   *
   * Never trusts a tenant id on its own: otherwise any signed-in user could
   * administer any organisation by guessing an id.
   */
  function requireRole(
    request: ConsoleRequest,
    reply: FastifyReply,
    tenantId: string,
    minimum: Role = "member",
  ): { user: User; role: Role } | undefined {
    const user = requireUser(request, reply);
    if (!user) return undefined;

    const role = accounts.roleIn(user.id, tenantId);
    if (!role) {
      // 404 rather than 403: a non-member should not learn the org exists.
      void reply.code(404).send({ error: "organisation not found" });
      return undefined;
    }
    if (minimum === "owner" && role !== "owner") {
      void reply.code(403).send({ error: "this action requires the owner role" });
      return undefined;
    }
    return { user, role };
  }

  return { requireUser, requireRole };
}

export { SESSION_COOKIE, maskSecret };
