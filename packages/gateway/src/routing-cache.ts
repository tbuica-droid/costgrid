import type { TaskKind } from "@costgrid/core";
import { type Db, type RouteChoice, RoutingRepository } from "@costgrid/db";

/**
 * The per-request routing table and cheap-first settings, held in memory for
 * the proxy (v3, phase 6). Read from the database at most once a minute, so
 * choosing a model per request adds a map lookup before forwarding, nothing
 * more. The table itself is built in the background (`RoutingRepository.buildAll`).
 */
export class RoutingCache {
  readonly #routing: RoutingRepository;
  readonly #maxAgeMs: number;
  #loadedAt = -Infinity;
  #steps = new Map<string, string>();
  #choices = new Map<string, RouteChoice>();

  constructor(db: Db, maxAgeMs = 60_000) {
    this.#routing = new RoutingRepository(db);
    this.#maxAgeMs = maxAgeMs;
  }

  #fresh(now: number): void {
    if (now - this.#loadedAt < this.#maxAgeMs) return;
    const { steps, choices } = this.#routing.forProxy();
    this.#steps = steps;
    this.#choices = choices;
    this.#loadedAt = now;
  }

  /** Forget what is cached, after a setting changes or the table is rebuilt. */
  invalidate(): void {
    this.#loadedAt = -Infinity;
  }

  choice(tenantId: string, agentId: string, kind: TaskKind, now = Date.now()): RouteChoice | undefined {
    this.#fresh(now);
    return this.#choices.get(`${tenantId}|${agentId}|${kind}`);
  }

  stepUp(tenantId: string, agentId: string, now = Date.now()): string | undefined {
    this.#fresh(now);
    return this.#steps.get(`${tenantId}|${agentId}`);
  }
}
