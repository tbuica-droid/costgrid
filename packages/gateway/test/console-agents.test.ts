import { deriveMasterKey, usd, ZERO_USAGE } from "@costgrid/core";
import {
  AccountsRepository,
  Analytics,
  CostGridRepository,
  type ImportedRow,
  ImportsRepository,
  openDatabase,
  SourcesRepository,
} from "@costgrid/db";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GatewayConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

/**
 * Step 3 of setup, through the routes the screen calls: naming agents and
 * saying which provider key, workspace or project each one uses.
 */

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

const today = new Date().toISOString().slice(0, 10);
const FILE_KEY = "Support / support-bot";

function row(sourceId: string, cost: string): ImportedRow {
  return {
    provider: "anthropic",
    day: today,
    model: "claude-opus-5",
    usage: { ...ZERO_USAGE, inputTokens: 1000 },
    requests: 0,
    costCatalog: usd(cost),
    priced: true,
    sourceKind: "key",
    sourceId,
  };
}

describe("matching keys to agents", () => {
  let db: ReturnType<typeof openDatabase>;
  let accounts: AccountsRepository;
  let repository: CostGridRepository;
  let sources: SourcesRepository;
  let app: FastifyInstance;
  let cookie: string;
  let tenantId: string;

  const call = (method: "GET" | "PUT" | "POST" | "PATCH" | "DELETE", url: string, payload?: object, as = cookie) =>
    app.inject({ method, url, headers: { cookie: as }, ...(payload ? { payload } : {}) });
  const view = async () => (await call("GET", `/console/${tenantId}/agents?days=90`)).json();
  const assign = (id: string, body: object, as = cookie) =>
    call("PUT", `/console/${tenantId}/sources/anthropic/key/${encodeURIComponent(id)}/agent`, body, as);
  const audit = (action: string) =>
    db.prepare("SELECT subject, detail, actor_kind FROM audit_log WHERE tenant_id = ? AND action = ?").all(tenantId, action) as {
      subject: string;
      detail: string;
      actor_kind: string;
    }[];

  async function signup(email: string, organisation: string) {
    const res = await app.inject({
      method: "POST",
      url: "/console/signup",
      payload: { email, name: "Someone", password: "a-sufficiently-long-password", organisation },
    });
    return {
      cookie: String(res.headers["set-cookie"]).split(";")[0]!,
      tenantId: res.json().tenantId as string,
      userId: res.json().user.id as string,
    };
  }

  beforeEach(async () => {
    db = openDatabase({ path: ":memory:" });
    accounts = new AccountsRepository(db, deriveMasterKey(MASTER_SECRET));
    repository = new CostGridRepository(db);
    sources = new SourcesRepository(db);
    app = createServer({
      config: HOSTED,
      db,
      repository,
      analytics: new Analytics(db),
      accounts,
      imports: new ImportsRepository(db),
    });
    ({ cookie, tenantId } = await signup("owner@acme.test", "Acme"));

    // A key named in a usage file, the same key seen through the admin API, and another.
    sources.upsertSources(
      tenantId,
      [
        { provider: "anthropic", kind: "key", id: FILE_KEY, parentId: "Support" },
        { provider: "anthropic", kind: "key", id: "apikey_s", parentId: "wrkspc_1", label: "support-bot", parentLabel: "Support" },
        { provider: "anthropic", kind: "key", id: "apikey_w", parentId: "wrkspc_2", label: "writer", parentLabel: "Content" },
      ],
      { first: today, last: today },
    );
    new ImportsRepository(db).putRows(
      tenantId,
      "anthropic",
      { fromDay: today, toDay: today },
      [row(FILE_KEY, "1.00"), row("apikey_w", "3.00")],
      "csv",
    );
  });

  afterEach(async () => {
    await app?.close();
    db.close();
  });

  it("creates an agent, puts a key on it, and carries it to the same key seen the other way", async () => {
    const created = await call("POST", `/console/${tenantId}/agents`, {
      name: "  Support bot ",
      purposeId: "support",
      purposeVersion: "99",
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual({ id: "support-bot" });

    const res = await assign(FILE_KEY, { agentId: "support-bot" });
    expect(res.json()).toEqual({ ok: true, matched: { provider: "anthropic", kind: "key", id: "apikey_s" } });

    const v = await view();
    expect(v.agents).toHaveLength(1);
    // The version is the catalog's, whatever the client claimed.
    expect(v.agents[0]).toMatchObject({
      id: "support-bot",
      name: "Support bot",
      purposeId: "support",
      purposeVersion: "2",
      origin: "owner",
      imported: { costUsd: "1.000000", estimatedUsd: "1.000000" },
      metered: { costUsd: "0.000000", calls: 0 },
    });
    const byId = Object.fromEntries(v.agents[0].sources.map((s: { id: string }) => [s.id, s]));
    expect(byId[FILE_KEY]).toMatchObject({ agentId: "support-bot", assignedBy: "owner" });
    expect(byId["apikey_s"]).toMatchObject({ agentId: "support-bot", assignedBy: "match", parentLabel: "Support" });
    expect(v.unassigned.map((s: { id: string }) => s.id)).toEqual(["apikey_w"]);

    expect(audit("agent.created")).toHaveLength(1);
    expect(audit("source.assigned")[0]).toMatchObject({ subject: `anthropic:key:${FILE_KEY}`, actor_kind: "user" });
    expect(audit("source.matched")[0]).toMatchObject({ subject: "anthropic:key:apikey_s", actor_kind: "system" });

    // "Not the same key" sticks: the next visit does not match it again.
    await assign("apikey_s", { agentId: null });
    const after = await view();
    expect(after.unassigned.map((s: { id: string }) => s.id).sort()).toEqual(["apikey_s", "apikey_w"]);
    expect(audit("source.matched")).toHaveLength(1);
  });

  it("marks a key as shared, so its cost belongs to no agent", async () => {
    await call("POST", `/console/${tenantId}/agents`, { name: "Writer" });
    expect((await assign("apikey_w", { agentId: "writer", shared: true })).statusCode).toBe(400);
    expect((await assign("apikey_w", { agentId: null, shared: true })).json()).toMatchObject({ ok: true });

    const v = await view();
    expect(v.shared).toEqual([expect.objectContaining({ id: "apikey_w", shared: true, agentId: null, costUsd: "3.000000" })]);
    expect(v.agents[0]).toMatchObject({ id: "writer", sources: [], imported: { costUsd: "0.000000" } });
  });

  it("renames, changes the purpose of, and removes an agent", async () => {
    await call("POST", `/console/${tenantId}/agents`, { name: "Writer", purposeId: "content" });
    await assign("apikey_w", { agentId: "writer" });

    expect((await call("PATCH", `/console/${tenantId}/agents/writer`, { name: "Blog writer", purposeId: "" })).json()).toEqual({
      ok: true,
    });
    expect((await view()).agents[0]).toMatchObject({ name: "Blog writer", purposeId: null });

    expect((await call("DELETE", `/console/${tenantId}/agents/writer`)).json()).toEqual({ ok: true });
    const v = await view();
    expect(v.agents).toEqual([]);
    expect(v.unassigned.map((s: { id: string }) => s.id)).toContain("apikey_w");
    expect((await call("DELETE", `/console/${tenantId}/agents/writer`)).statusCode).toBe(404);
    expect(audit("agent.removed")).toHaveLength(1);
  });

  it("names an agent the proxy already saw, so its traffic and its keys meet", async () => {
    repository.touchAgent(tenantId, "classifier", "Ops");
    expect((await view()).proxyOnly).toEqual([
      { id: "classifier", lastSeenAt: expect.any(Number), metered: { costUsd: "0.000000", calls: 0 } },
    ]);

    const linked = await call("POST", `/console/${tenantId}/agents`, { name: "Ticket sorter", linkProxyId: "classifier" });
    expect(linked.json()).toEqual({ id: "classifier" });
    expect((await call("POST", `/console/${tenantId}/agents`, { name: "Again", linkProxyId: "classifier" })).statusCode).toBe(404);
    const v = await view();
    expect(v.proxyOnly).toEqual([]);
    expect(v.agents[0]).toMatchObject({ id: "classifier", name: "Ticket sorter", origin: "proxy" });
  });

  it("refuses what it cannot trust", async () => {
    const post = (body: object) => call("POST", `/console/${tenantId}/agents`, body);
    for (const body of [{}, { name: "" }, { name: "x".repeat(81) }, { name: "two\nlines" }, { name: 7 }, { name: "A", purposeId: "world-domination" }, { name: "A", linkProxyId: 5 }]) {
      expect((await post(body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    await post({ name: "Writer" });
    expect((await call("PATCH", `/console/${tenantId}/agents/writer`, {})).statusCode).toBe(400);
    expect((await call("PATCH", `/console/${tenantId}/agents/nobody`, { name: "x" })).statusCode).toBe(404);

    const put = (path: string, body: object) => call("PUT", `/console/${tenantId}/sources/${path}/agent`, body);
    expect((await put("anthropic/key/_", { agentId: null })).statusCode).toBe(400);
    expect((await put("anthropic/account/acct", { agentId: null })).statusCode).toBe(400);
    expect((await put("anthropic/team/apikey_w", { agentId: null })).statusCode).toBe(400);
    expect((await put("nobody/key/apikey_w", { agentId: null })).statusCode).toBe(400);
    expect((await put("anthropic/key/apikey_w", {})).statusCode).toBe(400);
    expect((await put("anthropic/key/apikey_w", { agentId: null, shared: "yes" })).statusCode).toBe(400);
    expect((await put("anthropic/key/apikey_w", { agentId: "nobody" })).statusCode).toBe(404);
    expect((await put("anthropic/key/apikey_404", { agentId: "writer" })).statusCode).toBe(404);
    expect((await call("GET", `/console/${tenantId}/agents?days=0`)).statusCode).toBe(400);
  });

  it("is for the owner only, and only from the console's own origin", async () => {
    const member = await signup("member@acme.test", "Personal");
    accounts.addMember(tenantId, member.userId, "member");
    for (const res of [
      await call("GET", `/console/${tenantId}/agents`, undefined, member.cookie),
      await call("POST", `/console/${tenantId}/agents`, { name: "x" }, member.cookie),
      await call("PATCH", `/console/${tenantId}/agents/x`, { name: "y" }, member.cookie),
      await call("DELETE", `/console/${tenantId}/agents/x`, undefined, member.cookie),
      await assign("apikey_w", { agentId: null }, member.cookie),
    ]) {
      expect(res.statusCode).toBe(403);
    }

    const other = await signup("other@other.test", "Other");
    expect((await call("GET", `/console/${tenantId}/agents`, undefined, other.cookie)).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/console/${tenantId}/agents` })).statusCode).toBe(401);

    const forged = await app.inject({
      method: "POST",
      url: `/console/${tenantId}/agents`,
      headers: { cookie, origin: "https://evil.test", host: "costgrid.test" },
      payload: { name: "Sneaky" },
    });
    expect(forged.statusCode).toBe(403);
    expect((await view()).agents).toEqual([]);
  });
});
