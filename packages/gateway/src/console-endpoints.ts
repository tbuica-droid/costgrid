import { ENDPOINT_ID, usd } from "@costgrid/core";
import { type AccountsRepository, type Db, type Destination, EndpointsRepository, isDestination } from "@costgrid/db";
import type { FastifyInstance, FastifyReply } from "fastify";
import { type ConsoleRequest, createGuards } from "./console.js";
import { assertPublicUrl } from "./outbound-guard.js";

/**
 * Open models and where each agent may be sent, on the console (v3, phase 3).
 *
 * An owner connects an endpoint (any service that accepts OpenAI-format
 * requests), lists the models it serves with their prices and where those
 * prices came from, and opts each agent in to the destinations its calls may
 * be routed to. Nothing is routed anywhere new until an agent is opted in and
 * a route rule says so.
 *
 * Every input is checked here, at the write boundary. Hosted, an endpoint must
 * be a public https address; a desktop or self-hosted install may point at
 * this computer, which is where a self-run model usually lives.
 */

export interface EndpointsDeps {
  readonly db: Db;
  readonly accounts: AccountsRepository;
  readonly hosted: boolean;
  readonly masterKey: Buffer | undefined;
}

/** Prices are typed in dollars per million tokens, up to nine decimals. */
const PRICE = /^\d{1,6}(\.\d{1,9})?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

async function checkUrl(raw: unknown, hosted: boolean): Promise<string> {
  if (typeof raw !== "string" || raw.length > 500) throw new Error("the address must be a URL");
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("the address must be a URL, like https://api.together.xyz/v1");
  }
  if (url.username !== "" || url.password !== "") throw new Error("put the key in the key field, not in the address");
  if (hosted) await assertPublicUrl(url);
  else if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("the address must start with https:// or http://");
  return url.toString().replace(/\/+$/, "");
}

function price(raw: unknown, what: string): bigint | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string" || !PRICE.test(raw.trim())) throw new Error(`${what} must be dollars per million tokens, like 0.88`);
  return usd(raw.trim());
}

export function registerEndpoints(app: FastifyInstance, deps: EndpointsDeps): void {
  const { accounts, db, hosted } = deps;
  const { requireRole } = createGuards(accounts);
  const endpoints = new EndpointsRepository(db, deps.masterKey);
  const bad = (reply: FastifyReply, error: string) => reply.code(400).send({ error });
  const by = (user: { id: string; email: string }) => ({ kind: "user" as const, id: user.id, label: user.email });

  const view = (tenantId: string) => {
    const destinations = endpoints.allDestinations(tenantId);
    const agents = db
      .prepare("SELECT id, name FROM agents WHERE tenant_id = ? ORDER BY COALESCE(name, id) LIMIT 500")
      .all(tenantId) as { id: string; name: string | null }[];
    return {
      endpoints: endpoints.list(tenantId).map((e) => ({
        ...e,
        models: endpoints.models(tenantId, e.id).map((m) => ({
          id: m.id,
          model: m.model,
          inputPerMUsd: m.price === undefined ? null : (Number(m.price.inputPerM) / 1e9).toString(),
          outputPerMUsd: m.price === undefined ? null : (Number(m.price.outputPerM) / 1e9).toString(),
          cachedInputPerMUsd:
            m.price?.cachedInputPerM === undefined ? null : (Number(m.price.cachedInputPerM) / 1e9).toString(),
          priceSource: m.priceSource,
          pricedOn: m.pricedOn,
        })),
      })),
      agents: agents.map((a) => ({ ...a, destinations: destinations.get(a.id) ?? [] })),
    };
  };

  app.get("/console/:tenantId/endpoints", async (request: ConsoleRequest, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    if (!requireRole(request, reply, tenantId)) return;
    return view(tenantId);
  });

  app.put("/console/:tenantId/endpoints/:id", async (request: ConsoleRequest, reply) => {
    const { tenantId, id } = request.params as { tenantId: string; id: string };
    const actor = requireRole(request, reply, tenantId, "owner");
    if (!actor) return;
    if (!ENDPOINT_ID.test(id)) return bad(reply, "the endpoint's short name must be lower-case letters, digits and hyphens");
    const body = (request.body ?? {}) as Record<string, unknown>;
    const name = typeof body["name"] === "string" ? body["name"].trim() : "";
    if (name === "" || name.length > 80 || CONTROL.test(name)) return bad(reply, "give the endpoint a name of up to 80 characters");
    let baseUrl: string;
    try {
      baseUrl = await checkUrl(body["baseUrl"], hosted);
    } catch (error) {
      return bad(reply, error instanceof Error ? error.message : "that address cannot be used");
    }
    const key = body["apiKey"];
    if (key !== undefined && key !== null && (typeof key !== "string" || key.length > 500 || CONTROL.test(key))) {
      return bad(reply, "the key must be text on one line");
    }
    if (typeof key === "string" && key !== "" && deps.masterKey === undefined) {
      return bad(reply, "this install cannot store keys");
    }
    endpoints.put(tenantId, {
      id,
      name,
      baseUrl,
      // A new key replaces the stored one, null removes it, and leaving it blank keeps it.
      ...(key === null ? { apiKey: null } : typeof key === "string" && key !== "" ? { apiKey: key } : {}),
    });
    // The address, never the key.
    accounts.audit.record(tenantId, { actor: by(actor.user), action: "endpoint.saved", subject: id, detail: { name, baseUrl } });
    return view(tenantId);
  });

  app.delete("/console/:tenantId/endpoints/:id", async (request: ConsoleRequest, reply) => {
    const { tenantId, id } = request.params as { tenantId: string; id: string };
    const actor = requireRole(request, reply, tenantId, "owner");
    if (!actor) return;
    if (!endpoints.remove(tenantId, id)) return reply.code(404).send({ error: "no such endpoint" });
    accounts.audit.record(tenantId, { actor: by(actor.user), action: "endpoint.removed", subject: id, detail: {} });
    return view(tenantId);
  });

  /** A model an endpoint serves, with the owner's prices and where they came from. */
  app.put("/console/:tenantId/endpoints/:id/models", async (request: ConsoleRequest, reply) => {
    const { tenantId, id } = request.params as { tenantId: string; id: string };
    const actor = requireRole(request, reply, tenantId, "owner");
    if (!actor) return;
    if (!endpoints.list(tenantId).some((e) => e.id === id)) return reply.code(404).send({ error: "no such endpoint" });
    const body = (request.body ?? {}) as Record<string, unknown>;
    const model = typeof body["model"] === "string" ? body["model"].trim() : "";
    if (!MODEL.test(model)) return bad(reply, "the model must be its name at the endpoint, like meta-llama/Llama-3.3-70B-Instruct-Turbo");
    let input: bigint | undefined;
    let output: bigint | undefined;
    let cached: bigint | undefined;
    try {
      input = price(body["inputPerMUsd"], "the input price");
      output = price(body["outputPerMUsd"], "the output price");
      cached = price(body["cachedInputPerMUsd"], "the cached input price");
    } catch (error) {
      return bad(reply, (error as Error).message);
    }
    if ((input === undefined) !== (output === undefined)) return bad(reply, "give both an input and an output price, or neither");
    const source = typeof body["priceSource"] === "string" ? body["priceSource"].trim() : "";
    const pricedOn = typeof body["pricedOn"] === "string" ? body["pricedOn"].trim() : "";
    if (input !== undefined) {
      // A price nobody can check is the decay the catalog's provenance rule exists to prevent.
      if (source === "" || source.length > 300 || CONTROL.test(source)) return bad(reply, "say where the prices come from, such as the host's pricing page");
      if (!DATE.test(pricedOn)) return bad(reply, "give the date you read the prices, as YYYY-MM-DD");
    }
    endpoints.putModel(tenantId, {
      endpointId: id,
      model,
      ...(input !== undefined && output !== undefined
        ? { price: { inputPerM: input, outputPerM: output, ...(cached !== undefined ? { cachedInputPerM: cached } : {}) } }
        : {}),
      ...(input !== undefined ? { priceSource: source, pricedOn } : {}),
    });
    accounts.audit.record(tenantId, {
      actor: by(actor.user),
      action: "endpoint.model",
      subject: `${id}/${model}`,
      detail: { priced: input !== undefined, source: input !== undefined ? source : null, pricedOn: input !== undefined ? pricedOn : null },
    });
    return view(tenantId);
  });

  app.delete("/console/:tenantId/endpoints/:id/models", async (request: ConsoleRequest, reply) => {
    const { tenantId, id } = request.params as { tenantId: string; id: string };
    const actor = requireRole(request, reply, tenantId, "owner");
    if (!actor) return;
    const model = String(((request.query ?? {}) as Record<string, unknown>)["model"] ?? "");
    if (!endpoints.removeModel(tenantId, id, model)) return reply.code(404).send({ error: "no such model" });
    accounts.audit.record(tenantId, { actor: by(actor.user), action: "endpoint.model-removed", subject: `${id}/${model}`, detail: {} });
    return view(tenantId);
  });

  /** Where an agent's calls may be routed beyond its own provider. */
  app.put("/console/:tenantId/agents/:agentId/destinations", async (request: ConsoleRequest, reply) => {
    const { tenantId, agentId } = request.params as { tenantId: string; agentId: string };
    const actor = requireRole(request, reply, tenantId, "owner");
    if (!actor) return;
    const raw = ((request.body ?? {}) as Record<string, unknown>)["destinations"];
    if (!Array.isArray(raw) || raw.length > 50 || !raw.every(isDestination)) {
      return bad(reply, "destinations must be a list of openai, anthropic or open:<endpoint>");
    }
    const known = new Set(endpoints.list(tenantId).map((e) => `open:${e.id}`));
    const unknown = (raw as Destination[]).find((d) => d.startsWith("open:") && !known.has(d));
    if (unknown !== undefined) return bad(reply, `${unknown} is not a connected endpoint`);
    const exists = db.prepare("SELECT 1 FROM agents WHERE tenant_id = ? AND id = ?").get(tenantId, agentId);
    if (exists === undefined) return reply.code(404).send({ error: "agent not found" });
    endpoints.setDestinations(tenantId, agentId, raw as Destination[]);
    accounts.audit.record(tenantId, {
      actor: by(actor.user),
      action: "agent.destinations",
      subject: agentId,
      detail: { destinations: (raw as string[]).join(",") },
    });
    return view(tenantId);
  });
}
