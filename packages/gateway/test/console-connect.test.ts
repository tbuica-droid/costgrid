import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveMasterKey } from "@costgrid/core";
import {
  AccountsRepository,
  Analytics,
  CostGridRepository,
  ImportsRepository,
  openDatabase,
  SourcesRepository,
} from "@costgrid/db";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GatewayConfig } from "../src/config.js";
import { adminKeyAccount, MemorySecretStore } from "../src/secret-store.js";
import { createServer } from "../src/server.js";

/**
 * Connecting a provider and naming its sources, through the routes the setup
 * screen calls. The provider is a stub and the keychain is a map, so the
 * tests can check the one thing that matters most: the admin key goes to the
 * store and nowhere else.
 */

const MASTER_SECRET = "test-master-key-long-enough-to-be-accepted-0123456789";
const ADMIN_KEY = "sk-ant-admin01-CONNECTTESTKEY-0123456789abcdef";
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "usage");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

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

/** The Claude admin API as far as these routes use it: one day of usage and the names. */
function anthropicStub(seen: { urls: URL[]; keys: string[] }, failWith?: number): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    seen.urls.push(url);
    seen.keys.push((init?.headers as Record<string, string>)["x-api-key"] ?? "");
    if (failWith !== undefined) {
      // A provider that echoes the credential back, which must not leak further.
      return new Response(JSON.stringify({ error: { message: `invalid x-api-key ${ADMIN_KEY}` } }), {
        status: failWith,
      });
    }
    const body = url.pathname.endsWith("/workspaces")
      ? { data: [{ id: "wrkspc_01", name: "Support" }], has_more: false }
      : url.pathname.endsWith("/api_keys")
        ? {
            data: [
              { id: "apikey_01", name: "support-bot", status: "active", created_at: "2025-01-01T00:00:00Z", workspace_id: "wrkspc_01" },
              { id: "apikey_02", name: "old-test", status: "active", created_at: "2025-01-01T00:00:00Z", workspace_id: null },
            ],
            has_more: false,
          }
        : {
            data: [
              {
                starting_at: `${today}T00:00:00Z`,
                results: [
                  {
                    model: "claude-opus-5",
                    api_key_id: "apikey_01",
                    workspace_id: "wrkspc_01",
                    uncached_input_tokens: 1_000_000,
                    output_tokens: 0,
                  },
                ],
              },
            ],
            has_more: false,
          };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("connecting a provider", () => {
  let dir: string;
  let db: ReturnType<typeof openDatabase>;
  let accounts: AccountsRepository;
  let repository: CostGridRepository;
  let imports: ImportsRepository;
  let sources: SourcesRepository;
  let store: MemorySecretStore;
  let seen: { urls: URL[]; keys: string[] };
  let app: FastifyInstance;
  let cookie: string;
  let tenantId: string;

  function build(options: { fetchImpl?: typeof fetch; store?: MemorySecretStore | null } = {}): void {
    app = createServer({
      config: { ...HOSTED, logLevel: "debug", logFile: join(dir, "costgrid.log") },
      db,
      repository,
      analytics: new Analytics(db),
      accounts,
      imports,
      fetchImpl: options.fetchImpl ?? anthropicStub(seen),
      secretStore: options.store === null ? undefined : (options.store ?? store),
    });
  }

  const call = (method: "GET" | "PUT" | "POST" | "DELETE", url: string, payload?: object, as = cookie) =>
    app.inject({ method, url, headers: { cookie: as }, ...(payload ? { payload } : {}) });
  const connect = (payload: object, provider = "anthropic") =>
    call("PUT", `/console/${tenantId}/connect/${provider}/admin-key`, payload);
  const upload = (fileName: string, text: string, provider = "openai") =>
    call("POST", `/console/${tenantId}/connect/${provider}/usage-file`, { fileName, text });

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

  const auditActions = (): string[] =>
    (db.prepare("SELECT action FROM audit_log WHERE tenant_id = ?").all(tenantId) as { action: string }[]).map(
      (a) => a.action,
    );

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "costgrid-connect-"));
    db = openDatabase({ path: join(dir, "costgrid.db") });
    accounts = new AccountsRepository(db, deriveMasterKey(MASTER_SECRET));
    repository = new CostGridRepository(db);
    imports = new ImportsRepository(db);
    sources = new SourcesRepository(db);
    store = new MemorySecretStore();
    seen = { urls: [], keys: [] };
    build();
    ({ cookie, tenantId } = await signup("owner@acme.test", "Acme"));
  });

  afterEach(async () => {
    await app?.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Every row, and every byte of the database, its WAL and the debug log, for a secret. */
  async function expectNowhereOnDisk(secret: string): Promise<void> {
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]) {
      expect(JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all()), name).not.toContain(secret);
    }
    // Closing flushes the log; it must have something in it for the check to mean anything.
    await app.close();
    const log = join(dir, "costgrid.log");
    for (let i = 0; i < 50 && (!existsSync(log) || statSync(log).size === 0); i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(statSync(log).size).toBeGreaterThan(0);
    for (const file of readdirSync(dir)) {
      expect(readFileSync(join(dir, file)).includes(Buffer.from(secret)), file).toBe(false);
    }
  }

  // ---------------------------------------------------------- admin key

  it("imports 90 days, then keeps the key in the store and only there", async () => {
    const expiresAt = Date.now() + 7 * 86_400_000;
    const res = await connect({ adminKey: `  ${ADMIN_KEY}\n`, expiresAt });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ stored: true, rowsWritten: 1, sources: 1, unpricedModels: [] });
    expect(res.body).not.toContain(ADMIN_KEY);
    expect(await store.get(adminKeyAccount(tenantId, "anthropic"))).toBe(ADMIN_KEY);
    expect(store.size).toBe(1);

    // Only the provider's own admin host was contacted, always with this key.
    expect(new Set(seen.urls.map((u) => u.host))).toEqual(new Set(["api.anthropic.com"]));
    expect(new Set(seen.keys)).toEqual(new Set([ADMIN_KEY]));

    const state = (await call("GET", `/console/${tenantId}/connect`)).json();
    expect(state.secretStore).toBe(true);
    // The connect import counts as its first sync, so the background sync starts from here.
    expect(state.providers[0]).toMatchObject({
      provider: "anthropic",
      adminKey: { hint: "********cdef", expiresAt, lastSyncStatus: "ok" },
    });
    expect(state.sourceCount).toBe(1);
    expect(JSON.stringify(state)).not.toContain(ADMIN_KEY);

    expect(auditActions()).toEqual(expect.arrayContaining(["import.ran", "connect.key-stored"]));

    // The provider's name for the key came along.
    const listed = (await call("GET", `/console/${tenantId}/sources?days=90`)).json();
    expect(listed.sources[0]).toMatchObject({
      kind: "key",
      id: "apikey_01",
      parentId: "wrkspc_01",
      label: "support-bot",
      costUsd: "5.000000",
    });

    db.pragma("wal_checkpoint(TRUNCATE)");
    await expectNowhereOnDisk(ADMIN_KEY);
  });

  it("keeps what the key list says about each key, and warns about risky ones", async () => {
    expect((await connect({ adminKey: ADMIN_KEY, expiresAt: Date.now() + 7 * 86_400_000 })).statusCode).toBe(200);
    const res = await call("GET", `/console/${tenantId}/key-safety`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.keysChecked).toBe(true);
    expect(body.warnings.map((w: { code: string; subject: { id: string } | null }) => [w.code, w.subject?.id ?? null])).toEqual([
      ["admin-key-expiring", null],
      // Usage today, but no agent uses it yet.
      ["unassigned-spend", "apikey_01"],
      ["unused-active-key", "apikey_02"],
      ["default-workspace-key", "apikey_02"],
      ["old-key", "apikey_01"],
      ["old-key", "apikey_02"],
    ]);
    expect(JSON.stringify(body)).not.toContain(ADMIN_KEY);

    // Forgetting the admin key forgets what its lists said.
    expect((await call("DELETE", `/console/${tenantId}/connect/anthropic/admin-key`)).statusCode).toBe(200);
    const after = (await call("GET", `/console/${tenantId}/key-safety`)).json();
    expect(after.keysChecked).toBe(false);
    expect(after.warnings.map((w: { code: string }) => w.code)).toEqual(["unassigned-spend"]);

    const other = await signup("other@other.test", "Other");
    expect((await call("GET", `/console/${tenantId}/key-safety`, undefined, other.cookie)).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/console/${tenantId}/key-safety` })).statusCode).toBe(401);
  });

  it("stores nothing when the import fails, and never repeats the key", async () => {
    await app.close();
    build({ fetchImpl: anthropicStub(seen, 401) });

    const res = await connect({ adminKey: ADMIN_KEY, expiresAt: null });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/^Claude didn't accept this key for reading usage\. .*Usage file tab/);
    expect(res.body).not.toContain(ADMIN_KEY);
    expect(store.size).toBe(0);
    expect(sources.adminKeys(tenantId)).toEqual([]);

    const state = (await call("GET", `/console/${tenantId}/connect`)).json();
    expect(state.runs[0]).toMatchObject({ status: "error", origin: "admin-api" });
    expect(state.runs[0].errorMessage).toContain("[key]");
    await expectNowhereOnDisk(ADMIN_KEY);
  });

  it("uses the key once and keeps nothing when there is no store", async () => {
    await app.close();
    build({ store: null });

    const res = await connect({ adminKey: ADMIN_KEY, expiresAt: null });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ stored: false, rowsWritten: 1 });
    expect(sources.adminKeys(tenantId)).toEqual([]);
    expect((await call("GET", `/console/${tenantId}/connect`)).json().secretStore).toBe(false);
    expect(auditActions()).toContain("connect.key-used-once");
    await expectNowhereOnDisk(ADMIN_KEY);
  });

  it("forgets a stored key and its metadata, and keeps the usage it imported", async () => {
    await connect({ adminKey: ADMIN_KEY, expiresAt: null });
    const res = await call("DELETE", `/console/${tenantId}/connect/anthropic/admin-key`);

    expect(res.json()).toEqual({ forgotten: true });
    expect(store.size).toBe(0);
    expect(sources.adminKeys(tenantId)).toEqual([]);
    expect(imports.hasImports(tenantId)).toBe(true);
    expect((await call("DELETE", `/console/${tenantId}/connect/anthropic/admin-key`)).json()).toEqual({ forgotten: false });
  });

  it("refuses a bad key, a bad expiry or an unknown provider before contacting anyone", async () => {
    const now = Date.now();
    const bad = [
      connect({ adminKey: "", expiresAt: null }),
      connect({ adminKey: "sk-ant two parts", expiresAt: null }),
      connect({ adminKey: "x".repeat(513), expiresAt: null }),
      connect({ adminKey: 42, expiresAt: null }),
      connect({ adminKey: ADMIN_KEY }),
      connect({ adminKey: ADMIN_KEY, expiresAt: now - 1_000 }),
      connect({ adminKey: ADMIN_KEY, expiresAt: now + 3 * 365 * 86_400_000 }),
      connect({ adminKey: ADMIN_KEY, expiresAt: "tomorrow" }),
      connect({ adminKey: ADMIN_KEY, expiresAt: now + 1.5 * 86_400_000 + 0.5 }),
      connect({ adminKey: ADMIN_KEY, expiresAt: null }, "bedrock"),
      connect({ adminKey: ADMIN_KEY, expiresAt: null }, "..%2F..%2Fother"),
    ];
    for (const res of await Promise.all(bad)) {
      expect(res.statusCode).toBe(400);
      expect(res.body).not.toContain(ADMIN_KEY);
    }
    expect(seen.urls).toEqual([]);
    expect(store.size).toBe(0);
  });

  it("turns away a key that cannot read usage, or belongs on the other card, before sending it", async () => {
    const ordinary = await connect({ adminKey: "sk-proj-ORDINARYKEY0123456789", expiresAt: null }, "openai");
    expect(ordinary.statusCode).toBe(400);
    expect(ordinary.json().error).toMatch(/^This is an ordinary OpenAI API key, which can't read usage\. .*sk-admin-/);

    const wrongCard = await connect({ adminKey: "sk-admin-OPENAIADMINKEY0123456789", expiresAt: null });
    expect(wrongCard.json().error).toBe("This looks like an OpenAI key. Paste it on the OpenAI card instead.");
    const claudeOnOpenAi = await connect({ adminKey: ADMIN_KEY, expiresAt: null }, "openai");
    expect(claudeOnOpenAi.json().error).toBe("This looks like a Claude key. Paste it on the Claude card instead.");

    expect(seen.urls).toEqual([]);
    expect(store.size).toBe(0);
  });

  it("is for the owner only, and only from the console's own origin", async () => {
    const member = await signup("member@acme.test", "Personal");
    accounts.addMember(tenantId, member.userId, "member");

    for (const res of [
      await call("GET", `/console/${tenantId}/connect`, undefined, member.cookie),
      await call("PUT", `/console/${tenantId}/connect/anthropic/admin-key`, { adminKey: ADMIN_KEY, expiresAt: null }, member.cookie),
      await call("DELETE", `/console/${tenantId}/connect/anthropic/admin-key`, undefined, member.cookie),
      await call("POST", `/console/${tenantId}/connect/openai/usage-file`, { fileName: "a.csv", text: "x" }, member.cookie),
      await call("GET", `/console/${tenantId}/sources`, undefined, member.cookie),
      await call("GET", `/console/${tenantId}/connect/developer-message`, undefined, member.cookie),
    ]) {
      expect(res.statusCode).toBe(403);
    }

    // Another organisation's owner learns nothing.
    const other = await signup("other@other.test", "Other");
    expect((await call("GET", `/console/${tenantId}/connect`, undefined, other.cookie)).statusCode).toBe(404);

    const forged = await app.inject({
      method: "PUT",
      url: `/console/${tenantId}/connect/anthropic/admin-key`,
      headers: { cookie, origin: "https://evil.test", host: "costgrid.test" },
      payload: { adminKey: ADMIN_KEY, expiresAt: null },
    });
    expect(forged.statusCode).toBe(403);
    expect(seen.urls).toEqual([]);
    expect(store.size).toBe(0);
  });

  // --------------------------------------------------------- usage file

  it("imports a usage file and records where its usage came from", async () => {
    const res = await upload("completions_usage_2026-09-01_2026-09-02.csv", fixture("completions_usage_2026_order.csv"));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ rowsWritten: 1, sources: 1, fromDay: "2026-09-01", toDay: "2026-09-01" });
    expect(res.json().warnings).toEqual(["Audio and image tokens are priced at text rates."]);

    const state = (await call("GET", `/console/${tenantId}/connect`)).json();
    expect(state.runs[0]).toMatchObject({ provider: "openai", origin: "csv", status: "ok", rowsWritten: 1 });
    const entry = db.prepare("SELECT detail FROM audit_log WHERE action = 'import.file'").get() as { detail: string };
    expect(JSON.parse(entry.detail)).toMatchObject({ fileName: "completions_usage_2026-09-01_2026-09-02.csv", fromDay: "2026-09-01" });

    const claude = await upload("claude_api_tokens.csv", fixture("claude_api_tokens_current.csv"), "anthropic");
    expect(claude.statusCode).toBe(200);
    expect(claude.json().rowsWritten).toBeGreaterThan(0);
  });

  it("leaves usage already imported alone when a file has none", async () => {
    await upload("completions_usage_2026-09-01_2026-09-02.csv", fixture("completions_usage_2026_order.csv"));
    const res = await upload("completions_usage.csv", fixture("completions_usage_no_usage.csv"));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ rowsWritten: 0, sources: 0, fromDay: "2026-09-01", toDay: "2026-09-03" });
    expect(res.json().warnings).toContain("Nothing already imported for these days was changed.");
    expect(imports.recentRuns(tenantId)).toHaveLength(1);
    expect(imports.hasImports(tenantId)).toBe(true);
  });

  it("says plainly why a file cannot be imported", async () => {
    const cost = await upload("cost.csv", fixture("cost_2026-09-01_2026-09-30.csv"));
    expect(cost.statusCode).toBe(400);
    expect(cost.json().code).toBe("cost-file");

    const undated = await upload("claude_api_tokens.csv", fixture("claude_api_tokens_no_usage.csv"), "anthropic");
    expect(undated.statusCode).toBe(400);
    expect(undated.json().code).toBe("empty");

    const wrong = await upload("claude.csv", fixture("claude_api_tokens_current.csv"), "openai");
    expect(wrong.json().code).toBe("wrong-provider");

    for (const fileName of ["", "../etc/passwd", "a\\b.csv", "x".repeat(121), "bad\nname.csv"]) {
      expect((await upload(fileName, "a,b\n1,2")).statusCode).toBe(400);
    }
    expect((await call("POST", `/console/${tenantId}/connect/openai/usage-file`, { fileName: "a.csv" })).statusCode).toBe(400);
    expect(imports.hasImports(tenantId)).toBe(false);
  });

  // ------------------------------------------------------------ sources

  it("lists sources with their cost, and whether an agent uses them", async () => {
    await upload("completions_usage.csv", fixture("completions_usage_ungrouped.csv"));
    await upload("completions_usage.csv", fixture("completions_usage_2026_order.csv"));
    const listed = (await call("GET", `/console/${tenantId}/sources?days=365`)).json().sources;
    expect(listed.map((s: { kind: string }) => s.kind).sort()).toEqual(["account", "key"]);
    expect(typeof listed[0].costUsd).toBe("string");
    expect(listed[0]).toMatchObject({ agentId: null, shared: false, assignedBy: null });

    expect((await call("GET", `/console/${tenantId}/sources?days=0`)).statusCode).toBe(400);
    expect((await call("GET", `/console/${tenantId}/sources?days=366`)).statusCode).toBe(400);
  });

  // ------------------------------------------------------ presets, copy

  it("serves the purpose presets to any signed-in member", async () => {
    const member = await signup("member@acme.test", "Personal");
    accounts.addMember(tenantId, member.userId, "member");
    const res = await call("GET", "/console/presets", undefined, member.cookie);
    expect(res.json().presets.map((p: { id: string }) => p.id)).toEqual(["support", "sales-leads", "content", "data-entry", "other"]);
    expect(res.json().presets[0]).toEqual({
      id: "support",
      version: "2",
      label: "Customer support",
      finishedJob: expect.any(String),
      evidence: "medium",
    });
    expect((await app.inject({ method: "GET", url: "/console/presets" })).statusCode).toBe(401);
  });

  it("writes a developer message with no key, token or local link in it", async () => {
    await connect({ adminKey: ADMIN_KEY, expiresAt: null });
    for (const provider of ["anthropic", "openai", "both"]) {
      const res = await call("GET", `/console/${tenantId}/connect/developer-message?provider=${provider}`);
      const { subject, body } = res.json();
      expect(subject).toBeTruthy();
      expect(body).toMatch(/usage/);
      for (const banned of ["sk-", "http://127.0.0.1", "localhost", "cg_live_", ADMIN_KEY.slice(-8)]) {
        expect(`${subject}\n${body}`).not.toContain(banned);
      }
    }
    expect((await call("GET", `/console/${tenantId}/connect/developer-message?provider=evil`)).statusCode).toBe(400);
  });

  it("tells the dashboard how many sources the imported history has", async () => {
    await upload("completions_usage.csv", fixture("completions_usage_2026_order.csv"));
    const apiKey = repository.createApiKey(tenantId, "reader").plaintext;
    const history = await app.inject({ method: "GET", url: "/api/history?days=365", headers: { "x-costgrid-key": apiKey } });
    expect(history.json().sourceCount).toBe(1);
  });
});
