import {
  type AccountsRepository,
  Analytics,
  type CostGridRepository,
  type Role,
  SESSION_TTL_MS,
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
}

interface ConsoleRequest extends FastifyRequest {
  user?: User | undefined;
}

function readCookie(request: FastifyRequest, name: string): string | undefined {
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

function setSessionCookie(
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

function clearSessionCookie(reply: FastifyReply, secure: boolean): void {
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
function sameOrigin(request: FastifyRequest): boolean {
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

export function registerConsole(app: FastifyInstance, deps: ConsoleDeps): void {
  const { accounts, analytics, config, repository } = deps;
  const secure = config.secureCookies;

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
   * Never trusts a tenant id on its own — otherwise any signed-in user could
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

  // -------------------------------------------------------------- accounts

  app.post("/console/signup", async (request, reply) => {
    const body = request.body as Record<string, unknown> | undefined;
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
      created = accounts.signUp({ email, name, password, organisation });
    } catch (error) {
      return reply
        .code(400)
        .send({ error: error instanceof Error ? error.message : "could not create account" });
    }

    const session = accounts.createSession(created.user.id);
    setSessionCookie(reply, session.token, session.expiresAt, secure);

    return reply.code(201).send({
      user: { id: created.user.id, email: created.user.email, name: created.user.name },
      tenantId: created.tenantId,
    });
  });

  app.post("/console/login", async (request, reply) => {
    const body = request.body as Record<string, unknown> | undefined;
    const email = typeof body?.["email"] === "string" ? body["email"] : "";
    const password = typeof body?.["password"] === "string" ? body["password"] : "";

    const user = accounts.authenticate(email, password);
    if (!user) {
      // One message for both causes, so this cannot enumerate accounts.
      return reply.code(401).send({ error: "email or password is incorrect" });
    }

    const session = accounts.createSession(user.id, SESSION_TTL_MS);
    setSessionCookie(reply, session.token, session.expiresAt, secure);
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
    if (!requireRole(request, reply, tenantId, "owner")) return;

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
    // Echo only the mask. The key never travels back out of the server.
    return reply.code(200).send({ provider: stored.provider, hint: stored.hint });
  });

  app.delete("/console/:tenantId/credentials/:provider", async (request: ConsoleRequest, reply) => {
    const { tenantId, provider } = request.params as { tenantId: string; provider: string };
    if (!requireRole(request, reply, tenantId, "owner")) return;

    accounts.deleteCredential(tenantId, provider as Provider);
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
    if (!requireRole(request, reply, tenantId, "owner")) return;

    const body = request.body as Record<string, unknown> | undefined;
    const name = typeof body?.["name"] === "string" ? body["name"].trim() : "";
    if (name === "") return reply.code(400).send({ error: "name is required" });

    const created = repository.createApiKey(tenantId, name);
    // The only time the plaintext is ever returned.
    return reply.code(201).send({ id: created.id, key: created.plaintext, name });
  });

  app.delete("/console/:tenantId/keys/:keyId", async (request: ConsoleRequest, reply) => {
    const { tenantId, keyId } = request.params as { tenantId: string; keyId: string };
    if (!requireRole(request, reply, tenantId, "owner")) return;

    if (!repository.listApiKeys(tenantId).some((k) => k.id === keyId)) {
      return reply.code(404).send({ error: "key not found" });
    }
    repository.revokeApiKey(keyId);
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
        spendFeeBps: invoice.plan.spendFeeBps,
        includedCallsPerMonth: invoice.plan.includedCallsPerMonth,
        rateLimitPerMinute: invoice.plan.rateLimitPerMinute,
        seats: invoice.plan.seats,
      },
      period: window,
      // Kept as separate lines: what the customer's AI cost them, and what
      // CostGrid charges for governing it, are different numbers.
      meteredSpendUsd: toUsdString(invoice.meteredSpend, 6),
      calls: invoice.calls,
      baseUsd: toUsdString(invoice.base, 2),
      spendFeeUsd: toUsdString(invoice.spendFee, 6),
      totalUsd: toUsdString(invoice.total, 6),
      overageCalls: invoice.overageCalls,
      withinAllowance: invoice.withinAllowance,
      availablePlans: Object.values(PLANS).map((p) => ({
        id: p.id,
        name: p.name,
        monthlyBaseUsd: toUsdString(p.monthlyBase, 2),
        spendFeeBps: p.spendFeeBps,
        includedCallsPerMonth: p.includedCallsPerMonth,
        rateLimitPerMinute: p.rateLimitPerMinute,
      })),
    };
  });

  app.put("/console/:tenantId/plan", async (request: ConsoleRequest, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    if (!requireRole(request, reply, tenantId, "owner")) return;

    const body = request.body as Record<string, unknown> | undefined;
    const plan = typeof body?.["plan"] === "string" ? body["plan"] : "";
    if (!isPlanId(plan)) return reply.code(400).send({ error: `unknown plan: ${plan}` });

    // No payment processor is wired up: this records the intent, and an
    // operator collects. Charging a card is a real-world action that belongs
    // behind an explicit integration, not a PUT.
    accounts.setPlan(tenantId, plan);
    return { plan, note: "Plan recorded. Billing is invoiced manually in this release." };
  });
}

export { SESSION_COOKIE, maskSecret };
