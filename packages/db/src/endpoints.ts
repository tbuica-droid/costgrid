import {
  decryptSecret,
  encryptSecret,
  maskSecret,
  type Nanodollars,
  type OpenModelPrice,
  openModelId,
  parseOpenModel,
} from "@costgrid/core";
import type { Db } from "./database.js";

/**
 * Open-model endpoints, the models they serve with the owner's prices, and
 * which destinations each agent has opted in to.
 *
 * An endpoint's key is encrypted under the master key, like a provider key,
 * and only `reveal` returns it, for the upstream call. A destination is
 * `openai`, `anthropic` or `open:<endpoint>`; an agent with none is never sent
 * anywhere but its own provider.
 */

export interface Endpoint {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly keyHint: string | null;
  readonly updatedAt: number;
}

export interface EndpointModel {
  readonly endpointId: string;
  readonly model: string;
  /** `open:<endpoint>/<model>`, the id calls and rules use. */
  readonly id: string;
  readonly price: OpenModelPrice | undefined;
  readonly priceSource: string | null;
  readonly pricedOn: string | null;
}

export type Destination = "openai" | "anthropic" | `open:${string}`;

export function isDestination(value: unknown): value is Destination {
  return value === "openai" || value === "anthropic" || (typeof value === "string" && /^open:[a-z0-9][a-z0-9-]{0,39}$/.test(value));
}

/** The destination a model belongs to: its provider, or its endpoint. */
export function destinationOf(model: string, provider: string | undefined): Destination | undefined {
  const open = parseOpenModel(model);
  if (open !== undefined) return `open:${open.endpoint}`;
  return provider === "openai" || provider === "anthropic" ? provider : undefined;
}

export class EndpointsRepository {
  readonly #db: Db;
  readonly #masterKey: Buffer | undefined;

  /** Without a master key, endpoints that need a key cannot be saved or used. */
  constructor(db: Db, masterKey?: Buffer) {
    this.#db = db;
    this.#masterKey = masterKey;
  }

  /** Insert or replace an endpoint. `apiKey` undefined keeps the stored key; null removes it. */
  put(tenantId: string, e: { id: string; name: string; baseUrl: string; apiKey?: string | null }, at = Date.now()): void {
    const existing = this.#db
      .prepare("SELECT encrypted_key AS k, key_hint AS h FROM model_endpoints WHERE tenant_id = ? AND id = ?")
      .get(tenantId, e.id) as { k: string | null; h: string | null } | undefined;
    let encrypted = existing?.k ?? null;
    let hint = existing?.h ?? null;
    if (e.apiKey === null) {
      encrypted = null;
      hint = null;
    } else if (e.apiKey !== undefined) {
      if (this.#masterKey === undefined) throw new Error("a master key is needed to store an endpoint key");
      encrypted = encryptSecret(e.apiKey, this.#masterKey);
      hint = maskSecret(e.apiKey);
    }
    this.#db
      .prepare(
        `INSERT INTO model_endpoints (tenant_id, id, name, base_url, encrypted_key, key_hint, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id, id) DO UPDATE SET
           name = excluded.name, base_url = excluded.base_url,
           encrypted_key = excluded.encrypted_key, key_hint = excluded.key_hint, updated_at = excluded.updated_at`,
      )
      .run(tenantId, e.id, e.name, e.baseUrl, encrypted, hint, at, at);
  }

  list(tenantId: string): Endpoint[] {
    return this.#db
      .prepare(
        `SELECT id, name, base_url AS baseUrl, key_hint AS keyHint, updated_at AS updatedAt
         FROM model_endpoints WHERE tenant_id = ? ORDER BY name`,
      )
      .all(tenantId) as Endpoint[];
  }

  remove(tenantId: string, id: string): boolean {
    return this.#db.transaction(() => {
      this.#db.prepare("DELETE FROM endpoint_models WHERE tenant_id = ? AND endpoint_id = ?").run(tenantId, id);
      this.#db.prepare("DELETE FROM agent_providers WHERE tenant_id = ? AND destination = ?").run(tenantId, `open:${id}`);
      return this.#db.prepare("DELETE FROM model_endpoints WHERE tenant_id = ? AND id = ?").run(tenantId, id).changes === 1;
    })();
  }

  /** The address and key for an upstream call. The only method that returns the key. */
  reveal(tenantId: string, id: string): { baseUrl: string; apiKey: string | undefined } | undefined {
    const row = this.#db
      .prepare("SELECT base_url AS baseUrl, encrypted_key AS k FROM model_endpoints WHERE tenant_id = ? AND id = ?")
      .get(tenantId, id) as { baseUrl: string; k: string | null } | undefined;
    if (row === undefined) return undefined;
    if (row.k !== null && this.#masterKey === undefined) return undefined;
    return { baseUrl: row.baseUrl, apiKey: row.k === null ? undefined : decryptSecret(row.k, this.#masterKey!) };
  }

  // --------------------------------------------------------------- models

  putModel(
    tenantId: string,
    m: {
      endpointId: string;
      model: string;
      price?: OpenModelPrice | undefined;
      priceSource?: string | undefined;
      pricedOn?: string | undefined;
    },
    at = Date.now(),
  ): void {
    this.#db
      .prepare(
        `INSERT INTO endpoint_models
           (tenant_id, endpoint_id, model, input_per_m, output_per_m, cached_input_per_m, price_source, priced_on, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id, endpoint_id, model) DO UPDATE SET
           input_per_m = excluded.input_per_m, output_per_m = excluded.output_per_m,
           cached_input_per_m = excluded.cached_input_per_m, price_source = excluded.price_source,
           priced_on = excluded.priced_on, updated_at = excluded.updated_at`,
      )
      .run(
        tenantId,
        m.endpointId,
        m.model,
        m.price?.inputPerM ?? null,
        m.price?.outputPerM ?? null,
        m.price?.cachedInputPerM ?? null,
        m.priceSource ?? null,
        m.pricedOn ?? null,
        at,
      );
  }

  removeModel(tenantId: string, endpointId: string, model: string): boolean {
    return (
      this.#db
        .prepare("DELETE FROM endpoint_models WHERE tenant_id = ? AND endpoint_id = ? AND model = ?")
        .run(tenantId, endpointId, model).changes === 1
    );
  }

  models(tenantId: string, endpointId?: string): EndpointModel[] {
    const rows = this.#db
      .prepare(
        `SELECT endpoint_id AS endpointId, model, input_per_m AS i, output_per_m AS o, cached_input_per_m AS c,
                price_source AS priceSource, priced_on AS pricedOn
         FROM endpoint_models WHERE tenant_id = ? ${endpointId === undefined ? "" : "AND endpoint_id = ?"}
         ORDER BY endpoint_id, model`,
      )
      .safeIntegers(true)
      .all(...(endpointId === undefined ? [tenantId] : [tenantId, endpointId])) as {
      endpointId: string;
      model: string;
      i: bigint | null;
      o: bigint | null;
      c: bigint | null;
      priceSource: string | null;
      pricedOn: string | null;
    }[];
    return rows.map((r) => ({
      endpointId: r.endpointId,
      model: r.model,
      id: openModelId(r.endpointId, r.model),
      price:
        r.i === null || r.o === null
          ? undefined
          : { inputPerM: r.i as Nanodollars, outputPerM: r.o as Nanodollars, ...(r.c !== null ? { cachedInputPerM: r.c } : {}) },
      priceSource: r.priceSource,
      pricedOn: r.pricedOn,
    }));
  }

  /** The owner's price for `open:<endpoint>/<model>`, or undefined when it has none. */
  priceOf(tenantId: string, id: string): OpenModelPrice | undefined {
    const open = parseOpenModel(id);
    if (open === undefined) return undefined;
    return this.models(tenantId, open.endpoint).find((m) => m.model === open.model)?.price;
  }

  // -------------------------------------------------------------- opt-in

  destinations(tenantId: string, agentId: string): Destination[] {
    return (
      this.#db
        .prepare("SELECT destination FROM agent_providers WHERE tenant_id = ? AND agent_id = ? ORDER BY destination")
        .all(tenantId, agentId) as { destination: Destination }[]
    ).map((r) => r.destination);
  }

  allDestinations(tenantId: string): Map<string, Destination[]> {
    const out = new Map<string, Destination[]>();
    for (const r of this.#db
      .prepare("SELECT agent_id AS agentId, destination FROM agent_providers WHERE tenant_id = ?")
      .all(tenantId) as { agentId: string; destination: Destination }[]) {
      out.set(r.agentId, [...(out.get(r.agentId) ?? []), r.destination]);
    }
    return out;
  }

  /** Replace an agent's opt-ins. */
  setDestinations(tenantId: string, agentId: string, destinations: readonly Destination[], at = Date.now()): void {
    this.#db.transaction(() => {
      this.#db.prepare("DELETE FROM agent_providers WHERE tenant_id = ? AND agent_id = ?").run(tenantId, agentId);
      const insert = this.#db.prepare(
        "INSERT INTO agent_providers (tenant_id, agent_id, destination, created_at) VALUES (?, ?, ?, ?)",
      );
      for (const d of new Set(destinations)) insert.run(tenantId, agentId, d, at);
    })();
  }
}
