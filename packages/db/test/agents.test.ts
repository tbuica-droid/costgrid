import { priceUsage, usd, ZERO_USAGE } from "@costgrid/core";
import { beforeEach, describe, expect, it } from "vitest";
import {
  AgentsRepository,
  CostGridRepository,
  type Db,
  type ImportedRow,
  ImportsRepository,
  openDatabase,
  slugOf,
  SourcesRepository,
} from "../src/index.js";

/**
 * Agents and the sources they use.
 *
 * What matters most: a cost lands on one agent or none, a shared key's cost
 * on none, and imported usage is never added to metered calls.
 */

const T = "t1";
const RANGE = { from: "2026-06-01", to: "2026-06-30" };
const WINDOW = { fromDay: "2026-06-01", toDay: "2026-06-30" };

function row(cost: string, sourceId: string, reported?: string): ImportedRow {
  return {
    provider: "anthropic",
    day: "2026-06-02",
    model: "claude-opus-5",
    usage: { ...ZERO_USAGE, inputTokens: 1000 },
    requests: 0,
    costCatalog: usd(cost),
    priced: true,
    sourceKind: "key",
    sourceId,
    ...(reported !== undefined ? { costReported: usd(reported) } : {}),
  };
}

describe("AgentsRepository", () => {
  let db: Db;
  let agents: AgentsRepository;
  let sources: SourcesRepository;

  const key = (id: string) => ({ provider: "anthropic" as const, kind: "key" as const, id });

  beforeEach(() => {
    db = openDatabase({ path: ":memory:" });
    for (const t of [T, "t2"]) db.prepare("INSERT INTO tenants (id, name, created_at) VALUES (?, ?, 0)").run(t, t);
    agents = new AgentsRepository(db);
    sources = new SourcesRepository(db);
    sources.upsertSources(T, [key("apikey_a"), key("apikey_b"), key("apikey_c")], { first: "2026-06-02", last: "2026-06-02" });
    new ImportsRepository(db).putRows(
      T,
      "anthropic",
      WINDOW,
      [row("1.00", "apikey_a"), row("2.00", "apikey_b", "1.50"), row("4.00", "apikey_c")],
      "admin-api",
    );
  });

  it("makes readable ids from names, and never reuses one", () => {
    expect(slugOf("Support bot")).toBe("support-bot");
    expect(slugOf("  Café — leads!! ")).toBe("cafe-leads");
    expect(slugOf("???")).toBe("agent");
    expect(agents.create(T, { name: "Support bot" })).toBe("support-bot");
    expect(agents.create(T, { name: "Support Bot" })).toBe("support-bot-2");
    expect(agents.create("t2", { name: "Support bot" })).toBe("support-bot");
  });

  it("puts each source's cost on its agent, and the estimate apart", () => {
    const id = agents.create(T, { name: "Support bot", purposeId: "support", purposeVersion: "1" })!;
    expect(agents.assign(T, key("apikey_a"), { agentId: id, shared: false, by: "owner" })).toBe("ok");
    expect(agents.assign(T, key("apikey_b"), { agentId: id, shared: false, by: "owner" })).toBe("ok");

    const view = agents.view(T, RANGE);
    expect(view.agents).toHaveLength(1);
    expect(view.agents[0]).toMatchObject({
      id: "support-bot",
      name: "Support bot",
      purposeId: "support",
      purposeVersion: "1",
      origin: "owner",
      lastSeenAt: null,
      // $1.00 estimated + $1.50 reported by the provider (its $2.00 list price is not used).
      imported: { costNano: usd("2.50"), estimatedNano: usd("1.00") },
      metered: { costNano: 0n, calls: 0 },
    });
    expect(view.agents[0]!.sources.map((s) => s.id).sort()).toEqual(["apikey_a", "apikey_b"]);
    expect(view.unassigned.map((s) => s.id)).toEqual(["apikey_c"]);
  });

  it("keeps a shared key off every agent", () => {
    const id = agents.create(T, { name: "Writer" })!;
    expect(() => agents.assign(T, key("apikey_c"), { agentId: id, shared: true, by: "owner" })).toThrow();
    expect(agents.assign(T, key("apikey_c"), { agentId: null, shared: true, by: "owner" })).toBe("ok");

    const view = agents.view(T, RANGE);
    expect(view.shared.map((s) => s.id)).toEqual(["apikey_c"]);
    expect(view.agents).toEqual([expect.objectContaining({ id, imported: { costNano: 0n, estimatedNano: 0n } })]);

    // Putting it on an agent again clears the mark.
    agents.assign(T, key("apikey_c"), { agentId: id, shared: false, by: "owner" });
    expect(agents.view(T, RANGE).shared).toEqual([]);
  });

  it("refuses an agent or source that does not exist, or belongs to someone else", () => {
    const id = agents.create(T, { name: "Writer" })!;
    expect(agents.assign(T, key("apikey_a"), { agentId: "nobody", shared: false, by: "owner" })).toBe("no-agent");
    expect(agents.assign(T, key("apikey_404"), { agentId: id, shared: false, by: "owner" })).toBe("no-source");
    expect(agents.assign("t2", key("apikey_a"), { agentId: null, shared: false, by: "owner" })).toBe("no-source");
    expect(agents.update("t2", id, { name: "Mine now" })).toBe(false);
    expect(agents.remove("t2", id)).toBe(false);
    expect(agents.view("t2", RANGE)).toEqual({ agents: [], unassigned: [], shared: [], proxyOnly: [] });
  });

  it("reports metered calls beside imported usage, never added to it", () => {
    const repository = new CostGridRepository(db);
    const usage = { ...ZERO_USAGE, inputTokens: 1_000_000 };
    const priced = priceUsage("claude-opus-5", usage);
    repository.touchAgent(T, "classifier", "Ops");
    repository.recordCall({
      id: "c1", tenantId: T, agentId: "classifier", department: "Ops", provider: "anthropic",
      model: "claude-opus-5", startedAt: Date.UTC(2026, 5, 10), durationMs: 10, streamed: false, usage,
      cost: priced.cost, priced: priced.priced, outcome: "ok", runId: "c1", runDeclared: false, runDepth: 0,
    });

    // Seen by the proxy, not yet named: offered for linking rather than listed.
    let view = agents.view(T, RANGE);
    expect(view.agents).toEqual([]);
    expect(view.proxyOnly).toEqual([
      { id: "classifier", lastSeenAt: expect.any(Number), metered: { costNano: priced.cost.total, calls: 1 } },
    ]);

    expect(agents.create(T, { name: "Ticket sorter", linkProxyId: "classifier" })).toBe("classifier");
    expect(agents.create(T, { name: "Again", linkProxyId: "classifier" })).toBeUndefined();
    agents.assign(T, key("apikey_c"), { agentId: "classifier", shared: false, by: "owner" });

    view = agents.view(T, RANGE);
    expect(view.agents[0]).toMatchObject({
      id: "classifier",
      name: "Ticket sorter",
      origin: "proxy",
      imported: { costNano: usd("4.00"), estimatedNano: usd("4.00") },
      metered: { costNano: priced.cost.total, calls: 1 },
    });
    expect(view.proxyOnly).toEqual([]);
  });

  it("removes an owner's agent but only unnames one the proxy saw", () => {
    const owner = agents.create(T, { name: "Writer" })!;
    agents.assign(T, key("apikey_a"), { agentId: owner, shared: false, by: "owner" });
    new CostGridRepository(db).touchAgent(T, "classifier", "Ops");
    agents.create(T, { name: "Sorter", purposeId: "support", purposeVersion: "1", linkProxyId: "classifier" });
    agents.assign(T, key("apikey_b"), { agentId: "classifier", shared: false, by: "owner" });

    expect(agents.remove(T, owner)).toBe(true);
    expect(agents.remove(T, "classifier")).toBe(true);
    expect(agents.exists(T, owner)).toBe(false);
    expect(agents.exists(T, "classifier")).toBe(true);

    const view = agents.view(T, RANGE);
    expect(view.agents).toEqual([]);
    expect(view.unassigned.map((s) => [s.id, s.assignedBy]).sort()).toEqual([
      ["apikey_a", null],
      ["apikey_b", null],
      ["apikey_c", null],
    ]);
    expect(view.proxyOnly.map((p) => p.id)).toEqual(["classifier"]);
  });

  it("changes a name or purpose, and clears a purpose with an empty id", () => {
    const id = agents.create(T, { name: "Writer", purposeId: "content", purposeVersion: "1" })!;
    expect(agents.update(T, id, { name: "Blog writer" })).toBe(true);
    expect(agents.update(T, id, { purposeId: "" })).toBe(true);
    expect(agents.view(T, RANGE).agents[0]).toMatchObject({ name: "Blog writer", purposeId: null, purposeVersion: null });
    expect(agents.update(T, "nobody", { name: "x" })).toBe(false);
  });

  it("starts an owner's agent's seen-times when its first proxied call arrives", () => {
    const id = agents.create(T, { name: "Support bot" })!;
    new CostGridRepository(db).touchAgent(T, id, "Support");
    const row = db.prepare("SELECT origin, first_seen_at, last_seen_at FROM agents WHERE id = ?").get(id) as {
      origin: string;
      first_seen_at: number | null;
      last_seen_at: number | null;
    };
    expect(row.origin).toBe("owner");
    expect(row.first_seen_at).toEqual(expect.any(Number));
    expect(row.last_seen_at).toBe(row.first_seen_at);
  });

  it("gives an undecided twin the agent of the same key seen the other way", () => {
    // The usage file's view of a key, and the admin API's view of the same key.
    sources.upsertSources(
      T,
      [
        { provider: "anthropic", kind: "key", id: "Support / support-bot", parentId: "Support" },
        { provider: "anthropic", kind: "key", id: "apikey_s", parentId: "wrkspc_1", label: "support-bot", parentLabel: "Support" },
      ],
      { first: "2026-06-01", last: "2026-06-01" },
    );
    const id = agents.create(T, { name: "Support bot" })!;
    agents.assign(T, key("Support / support-bot"), { agentId: id, shared: false, by: "owner" });

    expect(agents.matchTwins(T)).toEqual([{ source: key("apikey_s"), agentId: id, shared: false }]);
    const twin = agents.view(T, RANGE).agents[0]!.sources.find((s) => s.id === "apikey_s");
    expect(twin).toMatchObject({ agentId: id, assignedBy: "match" });
    // Nothing left to do the second time.
    expect(agents.matchTwins(T)).toEqual([]);

    // The owner says it is not the same key: that decision stands.
    agents.assign(T, key("apikey_s"), { agentId: null, shared: false, by: "owner" });
    expect(agents.matchTwins(T)).toEqual([]);
  });
});
